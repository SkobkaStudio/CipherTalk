// =============================================================================
//  main.cpp — точка входа сервера мессенджера (собирает MVC вместе)
// =============================================================================
//  Архитектура проекта (MVC):
//
//    src/
//      model/       — работа с БД SQLite (репозитории, никакого HTML/HTTP)
//      view/        — на сервере «view» = JSON-сериализация (встроена в модели,
//                     toJson()). Классический серверный рендеринг не нужен,
//                     потому что представление живёт в браузере (web/js).
//      controller/  — HTTP+WS маршруты: принимают запрос, дёргают модель,
//                     отдают ответ. Никакого SQL здесь нет!
//      utils/       — инфраструктура: Json, шифрование, кодировки, HTTP/WS-сервер
//    web/           — фронтенд (HTML/CSS/JS), отдаётся как статика с /
//
//  Запуск:  ./messenger [порт]     (по умолчанию 3000)
//  Открыть: http://localhost:3000
// =============================================================================
#include <iostream>
#include <string>
#include <csignal>

#include "utils/http_server.h"
#include "model/database.h"
#include "model/user_repository.h"
#include "model/chat_repository.h"
#include "model/message_repository.h"
#include "controller/auth_controller.h"
#include "controller/chat_controller.h"
#include "controller/message_controller.h"
#include "controller/attachment_controller.h"
#include "controller/ws_controller.h"

static HttpServer* g_srv = nullptr;                 // для обработчика Ctrl+C
void onSigint(int) { if (g_srv) g_srv->stop(); }    // gracefully stop

int main(int argc, char** argv) {
    // Порт можно передать первым аргументом: ./messenger 3000
    int port = (argc > 1) ? atoi(argv[1]) : 3000;

    try {
        // ---------------- MODEL: база данных + репозитории ----------------
        Database db("messenger.db");            // создаст файл и применит схему
        UserRepository  users(db);
        ChatRepository  chats(db);
        MessageRepository messages(db);

        // ---------------- TRANSPORT: HTTP + WebSocket сервер ----------------
        HttpServer srv(port);
        srv.webRoot = "web";                    // папка фронтенда
        g_srv = &srv;
        signal(SIGINT, onSigint);

        // ---------------- CONTROLLER: регистрируют маршруты ----------------
        // Порядок важен только логически — каждый сам вызывает srv.route(...).
        AuthController        auth(srv, users);          // /api/register,/api/login,...
        ChatController        chatCtl(srv, db, users, chats, messages); // чаты/группы/каналы
        MessageController     msgCtl(srv, db, users, chats, messages);  // сообщения
        AttachmentController  attachCtl(srv, db, chats); // загрузка файлов
        WsController          ws(srv, users, chats, messages);          // live-события

        std::cout << "======================================================\n";
        std::cout << "  Мессенджер (клон Telegram) запущен\n";
        std::cout << "  Откройте в браузере:  http://localhost:" << port << "\n";
        std::cout << "  E2EE: сообщения шифруются в браузере (WebCrypto)\n";
        std::cout << "  Ctrl+C — остановка\n";
        std::cout << "======================================================\n";

        srv.start();   // блокирует до SIGINT
        std::cout << "[main] сервер остановлен. Пока!" << std::endl;
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "[FATAL] " << e.what() << std::endl;
        return 1;
    }
}
