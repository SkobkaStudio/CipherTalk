// ============================================================
// Точка входа приложения CipherTalk.
// Инициализация БД, регистрация маршрутов HTTP и WebSocket,
// запуск сервера на порту 3000.
// ============================================================
#include "utils/config.hpp"
#include "utils/http_server.hpp"
#include "models/database.hpp"
#include "models/schema.hpp"
#include "controllers/auth_controller.hpp"
#include "controllers/chat_controller.hpp"
#include "controllers/ws_controller.hpp"

#include <iostream>
#include <sys/stat.h>

// Глобальная база данных (используется моделями через extern)
Database* g_db = nullptr;

// Каталог статики — объявлен extern в http_server.cpp
// (не const, чтобы определение имело внешнюю линковку и было видно из других TU)
std::string g_webDir = config::WEB_DIR;

// Создать каталоги для файла БД, если их нет (build/)
static void ensureDbDir(const std::string& dbPath) {
    size_t slash = dbPath.rfind('/');
    if (slash != std::string::npos) {
        std::string dir = dbPath.substr(0, slash);
        ::mkdir(dir.c_str(), 0755);
    }
}

int main() {
    // 1. Открываем базу данных build/ciphertalk-db.sqlite
    ensureDbDir(config::DB_PATH);
    g_db = new Database(config::DB_PATH);
    if (!initSchema()) {
        std::cerr << "[main] не удалось инициализировать схему БД" << std::endl;
        return 1;
    }
    std::cout << "[main] схема БД готова: " << config::DB_PATH << std::endl;

    // 2. Создаём HTTP-сервер и регистрируем маршруты API
    HttpServer server;

    // Аутентификация
    server.route("POST", "/api/register", auth_controller::registerUser);
    server.route("POST", "/api/login",    auth_controller::login);
    server.route("GET",  "/api/me",       auth_controller::me);

    // Пользователи, чаты, сообщения
    server.route("GET",  "/api/users",    chat_controller::listUsers);
    server.route("GET",  "/api/chats",    chat_controller::listChats);
    server.route("POST", "/api/chats",    chat_controller::createChat);
    server.route("GET",  "/api/messages", chat_controller::listMessages);
    server.route("POST", "/api/messages", chat_controller::sendMessage);

    // Служебный эндпоинт проверки работоспособности
    server.route("GET", "/api/health", [](const HttpRequest&) {
        return HttpResponse::json(200, "{\"status\":\"ok\",\"app\":\"ciphertalk\"}");
    });

    // 3. WebSocket endpoint для real-time доставки сообщений
    server.wsRoute("/ws", ws_controller::handleUpgrade);

    // 4. Запуск блокирующего цикла сервера на порту 3000
    if (!server.start(config::PORT)) {
        std::cerr << "[main] не удалось запустить сервер" << std::endl;
        delete g_db;
        return 1;
    }

    delete g_db;
    return 0;
}
