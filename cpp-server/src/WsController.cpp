#include "WsController.h"
#include "Crypto.h"
#include "Json.h"
#include <sys/socket.h>
#include <unistd.h>
#include <openssl/sha.h>
#include <openssl/evp.h>
#include <cstring>
#include <cstdint>
#include <chrono>
#include <iostream>
#include <algorithm>

namespace {

// ---------- низкоуровневый I/O ----------
bool readLine(int fd, std::string& out, size_t max_len = 8192) {
    out.clear();
    char c = 0;
    while (out.size() < max_len) {
        ssize_t n = ::recv(fd, &c, 1, 0);
        if (n <= 0) return false;
        if (c == '\n') {
            if (!out.empty() && out.back() == '\r') out.pop_back();
            return true;
        }
        out += c;
    }
    return false;
}

bool readAll(int fd, void* buf, size_t len) {
    size_t done = 0;
    while (done < len) {
        ssize_t n = ::recv(fd, static_cast<char*>(buf) + done, len - done, 0);
        if (n <= 0) return false;
        done += static_cast<size_t>(n);
    }
    return true;
}

bool writeAllFd(int fd, const std::string& data) {
    size_t done = 0;
    while (done < data.size()) {
        ssize_t n = ::send(fd, data.data() + done, data.size() - done, MSG_NOSIGNAL);
        if (n <= 0) return false;
        done += static_cast<size_t>(n);
    }
    return true;
}

std::string base64Encode(const std::string& in) {
    unsigned char buf[512];
    int len = EVP_EncodeBlock(buf, reinterpret_cast<const unsigned char*>(in.data()),
                              static_cast<int>(in.size()));
    return std::string(reinterpret_cast<char*>(buf), static_cast<size_t>(len));
}

int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

const uint16_t kMaxMessageBytes = 64 * 1024; // лимит на размер WS-сообщения

} // namespace

WsController::WsController(AuthController& auth) : auth_(auth) {}

WsController::~WsController() { shutdown(); }

std::string WsController::wsAcceptKey(const std::string& client_key) {
    static const std::string magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    std::string concat = client_key + magic;
    unsigned char sha[SHA_DIGEST_LENGTH];
    SHA1(reinterpret_cast<const unsigned char*>(concat.data()), concat.size(), sha);
    return base64Encode(std::string(reinterpret_cast<char*>(sha), SHA_DIGEST_LENGTH));
}

bool WsController::handleNewConnection(int fd, const http::Request& handshake_req) {
    // --- Шаг 3: авторизация при handshake. Токен берётся из query (?token=...) или
    // заголовка Authorization. AuthController::authenticate понимает и JWT, и сырые токены ботов.
    Principal p;
    if (!auth_.authenticate(handshake_req, p)) {
        const char* deny = "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n"
                           "Content-Length: 0\r\n\r\n";
        ::send(fd, deny, std::strlen(deny), MSG_NOSIGNAL);
        ::close(fd);
        return false;
    }

    auto conn = std::make_shared<Connection>();
    conn->fd = fd;
    conn->user_id = p.user_id;
    conn->is_bot = p.is_bot;

    // Проверка membership по БД — источник истины; WS-комнаты лишь оптимизация доставки.
    for (long long chat_id : auth_.db().chatIdsForUser(p.user_id)) {
        conn->chats.insert(chat_id);
    }

    // Handshake response
    std::string key = handshake_req.header("Sec-WebSocket-Key");
    if (key.empty()) { ::close(fd); return false; }
    std::string resp =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + wsAcceptKey(key) + "\r\n\r\n";
    if (!writeAllFd(fd, resp)) { ::close(fd); return false; }

    {
        std::lock_guard<std::mutex> lock(mtx_);   // Шаг 5: добавление под mutex
        connections_.push_back(conn);
        for (long long chat_id : conn->chats) chat_rooms_[chat_id].push_back(conn);
    }

    conn->worker = std::thread([this, conn] { sessionLoop(conn); });
    return true;
}

void WsController::joinChat(long long chat_id, long long user_id) {
    std::vector<std::shared_ptr<Connection>> targets;
    {
        std::lock_guard<std::mutex> lock(mtx_);
        for (auto& conn : connections_) {
            if (conn->user_id == user_id) {
                if (conn->chats.insert(chat_id).second) {
                    chat_rooms_[chat_id].push_back(conn);
                    targets.push_back(conn);
                }
            }
        }
    }
    // Уведомляем без блокировки mutex (запись может быть медленной).
    json::Object ev;
    ev["type"] = json::Value("chat_joined");
    ev["chat_id"] = json::Value(chat_id);
    std::string payload = json::Value(ev).dump();
    for (auto& conn : targets) sendText(conn, payload);
}

