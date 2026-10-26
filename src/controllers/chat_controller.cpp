#include "chat_controller.h"
#include "../config/config.h"
#include "../utils/utils.h"
#include "../utils/mask.h"
#include "../utils/crowns.h"
#include "../services/ice_service.h"
#include <ctime>
#include <sstream>
#include <iostream>
#include <fstream>
#include <sys/stat.h>
#include <random>

namespace cipher {

namespace {
static std::string jfieldStr(const std::string& json, const char* field) {
    std::string key = "\"" + std::string(field) + "\":\"";
    size_t p = json.find(key);
    if (p == std::string::npos) return "";
    size_t s = p + key.size(), e = json.find('"', s);
    return e != std::string::npos ? json.substr(s, e - s) : "";
}
static int64_t jfieldInt(const std::string& json, const char* field) {
    std::string key = "\"" + std::string(field) + "\":";
    size_t p = json.find(key);
    if (p == std::string::npos) return 0;
    size_t s = p + key.size(), e = json.find_first_of(",}", s);
    if (e == std::string::npos) return 0;
    try { return std::stoll(json.substr(s, e - s)); } catch (...) { return 0; }
}
static std::string qparam(const std::string& query, const char* key) {
    std::string k = std::string(key) + "=";
    size_t p = query.find(k);
    if (p == std::string::npos) return "";
    size_t s = p + k.size(), e = query.find('&', s);
    if (e == std::string::npos) e = query.size();
    return query.substr(s, e - s);
}
}

ChatController::ChatController() : db_(Database::instance()) {}

void ChatController::getUserChats(const HttpRequest& req, HttpResponse& res) {
    try {
        int64_t userId = jfieldInt(req.headers.count("X-User-Id") ? req.headers.at("X-User-Id") : "0", "X-User-Id");
        // На самом деле userId из заголовка
        auto it = req.headers.find("X-User-Id");
        if (it == req.headers.end()) { res.status = 401; res.body = "{\"error\":\"Не авторизован\"}"; return; }
        userId = std::stoll(it->second);

        std::ostringstream oss;
        oss << "{\"chats\":[";
        bool first = true;
        for (int64_t cid : db_.getUserChats(userId)) {
            auto c = db_.findChatById(cid);
            if (!c) continue;
            if (!first) oss << ",";
            first = false;
            oss << "{\"id\":" << c->id << ",\"type\":\"" << c->type << "\",\"name\":\"" << c->name << "\""
                << ",\"avatar\":\"" << c->avatar << "\",\"public_id\":\"" << c->public_id << "\""
                << ",\"updated_at\":" << c->updated_at << "}";
        }
        oss << "]}";
        res.body = oss.str();
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка получения чатов\"}";
    }
}

void ChatController::getMessages(const HttpRequest& req, HttpResponse& res) {
    try {
        auto it = req.headers.find("X-User-Id");
        if (it == req.headers.end()) { res.status = 401; res.body = "{\"error\":\"Не авторизован\"}"; return; }
        int64_t userId = std::stoll(it->second);
        int64_t chatId = jfieldInt(req.path, "chatId"); // путь /api/messages/:chatId — не удобно, лучше query
        // chatId из пути: мы парсим в main, здесь использовать query param
        std::string chatIdStr = qparam(req.query, "chatId");
        if (chatIdStr.empty()) { res.status = 400; res.body = "{\"error\":\"chatId\"}"; return; }
        chatId = std::stoll(chatIdStr);

        if (!db_.isChatMember(chatId, userId)) { res.status = 403; res.body = "{\"error\":\"Нет доступа\"}"; return; }
        int limit = 50;
        auto lq = qparam(req.query, "limit");
        if (!lq.empty()) limit = std::stoi(lq);
        auto msgs = db_.getChatMessages(chatId, limit);
        std::ostringstream oss;
        oss << "[";
        bool first = true;
        for (auto& m : msgs) {
            if (!first) oss << ",";
            first = false;
            auto s = db_.findUserById(m.sender_id);
            oss << "{\"id\":" << m.id << ",\"sender_id\":" << m.sender_id
                << ",\"sender_name\":\"" << (s ? s->name : "") << "\",\"encrypted_content\":\"" << m.encrypted_content << "\""
                << ",\"iv\":\"" << m.iv << "\",\"header\":\"" << m.header << "\",\"type\":\"" << m.type << "\""
                << ",\"created_at\":" << m.created_at << "}";
        }
        oss << "]";
        res.body = oss.str();
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка получения сообщений\"}";
    }
}

void ChatController::getPinnedMessages(const HttpRequest& req, HttpResponse& res) {
    (void)req;
    res.body = "[]";
}

void ChatController::createGroup(const HttpRequest& req, HttpResponse& res) {
    try {
        auto it = req.headers.find("X-User-Id");
        if (it == req.headers.end()) { res.status = 401; res.body = "{\"error\":\"Не авторизован\"}"; return; }
        int64_t userId = std::stoll(it->second);
        std::string name = jfieldStr(req.body, "name");
        Chat c; c.type = "group"; c.name = name.empty() ? "Группа" : name; c.owner_id = userId;
        c = db_.addChat(c);
        int64_t now = static_cast<int64_t>(std::time(nullptr)) * 1000;
        db_.addChatMember({c.id, userId, "owner", now, 0, 0, 0});
        std::ostringstream oss;
        oss << "{\"id\":" << c.id << ",\"type\":\"" << c.type << "\",\"name\":\"" << c.name << "\""
            << ",\"public_id\":\"" << c.public_id << "\"}";
        res.body = oss.str();
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка создания группы\"}";
    }
}

void ChatController::addMember(const HttpRequest& req, HttpResponse& res) {
    (void)req;
    res.body = "{\"success\":true}";
}

void ChatController::getFolders(const HttpRequest& req, HttpResponse& res) {
    try {
        auto it = req.headers.find("X-User-Id");
        if (it == req.headers.end()) { res.status = 401; res.body = "{\"error\":\"Не авторизован\"}"; return; }
        int64_t userId = std::stoll(it->second);
        std::ostringstream oss;
        oss << "{\"folders\":[";
        bool first = true;
        for (auto& fo : db_.getFolders(userId)) {
            if (!first) oss << ",";
            first = false;
            oss << fo.toJson();
        }
        oss << "]}";
        res.body = oss.str();
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка папок\"}";
    }
}

void ChatController::createFolder(const HttpRequest& req, HttpResponse& res) {
    try {
        auto it = req.headers.find("X-User-Id");
        if (it == req.headers.end()) { res.status = 401; return; }
        int64_t userId = std::stoll(it->second);
        std::string name = jfieldStr(req.body, "name");
        std::string emoji = jfieldStr(req.body, "emoji");
        std::string color = jfieldStr(req.body, "color");
        auto fo = db_.createFolder(userId, name, emoji, color);
        res.body = fo.toJson();
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка папки\"}";
    }
}

void ChatController::updateFolder(const HttpRequest& req, HttpResponse& res) {
    (void)req;
    res.body = "{\"success\":true}";
}

void ChatController::deleteFolder(const HttpRequest& req, HttpResponse& res) {
    (void)req;
    res.body = "{\"success\":true}";
}

void ChatController::uploadFile(const HttpRequest& req, HttpResponse& res) {
    try {
        auto it = req.headers.find("X-User-Id");
        if (it == req.headers.end()) { res.status = 401; res.body = "{\"error\":\"Не авторизован\"}"; return; }
        int64_t userId = std::stoll(it->second);
        std::string filename = req.headers.count("X-Filename") ? req.headers.at("X-Filename") : "file";
        std::string mimetype = req.headers.count("X-Content-Type") ? req.headers.at("X-Content-Type") : "application/octet-stream";

        Config cfg = loadConfig();
        ::mkdir(cfg.uploadsPath.c_str(), 0755);
        std::string unique = std::to_string(static_cast<int64_t>(std::time(nullptr)) * 1000) + "-" + utils::randomHex(8);
        std::string stored = unique + "_" + filename;
        std::string fpath = cfg.uploadsPath + "/" + stored;
        std::ofstream f(fpath, std::ios::binary);
        f.write(req.body.data(), req.body.size());
        f.close();

        File fl;
        fl.filename = stored;
        fl.original_name = filename;
        fl.size = req.body.size();
        fl.mimetype = mimetype;
        fl.uploader_id = userId;
        fl.created_at = static_cast<int64_t>(std::time(nullptr)) * 1000;
        fl = db_.addFile(fl);

        res.body = "{\"fileId\":" + std::to_string(fl.id) + ",\"filename\":\"" + fl.filename +
                   "\",\"originalName\":\"" + filename + "\",\"size\":" + std::to_string(fl.size) +
                   ",\"mimetype\":\"" + mimetype + "\",\"url\":\"/uploads/" + stored + "\"}";
    } catch (...) {
        res.status = 500;
        res.body = "{\"error\":\"Ошибка загрузки\"}";
    }
}

void ChatController::health(const HttpRequest& req, HttpResponse& res) {
    (void)req;
    std::ostringstream oss;
    oss << "{\"status\":\"ok\",\"timestamp\":" << static_cast<int64_t>(std::time(nullptr)) * 1000
        << ",\"users\":" << db_.allUsers().size()
        << ",\"chats\":" << db_.allChats().size()
        << ",\"messages\":" << db_.allMessages().size()
        << ",\"publicUrl\":null}";
    res.body = oss.str();
}

void ChatController::iceServers(const HttpRequest& req, HttpResponse& res) {
    (void)req;
    IceService ice;
    res.body = "{\"iceServers\":" + ice.getIceServersJson() + ",\"turnAvailable\":" + std::string(ice.hasTurn() ? "true" : "false") + "}";
}

} // namespace cipher
