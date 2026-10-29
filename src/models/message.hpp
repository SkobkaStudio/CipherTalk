#pragma once
// ============================================================
// Модель сообщения. Сообщения хранятся в таблице messages,
// выборка — по чату с ограничением (последние N).
// ============================================================
#include <string>
#include <vector>
#include <cstdint>

struct Message {
    int64_t id = 0;
    int64_t chatId = 0;
    int64_t senderId = 0;
    std::string text;
    int64_t createdAt = 0;

    // Сохранить сообщение, вернуть его id или -1 при ошибке
    static int64_t create(int64_t chatId, int64_t senderId, const std::string& text);

    // Последние `limit` сообщений чата в хронологическом порядке
    static std::vector<Message> latest(int64_t chatId, int limit = 100);

    // Сообщение по id (для рассылки через WebSocket)
    static bool findById(int64_t id, Message& out);
};
