#pragma once
// ============================================================
// Конфигурация приложения CipherTalk
// Хранит пути и параметры сервера
// ============================================================
#include <string>

namespace config {

// Порт HTTP/WebSocket сервера
constexpr int PORT = 3000;

// Путь к файлу базы данных SQLite (относительно корня проекта)
const std::string DB_PATH = "build/ciphertalk-db.sqlite";

// Секретный ключ для подписи JWT-токенов (HS256)
const std::string JWT_SECRET = "ciphertalk-super-secret-key-change-me";

// Время жизни токена в секундах (7 дней)
constexpr long JWT_EXPIRES_IN = 7 * 24 * 3600;

// Папка со статическими файлами фронтенда
const std::string WEB_DIR = "web";

} // namespace config
