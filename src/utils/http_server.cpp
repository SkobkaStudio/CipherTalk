// ============================================================
// Реализация HTTP-сервера на POSIX-сокетах.
// Модель: один поток accept + по потоку на соединение (thread-per-connection).
// Для учебного проекта этого достаточно.
// ============================================================
#include "utils/http_server.hpp"

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>

#include <thread>
#include <fstream>
#include <sstream>
#include <iostream>
#include <algorithm>
#include <cctype>

// ---- Вспомогательные функции ----

// Получить заголовок из запроса (регистронезависимо)
std::string HttpRequest::header(const std::string& name) const {
    std::string lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    auto it = headers.find(lower);
    return it != headers.end() ? it->second : std::string();
}

// Статические конструкторы ответов
HttpResponse HttpResponse::json(int status, const std::string& body) {
    HttpResponse r; r.status = status; r.contentType = "application/json"; r.body = body;
    return r;
}
HttpResponse HttpResponse::text(int status, const std::string& body) {
    HttpResponse r; r.status = status; r.contentType = "text/plain; charset=utf-8"; r.body = body;
    return r;
}
HttpResponse HttpResponse::html(const std::string& body) {
    HttpResponse r; r.status = 200; r.contentType = "text/html; charset=utf-8"; r.body = body;
    return r;
}

// Определение MIME-типа по расширению файла
static std::string mimeForPath(const std::string& path) {
    auto dot = path.rfind('.');
    if (dot == std::string::npos) return "application/octet-stream";
    std::string ext = path.substr(dot + 1);
    std::transform(ext.begin(), ext.end(), ext.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    if (ext == "html") return "text/html; charset=utf-8";
    if (ext == "css")  return "text/css; charset=utf-8";
    if (ext == "js")   return "application/javascript; charset=utf-8";
    if (ext == "json") return "application/json";
    if (ext == "png")  return "image/png";
    if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
    if (ext == "svg")  return "image/svg+xml";
    if (ext == "ico")  return "image/x-icon";
    return "application/octet-stream";
}

// Текст причины для HTTP-статуса
static std::string statusText(int code) {
    switch (code) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 301: return "Moved Permanently";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 409: return "Conflict";
        case 500: return "Internal Server Error";
        default:  return "Unknown";
    }
}

// URL-декодирование (для query-параметров)
static std::string urlDecode(const std::string& s) {
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            int val = std::stoi(s.substr(i + 1, 2), nullptr, 16);
            out += static_cast<char>(val);
            i += 2;
        } else if (s[i] == '+') out += ' ';
        else out += s[i];
    }
    return out;
}

// Прочитать весь fd до конца заголовков (\r\n\r\n), затем тело по Content-Length.
// Возвращает false если соединение закрыто до завершения.
static bool recvRequest(int fd, std::string& raw) {
    char buf[8192];
    size_t headerEndPos = std::string::npos;
    // Читаем пока не найдём конец заголовков
    while (headerEndPos == std::string::npos) {
        ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) return false;
        raw.append(buf, static_cast<size_t>(n));
        headerEndPos = raw.find("\r\n\r\n");
        if (raw.size() > 1024 * 1024) return false; // защита от переполнения
    }
    // Разбираем Content-Length, чтобы дочитать тело
    std::string head = raw.substr(0, headerEndPos);
    size_t contentLength = 0;
    {
        std::string lower = head;
        std::transform(lower.begin(), lower.end(), lower.begin(),
                       [](unsigned char c) { return std::tolower(c); });
        size_t pos = lower.find("content-length:");
        if (pos != std::string::npos) {
            pos += 15;
            size_t end = lower.find("\r\n", pos);
            contentLength = std::stoul(head.substr(pos, end - pos));
        }
    }
    size_t have = raw.size() - (headerEndPos + 4);
    while (have < contentLength) {
        ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) return false;
        raw.append(buf, static_cast<size_t>(n));
        have += static_cast<size_t>(n);
    }
    return true;
}

// ---- HttpServer ----

HttpServer::~HttpServer() { stop(); }

void HttpServer::route(const std::string& method, const std::string& path, RouteHandler handler) {
    routes_[method + " " + path] = std::move(handler);
}

void HttpServer::wsRoute(const std::string& path, WsUpgradeHandler handler) {
    wsRoutes_[path] = std::move(handler);
}

bool HttpServer::start(int port) {
    // Игнорируем SIGPIPE — write() на закрытый сокет не должен убивать процесс
    signal(SIGPIPE, SIG_IGN);

    listenFd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listenFd_ < 0) { perror("socket"); return false; }

    // Позволяем быстро переиспользовать порт после рестарта
    int opt = 1;
    ::setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;      // слушаем все интерфейсы
    addr.sin_port = htons(static_cast<uint16_t>(port));

    if (::bind(listenFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        perror("bind");
        ::close(listenFd_);
        listenFd_ = -1;
        return false;
    }
    if (::listen(listenFd_, 128) < 0) {
        perror("listen");
        ::close(listenFd_);
        listenFd_ = -1;
        return false;
    }

    running_ = true;
    std::cout << "[server] CipherTalk запущен на http://localhost:" << port << std::endl;

    // Цикл принятия соединений
    while (running_) {
        sockaddr_in peer{};
        socklen_t peerLen = sizeof(peer);
        int clientFd = ::accept(listenFd_, reinterpret_cast<sockaddr*>(&peer), &peerLen);
        if (clientFd < 0) {
            if (!running_) break;
            continue;
        }
        // Каждый клиент — отдельный поток (detach, живёт сам)
        std::thread([this, clientFd]() { handleClient(clientFd); }).detach();
    }
    return true;
}

