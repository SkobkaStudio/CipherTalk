// CipherTalk C++ server: точка входа.
// Секреты берутся ТОЛЬКО из переменных окружения и никогда не пишутся в лог.
#include "Database.h"
#include "AuthController.h"
#include "ProfileController.h"
#include "ChatController.h"
#include "WsController.h"
#include "HttpServer.h"
#include "Crypto.h"
#include <iostream>
#include <cstdlib>
#include <fstream>
#include <string>
#include <memory>
#include <csignal>
#include <atomic>
#include <thread>
#include <chrono>

namespace {
std::atomic<bool> g_stop{false};
void on_signal(int) { g_stop.store(true); }

// Читает секрет из env; если отсутствует — генерирует случайный и сохраняет в файл
// с правами 0600 (чтобы JWT переживали рестарт). Сам секрет в stdout не печатается.
std::string loadOrCreateSecret(const char* env_name, const std::string& file_path) {
    if (const char* v = std::getenv(env_name); v && *v) return std::string(v);
    std::ifstream in(file_path, std::ios::binary);
    if (in) {
        std::string s((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
        if (!s.empty()) return s;
    }
    std::string generated = crypto::randomHex(32);
    std::ofstream out(file_path, std::ios::binary | std::ios::trunc);
    out << generated;
    out.close();
    ::chmod(file_path.c_str(), S_IRUSR | S_IWUSR); // 0600
    return generated;
}
} // namespace

int main() {
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    const int port = [] {
        if (const char* p = std::getenv("PORT"); p && *p) {
            long v = std::atol(p);
            if (v > 0 && v < 65536) return static_cast<int>(v);
        }
        return 8787;
    }();
    const std::string db_path = [] {
        if (const char* d = std::getenv("CIPHERTALK_DB"); d && *d) return std::string(d);
        return std::string("ciphertalk.db");
    }();
    const std::string static_dir = [] {
        if (const char* s = std::getenv("STATIC_DIR"); s && *s) return std::string(s);
        return std::string("../app/public");
    }();

    // Секреты: SQLCipher key и JWT secret. В коде захардкожены fallback-значения
    // только для dev; в продакшене обязательны env-переменные.
    const std::string cipher_key = loadOrCreateSecret("SQLCIPHER_KEY", ".sqlcipher.key");
    const std::string jwt_secret = loadOrCreateSecret("JWT_SECRET", ".jwt.secret");

    std::unique_ptr<Database> db;
    try {
        db = Database::open(db_path, cipher_key);
        db->ensureSchema();
    } catch (const std::exception&) {
        // Не печатаем текст исключения целиком (может содержать путь к файлу) — только факт ошибки.
        std::cerr << "Failed to open database" << std::endl;
        return 1;
    }

    auto auth = std::make_unique<AuthController>(*db, jwt_secret);
    auto ws = std::make_unique<WsController>(*auth);
    auto profile = std::make_unique<ProfileController>(*auth);
    auto chat = std::make_unique<ChatController>(*auth, *ws);

    http::Server router;
    auth->registerRoutes(router);
    profile->registerRoutes(router);
    chat->registerRoutes(router);
    router.get("/api/health", [](http::Request&) {
        return http::Response::json(200, "{\"ok\":true,\"server\":\"ciphertalk-cpp\"}");
    });

    HttpServer server(router, port, static_dir);
    // WebSocket handshake уходит в WsController (он забирает fd и авторизует токен: JWT или bot token)
    server.setWsHook([ws_raw = ws.get()](int fd, const http::Request& req) {
        return ws_raw->handleNewConnection(fd, req);
    });

    if (!server.start()) {
        std::cerr << "Failed to bind port " << port << std::endl;
        return 1;
    }
    std::cout << "CipherTalk C++ server listening on port " << port << std::endl;

    while (!g_stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(200));

    std::cout << "Shutting down..." << std::endl;
    server.stop();   // больше не принимаем новые соединения
    ws->shutdown();  // корректно завершаем все WS-сессии (join worker-потоков)
    return 0;
}
