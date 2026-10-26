#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <random>
#include <ctime>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cctype>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <openssl/evp.h>

namespace cipher::utils {

// ---------- Время ----------
int64_t nowMs();

// ---------- Случайные байты / числа ----------
std::vector<uint8_t> randomBytes(size_t n);
std::string randomHex(size_t bytes);
std::string randomBase64url(size_t bytes);
int randomInt(int lo, int hi);
std::string randomDigits(int length = 6);

// ---------- Base64 (стандартный + urlsafe) ----------
std::string base64Encode(const uint8_t* data, size_t len);
std::string base64EncodeStr(const std::string& s);
std::string base64urlEncode(const uint8_t* data, size_t len);
std::string base64urlEncodeStr(const std::string& s);
std::vector<uint8_t> base64Decode(const std::string& s);
std::vector<uint8_t> base64urlDecode(const std::string& s);

// ---------- Hex ----------
std::string hexEncode(const uint8_t* data, size_t len);
std::vector<uint8_t> hexDecode(const std::string& s);

// ---------- HMAC / SHA256 ----------
std::vector<uint8_t> hmacSha256(const uint8_t* key, size_t keyLen,
                                const uint8_t* data, size_t dataLen);
std::vector<uint8_t> sha256(const uint8_t* data, size_t len);
std::string sha256Hex(const std::string& s);

// ---------- Сравнение за постоянное время ----------
bool timingSafeEqual(const std::string& a, const std::string& b);

// ---------- Строки ----------
std::string trim(const std::string& s);
std::string toLower(const std::string& s);
std::vector<std::string> split(const std::string& s, char delim);
bool startsWith(const std::string& s, const std::string& prefix);
bool endsWith(const std::string& s, const std::string& suffix);

// ---------- Телефон / username (перенесено с JS) ----------
std::string normalizePhone(const std::string& raw);
std::string normalizeUsername(const std::string& value);

// ---------- Публичные ID (Telegram-подобные) ----------
constexpr int USER_ID_DIGITS = 8;
constexpr int CHAT_ID_DIGITS = 14;
constexpr int64_t MAX_USER_INTERNAL_ID = 99999999;
constexpr int64_t MAX_CHAT_INTERNAL_ID = 99999999999999LL;
constexpr int64_t PRIVATE_CHAT_MULT = 1000000LL;

std::string padDigits(int64_t n, int digits);
std::string formatUserId(int64_t internalId);
std::string formatChatId(int64_t internalId, const std::string& type);
int64_t privateChatInternalId(int64_t a, int64_t b);
std::pair<int64_t,int64_t> privateChatMembersFromInternalId(int64_t negativeChatId);

// ---------- Безопасное чтение файла ----------
std::string readFile(const std::string& path);
bool fileExists(const std::string& path);

} // namespace cipher::utils
