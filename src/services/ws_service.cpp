// ============================================================
// Реализация WebSocket-протокола (RFC 6455): handshake, фреймы,
// менеджер соединений. SHA-1 и base64 — через OpenSSL EVP.
// ============================================================
#include "services/ws_service.hpp"

#include <openssl/evp.h>

#include <sys/socket.h>
#include <unistd.h>

#include <cstring>
#include <iostream>
#include <algorithm>

// ---- Base64 (стандартный, для Sec-WebSocket-Accept) ----

static const char* B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string base64Encode(const unsigned char* data, size_t len) {
    std::string out;
    int val = 0, bits = -6;
    for (size_t i = 0; i < len; ++i) {
        val = (val << 8) + data[i];
        bits += 8;
        while (bits >= 0) {
            out += B64[(val >> bits) & 0x3F];
            bits -= 6;
        }
    }
    if (bits > -6) out += B64[((val << 8) >> (bits + 8)) & 0x3F];
    while (out.size() % 4) out += '=';
    return out;
}

// SHA-1 от строки -> сырые байты
static std::string sha1raw(const std::string& input) {
    unsigned char md[EVP_MAX_MD_SIZE];
    unsigned int mdLen = 0;
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    EVP_DigestInit_ex(ctx, EVP_sha1(), nullptr);
    EVP_DigestUpdate(ctx, input.data(), input.size());
    EVP_DigestFinal_ex(ctx, md, &mdLen);
    EVP_MD_CTX_free(ctx);
    return std::string(reinterpret_cast<char*>(md), mdLen);
}

// Магический GUID из RFC 6455
static const char* WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

std::string wsComputeAccept(const std::string& secWebSocketKey) {
    std::string combined = secWebSocketKey + WS_GUID;
    std::string sha1 = sha1raw(combined);
    return base64Encode(reinterpret_cast<const unsigned char*>(sha1.data()), sha1.size());
}

// Кодирование текстового фрейма сервера (без маскирования, FIN=1, opcode=TEXT)
std::string wsEncodeTextFrame(const std::string& payload) {
    std::string frame;
    frame += static_cast<char>(0x81); // FIN + opcode 0x1
    size_t len = payload.size();
    if (len < 126) {
        frame += static_cast<char>(len);
    } else if (len <= 0xFFFF) {
        frame += static_cast<char>(126);
        frame += static_cast<char>((len >> 8) & 0xFF);
        frame += static_cast<char>(len & 0xFF);
    } else {
        frame += static_cast<char>(127);
        for (int shift = 56; shift >= 0; shift -= 8)
            frame += static_cast<char>((len >> shift) & 0xFF);
    }
    frame += payload;
    return frame;
}

// Прочитать ровно n байт из сокета
static bool readExact(int fd, void* buf, size_t n) {
    size_t got = 0;
    auto* p = static_cast<unsigned char*>(buf);
    while (got < n) {
        ssize_t r = ::recv(fd, p + got, n - got, 0);
        if (r <= 0) return false;
        got += static_cast<size_t>(r);
    }
    return true;
}

bool wsReadFrame(int fd, std::string& payload, uint8_t& opcode) {
    unsigned char hdr[2];
    if (!readExact(fd, hdr, 2)) return false;

    bool fin = (hdr[0] & 0x80) != 0;
    opcode = hdr[0] & 0x0F;
    bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;

    if (len == 126) {
        unsigned char ext[2];
        if (!readExact(fd, ext, 2)) return false;
        len = (static_cast<uint64_t>(ext[0]) << 8) | ext[1];
    } else if (len == 127) {
        unsigned char ext[8];
        if (!readExact(fd, ext, 8)) return false;
        len = 0;
        for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }

    if (len > 16 * 1024 * 1024) return false; // защита от огромных кадров

    unsigned char maskKey[4] = {0, 0, 0, 0};
    if (masked && !readExact(fd, maskKey, 4)) return false;

    payload.resize(static_cast<size_t>(len));
    if (len > 0 && !readExact(fd, &payload[0], static_cast<size_t>(len))) return false;

    // Демаскирование данных клиента по RFC 6455
    if (masked) {
        for (uint64_t i = 0; i < len; ++i)
            payload[i] = static_cast<char>(static_cast<unsigned char>(payload[i]) ^ maskKey[i % 4]);
    }
    (void)fin; // фрагментированные сообщения в MVP не поддерживаем
    return true;
}

bool wsSendText(int fd, const std::string& text) {
    std::string frame = wsEncodeTextFrame(text);
    size_t sent = 0;
    while (sent < frame.size()) {
        ssize_t w = ::send(fd, frame.data() + sent, frame.size() - sent, MSG_NOSIGNAL);
        if (w <= 0) return false;
        sent += static_cast<size_t>(w);
    }
    return true;
}

// ---- WsManager ----

WsManager& WsManager::instance() {
    static WsManager mgr;
    return mgr;
}

void WsManager::addConnection(int64_t userId, int fd) {
    std::lock_guard<std::mutex> lock(mtx_);
    userToFd_.emplace(userId, fd);
}

void WsManager::removeConnection(int fd) {
    std::lock_guard<std::mutex> lock(mtx_);
    for (auto it = userToFd_.begin(); it != userToFd_.end();) {
        if (it->second == fd) it = userToFd_.erase(it);
        else ++it;
    }
}

void WsManager::sendToUser(int64_t userId, const std::string& jsonText) {
    // Собираем список fd под блокировкой, отправляем без неё
    std::vector<int> fds;
    {
        std::lock_guard<std::mutex> lock(mtx_);
        auto range = userToFd_.equal_range(userId);
        for (auto it = range.first; it != range.second; ++it)
            fds.push_back(it->second);
    }
    for (int fd : fds) {
        if (!wsSendText(fd, jsonText)) removeConnection(fd);
    }
}

void WsManager::sendToChat(const std::vector<int64_t>& chatMembers,
                           int64_t exceptUserId,
                           const std::string& jsonText) {
    for (int64_t uid : chatMembers) {
        if (uid != exceptUserId) sendToUser(uid, jsonText);
    }
}

size_t WsManager::connectionCount() {
    std::lock_guard<std::mutex> lock(mtx_);
    return userToFd_.size();
}
