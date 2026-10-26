// =============================================================================
//  utils/http_server.h — мини HTTP + WebSocket сервер «с нуля» на POSIX сокетах
// =============================================================================
//  Это ТРАНСПОРТНЫЙ слой MVC. Он ничего не знает о чатах и пользователях —
//  контроллеры лишь регистрируют сюда маршруты.
//
//  Возможности:
//    * GET/POST/PUT/DELETE c разбором заголовков, query-параметров и JSON-тела;
//    * сессии через cookie sid (токены генерирует контроллер AuthController);
//    * отдача статики из папки web/ (index.html, css, js) с Content-Type;
//    * WebSocket (RFC 6455): handshake по заголовку Upgrade, кадры text/bin,
//      ping/pong, маскирование от клиента, широковещательные рассылки.
//
//  Модель потоков: 1 поток-acceptор + пул потоков обработчиков соединений.
//  Все блокирующие read() идут в сокеты, которые мы держим открытыми до
//  закрытия клиентом (WebSocket живёт в своём потоке).
// =============================================================================
#pragma once
#include <string>
#include <vector>
#include <map>
#include <functional>
#include <thread>
#include <mutex>
#include <atomic>
#include <cstring>
#include <sstream>
#include <iostream>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <poll.h>

#include <algorithm>
#include "json.h"
#include "encoding.h"
#include "crypto.h"

// ------------------------------- запрос/ответ --------------------------------
struct HttpRequest {
    std::string method;                       // "GET", "POST"...
    std::string path;                         // "/api/chats" без query
    std::string query;                        // "chat_id=5&limit=20"
    std::map<std::string,std::string> params; // разобранный query
    std::map<std::string,std::string> headers;// заголовки (ключи в нижнем регистре)
    std::map<std::string,std::string> cookies;// cookie "sid=..." и т.п.
    std::string body;                         // сырое тело запроса
    long long userId = 0;                     // заполняет сервер, если cookie sid валиден

    const std::string& param(const std::string& k, const std::string& def="") const {
        auto it = params.find(k); return it==params.end()?def:it->second;
    }
    Json json() const { return body.empty() ? Json::object() : Json::parse(body); }
};

struct HttpResponse {
    int status = 200;
    std::string statusText = "OK";
    std::string contentType = "application/json; charset=utf-8";
    std::string body;
    std::vector<std::string> extraHeaders;    // например Set-Cookie

    static HttpResponse json(const Json& j, int status=200){
        HttpResponse r; r.status=status; r.body=j.dump(); return r;
    }
    static HttpResponse error(const std::string& msg, int status=400){
        Json j = Json::object(); j["error"]=msg; j["status"]=status;
        return json(j,status);
    }
    static HttpResponse text(const std::string& s, int status=200){
        HttpResponse r; r.status=status; r.contentType="text/plain; charset=utf-8"; r.body=s; return r;
    }
};

// ------------------------------- WebSocket клиент -----------------------------
// Один подключённый браузер. Отправка сообщений потокобезопасна (мьютекс на сокет).
struct WsClient {
    int fd = -1;                              // файловый дескриптор сокета
    long long userId = 0;                     // кто авторизован под этим соединением
    std::mutex sendMtx;                       // защита от «перемешивания» кадров

    // Отправить JSON-текст клиенту (opcode 0x1, без маскирования — так делает сервер)
    bool sendText(const std::string& payload) {
        std::lock_guard<std::mutex> lk(sendMtx);
        if (fd < 0) return false;
        unsigned char hdr[10]; size_t hlen = 2;
        hdr[0] = 0x81; // FIN + opcode text
        size_t n = payload.size();
        if (n < 126) { hdr[1] = (unsigned char)n; }
        else if (n <= 0xFFFF) { hdr[1]=126; hdr[2]=(n>>8)&0xFF; hdr[3]=n&0xFF; hlen=4; }
        else { hdr[1]=127; for(int i=0;i<8;i++) hdr[2+i]=(n>>(56-8*i))&0xFF; hlen=10; }
        if (::send(fd, hdr, hlen, MSG_NOSIGNAL) < 0) return false;
        size_t off = 0;
        while (off < n) {
            ssize_t w = ::send(fd, payload.data()+off, n-off, MSG_NOSIGNAL);
            if (w <= 0) return false;
            off += (size_t)w;
        }
        return true;
    }
    void close() { if (fd>=0){ ::shutdown(fd,SHUT_RDWR); ::close(fd); fd=-1; } }
};

