#include "utils.h"
#include <fstream>
#include <cstring>
#include <cstdio>
#include <sys/stat.h>
#include <openssl/rand.h>
#include <openssl/evp.h>

namespace cipher::utils {

int64_t nowMs() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts); // не используем, ниже системное время
    (void)ts;
    return static_cast<int64_t>(std::time(nullptr)) * 1000;
}

std::vector<uint8_t> randomBytes(size_t n) {
    std::vector<uint8_t> out(n);
    if (RAND_bytes(out.data(), static_cast<int>(n)) != 1) {
        // Фолбэк на случай ошибки OpenSSL RNG
        std::random_device rd;
        std::mt19937_64 gen(rd());
        for (auto& b : out) b = static_cast<uint8_t>(gen());
    }
    return out;
}

std::string randomHex(size_t bytes) {
    auto b = randomBytes(bytes);
    static const char* hex = "0123456789abcdef";
    std::string out; out.reserve(b.size() * 2);
    for (uint8_t x : b) {
        out.push_back(hex[x >> 4]);
        out.push_back(hex[x & 0x0F]);
    }
    return out;
}

std::string randomBase64url(size_t bytes) {
    auto b = randomBytes(bytes);
    return base64urlEncode(b.data(), b.size());
}

int randomInt(int lo, int hi) {
    std::random_device rd;
    std::mt19937_64 gen(rd());
    std::uniform_int_distribution<int> dist(lo, hi);
    return dist(gen);
}

std::string randomDigits(int length) {
    std::string out; out.reserve(length);
    for (int i = 0; i < length; ++i) {
        out.push_back(static_cast<char>('0' + randomInt(0, 9)));
    }
    return out;
}

// ---------- Base64 ----------
static const char* B64_ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const char* B64_URL_ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

std::string base64Encode(const uint8_t* data, size_t len) {
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len;) {
        uint32_t triple = 0;
        size_t bytes = 0;
        for (size_t j = 0; j < 3 && i + j < len; ++j, ++bytes) {
            triple = (triple << 8) | data[i + j];
        }
        triple <<= (3 - bytes) * 8;
        for (int j = 3; j >= 0; --j) {
            if (j <= static_cast<int>(bytes)) {
                out.push_back(B64_ALPH[(triple >> (j * 6)) & 0x3F]);
            } else {
                out.push_back('=');
            }
        }
        i += bytes;
    }
    return out;
}

std::string base64EncodeStr(const std::string& s) {
    return base64Encode(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

std::string base64urlEncode(const uint8_t* data, size_t len) {
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len;) {
        uint32_t triple = 0;
        size_t bytes = 0;
        for (size_t j = 0; j < 3 && i + j < len; ++j, ++bytes) {
            triple = (triple << 8) | data[i + j];
        }
        triple <<= (3 - bytes) * 8;
        for (int j = 3; j >= 0; --j) {
            if (j <= static_cast<int>(bytes)) {
                out.push_back(B64_URL_ALPH[(triple >> (j * 6)) & 0x3F]);
            } else {
                out.push_back('=');
            }
        }
        i += bytes;
    }
    // Убираемpadding для urlsafe (как в Node.js base64url)
    while (!out.empty() && out.back() == '=') out.pop_back();
    return out;
}

std::string base64urlEncodeStr(const std::string& s) {
    return base64urlEncode(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

static int b64val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}

std::vector<uint8_t> base64Decode(const std::string& s) {
    std::vector<uint8_t> out;
    size_t i = 0;
    while (i < s.size()) {
        uint32_t triple = 0;
        size_t bytes = 0;
        for (int j = 0; j < 4 && i < s.size(); ++j, ++i) {
            int v = b64val(s[i]);
            if (v < 0) { if (s[i] == '=') continue; else break; }
            triple = (triple << 6) | static_cast<uint32_t>(v);
            if (j < 3) ++bytes; // считаем только реальные данные, padding не считаем
        }
        if (bytes == 0) break;
        // корректируем сдвиг
        triple <<= (4 - bytes) * 6;
        for (int j = 2; j >= 0 && bytes > 0; --j, --bytes) {
            out.push_back(static_cast<uint8_t>((triple >> (j * 8)) & 0xFF));
        }
    }
    return out;
}

std::vector<uint8_t> base64urlDecode(const std::string& s) {
    std::string norm = s;
    // Добавляем padding обратно
    while (norm.size() % 4 != 0) norm.push_back('=');
    // urlsafe -> стандартный base64
    for (auto& c : norm) {
        if (c == '-') c = '+';
        if (c == '_') c = '/';
    }
    return base64Decode(norm);
}

// ---------- Hex ----------
std::string hexEncode(const uint8_t* data, size_t len) {
    static const char* hex = "0123456789abcdef";
    std::string out; out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out.push_back(hex[data[i] >> 4]);
        out.push_back(hex[data[i] & 0x0F]);
    }
    return out;
}

std::vector<uint8_t> hexDecode(const std::string& s) {
    std::vector<uint8_t> out;
    if (s.size() % 2 != 0) return out;
    out.reserve(s.size() / 2);
    for (size_t i = 0; i < s.size(); i += 2) {
        auto hn = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        int hi = hn(s[i]), lo = hn(s[i+1]);
        if (hi < 0 || lo < 0) return {};
        out.push_back(static_cast<uint8_t>((hi << 4) | lo));
    }
    return out;
}

// ---------- HMAC / SHA256 ----------
std::vector<uint8_t> hmacSha256(const uint8_t* key, size_t keyLen,
                                const uint8_t* data, size_t dataLen) {
    unsigned int outLen = 0;
    uint8_t out[EVP_MAX_MD_SIZE];
    HMAC(EVP_sha256(), key, keyLen, data, dataLen, out, &outLen);
    return std::vector<uint8_t>(out, out + outLen);
}

std::vector<uint8_t> sha256(const uint8_t* data, size_t len) {
    unsigned int outLen = 0;
    uint8_t out[EVP_MAX_MD_SIZE];
    EVP_Digest(data, len, out, &outLen, EVP_sha256(), nullptr);
    return std::vector<uint8_t>(out, out + outLen);
}

std::string sha256Hex(const std::string& s) {
    return hexEncode(sha256(reinterpret_cast<const uint8_t*>(s.data()), s.size()).data(),
                     sha256(reinterpret_cast<const uint8_t*>(s.data()), s.size()).size());
}

bool timingSafeEqual(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    int result = 0;
    for (size_t i = 0; i < a.size(); ++i) result |= a[i] ^ b[i];
    return result == 0;
}

// ---------- Строки ----------
std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b-1]))) --b;
    return s.substr(a, b - a);
}

