#include "ChatController.h"
#include "WsController.h"
#include "Json.h"
#include <cstdlib>
#include <optional>

namespace {
// Безопасный парсинг id из URL: без исключений, с ограничением диапазона.
std::optional<long long> parseId(const std::string& s) {
    if (s.empty() || s.size() > 18) return std::nullopt;
    for (char c : s) if (c < '0' || c > '9') return std::nullopt;
    return static_cast<long long>(strtoll(s.c_str(), nullptr, 10));
}
} // namespace

ChatController::ChatController(AuthController& auth, WsController& ws)
    : auth_(auth), ws_(ws) {}

void ChatController::registerRoutes(http::Server& server) {
    server.get("/api/chats", [this](http::Request& req) { return handleListChats(req); });
    server.post("/api/chats", [this](http::Request& req) { return handleCreateChat(req); });
    server.post("/api/chats/:id/members", [this](http::Request& req) { return handleAddMember(req); });
    server.get("/api/chats/:id/messages", [this](http::Request& req) { return handleMessages(req); });
}

bool ChatController::parseChatId(const http::Request& req, long long& out) const {
    auto id = parseId(req.param("id"));
    if (!id) return false;
    out = *id;
    return true;
}

http::Response ChatController::handleListChats(http::Request& req) {
    Principal p;
    if (!auth_.authenticate(req, p)) return http::Response::error(401, "unauthorized");

    json::Array chats;
    for (long long chat_id : auth_.db().chatIdsForUser(p.user_id)) {
        auto chat = auth_.db().findChat(chat_id);
        if (!chat) continue;
        json::Object c;
        c["id"] = json::Value(chat->id);
        c["type"] = json::Value(chat->type);
        c["title"] = chat->title.empty() ? json::Value(nullptr) : json::Value(chat->title);
        chats.push_back(json::Value(c));
    }
    return http::Response::json(200, json::Value(chats).dump());
}

// POST /api/chats  body: {"type":"group","title":"..."}  или  {"with_user_id":N} для private
http::Response ChatController::handleCreateChat(http::Request& req) {
    Principal p;
    if (!auth_.authenticate(req, p)) return http::Response::error(401, "unauthorized");

    json::Value body;
    try {
        body = json::parse(req.body);
    } catch (const std::exception&) {
        return http::Response::error(400, "invalid JSON body");
    }
    if (!body.isObject()) return http::Response::error(400, "body must be an object");

    Database& db = auth_.db();
    long long chat_id = 0;

    if (body.has("with_user_id") && body["with_user_id"].isNumber()) {
        long long other = body["with_user_id"].asInt();
        if (other == p.user_id) return http::Response::error(400, "cannot chat with yourself");
        auto other_user = db.findUserById(other);
        if (!other_user) return http::Response::error(404, "user not found");
        chat_id = db.ensurePrivateChat(p.user_id, other);
    } else {
        std::string type = "group";
        if (body.has("type") && body["type"].isString()) type = body["type"].asString();
        if (type != "group" && type != "private") return http::Response::error(400, "invalid chat type");
        std::string title;
        if (body.has("title") && body["title"].isString()) title = body["title"].asString();
        if (type == "group" && title.empty()) return http::Response::error(400, "group chat requires title");
        if (title.size() > 128) return http::Response::error(400, "title too long");
        chat_id = db.createChat(type, title);
        db.addChatMember(chat_id, p.user_id);
    }

    ws_.joinChat(chat_id, p.user_id); // создатель сразу в комнате

    json::Object resp;
    resp["chat_id"] = json::Value(chat_id);
    return http::Response::json(201, json::Value(resp).dump());
}

// POST /api/chats/:id/members  body: {"user_id":N} — добавить участника может только участник.
http::Response ChatController::handleAddMember(http::Request& req) {
    Principal p;
    if (!auth_.authenticate(req, p)) return http::Response::error(401, "unauthorized");

    long long chat_id;
    if (!parseChatId(req, chat_id)) return http::Response::error(400, "invalid chat id");

    Database& db = auth_.db();
    if (!db.findChat(chat_id)) return http::Response::error(404, "chat not found");
    if (!db.isChatMember(chat_id, p.user_id)) return http::Response::error(403, "not a chat member");

    json::Value body;
    try {
        body = json::parse(req.body);
    } catch (const std::exception&) {
        return http::Response::error(400, "invalid JSON body");
    }
    if (!body.isObject() || !body.has("user_id") || !body["user_id"].isNumber())
        return http::Response::error(400, "user_id required");

    long long user_id = body["user_id"].asInt();
    if (!db.findUserById(user_id)) return http::Response::error(404, "user not found");

    db.addChatMember(chat_id, user_id);
    ws_.joinChat(chat_id, user_id);
    return http::Response::json(200, "{\"ok\":true}");
}

// --- Шаг 4: GET /api/chats/:id/messages?limit=50&before_id=N ---
http::Response ChatController::handleMessages(http::Request& req) {
    Principal p;
    if (!auth_.authenticate(req, p)) return http::Response::error(401, "unauthorized");

    long long chat_id;
    if (!parseChatId(req, chat_id)) return http::Response::error(400, "invalid chat id");

    Database& db = auth_.db();
    if (!db.findChat(chat_id)) return http::Response::error(404, "chat not found");
    // Не в чате => 403 (как требует чек-лист)
    if (!db.isChatMember(chat_id, p.user_id)) return http::Response::error(403, "not a chat member");

    int limit = 50;
    int before_id = 0;
    if (!req.qparam("limit").empty()) {
        auto v = parseId(req.qparam("limit"));
        if (!v || *v <= 0 || *v > 500) return http::Response::error(400, "invalid limit");
        limit = static_cast<int>(*v);
    }
    if (!req.qparam("before_id").empty()) {
        auto v = parseId(req.qparam("before_id"));
        if (!v || *v < 0) return http::Response::error(400, "invalid before_id");
        before_id = static_cast<int>(*v > 2147483647LL ? 2147483647LL : *v);
    }

    auto rows = db.getChatMessages(static_cast<int>(chat_id), limit, before_id);
    json::Array messages;
    for (const auto& m : rows) {
        json::Object o;
        o["id"] = json::Value(m.id);
        o["chat_id"] = json::Value(m.chat_id);
        o["sender_id"] = json::Value(m.sender_id);
        o["content"] = json::Value(m.content);
        o["timestamp"] = json::Value(m.timestamp);
        messages.push_back(json::Value(o));
    }
    return http::Response::json(200, json::Value(messages).dump());
}