bool WsController::performHandshake(Connection&, const http::Request&) {
    return true; // handshake выполняется в handleNewConnection до регистрации соединения
}

bool WsController::readFrame(int fd, std::string& payload, bool& is_close, uint8_t& opcode) {
    payload.clear();
    is_close = false;
    opcode = 0;

    unsigned char hdr[2];
    if (!readAll(fd, hdr, 2)) return false;
    opcode = hdr[0] & 0x0F;
    bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;

    if (len == 126) {
        unsigned char ext[2];
        if (!readAll(fd, ext, 2)) return false;
        len = (static_cast<uint64_t>(ext[0]) << 8) | ext[1];
    } else if (len == 127) {
        unsigned char ext[8];
        if (!readAll(fd, ext, 8)) return false;
        len = 0;
        for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }

    // Клиент ОБЯЗАН маскировать кадры (RFC 6455 5.1) — иначе протокольная ошибка.
    if (!masked) return false;
    if (len > kMaxMessageBytes) return false;

    unsigned char mask[4];
    if (!readAll(fd, mask, 4)) return false;

    std::string raw(static_cast<size_t>(len), '\0');
    if (len > 0 && !readAll(fd, &raw[0], static_cast<size_t>(len))) return false;
    for (size_t i = 0; i < raw.size(); ++i) raw[i] = static_cast<char>(raw[i] ^ mask[i % 4]);

    if (opcode == 0x8) { is_close = true; return true; }
    if (opcode == 0x9) { // ping -> pong
        std::string frame;
        frame += static_cast<char>(0x8A);
        frame += static_cast<char>(raw.size());
        frame += raw;
        writeAllFd(fd, frame);
        payload.swap(raw);
        return true;
    }
    if (opcode == 0xA || opcode == 0x0 || opcode == 0x1) {
        payload.swap(raw);
        return true;
    }
    return false; // неизвестный opcode
}

void WsController::sendRaw(std::shared_ptr<Connection> conn, const std::string& bytes) {
    std::lock_guard<std::mutex> wlock(conn->write_mtx); // последовательная запись в один fd
    writeAllFd(conn->fd, bytes);
}

bool WsController::sendText(std::shared_ptr<Connection> conn, const std::string& text) {
    std::string frame;
    frame += static_cast<char>(0x81); // FIN + text
    size_t len = text.size();
    if (len < 126) {
        frame += static_cast<char>(len);
    } else if (len <= 0xFFFF) {
        frame += static_cast<char>(126);
        frame += static_cast<char>((len >> 8) & 0xFF);
        frame += static_cast<char>(len & 0xFF);
    } else {
        frame += static_cast<char>(127);
        for (int i = 7; i >= 0; --i) frame += static_cast<char>((len >> (8 * i)) & 0xFF);
    }
    frame += text;
    sendRaw(conn, frame);
    return true;
}

void WsController::sessionLoop(std::shared_ptr<Connection> conn) {
    std::string self_intro;
    {
        json::Object hello;
        hello["type"] = json::Value("connected");
        hello["user_id"] = json::Value(conn->user_id);
        hello["is_bot"] = json::Value(conn->is_bot ? 1 : 0);
        json::Array chats_arr;
        for (long long c : conn->chats) chats_arr.push_back(json::Value(c));
        hello["chats"] = json::Value(chats_arr);
        self_intro = json::Value(hello).dump();
    }
    sendText(conn, self_intro);

    std::string payload;
    bool is_close = false;
    uint8_t opcode = 0;
    while (running_.load()) {
        if (!readFrame(conn->fd, payload, is_close, opcode)) break;
        if (is_close) break;
        if (opcode == 0x9 || payload.empty()) continue;
        handleMessage(conn, payload);
    }

    // вежливый close-фрейм (игнорируем ошибки — сокет мог уже умереть)
    std::string close_frame;
    close_frame += static_cast<char>(0x88);
    close_frame += static_cast<char>(0);
    {
        std::lock_guard<std::mutex> wlock(conn->write_mtx);
        writeAllFd(conn->fd, close_frame);
    }
    removeConnection(conn);
}

void WsController::removeConnection(const std::shared_ptr<Connection>& conn) {
    {
        std::lock_guard<std::mutex> lock(mtx_); // Шаг 5: удаление под mutex
        auto it = std::find(connections_.begin(), connections_.end(), conn);
        if (it != connections_.end()) connections_.erase(it);
        for (long long chat_id : conn->chats) {
            auto room_it = chat_rooms_.find(chat_id);
            if (room_it == chat_rooms_.end()) continue;
            auto& v = room_it->second;
            v.erase(std::remove_if(v.begin(), v.end(),
                                   [conn](const std::weak_ptr<Connection>& w) {
                                       auto sp = w.lock();
                                       return !sp || sp == conn;
                                   }),
                    v.end());
            if (v.empty()) chat_rooms_.erase(room_it);
        }
    }
    ::close(conn->fd); // единственный владелец fd закрывает его ровно один раз
}

