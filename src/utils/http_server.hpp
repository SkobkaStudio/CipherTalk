#pragma once
// ============================================================
// Минимальный HTTP-сервер на POSIX-сокетах.
// Поддерживает: разбор запроса, роутинг по методу+пути,
// отдачу статических файлов, апгрейд соединения на WebSocket.
// ============================================================
#include <string>
#include <map>
#include <functional>
#include <vector>

// Разобранный HTTP-запрос
struct HttpRequest {
    std::string method;                    // GET, POST, ...
    std::string path;                      // путь без query-строки
    std::string query;                     // query-строка (после ?)
    std::string body;                      // тело запроса
    std::map<std::string, std::string> headers; // заголовки (ключи в нижнем регистре)

    // Получить заголовок по имени (регистронезависимо)
    std::string header(const std::string& name) const;
};

// Формируемый HTTP-ответ
struct HttpResponse {
    int status = 200;                      // код состояния
    std::string contentType = "application/json";
    std::string body;                      // тело ответа
    std::map<std::string, std::string> extraHeaders; // доп. заголовки

    static HttpResponse json(int status, const std::string& body);
    static HttpResponse text(int status, const std::string& body);
    static HttpResponse html(const std::string& body);
};

// Обработчик API-маршрута
using RouteHandler = std::function<HttpResponse(const HttpRequest&)>;

// Обработчик WebSocket-апгрейда: получает fd сокета и запрос,
// сервер после возврата забирает соединение под себя.
using WsUpgradeHandler = std::function<void(int clientFd, const HttpRequest&)>;

class HttpServer {
public:
    HttpServer() = default;
    ~HttpServer();

    // Зарегистрировать обработчик для METHOD + путь
    void route(const std::string& method, const std::string& path, RouteHandler handler);

    // Зарегистрировать обработчик WebSocket-апгрейда для пути
    void wsRoute(const std::string& path, WsUpgradeHandler handler);

    // Запустить сервер на указанном порту (блокирует вызов)
    bool start(int port);

    // Остановить сервер
    void stop();

    // Отдать статический файл из корня webDir (возвращает false если не найден)
    static bool serveStatic(const std::string& webDir,
                            const std::string& urlPath,
                            HttpResponse& resp);

private:
    // Таблица маршрутов: ключ = "METHOD путь"
    std::map<std::string, RouteHandler> routes_;
    // Таблица WebSocket-маршрутов: путь -> обработчик
    std::map<std::string, WsUpgradeHandler> wsRoutes_;
    // listening socket
    int listenFd_ = -1;
    // флаг работы цикла
    bool running_ = false;

    // Обработать одно клиентское соединение
    void handleClient(int clientFd);

    // Разобрать raw-данные запроса
    static bool parseRequest(const std::string& raw, HttpRequest& req);

    // Отправить ответ клиенту
    static void sendResponse(int fd, const HttpResponse& resp);
};
