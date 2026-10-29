#pragma once
// ============================================================
// Модель чата (диалога). Личный чат — 2 участника, групповой — N.
// Хранится в таблицах chats + chat_participants.
// ============================================================
#include <string>
#include <vector>
#include <cstdint>

struct Chat {
    int64_t id = 0;
    std::string type;          // "private" | "group"
    std::string name;          // имя группы (пусто для личных)
    int64_t createdBy = 0;
    int64_t createdAt = 0;

    // ID участников чата
    std::vector<int64_t> participants;

    // Найти чат по id вместе с участниками
    static bool findById(int64_t id, Chat& out);

    // Все чаты пользователя с краткой информацией о собеседнике
    // (для списка чатов на фронтенде)
    static std::vector<Chat> forUser(int64_t userId);

    // Создать чат указанного типа с участниками. Возвращает id или -1.
    static int64_t create(const std::string& type,
                          const std::string& name,
                          int64_t creatorId,
                          const std::vector<int64_t>& memberIds);

    // Найти существующий личный чат между двумя пользователями
    // или создать новый. Возвращает id чата.
    static int64_t findOrCreatePrivate(int64_t userA, int64_t userB);

    // Проверить, является ли пользователь участником чата
    static bool hasParticipant(int64_t chatId, int64_t userId);
};