void WsController::handleMessage(const std::shared_ptr<Connection>& conn, const std::string& text) {
    json::Value msg;
    try {
        msg = json::parse(text);
    } catch (const std::exception&) {
        sendText(conn, "{\"type\":\"error\",\"error\":\"invalid JSON\"}");
        return;
    }
    if (!msg.isObject() || !msg.has("type") || !msg["type"].isString()) {
        sendText(conn, "{\"type\":\"error\",\"error\":\"missing type\"}");
        return;
    }
    const std::string type = msg["type"].asString();

    if (type == "ping") {
        sendText(conn, "{\"type\":\"pong\"}");
        return;
    }

    if (type == "subscribe") {
        if (!msg.has("chat_id") || !msg["chat_id"].isNumber()) {
            sendText(conn, "{\"type\":\"error\",\"error\":\"chat_id required\"}");
            return;
        }
        long long chat_id = msg["chat_id"].asInt();
        if (!auth_.db().isChatMember(chat_id, conn->user_id)) {
            sendText(conn, "{\"type\":\"error\",\"error\":\"not a chat member\"}");
            return;
        }
        bool added = false;
        {
            std::lock_guard<std::mutex> lock(mtx_);
            if (conn->chats.insert(chat_id).second) {
                chat_rooms_[chat_id].push_back(conn);
                added = true;
            }
        }
        if (added) {
            json::Object ok;
            ok["type"] = json::Value("subscribed");
            ok["chat_id"] = json::Value(chat_id);
            sendText(conn, json::Value(ok).dump());
        }
        return;
    }

    if (type == "message") {
        if (!msg.has("chat_id") || !msg["chat_id"].isNumber() ||
            !msg.has("content") || !msg["content"].isString()) {
            sendText(conn, "{\"type\":\"error\",\"error\":\"chat_id and content required\"}");
            return;
        }
        long long chat_id = msg["chat_id"].asInt();
        const std::string& content = msg["content"].asString();
        if (content.size() > 32 * 1024) {
            sendText(conn, "{\"type\":\"error\",\"error\":\"message too long\"}");
            return;
        }
        // Membership проверяется по БД на каждое сообщение (источник истины).
        if (!auth_.db().isChatMember(chat_id, conn->user_id)) {
            sendText(conn, "{\"type\":\"error\",\"error\":\"not a chat member\"}");
            return;
        }

        int64_t ts = nowMs();
        long long msg_id = auth_.db().insertMessage(chat_id, conn->user_id, content, ts);

        routeToChat(chat_id, "message", [&] {
            json::Object ev;
            ev["id"] = json::Value(msg_id);
            ev["chat_id"] = json::Value(chat_id);
            ev["sender_id"] = json::Value(conn->user_id);
            ev["sender_is_bot"] = json::Value(conn->is_bot ? 1 : 0);
            ev["content"] = json::Value(content);
            ev["timestamp"] = json::Value(ts);
            return json::Value(ev).dump();
        }());
        return;
    }

    sendText(conn, "{\"type\":\"error\",\"error\":\"unknown message type\"}");
}

void WsController::routeToChat(long long chat_id, const std::string& sender,
                               const std::string& json_payload) {
    // Снимок комнаты под mutex, отправка — вне mutex (иначе рассылка блокирует весь сервер).
    std::vector<std::shared_ptr<Connection>> recipients;
    {
        std::lock_guard<std::mutex> lock(mtx_); // Шаг 5: чтение connections_/chat_rooms_ под mutex
        auto it = chat_rooms_.find(chat_id);
        if (it == chat_rooms_.end()) return;
        for (auto& weak_conn : it->second) {
            if (auto sp = weak_conn.lock()) recipients.push_back(sp);
        }
    }
    for (auto& conn : recipients) {
        // единый формат события для клиента: {"type":"message","data":{...}}
        std::string envelope = "{\"type\":\"" + sender + "\",\"data\":" + json_payload + "}";
        sendText(conn, envelope);
    }
}

void WsController::shutdown() {
    running_.store(false);
    std::vector<std::shared_ptr<Connection>> conns;
    {
        std::lock_guard<std::mutex> lock(mtx_);
        conns = connections_;
        connections_.clear();
        chat_rooms_.clear();
    }
    for (auto& conn : conns) {
        ::shutdown(conn->fd, SHUT_RDWR); // расблокируем readFrame worker-потока
    }
    for (auto& conn : conns) {
        if (conn->worker.joinable()) conn->worker.join();
    }
}

size_t WsController::connectionCount() {
    std::lock_guard<std::mutex> lock(mtx_);
    return connections_.size();
}
