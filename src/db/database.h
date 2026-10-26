#pragma once

#include <string>
#include <vector>
#include <map>
#include <cstdint>
#include <optional>
#include <sqlite3.h>
#include "../models/user.h"
#include "../models/chat.h"
#include "../models/message.h"
#include "../models/session.h"
#include "../models/file.h"
#include "../models/folder.h"

namespace cipher {

class Database {
public:
    static Database& instance();
    ~Database();
    bool load();
    void flush();
    void markDirty();

    // ---------- Counters ----------
    int64_t nextId(const std::string& name);
    int64_t nextPublicUserId();

    // ---------- Users ----------
    std::optional<User> findUserById(int64_t id);
    std::optional<User> findUserByPhone(const std::string& phone);
    std::optional<User> findUserByEmail(const std::string& email);
    std::optional<User> findUserByPublicId(const std::string& publicId);
    bool isUsernameTaken(const std::string& username, std::optional<int64_t> excludeUserId = std::nullopt);
    User addUser(const User& u);
    bool updateUser(int64_t id, const std::map<std::string, std::string>& patch);

    // ---------- Chats ----------
    std::optional<Chat> findChatById(int64_t id);
    std::optional<Chat> findChatByPublicId(const std::string& publicId);
    Chat addChat(const Chat& c);
    int64_t nextPrivateChatId(int64_t a, int64_t b);
    bool updateChat(int64_t id, const std::map<std::string, std::string>& patch);
    bool deleteChat(int64_t chatId);

    // ---------- Chat members ----------
    std::vector<ChatMember> getChatMembers(int64_t chatId);
    bool isChatMember(int64_t chatId, int64_t userId);
    std::optional<ChatMember> getChatMember(int64_t chatId, int64_t userId);
    void addChatMember(const ChatMember& cm);
    void removeChatMember(int64_t chatId, int64_t userId);
    void updateChatMember(int64_t chatId, int64_t userId, const std::map<std::string, std::string>& patch);
    void hideChatForUser(int64_t chatId, int64_t userId);
    bool restoreChatForUser(int64_t chatId, int64_t userId);
    int64_t getChatClearedAt(int64_t chatId, int64_t userId);
    std::vector<int64_t> restoreHiddenChatMembers(int64_t chatId);
    std::vector<int64_t> getChatMemberIds(int64_t chatId);
    std::vector<int64_t> getUserChats(int64_t userId);

    // ---------- Messages ----------
    std::optional<Message> findMessageById(int64_t id);
    Message addMessage(const Message& m);
    bool updateMessage(int64_t id, const std::map<std::string, std::string>& patch);
    bool deleteMessage(int64_t id);
    int deleteMessagesByIds(const std::vector<int64_t>& ids);
    std::vector<Message> getChatMessages(int64_t chatId, int limit = 50, std::optional<int64_t> beforeId = std::nullopt);
    std::vector<Message> getMessagesByChat(int64_t chatId);
    std::vector<Message> getPinnedMessages(int64_t chatId);

    // ---------- Sessions ----------
    std::optional<Session> findSessionById(int64_t id);
    std::optional<Session> findSessionByToken(const std::string& token);
    std::optional<Session> findSessionByHash(const std::string& hash);
    void addSession(const Session& s);
    bool deleteSession(int64_t id);
    bool deleteSessionByToken(const std::string& token);
    bool deleteSessionByHash(const std::string& hash);
    void purgeExpiredSessions(int64_t nowMs = 0);

    // ---------- Files ----------
    std::optional<File> findFileById(int64_t id);
    File addFile(const File& f);

    // ---------- Verification codes ----------
    void addVerificationCode(int64_t id, const std::string& phone, const std::string& code, int64_t expiresAt);
    std::vector<std::string> findVerificationCode(const std::string& phone); // возвращает коды (расшифровано снаружи)
    std::optional<std::string> findLatestVerificationCodeRaw(const std::string& phone);
    void deleteVerificationCode(const std::string& phone);

    // ---------- Folders ----------
    std::vector<Folder> getFolders(int64_t userId);
    std::optional<Folder> findFolderById(int64_t id);
    Folder createFolder(int64_t userId, const std::string& name, const std::string& emoji, const std::string& color);
    void addFolder(const Folder& f);
    std::optional<Folder> updateFolder(int64_t id, int64_t userId, const std::map<std::string, std::string>& patch);
    bool deleteFolder(int64_t id, int64_t userId = -1);
    void removeChatFromAllFolders(int64_t chatId);

    // ---------- Group keys ----------
    struct GroupKey { int64_t chat_id; int version; std::string wrapped; int64_t created_by; int64_t created_at; int64_t updated_at; };
    std::optional<GroupKey> findGroupKey(int64_t chatId);
    void saveGroupKey(int64_t chatId, int version, const std::string& wrapped, int64_t createdBy);

    // ---------- Compatibility collections (для удобства портирования) ----------
    std::vector<User> allUsers();
    std::vector<Chat> allChats();
    std::vector<Message> allMessages();
    std::vector<ChatMember> allChatMembers();
    std::vector<Session> allSessions();
    std::vector<File> allFiles();
    std::vector<Folder> allFolders();
    std::vector<GroupKey> allGroupKeys();
    std::vector<std::string> allVerificationCodes();

    // ---------- Public ids ----------
    std::string getPublicUserId(int64_t internalId);
    std::string getPublicChatId(int64_t internalId, const std::string& type, std::optional<int64_t> requesterId = std::nullopt);
    int64_t getPrivateChatOtherUserId(int64_t negativeChatId, std::optional<int64_t> requesterInternalId = std::nullopt);
    std::optional<int64_t> findInternalByPublicToken(const std::string& token); // возвращает chatId (отрицательный для групп) или userId (положительный) —ambiguity, используем struct
    struct PublicResolve { bool isUser; int64_t id; }; // isUser=true -> userId, false -> chatId
    std::optional<PublicResolve> resolvePublicToken(const std::string& token);

    void assignPublicIds();
    void ensureSchema();
    void migrateSchema();

private:
    Database();
    sqlite3* db = nullptr;
    std::string dbPath;
    std::string keyHex;

    bool exec(const char* sql);
    void exec(const std::string& sql);
    int64_t lastInsertId();
    std::string esc(const std::string& s);
    void applyKey();
    bool isPlainSqlite();
    void ensureDirs();
};

} // namespace cipher
