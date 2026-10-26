#pragma once
// Слой доступа к SQLCipher (через SQLiteCpp). Все операции сериализуются внутренним mutex —
// потоки HTTP/WS безопасно используют один экземпляр. Никакой конкатенации значений в SQL:
// только Statement::bind().
#include <SQLiteCpp/SQLiteCpp.h>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include <cstdint>
#include <optional>

struct UserRow {
    long long id = 0;
    std::string phone;              // пустая строка == NULL
    std::string username;           // пустая строка == NULL
    std::string password_hash;      // пустая строка == NULL (аккаунт бота)
    bool is_bot = false;
};

struct ChatRow {
    long long id = 0;
    std::string type;               // private | group
    std::string title;              // пустая строка == NULL
};

struct MessageRow {
    long long id = 0;
    long long chat_id = 0;
    long long sender_id = 0;
    std::string content;            // расшифрованный текст
    int64_t timestamp = 0;          // unix ms
};

class Database {
public:
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    // Открывает БД и применяет ключ SQLCipher. Ключ НЕ логируется.
    static std::unique_ptr<Database> open(const std::string& path, const std::string& cipher_key);

    void ensureSchema();

    // --- users ---
    std::optional<UserRow> findUserByPhone(const std::string& phone);
    std::optional<UserRow> findUserById(long long id);
    long long createUser(const std::string& phone, const std::string& password_hash);
    // Создание аккаунта бота: phone=NULL, password_hash=NULL, is_bot=1.
    long long createBotUser(const std::string& username);

    // --- bot_tokens ---
    void insertBotToken(long long bot_id, const std::string& token_hash);
    std::optional<long long> findBotIdByTokenHash(const std::string& token_hash);

    // --- sessions (JWT sid) ---
    void createSession(const std::string& sid, long long user_id, int64_t expires_at);
    bool sessionActive(const std::string& sid, long long user_id);
    void revokeSession(const std::string& sid);

    // --- chats ---
    long long createChat(const std::string& type, const std::string& title); // title "" => NULL
    void addChatMember(long long chat_id, long long user_id);
    bool isChatMember(long long chat_id, long long user_id);
    std::optional<ChatRow> findChat(long long chat_id);
    // Ищет существующий private-чат между двумя юзерами или создаёт новый.
    long long ensurePrivateChat(long long user_a, long long user_b);
    std::vector<long long> chatIdsForUser(long long user_id);

    // --- messages ---
    long long insertMessage(long long chat_id, long long sender_id,
                            const std::string& encrypted_content, int64_t timestamp);
    // История: WHERE chat_id=? AND (beforeId==0 OR id<beforeId) ORDER BY id DESC LIMIT ?
    std::vector<MessageRow> getChatMessages(int chatId, int limit = 50, int beforeId = 0);

private:
    Database(std::unique_ptr<SQLite::Database> db);
    std::unique_ptr<SQLite::Database> db_;
    std::mutex mtx_;   // сериализует доступ к sqlite3-соединению из всех потоков
};