std::string toLower(const std::string& s) {
    std::string out = s;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c){ return std::tolower(c); });
    return out;
}

std::vector<std::string> split(const std::string& s, char delim) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == delim) { out.push_back(cur); cur.clear(); }
        else cur.push_back(c);
    }
    out.push_back(cur);
    return out;
}

bool startsWith(const std::string& s, const std::string& prefix) {
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

bool endsWith(const std::string& s, const std::string& suffix) {
    return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

// ---------- Телефон / username ----------
std::string normalizePhone(const std::string& raw) {
    std::string r = trim(raw);
    if (r.empty()) return "";
    std::string digits;
    for (char c : r) if (std::isdigit(static_cast<unsigned char>(c))) digits.push_back(c);
    if (digits.empty()) return r;

    if (digits.size() == 11 && digits[0] == '8') {
        return "+7" + digits.substr(1);
    }
    if (digits.size() == 11 && digits[0] == '7') {
        return "+" + digits;
    }
    if (digits.size() == 10) {
        return "+7" + digits;
    }
    if (!r.empty() && r[0] == '+') {
        return "+" + digits;
    }
    return "+" + digits;
}

std::string normalizeUsername(const std::string& value) {
    std::string v = trim(value);
    if (!v.empty() && v[0] == '@') v.erase(0, 1);
    return toLower(trim(v));
}

// ---------- Публичные ID ----------
std::string padDigits(int64_t n, int digits) {
    std::string s = std::to_string(n < 0 ? -n : n);
    while (static_cast<int>(s.size()) < digits) s = "0" + s;
    return s;
}

std::string formatUserId(int64_t internalId) {
    if (internalId <= 0) return "";
    return padDigits(internalId, USER_ID_DIGITS);
}

std::string formatChatId(int64_t internalId, const std::string& type) {
    if (internalId <= 0) return "";
    if (type == "group" || type == "supergroup" || type == "channel") {
        return "-" + padDigits(internalId, CHAT_ID_DIGITS);
    }
    return padDigits(internalId, USER_ID_DIGITS);
}

int64_t privateChatInternalId(int64_t a, int64_t b) {
    if (a <= 0 || b <= 0) return 0;
    int64_t lo = a < b ? a : b;
    int64_t hi = a < b ? b : a;
    return -(lo * PRIVATE_CHAT_MULT + hi);
}

std::pair<int64_t,int64_t> privateChatMembersFromInternalId(int64_t negativeChatId) {
    if (negativeChatId >= 0) return {0, 0};
    int64_t abs = -negativeChatId;
    int64_t lo = abs / PRIVATE_CHAT_MULT;
    int64_t hi = abs % PRIVATE_CHAT_MULT;
    if (lo <= 0 || hi <= 0 || hi > lo) return {0, 0};
    return {lo, hi};
}

// ---------- Файлы ----------
std::string readFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return "";
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

bool fileExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

} // namespace cipher::utils
