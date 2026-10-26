#pragma once
// HTTP/1.1 сервер на POSIX-сокетах. Поточная модель: accept-loop + detached worker на соединение.
// WebSocket-запросы перехватываются ws_hook_ до диспетчеризации маршрутов.
#include "Http.h"
#include <functional>
#include <string>
#include <thread>
#include <atomic>

class HttpServer {
public:
    using WsHook = std::function<bool(int fd, const http::Request& handshake_req)>;

    HttpServer(http::Server& router, int port, std::string static_dir);
    ~HttpServer();

    void setWsHook(WsHook hook) { ws_hook_ = std::move(hook); }

    bool start();          // запускает accept-loop в отдельном потоке
    void stop();           // останавливает и ждёт завершения
    int port() const { return port_; }

private:
    void acceptLoop();
    void handleConnection(int fd);
    bool readHttpRequest(int fd, http::Request& req);
    void sendResponse(int fd, const http::Response& res);
    http::Response serveStatic(const std::string& path);

    http::Server& router_;
    int port_;
    std::string static_dir_;
    WsHook ws_hook_;
    int listen_fd_ = -1;
    std::atomic<bool> running_{false};
    std::thread accept_thread_;
};
