#pragma once
// HTTP-слой: Request/Response + микро-фреймворк (роутинг, статика, CORS) на POSIX сокетах.
// Многопоточная модель: accept-поток спавнит worker-поток на соединение;
// все worker-потоки обращаются к БД через Database (её внутренний mutex) и к Auth (её mutex).
#include <string>
#include <map>
#include <vector>
#include <functional>
#include <mutex>
#include <sstream>
#include <algorithm>
#include <cctype>

namespace http {

struct Request {
    std::string method;
    std::string path;                                   // декодированный путь без query
    std::string raw_target;                             // как прислал клиент
    std::string body;
    std::map<std::string, std::string> headers;         // имена в нижнем регистре
    std::map<std::string, std::string> query;           // ?a=b&c=d
    std::map<std::string, std::string> params;          // :param из шаблона маршрута

    std::string header(const std::string& name) const {
        std::string lower = name;
        std::transform(lower.begin(), lower.end(), lower.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        auto it = headers.find(lower);
        return it == headers.end() ? std::string() : it->second;
    }
    std::string qparam(const std::string& name) const {
        auto it = query.find(name);
        return it == query.end() ? std::string() : it->second;
    }
    std::string param(const std::string& name) const {
        auto it = params.find(name);
        return it == params.end() ? std::string() : it->second;
    }
};

struct Response {
    int status = 200;
    std::string body;
    std::map<std::string, std::string> headers;

    static Response json(int status, const std::string& json_body) {
        Response r;
        r.status = status;
        r.body = json_body;
        r.headers["Content-Type"] = "application/json; charset=utf-8";
        return r;
    }
    static Response error(int status, const std::string& message) {
        std::string escaped;
        for (char c : message) {
            if (c == '"' || c == '\\') { escaped += '\\'; escaped += c; }
            else if (c == '\n') escaped += "\\n";
            else if (static_cast<unsigned char>(c) < 0x20) { /* пропускаем управляющие */ }
            else escaped += c;
        }
        return json(status, "{\"error\":\"" + escaped + "\"}");
    }
    static Response text(int status, const std::string& text_body,
                         const std::string& content_type = "text/plain; charset=utf-8") {
        Response r;
        r.status = status;
        r.body = text_body;
        r.headers["Content-Type"] = content_type;
        return r;
    }
};

using Handler = std::function<Response(Request&)>;

class Server {
public:
    void route(const std::string& method, const std::string& pattern, Handler handler) {
        Route r;
        r.method = method;
        r.pattern = pattern;
        r.handler = std::move(handler);
        splitPath(pattern, r.segments);
        routes_.push_back(std::move(r));
    }
    void get(const std::string& p, Handler h)    { route("GET", p, std::move(h)); }
    void post(const std::string& p, Handler h)   { route("POST", p, std::move(h)); }
    void setStaticDir(const std::string& dir)    { static_dir_ = dir; }
    const std::string& staticDir() const         { return static_dir_; }

    // Разбор запроса. Возвращает false, если запрос некорректен.
    bool dispatch(Request& req, Response& res) const {
        for (const auto& route : routes_) {
            if (route.method != req.method) continue;
            std::map<std::string, std::string> params;
            if (match(route.segments, req.path, params)) {
                req.params = std::move(params);
                try {
                    res = route.handler(req);
                } catch (const std::exception&) {
                    // Обработка исключений не должна содержать текста исключения в ответе
                    // (защита от утечки internals), логируем только факт ошибки без секретов.
                    res = Response::error(500, "internal server error");
                }
                return true;
            }
        }
        return false;
    }

    bool hasRoutes() const { return !routes_.empty(); }

private:
    struct Route {
        std::string method;
        std::string pattern;
        std::vector<std::string> segments;
        Handler handler;
    };

    static void splitPath(const std::string& path, std::vector<std::string>& out) {
        size_t i = 0;
        while (i < path.size()) {
            size_t j = path.find('/', i);
            if (j == std::string::npos) j = path.size();
            if (j > i) out.push_back(path.substr(i, j - i));
            i = j + 1;
        }
    }

    static bool match(const std::vector<std::string>& pattern, const std::string& path,
                      std::map<std::string, std::string>& params) {
        std::vector<std::string> parts;
        splitPath(path, parts);
        if (parts.size() != pattern.size()) return false;
        for (size_t i = 0; i < pattern.size(); ++i) {
            const std::string& seg = pattern[i];
            if (!seg.empty() && seg[0] == ':') {
                params[seg.substr(1)] = parts[i];
            } else if (seg != parts[i]) {
                return false;
            }
        }
        return true;
    }

    std::vector<Route> routes_;
    std::string static_dir_;
};

// ---------- Утилиты URL ----------
inline std::string urlDecode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    auto hexVal = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            int hi = hexVal(s[i + 1]), lo = hexVal(s[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out += static_cast<char>((hi << 4) | lo);
                i += 2;
                continue;
            }
        }
        if (s[i] == '+') out += ' ';
        else out += s[i];
    }
    return out;
}

inline std::map<std::string, std::string> parseQuery(const std::string& query) {
    std::map<std::string, std::string> out;
    size_t pos = 0;
    while (pos < query.size()) {
        size_t amp = query.find('&', pos);
        if (amp == std::string::npos) amp = query.size();
        std::string pair = query.substr(pos, amp - pos);
        size_t eq = pair.find('=');
        if (eq != std::string::npos) {
            out[urlDecode(pair.substr(0, eq))] = urlDecode(pair.substr(eq + 1));
        } else if (!pair.empty()) {
            out[urlDecode(pair)] = "";
        }
        pos = amp + 1;
    }
    return out;
}

inline std::string toLower(const std::string& s) {
    std::string out = s;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

} // namespace http
