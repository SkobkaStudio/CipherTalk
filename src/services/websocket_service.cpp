#include "websocket_service.h"
#include "../http_server.h"
#include "../utils/utils.h"
#include "../models/user.h"
#include "../models/chat.h"
#include "../models/message.h"
#include "../config/config.h"
#include "../websocket_frame.h"
#include <cstring>
#include <ctime>
#include <thread>
#include <sys/socket.h>
#include <unistd.h>
#include <poll.h>
#include <iostream>
#include <sstream>
#include <map>
#include <mutex>
#include <openssl/sha.h>

static std::string sha1Base64(const std::string& s) {
    unsigned char hash[SHA_DIGEST_LENGTH];
    SHA1(reinterpret_cast<const uint8_t*>(s.data()), s.size(), hash);
    return cipher::utils::base64Encode(hash, SHA_DIGEST_LENGTH);
}

namespace cipher {

WebSocketService::WebSocketService(Database& db, SessionService& sessions, PresenceService& presence)
    : db_(db), sessionService_(sessions), presence_(presence) {}

WebSocketService::~WebSocketService() { stop(); }

std::string WebSocketService::computeAcceptKey(const std::string& clientKey) {
    return sha1Base64(clientKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
}

bool WebSocketService::doHandshake(int fd, const HttpRequest& req) {
    auto it = req.headers.find("Sec-WebSocket-Key");
    if (it == req.headers.end()) return false;
    std::string accept = computeAcceptKey(it->second);
    std::string resp =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + accept + "\r\n"
        "\r\n";
    ::send(fd, resp.data(), resp.size(), 0);
    return true;
}

void WebSocketService::attachToHttpServer(HttpServer& http) {
    http.setWebSocketUpgradeHandler([this](int fd, const HttpRequest& req) {
        if (!doHandshake(fd, req)) { close(fd); return; }
        std::thread([this, fd]() { clientLoop(fd); }).detach();
    });
}

void WebSocketService::run() { (void)0; }

void WebSocketService::sendText(int fd, const std::string& json) {
    auto frame = ws::encodeFrame(json, ws::Opcode::TEXT, true);
    sendRaw(fd, frame);
}

void WebSocketService::sendRaw(int fd, const std::vector<uint8_t>& data) {
    ::send(fd, reinterpret_cast<const char*>(data.data()), data.size(), 0);
}

void WebSocketService::clientLoop(int fd) {
    int64_t userId = -1;
    bool authed = false;
    std::vector<uint8_t> buf;
    char tmp[4096];

    while (running_) {
        pollfd pfd{fd, POLLIN, 0};
        int rc = poll(&pfd, 1, 1000);
        if (rc <= 0) continue;
        ssize_t n = recv(fd, tmp, sizeof(tmp), 0);
        if (n <= 0) break;
        buf.insert(buf.end(), tmp, tmp + n);

        while (true) {
            auto res = ws::decodeFrame(buf.data(), buf.size());
            if (!res.frame || res.consumed == 0) break;
            buf.erase(buf.begin(), buf.begin() + res.consumed);
            auto& f = *res.frame;

            if (f.opcode == ws::Opcode::CLOSE) {
                auto cf = ws::closeFrame(1000, "");
                sendRaw(fd, cf);
                break;
            }
            if (f.opcode == ws::Opcode::PING) {
                auto pf = ws::encodeFrame(std::string(f.payload.begin(), f.payload.end()), ws::Opcode::PONG, true);
                sendRaw(fd, pf);
                continue;
            }
            if (f.opcode == ws::Opcode::TEXT || f.opcode == ws::Opcode::BINARY) {
                std::string text(f.payload.begin(), f.payload.end());
                handleMessage(fd, userId, authed, text);
            }
        }
    }

    if (authed && userId > 0) {
        bool fullyOffline = presence_.removeSocket(fd);
        {
            std::lock_guard<std::mutex> lock(authedMtx_);
            authed_.erase(fd);
        }
        if (fullyOffline) {
            auto u = db_.findUserById(userId);
            if (u) {
                int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
                db_.updateUser(userId, {{"online","0"},{"last_seen",std::to_string(now)}});
                if (!u->hide_online) {
                    std::ostringstream oss;
                    oss << "{\"type\":\"user_offline\",\"userId\":" << userId << "}";
                    presence_.broadcast(oss.str(), userId);
                }
            }
        }
    } else {
        presence_.removeSocket(fd);
    }
    close(fd);
}

void WebSocketService::handleMessage(int fd, int64_t& userId, bool& authed, const std::string& text) {
    std::string type;
    size_t tp = text.find("\"type\":\"");
    if (tp != std::string::npos) {
        size_t s = tp + 8;
        size_t e = text.find('"', s);
        if (e != std::string::npos) type = text.substr(s, e - s);
    }

    if (!authed) {
        if (type == "auth") {
            std::string token;
            size_t tk = text.find("\"token\":\"");
            if (tk != std::string::npos) {
                size_t s = tk + 9;
                size_t e = text.find('"', s);
                if (e != std::string::npos) token = text.substr(s, e - s);
            }
            handleAuth(fd, token, userId, authed);
        } else if (type == "ping") {
            sendText(fd, "{\"type\":\"pong\"}");
        } else {
            sendError(fd, "unauthorized", "Сначала авторизуйтесь");
        }
        return;
    }

    if (type == "ping") { sendText(fd, "{\"type\":\"pong\"}"); return; }

    auto strField = [&](const char* f) -> std::string {
        std::string key = "\"" + std::string(f) + "\":\"";
        size_t p = text.find(key);
        if (p == std::string::npos) return "";
        size_t ss = p + key.size(), ee = text.find('"', ss);
        return ee != std::string::npos ? text.substr(ss, ee - ss) : "";
    };
    auto intField = [&](const char* f) -> int64_t {
        std::string key = "\"" + std::string(f) + "\":";
        size_t p = text.find(key);
        if (p == std::string::npos) return 0;
        size_t s = p + key.size(), e = text.find_first_of(",}", s);
        if (e == std::string::npos) return 0;
        try { return std::stoll(text.substr(s, e - s)); } catch (...) { return 0; }
    };
    auto boolField = [&](const char* f) -> bool {
        std::string key = "\"" + std::string(f) + "\":";
        size_t p = text.find(key);
        if (p == std::string::npos) return false;
        size_t s = p + key.size();
        return s < text.size() && text[s] == 't';
    };

    if (type == "get_public_key") handleGetPublicKey(fd, intField("targetUserId"));
    else if (type == "start_chat") handleStartChat(fd, userId, strField("targetUserId"));
    else if (type == "create_group") handleCreateGroup(fd, userId, strField("name"), strField("members"));
    else if (type == "send_message") handleSendMessage(fd, userId, intField("chatId"), strField("content"),
        strField("iv"), strField("header"), strField("msgType"), intField("replyTo"));
    else if (type == "edit_message") handleEditMessage(fd, userId, intField("messageId"), strField("content"),
        strField("iv"), strField("header"));
    else if (type == "delete_message") handleDeleteMessage(fd, userId, intField("messageId"), boolField("forAll"));
    else if (type == "get_messages") handleGetMessages(fd, userId, intField("chatId"), strField("limit"), strField("beforeId"));
    else if (type == "typing") handleTyping(fd, userId, intField("chatId"));
    else if (type == "add_member") handleAddMember(fd, userId, intField("chatId"), intField("userId"));
    else if (type == "set_public_key") handleSetPublicKey(fd, userId, strField("publicKey"));
    else if (type == "forward_message") handleForwardMessage(fd, userId, intField("fromChatId"), intField("toChatId"),
        intField("messageId"), strField("content"), strField("iv"), strField("header"));
    else if (type == "pin_message") handlePinMessage(fd, userId, intField("chatId"), intField("messageId"), false);
    else if (type == "unpin_message") handlePinMessage(fd, userId, intField("chatId"), intField("messageId"), true);
    else if (type == "set_role") handleSetRole(fd, userId, intField("chatId"), intField("userId"), strField("role"));
    else if (type == "set_group_key") handleSetGroupKey(fd, userId, intField("chatId"), strField("wrapped"), strField("version"));
    else if (type == "get_group_key") handleGetGroupKey(fd, userId, intField("chatId"));
    else if (type == "resolve_public_id") handleResolvePublicId(fd, userId, strField("token"));
    else if (type == "create_folder") handleCreateFolder(fd, userId, strField("name"), strField("emoji"), strField("color"));
    else if (type == "delete_chat") handleDeleteChat(fd, userId, intField("chatId"), boolField("forAll"));
    else if (type == "set_privacy") handleSetPrivacy(fd, userId, boolField("hideOnline"));
    else if (type == "read_messages") handleReadMessages(fd, userId, intField("chatId"), intField("lastReadId"));
}

void WebSocketService::handleAuth(int fd, const std::string& token, int64_t& userId, bool& authed) {
    auto auth = sessionService_.verify(token);
    if (!auth.valid) {
        sendText(fd, "{\"type\":\"auth_error\",\"error\":\"Сессия недействительна\"}");
        return;
    }
    userId = auth.user.id;
    authed = true;
    {
        std::lock_guard<std::mutex> lock(authedMtx_);
        authed_[fd] = userId;
    }
    presence_.addSocket(userId, fd);
    auto u = db_.findUserById(userId);
    if (u) {
        int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
        db_.updateUser(userId, {{"online","1"},{"last_seen",std::to_string(now)}});
        if (!u->hide_online) {
            std::ostringstream oss;
            oss << "{\"type\":\"user_online\",\"userId\":" << userId << "}";
            presence_.broadcast(oss.str(), userId);
        }
    }
    std::ostringstream chats;
    chats << "{\"type\":\"chats\",\"chats\":[";
    bool first = true;
    for (int64_t cid : db_.getUserChats(userId)) {
        if (!first) chats << ",";
        first = false;
        chats << getChatWithDetailsJson(cid, userId);
    }
    chats << "]}";
    sendText(fd, chats.str());
    std::ostringstream folders;
    folders << "{\"type\":\"folders\",\"folders\":[";
    bool f1 = true;
    for (auto& fo : db_.getFolders(userId)) {
        if (!f1) folders << ",";
        f1 = false;
        folders << fo.toJson();
    }
    folders << "]}";
    sendText(fd, folders.str());
}

std::string WebSocketService::getChatWithDetailsJson(int64_t chatId, int64_t requesterId) {
    auto c = db_.findChatById(chatId);
    if (!c) return "null";
    std::ostringstream oss;
    oss << "{\"id\":" << c->id << ",\"type\":\"" << c->type << "\",\"name\":\"" << c->name << "\""
        << ",\"avatar\":\"" << c->avatar << "\",\"public_id\":\"" << c->public_id << "\""
        << ",\"owner_id\":" << c->owner_id << ",\"is_pinned\":" << c->is_pinned
        << ",\"updated_at\":" << c->updated_at << "}";
    return oss.str();
}

void WebSocketService::sendError(int fd, const std::string& error, const std::string& description) {
    std::ostringstream oss;
    oss << "{\"type\":\"error\",\"error\":\"" << error << "\",\"description\":\"" << description << "\"}";
    sendText(fd, oss.str());
}

std::string WebSocketService::serializeMessageJson(const Message& m, const User& sender) {
    std::ostringstream oss;
    oss << "{\"id\":" << m.id << ",\"chat_id\":" << m.chat_id << ",\"sender_id\":" << m.sender_id
        << ",\"sender_name\":\"" << sender.name << "\",\"sender_avatar\":\"" << sender.avatar << "\""
        << ",\"encrypted_content\":\"" << m.encrypted_content << "\",\"content\":\"" << m.encrypted_content << "\""
        << ",\"ciphertext\":\"" << m.encrypted_content << "\",\"iv\":\"" << m.iv << "\",\"header\":\"" << m.header << "\""
        << ",\"type\":\"" << m.type << "\",\"reply_to\":" << m.reply_to << ",\"forwarded_from\":" << m.forwarded_from
        << ",\"edited\":" << m.edited << ",\"deleted_for_all\":" << m.deleted_for_all
        << ",\"reactions\":" << m.reactions << ",\"pinned\":" << m.pinned
        << ",\"expires_at\":" << m.expires_at << ",\"created_at\":" << m.created_at << "}";
    return oss.str();
}

void WebSocketService::notifyChatMembers(int64_t chatId, const std::string& message, int64_t excluded) {
    auto ids = db_.getChatMemberIds(chatId);
    presence_.sendToChatMembers(ids, message, excluded);
}

void WebSocketService::handleGetPublicKey(int fd, int64_t targetUserId) {
    try {
        auto u = db_.findUserById(targetUserId);
        std::string pk = u ? u->public_key : "";
        std::ostringstream oss;
        oss << "{\"type\":\"public_key\",\"userId\":" << targetUserId << ",\"publicKey\":\"" << pk << "\"}";
        sendText(fd, oss.str());
    } catch (...) {}
}

void WebSocketService::handleStartChat(int fd, int64_t userId, const std::string& targetUserIdStr) {
    try {
        int64_t target = std::stoll(targetUserIdStr);
        if (target == userId) return;
        auto u = db_.findUserById(target);
        if (!u) return;
        int64_t det = db_.nextPrivateChatId(userId, target);
        auto existing = db_.findChatById(det);
        if (!existing) {
            Chat c; c.id = det; c.type = "private"; c.owner_id = 0;
            c = db_.addChat(c);
            int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
            db_.addChatMember({det, userId, "member", now, 0, 0, 0});
            db_.addChatMember({det, target, "member", now, 0, 0, 0});
        }
        std::ostringstream oss;
        oss << "{\"type\":\"chat_created\",\"chatId\":" << det << ",\"public_id\":\"" << db_.getPublicUserId(target) << "\"}";
        sendText(fd, oss.str());
    } catch (...) {}
}

void WebSocketService::handleCreateGroup(int fd, int64_t userId, const std::string& name, const std::string& membersJson) {
    (void)membersJson;
    Chat c; c.type = "group"; c.name = name.empty() ? "Группа" : name; c.owner_id = userId;
    c = db_.addChat(c);
    int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
    db_.addChatMember({c.id, userId, "owner", now, 0, 0, 0});
    std::ostringstream oss;
    oss << "{\"type\":\"group_created\",\"chat\":" << getChatWithDetailsJson(c.id, userId) << "}";
    sendText(fd, oss.str());
}

void WebSocketService::handleSendMessage(int fd, int64_t userId, int64_t chatId, const std::string& content,
                                         const std::string& iv, const std::string& header, const std::string& msgType,
                                         int64_t replyTo) {
    try {
        if (!db_.isChatMember(chatId, userId)) { sendError(fd, "forbidden", "Нет доступа"); return; }
        if (content.empty()) { sendError(fd, "bad_request", "Пустое сообщение"); return; }
        Message m; m.chat_id = chatId; m.sender_id = userId; m.encrypted_content = content;
        m.iv = iv; m.header = header; m.type = msgType.empty() ? "text" : msgType;
        m.reply_to = replyTo;
        m.created_at = static_cast<int64_t>(std::time(nullptr)) * 1000;
        m = db_.addMessage(m);
        auto sender = db_.findUserById(userId);
        std::string json = "{\"type\":\"new_message\",\"message\":" + serializeMessageJson(m, sender ? *sender : User()) + "}";
        notifyChatMembers(chatId, json, -1);
    } catch (...) {}
}

void WebSocketService::handleEditMessage(int fd, int64_t userId, int64_t messageId, const std::string& content,
                                         const std::string& iv, const std::string& header) {
    try {
        auto m = db_.findMessageById(messageId);
        if (!m || m->sender_id != userId) { sendError(fd, "forbidden", "Не своё сообщение"); return; }
        db_.updateMessage(messageId, {{"encrypted_content",content},{"iv",iv},{"header",header},{"edited","1"}});
        auto ids = db_.getChatMemberIds(m->chat_id);
        std::ostringstream oss;
        oss << "{\"type\":\"message_edited\",\"messageId\":" << messageId << ",\"content\":\"" << content << "\"}";
        presence_.sendToChatMembers(ids, oss.str());
    } catch (...) {}
}

void WebSocketService::handleDeleteMessage(int fd, int64_t userId, int64_t messageId, bool forAll) {
    try {
        auto m = db_.findMessageById(messageId);
        if (!m) { sendError(fd, "not_found", "Не найдено"); return; }
        if (forAll) {
            if (m->sender_id != userId) {
                auto cm = db_.getChatMember(m->chat_id, userId);
                if (!cm || (cm->role != "owner" && cm->role != "admin")) { sendError(fd, "forbidden", "Недостаточно прав"); return; }
            }
            db_.updateMessage(messageId, {{"deleted_for_all","1"},{"encrypted_content",""},{"iv",""},{"header",""},{"pinned","0"}});
            auto ids = db_.getChatMemberIds(m->chat_id);
            std::ostringstream oss;
            oss << "{\"type\":\"message_deleted\",\"messageId\":" << messageId << ",\"chatId\":" << m->chat_id << ",\"forAll\":true}";
            presence_.sendToChatMembers(ids, oss.str());
        } else {
            if (m->sender_id != userId) { sendError(fd, "forbidden", "Не своё"); return; }
            db_.deleteMessage(messageId);
            auto ids = db_.getChatMemberIds(m->chat_id);
            std::ostringstream oss;
            oss << "{\"type\":\"message_deleted\",\"messageId\":" << messageId << ",\"chatId\":" << m->chat_id << ",\"forAll\":false}";
            presence_.sendToChatMembers(ids, oss.str());
        }
    } catch (...) {}
}

void WebSocketService::handleGetMessages(int fd, int64_t userId, int64_t chatId, const std::string& limitStr,
                                         const std::string& beforeIdStr) {
    try {
        if (!db_.isChatMember(chatId, userId)) { sendError(fd, "forbidden", "Нет доступа"); return; }
        int limit = limitStr.empty() ? 50 : std::stoi(limitStr);
        std::optional<int64_t> beforeId;
        if (!beforeIdStr.empty()) beforeId = std::stoll(beforeIdStr);
        auto msgs = db_.getChatMessages(chatId, limit, beforeId);
        std::ostringstream oss;
        oss << "{\"type\":\"messages\",\"chatId\":" << chatId << ",\"messages\":[";
        bool first = true;
        for (auto& m : msgs) {
            if (!first) oss << ",";
            first = false;
            auto s = db_.findUserById(m.sender_id);
            oss << serializeMessageJson(m, s ? *s : User());
        }
        oss << "],\"hasMore\":false,\"beforeId\":null}";
        sendText(fd, oss.str());
    } catch (...) {}
}

void WebSocketService::handleTyping(int fd, int64_t userId, int64_t chatId) {
    try {
        auto ids = db_.getChatMemberIds(chatId);
        auto u = db_.findUserById(userId);
        std::string name = u ? u->name : "";
        std::ostringstream oss;
        oss << "{\"type\":\"typing\",\"chatId\":" << chatId << ",\"userId\":" << userId << ",\"name\":\"" << name << "\"}";
        presence_.sendToChatMembers(ids, oss.str(), userId);
    } catch (...) {}
}

void WebSocketService::handleAddMember(int fd, int64_t userId, int64_t chatId, int64_t targetUid) {
    try {
        if (!db_.isChatMember(chatId, userId)) { sendError(fd, "forbidden", "Нет доступа"); return; }
        if (!db_.isChatMember(chatId, targetUid)) {
            int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
            db_.addChatMember({chatId, targetUid, "member", now, 0, 0, 0});
        }
        auto ids = db_.getChatMemberIds(chatId);
        std::ostringstream oss;
        oss << "{\"type\":\"member_added\",\"chatId\":" << chatId << "}";
        presence_.sendToChatMembers(ids, oss.str());
    } catch (...) {}
}

void WebSocketService::handleSetPublicKey(int fd, int64_t userId, const std::string& publicKey) {
    try { db_.updateUser(userId, {{"public_key", publicKey}}); } catch (...) {}
}

void WebSocketService::handleForwardMessage(int fd, int64_t userId, int64_t fromChatId, int64_t toChatId,
                                            int64_t messageId, const std::string& content, const std::string& iv,
                                            const std::string& header) {
    try {
        if (!db_.isChatMember(fromChatId, userId) || !db_.isChatMember(toChatId, userId)) { sendError(fd, "forbidden", "Нет доступа"); return; }
        Message m; m.chat_id = toChatId; m.sender_id = userId; m.encrypted_content = content;
        m.iv = iv; m.header = header; m.type = "text"; m.forwarded_from = messageId;
        m.created_at = static_cast<int64_t>(std::time(nullptr)) * 1000;
        m = db_.addMessage(m);
        auto sender = db_.findUserById(userId);
        std::string json = "{\"type\":\"new_message\",\"message\":" + serializeMessageJson(m, sender ? *sender : User()) + "}";
        notifyChatMembers(toChatId, json, -1);
    } catch (...) {}
}

void WebSocketService::handlePinMessage(int fd, int64_t userId, int64_t chatId, int64_t messageId, bool unpin) {
    try {
        db_.updateMessage(messageId, {{"pinned", unpin ? "0" : "1"}});
        auto ids = db_.getChatMemberIds(chatId);
        std::ostringstream oss;
        oss << "{\"type\":\"message_pinned\",\"messageId\":" << messageId << ",\"chatId\":" << chatId << ",\"pinned\":" << (!unpin) << "}";
        presence_.sendToChatMembers(ids, oss.str());
    } catch (...) {}
}

void WebSocketService::handleSetRole(int fd, int64_t userId, int64_t chatId, int64_t targetUid, const std::string& role) {
    try {
        auto cm = db_.getChatMember(chatId, userId);
        if (!cm || (cm->role != "owner" && cm->role != "admin")) { sendError(fd, "forbidden", "Недостаточно прав"); return; }
        db_.updateChatMember(chatId, targetUid, {{"role", role}});
        auto ids = db_.getChatMemberIds(chatId);
        std::ostringstream oss;
        oss << "{\"type\":\"member_role_changed\",\"chatId\":" << chatId << ",\"userId\":" << targetUid << ",\"role\":\"" << role << "\"}";
        presence_.sendToChatMembers(ids, oss.str());
    } catch (...) {}
}

void WebSocketService::handleSetGroupKey(int fd, int64_t userId, int64_t chatId, const std::string& wrappedJson, const std::string& versionStr) {
    try {
        int ver = versionStr.empty() ? 1 : std::stoi(versionStr);
        db_.saveGroupKey(chatId, ver, wrappedJson, userId);
        auto ids = db_.getChatMemberIds(chatId);
        std::ostringstream oss;
        oss << "{\"type\":\"group_key\",\"chatId\":" << chatId << ",\"version\":" << ver << ",\"wrapped\":" << wrappedJson << "}";
        presence_.sendToChatMembers(ids, oss.str());
    } catch (...) {}
}

void WebSocketService::handleGetGroupKey(int fd, int64_t userId, int64_t chatId) {
    try {
        if (!db_.isChatMember(chatId, userId)) { sendError(fd, "forbidden", "Нет доступа"); return; }
        auto gk = db_.findGroupKey(chatId);
        std::ostringstream oss;
        if (gk) oss << "{\"type\":\"group_key\",\"chatId\":" << chatId << ",\"version\":" << gk->version
                    << ",\"wrapped\":" << gk->wrapped << ",\"createdBy\":" << gk->created_by << "}";
        else oss << "{\"type\":\"group_key\",\"chatId\":" << chatId << ",\"version\":0,\"wrapped\":{}}";
        sendText(fd, oss.str());
    } catch (...) {}
}

void WebSocketService::handleResolvePublicId(int fd, int64_t userId, const std::string& token) {
    (void)userId;
    try {
        auto r = db_.resolvePublicToken(token);
        if (!r) { sendText(fd, "{\"type\":\"not_found\"}"); return; }
        std::ostringstream oss;
        if (r->isUser) oss << "{\"type\":\"public_resolved\",\"token\":\"" << token << "\",\"userId\":" << r->id << "}";
        else oss << "{\"type\":\"public_resolved\",\"token\":\"" << token << "\",\"chatId\":" << r->id << "}";
        sendText(fd, oss.str());
    } catch (...) {}
}

void WebSocketService::handleCreateFolder(int fd, int64_t userId, const std::string& name, const std::string& emoji, const std::string& color) {
    try {
        auto fo = db_.createFolder(userId, name, emoji, color);
        std::ostringstream oss;
        oss << "{\"type\":\"folder_created\",\"folder\":" << fo.toJson() << "}";
        sendText(fd, oss.str());
    } catch (...) {}
}

void WebSocketService::handleDeleteChat(int fd, int64_t userId, int64_t chatId, bool forAll) {
    try {
        if (!forAll) {
            db_.hideChatForUser(chatId, userId);
            sendText(fd, "{\"type\":\"chat_deleted\",\"chatId\":" + std::to_string(chatId) + ",\"forAll\":false}");
            return;
        }
        db_.deleteChat(chatId);
        sendText(fd, "{\"type\":\"chat_deleted\",\"chatId\":" + std::to_string(chatId) + ",\"forAll\":true}");
    } catch (...) {}
}

void WebSocketService::handleSetPrivacy(int fd, int64_t userId, bool hideOnline) {
    try {
        db_.updateUser(userId, {{"hide_online", hideOnline ? "1" : "0"}});
        sendText(fd, "{\"type\":\"privacy_updated\",\"hideOnline\":" + std::string(hideOnline ? "true" : "false") + "}");
    } catch (...) {}
}

void WebSocketService::handleReadMessages(int fd, int64_t userId, int64_t chatId, int64_t lastReadId) {
    (void)fd;
    try {
        auto cm = db_.getChatMember(chatId, userId);
        if (!cm) return;
        if ((cm->last_read_message_id) >= lastReadId) return;
        db_.updateChatMember(chatId, userId, {{"last_read_message_id", std::to_string(lastReadId)}});
        auto ids = db_.getChatMemberIds(chatId);
        std::ostringstream oss;
        oss << "{\"type\":\"messages_read\",\"chatId\":" << chatId << ",\"userId\":" << userId << ",\"lastReadId\":" << lastReadId << "}";
        presence_.sendToChatMembers(ids, oss.str());
    } catch (...) {}
}

} // namespace cipher
