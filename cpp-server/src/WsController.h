#pragma once
// WsController: WebSocket-сервер (RFC 6455) поверх того же TCP-порта, что и HTTP.
// Handshake проходит через HttpServer hook; дальше соединение обслуживает этот класс.
// Маршрутизация сообщений по чатам; вся работа с connections_/chat_rooms_ — под std::mutex.
#include "AuthController.h"
#include <string>
#include <map>
#include <set>
#include <vector>
#include <memory>
#include <mutex>
#include <thread>
#include <atomic>

class WsController {
public:
    explicit WsController(AuthController& auth);
    ~WsController();

    WsController(const WsController&) = delete;
    WsController& operator=(const WsController&) = delete;

    // Вызывается из accept-loop при обнаружении Upgrade: websocket в HTTP-запросе.
    // Забирает fd на себя (transfer of ownership), выполняет handshake и запускает reader-поток.
    // Возвращает false, если авторизация не прошла (fd будет закрыт).
    bool handleNewConnection(int fd, const http::Request& handshake_req);

    // Добавляет все активные соединения юзера в комнату чата (для событий, созданных после join).
    void joinChat(long long chat_id, long long user_id);

    void shutdown();
    size_t connectionCount();

private:
    struct Connection {
        int fd = -1;                                  // владеет дескриптором, закрывает в cleanup
        long long user_id = 0;
        bool is_bot = false;
        std::set<long long> chats;                    // комнаты, к которым подключён
        std::mutex write_mtx;                         // последовательная запись кадров в fd
        std::thread worker;                           // reader-поток (join в cleanup)
    };

    void sessionLoop(std::shared_ptr<Connection> conn);
    bool performHandshake(Connection& conn, const http::Request& req);
    bool readFrame(int fd, std::string& payload, bool& is_close, uint8_t& opcode);
    bool sendText(std::shared_ptr<Connection> conn, const std::string& text);
    void sendRaw(std::shared_ptr<Connection> conn, const std::string& bytes);
    void handleMessage(const std::shared_ptr<Connection>& conn, const std::string& text);
    void routeToChat(long long chat_id, const std::string& sender, const std::string& json_payload);
    void removeConnection(const std::shared_ptr<Connection>& conn);
    static std::string wsAcceptKey(const std::string& client_key);

    AuthController& auth_;
    std::mutex mtx_;                                   // защищает connections_ и chat_rooms_
    std::vector<std::shared_ptr<Connection>> connections_;
    std::map<long long, std::vector<std::weak_ptr<Connection>>> chat_rooms_;
    std::atomic<bool> running_{true};
};
