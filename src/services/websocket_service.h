#pragma once

#include <string>
#include <vector>
#include <map>
#include <mutex>
#include <thread>
#include <cstdint>
#include <functional>
#include "../http_server.h"
#include "../services/presence_service.h"
#include "../db/database.h"
#include "../services/session_service.h"
#include "../websocket_frame.h"

namespace cipher {

class WebSocketService {
public:
    WebSocketService(Database& db, SessionService& sessions, PresenceService& presence);
    ~WebSocketService();

    void attachToHttpServer(class HttpServer& http);
    void run();
    void stop() { running_ = false; }

    void sendText(int fd, const std::string& json);
    void sendRaw(int fd, const std::vector<uint8_t>& data);

private:
    bool doHandshake(int fd, const HttpRequest& req);
    static std::string computeAcceptKey(const std::string& clientKey);
    void clientLoop(int fd);
    void handleMessage(int fd, int64_t& userId, bool& authed, const std::string& text);

    void handleAuth(int fd, const std::string& token, int64_t& userId, bool& authed);
    void handleGetPublicKey(int fd, int64_t targetUserId);
    void handleStartChat(int fd, int64_t userId, const std::string& targetUserIdStr);
    void handleCreateGroup(int fd, int64_t userId, const std::string& name, const std::string& membersJson);
    void handleSendMessage(int fd, int64_t userId, int64_t chatId, const std::string& content,
                           const std::string& iv, const std::string& header, const std::string& msgType,
                           int64_t replyTo);
    void handleEditMessage(int fd, int64_t userId, int64_t messageId, const std::string& content,
                           const std::string& iv, const std::string& header);
    void handleDeleteMessage(int fd, int64_t userId, int64_t messageId, bool forAll);
    void handleGetMessages(int fd, int64_t userId, int64_t chatId, const std::string& limitStr,
                           const std::string& beforeIdStr);
    void handleTyping(int fd, int64_t userId, int64_t chatId);
    void handleAddMember(int fd, int64_t userId, int64_t chatId, int64_t targetUid);
    void handleSetPublicKey(int fd, int64_t userId, const std::string& publicKey);
    void handleForwardMessage(int fd, int64_t userId, int64_t fromChatId, int64_t toChatId,
                              int64_t messageId, const std::string& content, const std::string& iv,
                              const std::string& header);
    void handlePinMessage(int fd, int64_t userId, int64_t chatId, int64_t messageId, bool unpin);
    void handleSetRole(int fd, int64_t userId, int64_t chatId, int64_t targetUid, const std::string& role);
    void handleSetGroupKey(int fd, int64_t userId, int64_t chatId, const std::string& wrappedJson, const std::string& versionStr);
    void handleGetGroupKey(int fd, int64_t userId, int64_t chatId);
    void handleResolvePublicId(int fd, int64_t userId, const std::string& token);
    void handleCreateFolder(int fd, int64_t userId, const std::string& name, const std::string& emoji, const std::string& color);
    void handleDeleteChat(int fd, int64_t userId, int64_t chatId, bool forAll);
    void handleSetPrivacy(int fd, int64_t userId, bool hideOnline);
    void handleReadMessages(int fd, int64_t userId, int64_t chatId, int64_t lastReadId);

    void sendError(int fd, const std::string& error, const std::string& description);
    std::string serializeMessageJson(const Message& m, const User& sender);
    std::string getChatWithDetailsJson(int64_t chatId, int64_t requesterId);
    void notifyChatMembers(int64_t chatId, const std::string& message, int64_t excluded = -1);

    Database& db_;
    SessionService& sessionService_;
    PresenceService& presence_;
    bool running_ = true;
    std::map<int, int64_t> authed_;
    std::mutex authedMtx_;
};

} // namespace cipher
