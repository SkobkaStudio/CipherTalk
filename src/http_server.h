#pragma once

#include <string>
#include <functional>
#include <map>
#include <vector>
#include <cstdint>

namespace cipher {

struct HttpRequest {
    std::string method;
    std::string path;
    std::string query;
    std::map<std::string, std::string> headers;
    std::string body;
};

struct HttpResponse {
    int status = 200;
    std::map<std::string, std::string> headers;
    std::string body;
    std::string contentType = "application/json";
};

using HttpHandler = std::function<void(const HttpRequest&, HttpResponse&)>;

class HttpServer {
public:
    HttpServer(uint16_t port);
    ~HttpServer();

    void get(const std::string& path, HttpHandler h);
    void post(const std::string& path, HttpHandler h);
    void put(const std::string& path, HttpHandler h);
    void del(const std::string& path, HttpHandler h);
    void route(const std::string& method, const std::string& path, HttpHandler h);
    /// Префиксный маршрут: handler вызывается, если path начинается с prefix.
    void prefix(const std::string& method, const std::string& prefix, HttpHandler h);

    // Для WebSocket upgrade: отдаёт слушающий сокет, чтобы WS-сервер мог принять соединение
    int listenFd() const { return listenFd_; }

    // Запустить цикл обработки HTTP (блокирующий)
    void run();

    // Обработать одно событие (для интеграции с внешним poll)
    void pollOnce(int timeoutMs = 1000);

    void stop() { running_ = false; }

    /// Установить обработчик WebSocket апгрейда. Сокет передаётся уже принятым
    /// и не закрывается HttpServer — вебсокет-сервер забирает управление.
    using WsUpgradeHandler = std::function<void(int clientFd, const HttpRequest& req)>;
    void setWebSocketUpgradeHandler(WsUpgradeHandler h) { wsUpgrade_ = h; }

private:
    uint16_t port_;
    int listenFd_ = -1;
    bool running_ = true;
    WsUpgradeHandler wsUpgrade_;

    std::map<std::string, HttpHandler> routes_; // ключ "METHOD path"
    std::vector<std::tuple<std::string, std::string, HttpHandler>> prefixRoutes_;

    void acceptConn();
    void handleClient(int clientFd);
    bool parseHttpRequest(int clientFd, HttpRequest& req);
    void dispatch(const HttpRequest& req, HttpResponse& res);
    void sendResponse(int clientFd, const HttpResponse& res);
    static std::string urlDecode(const std::string& s);
};

} // namespace cipher