void HttpServer::stop() {
    running_ = false;
    if (listenFd_ >= 0) {
        ::shutdown(listenFd_, SHUT_RDWR);
        ::close(listenFd_);
        listenFd_ = -1;
    }
}

// Разбор raw HTTP-запроса в структуру
bool HttpServer::parseRequest(const std::string& raw, HttpRequest& req) {
    size_t headerEnd = raw.find("\r\n\r\n");
    std::string head = raw.substr(0, headerEnd);
    std::istringstream stream(head);
    std::string line;

    // Стартовая строка: METHOD PATH VERSION
    if (!std::getline(stream, line)) return false;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    {
        std::istringstream ls(line);
        std::string version;
        ls >> req.method >> req.path >> version;
    }
    if (req.method.empty() || req.path.empty()) return false;

    // Разделяем путь и query-строку
    size_t qpos = req.path.find('?');
    if (qpos != std::string::npos) {
        req.query = req.path.substr(qpos + 1);
        req.path = req.path.substr(0, qpos);
    }

    // Заголовки Key: Value
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) break;
        size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string key = line.substr(0, colon);
        std::transform(key.begin(), key.end(), key.begin(),
                       [](unsigned char c) { return std::tolower(c); });
        std::string value = line.substr(colon + 1);
        // Обрезаем ведущие пробелы
        size_t vs = value.find_first_not_of(' ');
        req.headers[key] = (vs == std::string::npos) ? "" : value.substr(vs);
    }

    // Тело запроса
    if (headerEnd != std::string::npos) req.body = raw.substr(headerEnd + 4);
    return true;
}

// Отправка HTTP-ответа
void HttpServer::sendResponse(int fd, const HttpResponse& resp) {
    std::ostringstream out;
    out << "HTTP/1.1 " << resp.status << " " << statusText(resp.status) << "\r\n";
    out << "Content-Type: " << resp.contentType << "\r\n";
    out << "Content-Length: " << resp.body.size() << "\r\n";
    out << "Connection: close\r\n";
    out << "Access-Control-Allow-Origin: *\r\n";
    for (const auto& h : resp.extraHeaders) {
        out << h.first << ": " << h.second << "\r\n";
    }
    out << "\r\n";
    std::string head = out.str();

    // Пишем заголовки и тело одним циклом с повторными попытками
    const char* data = head.c_str();
    size_t left = head.size();
    while (left > 0) {
        ssize_t w = ::write(fd, data, left);
        if (w <= 0) return;
        data += w; left -= static_cast<size_t>(w);
    }
    data = resp.body.c_str();
    left = resp.body.size();
    while (left > 0) {
        ssize_t w = ::write(fd, data, left);
        if (w <= 0) return;
        data += w; left -= static_cast<size_t>(w);
    }
}

// Отдача статического файла с защитой от directory traversal
bool HttpServer::serveStatic(const std::string& webDir,
                             const std::string& urlPath,
                             HttpResponse& resp) {
    std::string rel = urlDecode(urlPath);
    if (rel.empty() || rel == "/") rel = "/index.html";
    // Убираем попытки выхода за пределы каталога
    if (rel.find("..") != std::string::npos) return false;

    std::string fullPath = webDir + rel;
    std::ifstream file(fullPath, std::ios::binary);
    if (!file) return false;

    std::ostringstream ss;
    ss << file.rdbuf();
    resp.status = 200;
    resp.contentType = mimeForPath(fullPath);
    resp.body = ss.str();
    return true;
}

// Обработка одного соединения
void HttpServer::handleClient(int clientFd) {
    std::string raw;
    if (!recvRequest(clientFd, raw)) { ::close(clientFd); return; }

    HttpRequest req;
    if (!parseRequest(raw, req)) {
        HttpResponse r = HttpResponse::json(400, "{\"error\":\"bad request\"}");
        sendResponse(clientFd, r);
        ::close(clientFd);
        return;
    }

    // WebSocket-апгрейд: передаём соединение обработчику WS
    if (req.header("upgrade").find("websocket") != std::string::npos) {
        auto it = wsRoutes_.find(req.path);
        if (it != wsRoutes_.end()) {
            it->second(clientFd, req); // обработчик сам закроет fd
            return;
        }
        HttpResponse r = HttpResponse::json(404, "{\"error\":\"no ws route\"}");
        sendResponse(clientFd, r);
        ::close(clientFd);
        return;
    }

    // CORS preflight
    if (req.method == "OPTIONS") {
        HttpResponse r;
        r.status = 204;
        r.extraHeaders["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
        r.extraHeaders["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
        r.extraHeaders["Access-Control-Max-Age"] = "86400";
        sendResponse(clientFd, r);
        ::close(clientFd);
        return;
    }

    // Поиск API-маршрута
    auto it = routes_.find(req.method + " " + req.path);
    if (it != routes_.end()) {
        HttpResponse resp;
        try {
            resp = it->second(req);
        } catch (const std::exception& e) {
            resp = HttpResponse::json(500, std::string("{\"error\":\"") + e.what() + "\"}");
        }
        sendResponse(clientFd, resp);
        ::close(clientFd);
        return;
    }

    // Статика фронтенда (только GET)
    if (req.method == "GET") {
        extern std::string g_webDir; // задаётся в main.cpp
        HttpResponse resp;
        if (serveStatic(g_webDir, req.path, resp)) {
            sendResponse(clientFd, resp);
            ::close(clientFd);
            return;
        }
    }

    HttpResponse nf = HttpResponse::json(404, "{\"error\":\"not found\"}");
    sendResponse(clientFd, nf);
    ::close(clientFd);
}
