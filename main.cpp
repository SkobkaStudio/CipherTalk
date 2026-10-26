#include "http_server.h"
#include "config/config.h"
#include "db/database.h"
#include "services/session_service.h"
#include "services/presence_service.h"
#include "services/websocket_service.h"
#include "services/encryption_service.h"
#include "services/sms_service.h"
#include "services/ice_service.h"
#include "controllers/auth_controller.h"
#include "controllers/chat_controller.h"
#include "controllers/profile_controller.h"
#include "middleware/auth.h"
#include "middleware/security.h"
#include <iostream>
#include <csignal>
#include <thread>
#include <sys/stat.h>

using namespace cipher;

int main() {
    try {
        Config cfg = loadConfig();
        std::cout << "🚀 CipherTalk C++ сервер" << std::endl;
        std::cout << "📦 Порт: " << cfg.port << std::endl;
        std::cout << "🗄️  БД: " << cfg.dbFile << (cfg.dbEncryption ? " (зашифрована)" : "") << std::endl;
        std::cout << "📁 Загрузки: " << cfg.uploadsPath << std::endl;

        // Инициализация базы данных
        auto& db = Database::instance();
        if (!db.load()) {
            std::cerr << "❌ Не удалось загрузить базу данных. Проверьте ключ (.dbkey) и путь к БД." << std::endl;
            return 1;
        }

        // Создаём директории
        ::mkdir(cfg.uploadsPath.c_str(), 0755);

        // HTTP сервер
        HttpServer http(cfg.port);

        // Контроллеры и сервисы
        AuthController authCtrl;
        ChatController chatCtrl;
        ProfileController profileCtrl;
        PresenceService presence;
        SessionService& sessionService = SessionService::instance();
        WebSocketService wsService(db, sessionService, presence);

        // Подключаем WebSocket к HTTP (Upgrade)
        wsService.attachToHttpServer(http);

        // Хелпер: обёртка с middleware-авторизацией
        auto authed = [&](HttpHandler h) {
            return [h](const HttpRequest& req, HttpResponse& res) {
                bool cont = true;
                // копируем req, так как AuthMiddleware модифицирует заголовки
                HttpRequest r = req;
                AuthMiddleware::authenticate(r, res, cont);
                if (!cont) return;
                // Переносим X-User-Id обратно в оригинальный req для контроллера? Нет — h принимает const ref.
                // Вместо этого передаём r.
                h(r, res);
            };
        };

        // === Публичные маршруты ===
        http.get("/api/health", [&](const HttpRequest& req, HttpResponse& res) { chatCtrl.health(req, res); });
        http.get("/api/ice-servers", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.iceServers(req, res); }));

        // === Auth ===
        http.post("/api/auth/send-code", [&](const HttpRequest& req, HttpResponse& res) { authCtrl.sendCode(req, res); });
        http.post("/api/auth/verify-code", [&](const HttpRequest& req, HttpResponse& res) { authCtrl.verifyCode(req, res); });
        http.post("/api/auth/register", [&](const HttpRequest& req, HttpResponse& res) { authCtrl.registerUser(req, res); });
        http.post("/api/auth/login", [&](const HttpRequest& req, HttpResponse& res) { authCtrl.login(req, res); });
        http.post("/api/auth/login-code", [&](const HttpRequest& req, HttpResponse& res) { authCtrl.loginWithCode(req, res); });
        http.post("/api/auth/logout", authed([&](const HttpRequest& req, HttpResponse& res) { authCtrl.logout(req, res); }));
        http.get("/api/auth/me", authed([&](const HttpRequest& req, HttpResponse& res) { authCtrl.me(req, res); }));
        http.get("/api/auth/check-username", [&](const HttpRequest& req, HttpResponse& res) { authCtrl.checkUsername(req, res); });

        // === Profile ===
        http.post("/api/profile/update-profile", authed([&](const HttpRequest& req, HttpResponse& res) { profileCtrl.updateProfile(req, res); }));
        http.get("/api/profile/profile", authed([&](const HttpRequest& req, HttpResponse& res) { profileCtrl.getProfile(req, res); }));
        http.get("/api/users/search", authed([&](const HttpRequest& req, HttpResponse& res) { profileCtrl.searchUsers(req, res); }));
        http.get("/api/search-users", authed([&](const HttpRequest& req, HttpResponse& res) { profileCtrl.searchUsers(req, res); }));

        // === Chats ===
        http.get("/api/chats", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.getUserChats(req, res); }));
        http.prefix("GET", "/api/messages/", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.getMessages(req, res); }));
        http.get("/api/pinned/*", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.getPinnedMessages(req, res); }));
        http.post("/api/create-group", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.createGroup(req, res); }));
        http.post("/api/add-member", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.addMember(req, res); }));
        http.get("/api/folders", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.getFolders(req, res); }));
        http.post("/api/folders", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.createFolder(req, res); }));
        http.put("/api/folders/*", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.updateFolder(req, res); }));
        http.del("/api/folders/*", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.deleteFolder(req, res); }));
        http.post("/api/upload", authed([&](const HttpRequest& req, HttpResponse& res) { chatCtrl.uploadFile(req, res); }));

        // === Security headers на все ответы ===
        // (Применяется в контроллерах или можно глобально — пока в контроллерах не делаем, чтобы не усложнять.)

        // Graceful shutdown
        std::signal(SIGINT, [](int){ std::cout << "\n🛑 SIGINT" << std::endl; });
        std::signal(SIGTERM, [](int){ std::cout << "\n🛑 SIGTERM" << std::endl; });

        // Запуск WebSocket сервиса (подключён к http через attachToHttpServer)
        wsService.run();

        std::cout << "📡 WebSocket готов" << std::endl;
        std::cout << "🌐 API: http://localhost:" << cfg.port << "/api/" << std::endl;

        // Основной цикл HTTP
        http.run();

        return 0;
    } catch (const std::exception& e) {
        std::cerr << "❌ Fatal: " << e.what() << std::endl;
        return 1;
    }
}
