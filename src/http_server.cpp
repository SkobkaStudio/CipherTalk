#include "http_server.h"
#include "utils.h"
#include <cstring>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sstream>
#include <iostream>

namespace cipher {

HttpServer* HttpServer::instance_ = nullptr;

static void setNonBlocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return;
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

HttpServer::HttpServer(uint16_t port) : port_(port) {
    listenFd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (listenFd_ < 0) { perror("socket"); return; }
    int opt = 1;
    setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    setNonBlocking(listenFd_);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port_);
    if (bind(listenFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) { perror("bind"); return; }
    if (listen(listenFd_, 128) < 0) { perror("listen"); return; }

    // Self-pipe для моментального выхода по сигналу
    if (pipe(signalPipe_) == 0) {
        setNonBlocking(signalPipe_[0]);
        setNonBlocking(signalPipe_[1]);
    }

    instance_ = this;
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
}

HttpServer::~HttpServer() {
    if (listenFd_ >= 0) close(listenFd_);
    if (signalPipe_[0] >= 0) close(signalPipe_[0]);
    if (signalPipe_[1] >= 0) close(signalPipe_[1]);
}

void HttpServer::signalHandler(int sig) {
    (void)sig;
    if (instance_ && instance_->signalPipe_[1] >= 0) {
        char x = 1;
        // write в pipe из сигнального обработчика — async-signal-safe
        ::write(instance_->signalPipe_[1], &x, 1);
    }
}

void HttpServer::route(const std::string& method, const std::string& path, HttpHandler h) {
    routes_[method + " " + path] = h;
}
void HttpServer::get(const std::string& path, HttpHandler h)   { route("GET", path, h); }
void HttpServer::post(const std::string& path, HttpHandler h)  { route("POST", path, h); }
void HttpServer::put(const std::string& path, HttpHandler h)   { route("PUT", path, h); }
void HttpServer::del(const std::string& path, HttpHandler h)   { route("DELETE", path, h); }

void HttpServer::prefix(const std::string& method, const std::string& prefix, HttpHandler h) {
    prefixRoutes_.emplace_back(method, prefix, h);
}

std::string HttpServer::urlDecode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            char hex[3] = { s[i+1], s[i+2], 0 };
            out.push_back(static_cast<char>(strtol(hex, nullptr, 16)));
            i += 2;
        } else if (s[i] == '+') {
            out.push_back(' ');
        } else {
            out.push_back(s[i]);
        }
    }
    return out;
}

bool HttpServer::parseHttpRequest(int clientFd, HttpRequest& req) {
    std::string buf;
    char tmp[4096];
    while (true) {
        ssize_t n = recv(clientFd, tmp, sizeof(tmp), 0);
        if (n <= 0) return false;
        buf.append(tmp, n);
        if (buf.find("\r\n\r\n") != std::string::npos) break;
        if (buf.size() > 1024 * 1024) return false;
    }

    size_t headerEnd = buf.find("\r\n\r\n");
    std::string headerPart = buf.substr(0, headerEnd);
    std::string rest = buf.substr(headerEnd + 4);

    size_t firstLineEnd = headerPart.find("\r\n");
    std::string firstLine = headerPart.substr(0, firstLineEnd);
    std::istringstream fls(firstLine);
    fls >> req.method >> req.path;
    size_t q = req.path.find('?');
    if (q != std::string::npos) {
        req.query = req.path.substr(q + 1);
        req.path = req.path.substr(0, q);
    }

    size_t pos = firstLineEnd + 2;
    while (pos < headerPart.size()) {
        size_t lineEnd = headerPart.find("\r\n", pos);
        if (lineEnd == std::string::npos) break;
        std::string line = headerPart.substr(pos, lineEnd - pos);
        pos = lineEnd + 2;
        size_t colon = line.find(':');
        if (colon != std::string::npos) {
            std::string key = line.substr(0, colon);
            std::string val = line.substr(colon + 1);
            while (!val.empty() && val[0] == ' ') val.erase(0, 1);
            req.headers[key] = val;
        }
    }

    int64_t contentLength = 0;
    auto it = req.headers.find("Content-Length");
    if (it != req.headers.end()) contentLength = std::stoll(it->second);

    req.body = rest;
    while ((int64_t)req.body.size() < contentLength) {
        ssize_t n = recv(clientFd, tmp, sizeof(tmp), 0);
        if (n <= 0) break;
        req.body.append(tmp, n);
    }
    return true;
}

