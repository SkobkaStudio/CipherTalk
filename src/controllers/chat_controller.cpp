// ============================================================
// Реализация контроллера чатов и сообщений.
// Все эндпоинты требуют Bearer-токен. Отправка сообщения
// параллельно рассылает его через WebSocket участникам чата.
// ============================================================
#include "controllers/chat_controller.hpp"
#include "controllers/auth_controller.hpp"
#include "models/chat.hpp"
#include "models/message.hpp"
#include "models/user.hpp"
#include "services/ws_service.hpp"
#include "utils/json.hpp"

#include <cstdlib>
#include <sstream>
#include <cctype>

namespace chat_controller {

// JSON-ответ с ошибкой
static HttpResponse error(int status, const std::string& message) {
    json::JsonObject o;
    o.put("error", message);
    return HttpResponse::json(status, json::dump(o));
}

// Разобрать query-строку "a=1&b=2" в карту
static std::map<std::string, std::string> parseQuery(const std::string& q) {
    std::map<std::string, std::string> out;
    std::istringstream ss(q);
    std::string pair;
    while (std::getline(ss, pair, '&')) {
        size_t eq = pair.find('=');
        if (eq != std::string::npos)
            out[pair.substr(0, eq)] = pair.substr(eq + 1);
    }
    return out;
}

// Сериализовать пользователя в JSON-объект (без хеша пароля)
static json::JsonObject userJson(const User& u) {
    json::JsonObject o;
    o.put("id", std::to_string(u.id));
    o.put("username", u.username);
    o.put("displayName", u.displayName);
    return o;
}

// GET /api/users — список всех пользователей
HttpResponse listUsers(const HttpRequest& req) {
    HttpResponse err;
    if (auth_controller::requireAuth(req, &err) < 0) return err;

    std::string arr = "[";
    auto users = User::all();
    for (size_t i = 0; i < users.size(); ++i) {
        if (i) arr += ",";
        arr += json::dump(userJson(users[i]));
    }
    arr += "]";
    return HttpResponse::json(200, "{\"users\":" + arr + "}");
}

// GET /api/chats — чаты текущего пользователя + имена собеседников
HttpResponse listChats(const HttpRequest& req) {
    HttpResponse err;
    int64_t userId = auth_controller::requireAuth(req, &err);
    if (userId < 0) return err;

    auto chats = Chat::forUser(userId);
    std::string arr = "[";
    for (size_t i = 0; i < chats.size(); ++i) {
        const Chat& c = chats[i];
        // Имена участников для отображения в списке
        std::string names = "[";
        std::string ids = "[";
        for (size_t k = 0; k < c.participants.size(); ++k) {
            if (k) { names += ","; ids += ","; }
            ids += "\"" + std::to_string(c.participants[k]) + "\"";
            User pu;
            if (User::findById(c.participants[k], pu))
                names += "\"" + json::escape(pu.displayName) + "\"";
            else
                names += "\"?\"";
        }
        names += "]";
        ids += "]";

        // Последний комментарий для превью в списке чатов
        auto last = Message::latest(c.id, 1);
        std::string preview = last.empty() ? "" : last.back().text;

        json::JsonObject o;
        o.put("id", std::to_string(c.id));
        o.put("type", c.type);
        o.put("name", c.name);
        o.put("participants", ""); // заполним вручную ниже
        std::string body = json::dump(o);
        // Подменяем строковые поля на JSON-массивы (значения вставлены как есть)
        std::string pid = "\"participants\":\"\"";
        size_t pos = body.find(pid);
        if (pos != std::string::npos)
            body.replace(pos, pid.size(), "\"participants\":" + ids);
        std::string extra = ",\"names\":" + names + ",\"preview\":\"" + json::escape(preview) + "\"";
        // Вставляем перед закрывающей скобкой
        body.insert(body.size() - 1, extra);

        if (i) arr += ",";
        arr += body;
    }
    arr += "]";
    return HttpResponse::json(200, "{\"chats\":" + arr + "}");
}

// POST /api/chats — создать личный чат или группу
HttpResponse createChat(const HttpRequest& req) {
    HttpResponse err;
    int64_t userId = auth_controller::requireAuth(req, &err);
    if (userId < 0) return err;

    json::JsonObject body;
    if (!json::parse(req.body, body)) return error(400, "некорректный JSON");

    int64_t chatId = -1;

    // Личный чат: {"withUserId": N}
    if (body.has("withUserId")) {
        int64_t other = std::strtoll(body.get("withUserId").c_str(), nullptr, 10);
        if (other <= 0 || other == userId) return error(400, "некорректный withUserId");
        User ou;
        if (!User::findById(other, ou)) return error(404, "пользователь не найден");
        chatId = Chat::findOrCreatePrivate(userId, other);
    }
    // Групповой чат: {"name": "...", "memberIds": [..]}
    else if (body.has("name")) {
        std::string name = body.get("name");
        std::string idsRaw = body.get("memberIds"); // например "[2,3]"
        std::vector<int64_t> members;
        std::string digits;
        for (char ch : idsRaw) {
            if (std::isdigit(static_cast<unsigned char>(ch))) digits += ch;
            else if (!digits.empty()) { members.push_back(std::strtoll(digits.c_str(), nullptr, 10)); digits.clear(); }
        }
        if (!digits.empty()) members.push_back(std::strtoll(digits.c_str(), nullptr, 10));
        if (members.empty()) return error(400, "нужен хотя бы один участник");
        chatId = Chat::create("group", name, userId, members);
    } else {
        return error(400, "ожидается withUserId или name+memberIds");
    }

    if (chatId < 0) return error(500, "не удалось создать чат");

    Chat c;
    Chat::findById(chatId, c);
    json::JsonObject out;
    out.put("chatId", std::to_string(chatId));
    out.put("type", c.type);
    out.put("name", c.name);
    return HttpResponse::json(201, json::dump(out));
}

// GET /api/messages?chatId=N&limit=M — история сообщений чата
HttpResponse listMessages(const HttpRequest& req) {
    HttpResponse err;
    int64_t userId = auth_controller::requireAuth(req, &err);
    if (userId < 0) return err;

    auto q = parseQuery(req.query);
    int64_t chatId = std::strtoll(q["chatId"].c_str(), nullptr, 10);
    int limit = q.count("limit") ? static_cast<int>(std::strtol(q["limit"].c_str(), nullptr, 10)) : 100;
    if (limit <= 0 || limit > 500) limit = 100;

    if (chatId <= 0) return error(400, "не указан chatId");
    if (!Chat::hasParticipant(chatId, userId)) return error(403, "вы не состоите в этом чате");

    auto msgs = Message::latest(chatId, limit);
    std::string arr = "[";
    for (size_t i = 0; i < msgs.size(); ++i) {
        const Message& m = msgs[i];
        User su;
        std::string senderName = "?";
        std::string senderUser = "?";
        if (User::findById(m.senderId, su)) { senderName = su.displayName; senderUser = su.username; }

        json::JsonObject o;
        o.put("id", std::to_string(m.id));
        o.put("chatId", std::to_string(m.chatId));
        o.put("senderId", std::to_string(m.senderId));
        o.put("senderName", senderName);
        o.put("senderUsername", senderUser);
        o.put("text", m.text);
        o.put("createdAt", std::to_string(m.createdAt));
        if (i) arr += ",";
        arr += json::dump(o);
    }
    arr += "]";
    return HttpResponse::json(200, "{\"messages\":" + arr + "}");
}

// POST /api/messages {chatId, text} — сохранить и разослать по WebSocket
HttpResponse sendMessage(const HttpRequest& req) {
    HttpResponse err;
    int64_t userId = auth_controller::requireAuth(req, &err);
    if (userId < 0) return err;

    json::JsonObject body;
    if (!json::parse(req.body, body)) return error(400, "некорректный JSON");

    int64_t chatId = std::strtoll(body.get("chatId").c_str(), nullptr, 10);
    std::string text = body.get("text");
    // Обрезаем пробелы по краям
    size_t a = text.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return error(400, "пустое сообщение");
    text = text.substr(a, text.find_last_not_of(" \t\r\n") - a + 1);
    if (text.size() > 4000) return error(400, "сообщение слишком длинное");

    if (chatId <= 0) return error(400, "не указан chatId");
    if (!Chat::hasParticipant(chatId, userId)) return error(403, "вы не состоите в этом чате");

    int64_t msgId = Message::create(chatId, userId, text);
    if (msgId < 0) return error(500, "не удалось сохранить сообщение");

    Message m;
    Message::findById(msgId, m);
    User su;
    User::findById(userId, su);

    // Формируем событие для WebSocket-рассылки
    json::JsonObject ev;
    ev.put("type", "message");
    ev.put("id", std::to_string(m.id));
    ev.put("chatId", std::to_string(m.chatId));
    ev.put("senderId", std::to_string(m.senderId));
    ev.put("senderName", su.displayName);
    ev.put("senderUsername", su.username);
    ev.put("text", m.text);
    ev.put("createdAt", std::to_string(m.createdAt));
    std::string payload = json::dump(ev);

    // Рассылаем всем соединениям отправителя (все его вкладки)
    WsManager::instance().sendToUser(userId, payload);
    // И остальным участникам чата — real-time доставка
    Chat c;
    if (Chat::findById(chatId, c))
        WsManager::instance().sendToChat(c.participants, userId, payload);

    json::JsonObject ok;
    ok.put("ok", "true");
    ok.put("messageId", std::to_string(msgId));
    return HttpResponse::json(201, json::dump(ok));
}

} // namespace chat_controller
