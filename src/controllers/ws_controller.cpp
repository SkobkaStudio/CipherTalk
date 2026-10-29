// ============================================================
// Реализация WebSocket-контроллера.
// Клиент подключается к ws://host:3000/ws?token=<JWT>.
// После handshake соединение держится в потоке-читателе:
// - входящие TEXT-кадры обрабатываются как команды (ping/pong);
// - сервер рассылает события через WsManager из других потоков.
// ============================================================
#include "controllers/ws_controller.hpp"
#include "services/auth_service.hpp"
#include "services/ws_service.hpp"
#include "utils/json.hpp"

#include <sys/socket.h>
#include <unistd.h>

#include <iostream>
#include <sstream>
#include <cstring>

namespace ws_controller {

// Разобрать query "token=..." и достать параметр token
static std::string getQueryParam(const std::string& query, const std::string& name) {
    std::istringstream ss(query);
    std::string pair;
    while (std::getline(ss, pair, '&')) {
        size_t eq = pair.find('=');
        if (eq != std::string::npos && pair.substr(0, eq) == name)
            return pair.substr(eq + 1);
    }
    return "";
}

void handleUpgrade(int clientFd, const HttpRequest& req) {
    // 1. Аутентификация по токену из query-строки
    std::string token = getQueryParam(req.query, "token");
    int64_t userId = 0;
    std::string username;
    if (token.empty() || !auth::verifyToken(token, userId, username)) {
        // Отказываем обычным HTTP-ответом 401
        const char* deny = "HTTP/1.1 401 Unauthorized\r\n"
                           "Content-Length: 0\r\nConnection: close\r\n\r\n";
        ::send(clientFd, deny, std::strlen(deny), MSG_NOSIGNAL);
        ::close(clientFd);
        return;
    }

    // 2. Формируем ответ handshake 101 Switching Protocols
    std::string key = req.header("sec-websocket-key");
    if (key.empty()) { ::close(clientFd); return; }
    std::string accept = wsComputeAccept(key);
    std::ostringstream resp;
    resp << "HTTP/1.1 101 Switching Protocols\r\n"
         << "Upgrade: websocket\r\n"
         << "Connection: Upgrade\r\n"
         << "Sec-WebSocket-Accept: " << accept << "\r\n\r\n";
    std::string raw = resp.str();
    if (::send(clientFd, raw.data(), raw.size(), MSG_NOSIGNAL) < 0) {
        ::close(clientFd);
        return;
    }

    // 3. Регистрируем соединение в менеджере
    WsManager::instance().addConnection(userId, clientFd);
    std::cout << "[ws] пользователь @" << username << " подключился (fd=" << clientFd << ")" << std::endl;

    // Приветственное событие
    json::JsonObject hello;
    hello.put("type", "hello");
    hello.put("userId", std::to_string(userId));
    wsSendText(clientFd, json::dump(hello));

    // 4. Цикл чтения кадров этого соединения
    std::string payload;
    uint8_t opcode = 0;
    while (wsReadFrame(clientFd, payload, opcode)) {
        if (opcode == 0x8) break;                 // close от клиента
        if (opcode == 0x9) {                      // ping -> pong
            // Кадры pong от сервера: FIN+opcode 0xA, пустая нагрузка
            std::string pong;
            pong += static_cast<char>(0x8A);
            pong += static_cast<char>(0x00);
            ::send(clientFd, pong.data(), pong.size(), MSG_NOSIGNAL);
            continue;
        }
        if (opcode == 0x1) {                      // текстовое сообщение
            json::JsonObject cmd;
            if (json::parse(payload, cmd)) {
                std::string type = cmd.get("type");
                if (type == "ping") {             // прикладной keepalive
                    wsSendText(clientFd, "{\"type\":\"pong\"}");
                }
                // Сообщения отправляются через REST /api/messages —
                // там они сохраняются в БД и рассылаются всем участникам.
            }
        }
    }

    // 5. Отключение — убираем fd из реестра и закрываем сокет
    WsManager::instance().removeConnection(clientFd);
    ::close(clientFd);
    std::cout << "[ws] пользователь @" << username << " отключился (fd=" << clientFd << ")" << std::endl;
}

} // namespace ws_controller