void HttpServer::dispatch(const HttpRequest& req, HttpResponse& res) {
    auto it = routes_.find(req.method + " " + req.path);
    if (it != routes_.end()) {
        it->second(req, res);
        return;
    }
    for (auto& [m, prefix, h] : prefixRoutes_) {
        if (m == req.method && utils::startsWith(req.path, prefix)) {
            HttpRequest r = req;
            r.path = req.path.substr(prefix.size());
            h(r, res);
            return;
        }
    }
    res.status = 404;
    res.body = "{\"error\":\"Not found\"}";
}

void HttpServer::sendResponse(int clientFd, const HttpResponse& res) {
    std::ostringstream oss;
    oss << "HTTP/1.1 " << res.status << " OK\r\n";
    oss << "Content-Type: " << res.contentType << "\r\n";
    oss << "Access-Control-Allow-Origin: *\r\n";
    oss << "Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Authorization\r\n";
    oss << "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n";
    oss << "Access-Control-Allow-Credentials: true\r\n";
    oss << "Connection: close\r\n";
    oss << "Content-Length: " << res.body.size() << "\r\n";
    for (auto& [k, v] : res.headers) oss << k << ": " << v << "\r\n";
    oss << "\r\n";
    oss << res.body;
    std::string msg = oss.str();
    send(clientFd, msg.data(), msg.size(), 0);
}

void HttpServer::acceptConn() {
    sockaddr_in caddr{};
    socklen_t clen = sizeof(caddr);
    int fd = accept(listenFd_, reinterpret_cast<sockaddr*>(&caddr), &clen);
    if (fd < 0) return;
    setNonBlocking(fd);
    handleClient(fd);
}

void HttpServer::handleClient(int clientFd) {
    HttpRequest req;
    if (!parseHttpRequest(clientFd, req)) {
        close(clientFd);
        return;
    }

    if (req.method == "OPTIONS") {
        HttpResponse res;
        res.status = 204;
        res.body = "";
        sendResponse(clientFd, res);
        close(clientFd);
        return;
    }

    auto upg = req.headers.find("Upgrade");
    if (upg != req.headers.end() && upg->second == "websocket" && wsUpgrade_) {
        wsUpgrade_(clientFd, req);
        return;
    }

    HttpResponse res;
    dispatch(req, res);
    sendResponse(clientFd, res);
    close(clientFd);
}

void HttpServer::pollOnce(int timeoutMs) {
    struct pollfd pfd[2];
    int nfds = 1;
    pfd[0].fd = listenFd_;
    pfd[0].events = POLLIN;
    pfd[0].revents = 0;

    if (signalPipe_[0] >= 0) {
        pfd[1].fd = signalPipe_[0];
        pfd[1].events = POLLIN;
        pfd[1].revents = 0;
        nfds = 2;
    }

    int rc = poll(pfd, nfds, timeoutMs);
    if (rc <= 0) return;

    // Сигнал через self-pipe -> немедленно останавливаемся
    if (signalPipe_[0] >= 0 && (pfd[1].revents & POLLIN)) {
        char buf[16];
        while (read(signalPipe_[0], buf, sizeof(buf)) > 0) {}
        running_ = false;
        return;
    }

    if (pfd[0].revents & POLLIN) {
        acceptConn();
    }
}

void HttpServer::run() {
    while (running_) pollOnce(100);
}

} // namespace cipher
