#pragma once
// ============================================================
// Сервис аутентификации: генерация и проверка JWT (HS256).
// Токен: base64url(header).base64url(payload).base64url(HMAC-SHA256)
// Payload содержит user_id, username и срок действия exp.
// ============================================================
#include <string>
#include <cstdint>

namespace auth {

// Создать JWT-токен для пользователя
std::string createToken(int64_t userId, const std::string& username);

// Проверить подпись и срок действия токена.
// При успехе заполняет userId/username и возвращает true.
bool verifyToken(const std::string& token, int64_t& userId, std::string& username);

// Извлечь "Bearer <token>" из заголовка Authorization
std::string extractBearer(const std::string& authHeader);

} // namespace auth