class HttpServer {
public:
    using Handler = std::function<HttpResponse(HttpRequest&)>;

    // ---------- регистрация REST-маршрутов (вызывается контроллерами) --------
    // Пример: srv.route("GET", "/api/me", [&](HttpRequest& rq){ ... });
    void route(const std::string& method, const std::string& pathPattern, Handler h) {
        routes_.push_back({method, pathPattern, h});
    }

    // Отдача файла по префиксу URL (/files/...): возвращает true, если маршрут обработан.
    bool routePrefix(const std::string& method, const std::string& prefix, Handler h) {
        prefixRoutes_.push_back({method, prefix, h});
        return true;
    }
    // ---------- колбэки жизненного цикла WebSocket (задаёт WsController) -----
    std::function<void(WsClient*)> onWsOpen;    // соединение установлено+авторизовано
    std::function<void(WsClient*, const std::string&)> onWsMessage; // пришёл текст
    std::function<void(WsClient*)> onWsClose;   // соединение закрылось

    // Папка со статикой (фронтендом) и карта cookie-сессий token->userId
    std::string webRoot = "web";
    std::map<std::string,long long> sessions;    // sid -> user_id
    std::mutex sessionsMtx;

    explicit HttpServer(int port) : port_(port) {}

    // ============================== ЗАПУСК ===================================
    void start() {
        int srv = ::socket(AF_INET, SOCK_STREAM, 0);
        if (srv < 0) { perror("socket"); exit(1); }
        int opt = 1;
        setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof opt); // чтобы порт 3000 можно было сразу пересоздать

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;      // слушаем 0.0.0.0:3000
        addr.sin_port = htons((uint16_t)port_);
        if (::bind(srv, (sockaddr*)&addr, sizeof addr) < 0) { perror("bind"); exit(1); }
        if (::listen(srv, 64) < 0) { perror("listen"); exit(1); }
        running_ = true;
        std::cout << "[HTTP] сервер слушает порт " << port_ << std::endl;

        while (running_) {
            int fd = ::accept(srv, nullptr, nullptr);
            if (fd < 0) { if (!running_) break; continue; }
            std::thread([this, fd]{ this->connectionLoop(fd); }).detach(); // пул «по соединению»
        }
        ::close(srv);
    }
    void stop(){ running_=false; }

    // ---------- работа с реестром WebSocket-клиентов (для рассылок) ----------
    void wsAdd(WsClient* c){ std::lock_guard<std::mutex> lk(wsMtx_); wsClients_.push_back(c); }
    void wsRemove(WsClient* c){
        std::lock_guard<std::mutex> lk(wsMtx_);
        wsClients_.erase(std::remove(wsClients_.begin(),wsClients_.end(),c), wsClients_.end());
    }
    // Отправить JSON всем соединениям конкретного пользователя (у него может быть
    // несколько вкладок/устройств одновременно — как «облачная синхронизация» TG)
    void sendToUser(long long userId, const Json& event) {
        std::string payload = event.dump();
        std::lock_guard<std::mutex> lk(wsMtx_);
        for (auto* c : wsClients_) if (c->userId == userId) c->sendText(payload);
    }
    // Отправить JSON списку пользователей одним сообщением
    void sendToUsers(const std::vector<long long>& userIds, const Json& event) {
        std::string payload = event.dump();
        std::lock_guard<std::mutex> lk(wsMtx_);
        for (auto* c : wsClients_) {
            for (long long u : userIds) if (c->userId == u) { c->sendText(payload); break; }
        }
    }
    // Кто сейчас онлайн (для статусов «в сети», как зелёная точка в TG)
    std::vector<long long> onlineUsers() {
        std::lock_guard<std::mutex> lk(wsMtx_);
        std::vector<long long> out;
        for (auto* c : wsClients_) if (std::find(out.begin(),out.end(),c->userId)==out.end()) out.push_back(c->userId);
        return out;
    }

