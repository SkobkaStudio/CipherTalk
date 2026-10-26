#include "HttpServer.h"
#include <sys/socket.h>
#include <sys/stat.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <signal.h>
#include <cstring>
#include <fstream>
#include <sstream>
#include <iostream>
#include <thread>
#include <algorithm>
#include <cctype>

namespace {
constexpr size_t kMaxHeadersBytes = 64 * 1024;
constexpr size_t kMaxBodyBytes = 1024 * 1024; // 1 MiB

const char* statusText(int code) {
    switch (code) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 409: return "Conflict";
        case 413: return "Payload Too Large";
        case 500: return "Internal Server Error";
        case 503: return "Service Unavailable";
        default:  return "Unknown";
    }
}

std::string mimeTypeFor(const std::string& path) {
    auto ends = [&](const char* ext) {
        size_t n = std::strlen(ext);
        return path.size() >= n && path.compare(path.size() - n, n, ext) == 0;
    };
    if (ends(".html") || ends(".htm")) return "text/html; charset=utf-8";
    if (ends(".js"))   return "application/javascript; charset=utf-8";
    if (ends(".css"))  return "text/css; charset=utf-8";
    if (ends(".json")) return "application/json; charset=utf-8";
    if (ends(".png"))  return "image/png";
    if (ends(".jpg") || ends(".jpeg")) return "image/jpeg";
    if (ends(".svg"))  return "image/svg+xml";
    if (ends(".ico"))  return "image/x-icon";
    if (ends(".wasm")) return "application/wasm";
    return "application/octet-stream";
}
} // namespace

HttpServer::HttpServer(http::Server& router, int port, std::string static_dir)
    : router_(router), port_(port), static_dir_(std::move(static_dir)) {}

HttpServer::~HttpServer() { stop(); }

bool HttpServer::start() {
    ::signal(SIGPIPE, SIG_IGN); // write-on-closed-socket не убивает процесс

    listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) { std::perror("socket"); return false; }

    int opt = 1;
    ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(static_cast<uint16_t>(port_));
    if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::perror("bind");
        ::close(listen_fd_);
        listen_fd_ = -1;
        return false;
    }
    if (::listen(listen_fd_, 128) < 0) {
        std::perror("listen");
        ::close(listen_fd_);
        listen_fd_ = -1;
        return false;
    }
    running_.store(true);
    accept_thread_ = std::thread([this] { acceptLoop(); });
    return true;
}

void HttpServer::stop() {
    if (!running_.exchange(false)) return;
    if (listen_fd_ >= 0) {
        ::shutdown(listen_fd_, SHUT_RDWR);
        ::close(listen_fd_);
        listen_fd_ = -1;
    }
    if (accept_thread_.joinable()) accept_thread_.join();
}

void HttpServer::acceptLoop() {
    while (running_.load()) {
        int fd = ::accept(listen_fd_, nullptr, nullptr);
        if (fd < 0) {
            if (!running_.load()) break;
            continue;
        }
        // Worker на соединение в detached-потоке (соединение живёт свою жизнь и само себя убирает).
        std::thread([this, fd] { handleConnection(fd); }).detach();
    }
}