private:
    struct Route { std::string method, path; Handler handler; };
    int port_;
    std::atomic<bool> running_{false};
    std::vector<Route> routes_;
    std::vector<Route> prefixRoutes_;   // маршруты-префиксы (например /files/...)
    std::vector<WsClient*> wsClients_;
    std::mutex wsMtx_;

    // ------------------- обработка одного TCP-соединения ---------------------
    void connectionLoop(int fd) {
        // Буферизуем входящие байты: браузер может прислать заголовки частями
        std::string buf;
        if (!readUntilHeadersEnd(fd, buf)) { ::close(fd); return; }

        // Разбираем запрос HTTP/1.1
        HttpRequest req;
        if (!parseRequest(buf, req, fd)) { ::close(fd); return; }

        // Авторизация по cookie sid (если токен есть в реестре сессий)
        {
            std::lock_guard<std::mutex> lk(sessionsMtx);
            auto it = sessions.find(req.cookies.count("sid") ? req.cookies["sid"] : "");
            if (it != sessions.end()) req.userId = it->second;
        }

        // --- это WebSocket upgrade? Тогда переходим в режим WS в этом же потоке
        if (enc::toLower(req.headers["upgrade"]) == "websocket") {
            handleWebSocket(fd, req);
            return; // сокет закроет handleWebSocket
        }

        // --- обычный HTTP: маршрут / статика / 404
        HttpResponse res = dispatch(req, fd);
        writeResponse(fd, res);
        ::close(fd);
    }

    HttpResponse dispatch(HttpRequest& req, int fd) {
        try {
            for (auto& r : routes_) {
                if (r.method == req.method && r.path == req.path) return r.handler(req);
            }
            // маршруты-префиксы: /files/<ключ>/<имя> обрабатываются одним обработчиком
            for (auto& r : prefixRoutes_) {
                if (r.method == req.method && enc::startsWith(req.path, r.path)) return r.handler(req);
            }
            if (req.method == "OPTIONS") { // CORS preflight (на случай внешнего фронта)
                HttpResponse res; res.status=204;
                res.extraHeaders.push_back("Access-Control-Allow-Origin: *");
                res.extraHeaders.push_back("Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS");
                res.extraHeaders.push_back("Access-Control-Allow-Headers: Content-Type");
                return res;
            }
            if (req.method == "GET") {          // статика фронтенда из web/
                HttpResponse fileRes;
                if (serveStatic(req.path, fileRes)) return fileRes;
            }
            return HttpResponse::error("not found", 404);
        } catch (const std::exception& e) {
            std::cerr << "[HTTP] исключение в обработчике " << req.path << ": " << e.what() << std::endl;
            return HttpResponse::error(e.what(), 500);
        }
    }

    // ------------------------- чтение заголовков ------------------------------
    bool readUntilHeadersEnd(int fd, std::string& buf) {
        char tmp[8192];
        while (buf.find("\r\n\r\n") == std::string::npos) {
            ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
            if (n <= 0) return false;
            buf.append(tmp, n);
            if (buf.size() > 32*1024*1024) return false; // защита от переполнения
        }
        return true;
    }

    bool parseRequest(std::string& buf, HttpRequest& req, int fd) {
        size_t he = buf.find("\r\n\r\n");
        std::string headPart = buf.substr(0, he);
        std::string rest     = buf.substr(he+4);

        std::istringstream hs(headPart);
        std::string line;
        if (!std::getline(hs, line)) return false;
        if (!line.empty() && line.back()=='\r') line.pop_back();
        {   // первая строка: "POST /api/login?x=1 HTTP/1.1"
            std::istringstream ls(line);
            std::string url, proto;
            ls >> req.method >> url >> proto;
            size_t q = url.find('?');
            if (q == std::string::npos) req.path = enc::urlDecode(url);
            else { req.path = enc::urlDecode(url.substr(0,q)); req.query = url.substr(q+1); }
            // разбираем query-параметры key=value&key2=value2
            size_t pos = 0;
            while (pos < req.query.size()) {
                size_t amp = req.query.find('&', pos);
                std::string kv = req.query.substr(pos, amp==std::string::npos?std::string::npos:amp-pos);
                size_t eq = kv.find('=');
                if (eq != std::string::npos)
                    req.params[enc::urlDecode(kv.substr(0,eq))] = enc::urlDecode(kv.substr(eq+1));
                pos = (amp==std::string::npos)?req.query.size():amp+1;
            }
        }
        // заголовки
        while (std::getline(hs, line)) {
            if (!line.empty() && line.back()=='\r') line.pop_back();
            size_t colon = line.find(':');
            if (colon == std::string::npos) continue;
            std::string k = enc::toLower(enc::trim(line.substr(0,colon)));
            std::string v = enc::trim(line.substr(colon+1));
            req.headers[k] = v;
        }
        // cookie: "sid=abc; theme=dark"
        auto ck = req.headers.find("cookie");
        if (ck != req.headers.end()) {
            size_t pos = 0;
            while (pos < ck->second.size()) {
                size_t sc = ck->second.find(';', pos);
                std::string kv = ck->second.substr(pos, sc==std::string::npos?std::string::npos:sc-pos);
                size_t eq = kv.find('=');
                if (eq != std::string::npos)
                    req.cookies[enc::trim(kv.substr(0,eq))] = enc::trim(kv.substr(eq+1));
                pos = (sc==std::string::npos)?ck->second.size():sc+1;
            }
        }
        // дочитать тело по Content-Length
        size_t contentLength = (size_t)atof(req.headers["content-length"].c_str());
        req.body = rest;
        char tmp[16384];
        while (req.body.size() < contentLength) {
            ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
            if (n <= 0) break;
            req.body.append(tmp, n);
        }
        return true;
    }

    // ------------------------- отправка HTTP-ответа ---------------------------
    void writeResponse(int fd, HttpResponse& res) {
        std::ostringstream o;
        o << "HTTP/1.1 " << res.status << " " << statusText(res.status) << "\r\n";
        o << "Content-Type: " << res.contentType << "\r\n";
        o << "Content-Length: " << res.body.size() << "\r\n";
        o << "Connection: close\r\n";
        o << "Cache-Control: no-store\r\n";
        for (auto& h : res.extraHeaders) o << h << "\r\n";
        o << "\r\n";
        std::string head = o.str();
        ::send(fd, head.data(), head.size(), MSG_NOSIGNAL);
        if (!res.body.empty()) ::send(fd, res.body.data(), res.body.size(), MSG_NOSIGNAL);
    }
    static std::string statusText(int code) {
        switch (code) {
            case 200: return "OK"; case 201: return "Created"; case 204: return "No Content";
            case 400: return "Bad Request"; case 401: return "Unauthorized"; case 403: return "Forbidden";
            case 404: return "Not Found"; case 409: return "Conflict"; default: return "Error";
        }
    }

    // --------------------------- статические файлы ----------------------------
    bool serveStatic(const std::string& path, HttpResponse& res) {
        std::string rel = (path=="/"||path.empty()) ? "/index.html" : path;
        // защита от "../": вырезаем любые фрагменты с ".."
        if (rel.find("..") != std::string::npos) return false;
        std::string full = webRoot + rel;
        FILE* f = fopen(full.c_str(), "rb");
        if (!f) return false;
        std::string data;
        char buf[65536]; size_t n;
        while ((n = fread(buf,1,sizeof buf,f))>0) data.append(buf,n);
        fclose(f);
        res.status=200; res.body=std::move(data); res.contentType = mimeFor(rel);
        return true;
    }
    static std::string mimeFor(const std::string& p) {
        auto ends=[&](const char* e){ return p.size()>=strlen(e)&&p.compare(p.size()-strlen(e),strlen(e),e)==0; };
        if (ends(".html")) return "text/html; charset=utf-8";
        if (ends(".css"))  return "text/css; charset=utf-8";
        if (ends(".js"))   return "application/javascript; charset=utf-8";
        if (ends(".json")) return "application/json";
        if (ends(".png"))  return "image/png";
        if (ends(".jpg")||ends(".jpeg")) return "image/jpeg";
        if (ends(".gif"))  return "image/gif";
        if (ends(".svg"))  return "image/svg+xml";
        if (ends(".ico"))  return "image/x-icon";
        if (ends(".woff2"))return "font/woff2";
        return "application/octet-stream";
    }

    // ============================ WEBSOCKET (RFC 6455) ========================
    void handleWebSocket(int fd, HttpRequest& req) {
        // 1) Handshake: Sec-WebSocket-Accept = base64(SHA1(key + magic GUID))
        std::string key = req.headers["sec-websocket-key"];
        std::string accept = wsAcceptKey(key);
        std::string resp =
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        if (::send(fd, resp.data(), resp.size(), MSG_NOSIGNAL) < 0) { ::close(fd); return; }

        // 2) Создаём объект клиента; userId уже известен из cookie sid
        WsClient* client = new WsClient();
        client->fd = fd;
        client->userId = req.userId;
        wsAdd(client);
        if (onWsOpen) onWsOpen(client);

        // 3) Цикл чтения кадров пока соединение живо
        std::string payloadAccum; uint8_t accumOpcode = 0;
        while (true) {
            uint8_t b0,b1;
            if (!recvExact(fd,&b0,1)) break;
            if (!recvExact(fd,&b1,1)) break;
            bool fin = b0 & 0x80;
            uint8_t opcode = b0 & 0x0F;
            bool masked = b1 & 0x80;
            uint64_t len = b1 & 0x7F;
            if (len == 126) { uint8_t ext[2]; if(!recvExact(fd,ext,2))break; len=(ext[0]<<8)|ext[1]; }
            else if (len == 127) { uint8_t ext[8]; if(!recvExact(fd,ext,8))break; len=0; for(int i=0;i<8;i++)len=(len<<8)|ext[i]; }
            if (len > 32*1024*1024) break; // слишком большое кадр — обрываем
            uint8_t maskKey[4] = {0,0,0,0};
            if (masked && !recvExact(fd,maskKey,4)) break;
            std::string payload(len, '\0');
            if (len && !recvExact(fd,&payload[0],(size_t)len)) break;
            if (masked) for (uint64_t i=0;i<len;i++) payload[i]^=maskKey[i%4]; // клиенты обязаны маскировать

            switch (opcode) {
                case 0x0: // continuation — дописываем в накопитель
                    payloadAccum += payload;
                    if (fin) { fireMessage(client,payloadAccum); payloadAccum.clear(); }
                    break;
                case 0x1: // text
                case 0x2: // binary (используем для файлов)
                    if (fin) { if (onWsMessage) onWsMessage(client,payload); }
                    else { payloadAccum = payload; accumOpcode = opcode; }
                    break;
                case 0x8: goto bye;                 // close
                case 0x9: {                         // ping -> pong
                    std::lock_guard<std::mutex> lk(client->sendMtx);
                    uint8_t pong[2] = {0x8A, (uint8_t)payload.size()};
                    ::send(fd,pong,2,MSG_NOSIGNAL);
                    if(!payload.empty()) ::send(fd,payload.data(),payload.size(),MSG_NOSIGNAL);
                    break;
                }
                case 0xA: break;                    // pong — игнорируем
            }
        }
bye:
        if (onWsClose) onWsClose(client);
        wsRemove(client);
        client->close();
        delete client;
    }

    void fireMessage(WsClient* c, const std::string& msg){ if(onWsMessage) onWsMessage(c,msg); }

    static bool recvExact(int fd, void* dst, size_t n) {
        size_t got = 0;
        while (got < n) {
            ssize_t r = ::recv(fd, (char*)dst+got, n-got, 0);
            if (r <= 0) return false;
            got += (size_t)r;
        }
        return true;
    }

    // SHA1 реализован локально (нужен только для handshake WebSocket)
    static std::string wsAcceptKey(const std::string& key) {
        static const char* GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        std::string combined = key + GUID;
        std::string sha1 = sha1Raw(combined);
        return enc::base64Encode(sha1);
    }
    static std::string sha1Raw(const std::string& msg) {
        // канонический RFC3161 SHA-1, 20 байт на выходе
        uint32_t h0=0x67452301,h1=0xEFCDAB89,h2=0x98BADCFE,h3=0x10325476,h4=0xC3D2E1F0;
        uint64_t ml = msg.size()*8;
        std::string m = msg; m += (char)0x80;
        while (m.size()%64 != 56) m += (char)0;
        for (int i=7;i>=0;i--) m += (char)((ml>>(i*8))&0xFF);
        auto rol=[](uint32_t v,int b){ return (v<<b)|(v>>(32-b)); };
        for (size_t off=0; off<m.size(); off+=64) {
            uint32_t w[80];
            for (int i=0;i<16;i++)
                w[i]=(uint8_t)m[off+i*4]<<24|(uint8_t)m[off+i*4+1]<<16|(uint8_t)m[off+i*4+2]<<8|(uint8_t)m[off+i*4+3];
            for (int i=16;i<80;i++) w[i]=rol(w[i-3]^w[i-8]^w[i-14]^w[i-16],1);
            uint32_t a=h0,b=h1,c=h2,d=h3,e=h4;
            for (int i=0;i<80;i++){
                uint32_t f,k;
                if(i<20){f=(b&c)|((~b)&d);k=0x5A827999;}
                else if(i<40){f=b^c^d;k=0x6ED9EBA1;}
                else if(i<60){f=(b&c)|(b&d)|(c&d);k=0x8F1BBCDC;}
                else {f=b^c^d;k=0xCA62C1D6;}
                uint32_t t=rol(a,5)+f+e+k+w[i];
                e=d;d=c;c=rol(b,30);b=a;a=t;
            }
            h0+=a;h1+=b;h2+=c;h3+=d;h4+=e;
        }
        std::string out;
        uint32_t hs[5]={h0,h1,h2,h3,h4};
        for (int i=0;i<5;i++) for (int j=3;j>=0;j--) out += (char)((hs[i]>>(j*8))&0xFF);
        return out;
    }
};