bool HttpServer::readHttpRequest(int fd, http::Request& req) {
    std::string data;
    char buf[4096];
    size_t header_end = std::string::npos;

    // 1. читаем заголовки
    while (header_end == std::string::npos) {
        if (data.size() > kMaxHeadersBytes) return false;
        ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) return false;
        data.append(buf, static_cast<size_t>(n));
        header_end = data.find("\r\n\r\n");
    }

    std::string head = data.substr(0, header_end);
    std::string body = data.substr(header_end + 4);

    // 2. request line
    size_t line_end = head.find("\r\n");
    std::string request_line = head.substr(0, line_end);
    {
        size_t sp1 = request_line.find(' ');
        size_t sp2 = request_line.rfind(' ');
        if (sp1 == std::string::npos || sp2 == std::string::npos || sp2 <= sp1) return false;
        req.method = request_line.substr(0, sp1);
        req.raw_target = request_line.substr(sp1 + 1, sp2 - sp1 - 1);
    }

    // 3. headers
    size_t pos = line_end + 2;
    while (pos < head.size()) {
        size_t eol = head.find("\r\n", pos);
        if (eol == std::string::npos) eol = head.size();
        std::string line = head.substr(pos, eol - pos);
        pos = eol + 2;
        size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string name = http::toLower(line.substr(0, colon));
        std::string value = line.substr(colon + 1);
        size_t vstart = value.find_first_not_of(" \t");
        req.headers[name] = (vstart == std::string::npos) ? std::string() : value.substr(vstart);
    }

    // 4. path/query
    std::string target = req.raw_target;
    size_t qmark = target.find('?');
    if (qmark != std::string::npos) {
        req.query = http::parseQuery(target.substr(qmark + 1));
        target = target.substr(0, qmark);
    }
    req.path = http::urlDecode(target);
    if (req.path.empty() || req.path[0] != '/' || req.path.find("..") != std::string::npos)
        return false;

    // 5. тело по content-length (дочитываем недостающее)
    size_t content_length = 0;
    std::string cl = req.header("Content-Length");
    if (!cl.empty()) {
        try { content_length = std::stoul(cl); }
        catch (...) { return false; }
        if (content_length > kMaxBodyBytes) return false;
    }
    while (body.size() < content_length) {
        ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) return false;
        body.append(buf, static_cast<size_t>(n));
        if (body.size() > kMaxBodyBytes) return false;
    }
    req.body = body.substr(0, content_length);
    return true;
}

void HttpServer::sendResponse(int fd, const http::Response& res) {
    std::ostringstream os;
    os << "HTTP/1.1 " << res.status << " " << statusText(res.status) << "\r\n";
    os << "Content-Length: " << res.body.size() << "\r\n";
    bool has_ct = false;
    for (const auto& h : res.headers) {
        os << h.first << ": " << h.second << "\r\n";
        if (http::toLower(h.first) == "content-type") has_ct = true;
    }
    if (!has_ct) os << "Content-Type: text/plain; charset=utf-8\r\n";
    // CORS для API-клиентов (браузерные тесты)
    os << "Access-Control-Allow-Origin: *\r\n";
    os << "Access-Control-Allow-Headers: Authorization, Content-Type\r\n";
    os << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
    os << "Connection: close\r\n";
    os << "\r\n";
    std::string head = os.str();

    std::string out;
    out.reserve(head.size() + res.body.size());
    out += head;
    out += res.body;

    size_t done = 0;
    while (done < out.size()) {
        ssize_t n = ::send(fd, out.data() + done, out.size() - done, MSG_NOSIGNAL);
        if (n <= 0) break;
        done += static_cast<size_t>(n);
    }
}

http::Response HttpServer::serveStatic(const std::string& path) {
    if (static_dir_.empty()) return http::Response::error(404, "not found");
    std::string rel = path == "/" ? "/index.html" : path;
    std::string full = static_dir_ + rel;
    std::ifstream f(full, std::ios::binary);
    if (!f) return http::Response::error(404, "not found");
    std::ostringstream ss;
    ss << f.rdbuf();
    return http::Response::text(200, ss.str(), mimeTypeFor(rel));
}

void HttpServer::handleConnection(int fd) {
    http::Request req;
    if (!readHttpRequest(fd, req)) { ::close(fd); return; }

    // WebSocket upgrade перехватывается до роутера (шаг 3 — авторизация внутри хука).
    std::string upgrade = http::toLower(req.header("Upgrade"));
    if (upgrade == "websocket") {
        if (ws_hook_ && ws_hook_(fd, req)) {
            // хук забрал fd себе; ничего не делаем
            return;
        }
        ::close(fd);
        return;
    }

    if (req.method == "OPTIONS") {
        http::Response res;
        res.status = 204;
        sendResponse(fd, res);
        ::close(fd);
        return;
    }

    http::Response res;
    if (!router_.dispatch(req, res)) {
        if (req.path.rfind("/api/", 0) == 0) {
            res = http::Response::error(404, "not found");
        } else if (req.method == "GET" || req.method == "HEAD") {
            res = serveStatic(req.path);
        } else {
            res = http::Response::error(404, "not found");
        }
    }
    sendResponse(fd, res);
    ::close(fd);
}
