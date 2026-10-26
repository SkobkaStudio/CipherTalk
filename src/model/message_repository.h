// =============================================================================
//  model/message_repository.h — сообщения, реакции, вложения, закреп (MODEL)
// =============================================================================
//  Ключевая идея E2EE на уровне модели: поле content хранит НЕ текст, а
//  «контейнер» — JSON {"iv": "...", "ct": "..."} (base64). Сервер не имеет
//  приватных ключей и физически не может его прочитать. Поэтому здесь нет
//  полнотекстового поиска по содержимому — только метаданные (кто, когда, в какой чат).
// =============================================================================
#pragma once
#include <string>
#include <vector>
#include <ctime>
#include "database.h"
#include "../utils/json.h"
#include "../utils/crypto.h"

class MessageRepository {
public:
    explicit MessageRepository(Database& db) : db_(db) {}

    // --------------------------- СОЗДАНИЕ --------------------------------------
    // senderId, chatId, contentType ('encrypted'|'text'|'service'), content, replyTo
    long long create(long long chatId, long long senderId, const std::string& contentType,
                     const std::string& content, long long replyTo = 0) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "INSERT INTO messages(chat_id,sender_id,content_type,content,reply_to,created_at,hash)"
            " VALUES(?,?,?,?,?,?,?)", -1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId);
        if(senderId) sqlite3_bind_int64(st,2,senderId); else sqlite3_bind_null(st,2);
        sqlite3_bind_text(st,3,contentType.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,4,content.c_str(),-1,SQLITE_TRANSIENT);
        if(replyTo) sqlite3_bind_int64(st,5,replyTo); else sqlite3_bind_null(st,5);
        sqlite3_bind_int64(st,6,(long long)time(nullptr));
        std::string h=crypto::sha256Hex(content);
        sqlite3_bind_text(st,7,h.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_step(st); sqlite3_finalize(st);
        return db_.lastInsertId();
    }

    // --------------------------- ЧТЕНИЕ ----------------------------------------
    // История чата: limit сообщений, id <= beforeId (пагинация «скролл вверх»).
    // Возвращаем в обратном порядке (сначала новые), фронт сам перевернёт.
    Json list(long long chatId, int limit, long long beforeId) {
        Json arr = Json::array();
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "SELECT m.id,m.chat_id,m.sender_id,u.name,u.avatar,m.content_type,m.content,"
            " m.reply_to,m.edited_at,m.deleted,m.created_at,m.hash,"
            " (SELECT COUNT(*) FROM message_views v WHERE v.message_id=m.id) AS views "
            "FROM messages m LEFT JOIN users u ON u.id=m.sender_id "
            "WHERE m.chat_id=? AND m.id<=? ORDER BY m.id DESC LIMIT ?",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId);
        sqlite3_bind_int64(st,2,beforeId?beforeId:0x7FFFFFFFFFFFFFFFLL);
        sqlite3_bind_int(st,3,limit);
        while (sqlite3_step(st)==SQLITE_ROW) {
            auto t=[&](int i)->std::string{auto p=sqlite3_column_text(st,i);return p?(const char*)p:"";};
            Json j=Json::object();
            j["id"]=sqlite3_column_int64(st,0);
            j["chat_id"]=sqlite3_column_int64(st,1);
            j["sender_id"]=sqlite3_column_int64(st,2);
            j["sender_name"]=t(3);
            j["sender_avatar"]=t(4);
            j["content_type"]=t(5);
            j["content"]=t(6);           // зашифрованный контейнер как есть
            j["reply_to"]=sqlite3_column_int64(st,7);
            j["edited_at"]=sqlite3_column_int64(st,8);
            j["deleted"]=sqlite3_column_int(st,9)!=0;
            j["created_at"]=sqlite3_column_int64(st,10);
            j["hash"]=t(11);
            j["views"]=sqlite3_column_int64(st,12);
            j["reactions"]=reactionsFor(j["id"].asInt()); // группировка эмодзи -> [{emoji,count,mine}]
            arr.push_back(j);
        }
        sqlite3_finalize(st);
        return arr;
    }

    Json byId(long long id) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "SELECT m.id,m.chat_id,m.sender_id,u.name,m.content_type,m.content,m.reply_to,"
            " m.edited_at,m.deleted,m.created_at,m.hash FROM messages m "
            "LEFT JOIN users u ON u.id=m.sender_id WHERE m.id=?", -1,&st,nullptr);
        sqlite3_bind_int64(st,1,id);
        Json j=Json::object();
        if (sqlite3_step(st)==SQLITE_ROW){
            auto t=[&](int i)->std::string{auto p=sqlite3_column_text(st,i);return p?(const char*)p:"";};
            j["id"]=sqlite3_column_int64(st,0); j["chat_id"]=sqlite3_column_int64(st,1);
            j["sender_id"]=sqlite3_column_int64(st,2); j["sender_name"]=t(3);
            j["content_type"]=t(4); j["content"]=t(5); j["reply_to"]=sqlite3_column_int64(st,6);
            j["edited_at"]=sqlite3_column_int64(st,7); j["deleted"]=sqlite3_column_int(st,8)!=0;
            j["created_at"]=sqlite3_column_int64(st,9); j["hash"]=t(10);
        }
        sqlite3_finalize(st);
        return j;
    }

    // --------------------------- РЕДАКТИРОВАНИЕ ---------------------------------
    // Обновить можно только своё сообщение. Проверяем hash старого содержимого,
    // чтобы исключить гонку («редактирую то, что уже изменил с другого устройства»).
    bool edit(long long msgId, long long userId, const std::string& newContent) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "UPDATE messages SET content=?, hash=?, edited_at=? WHERE id=? AND sender_id=? AND deleted=0",
            -1,&st,nullptr);
        sqlite3_bind_text(st,1,newContent.c_str(),-1,SQLITE_TRANSIENT);
        std::string h=crypto::sha256Hex(newContent);
        sqlite3_bind_text(st,2,h.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,3,(long long)time(nullptr));
        sqlite3_bind_int64(st,4,msgId); sqlite3_bind_int64(st,5,userId);
        sqlite3_step(st); sqlite3_finalize(st);
        return true;
    }

    // --------------------------- УДАЛЕНИЕ ---------------------------------------
    // Soft-delete: строку оставляем, ставим deleted=1 (в TG «Сообщение удалено»).
    void softDelete(long long msgId, long long userId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"UPDATE messages SET deleted=1, content='' WHERE id=? AND sender_id=?",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,msgId); sqlite3_bind_int64(st,2,userId);
        sqlite3_step(st); sqlite3_finalize(st);
    }
    // Hard-delete для всех участников (владелец чата может «стереть историю»)
    void deleteAllInChat(long long chatId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"DELETE FROM messages WHERE chat_id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId);
        sqlite3_step(st); sqlite3_finalize(st);
    }

    // --------------------------- РЕАКЦИИ -----------------------------------------
    void toggleReaction(long long msgId, long long userId, const std::string& emoji) {
        sqlite3_stmt* st=nullptr;
        // сначала пробуем удалить существующую реакцию (это «снятие» реакции)...
        sqlite3_prepare_v2(db_.raw(),"DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,msgId); sqlite3_bind_int64(st,2,userId);
        sqlite3_bind_text(st,3,emoji.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_step(st); sqlite3_finalize(st);
        int changed = sqlite3_changes(db_.raw());      // ...сразу после step читаем число изменённых строк
        if (!changed) {                                // если удалять было нечего — вставляем новую
            sqlite3_prepare_v2(db_.raw(),"INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)",
                -1,&st,nullptr);
            sqlite3_bind_int64(st,1,msgId); sqlite3_bind_int64(st,2,userId);
            sqlite3_bind_text(st,3,emoji.c_str(),-1,SQLITE_TRANSIENT);
            sqlite3_step(st); sqlite3_finalize(st);
        }
    }
    // Группировка: [{"emoji":"👍","count":2}, ...] — список «моих» реакций добавляет контроллер
    Json reactionsFor(long long msgId) {
        Json arr=Json::array();
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "SELECT emoji, COUNT(*) FROM reactions WHERE message_id=? GROUP BY emoji ORDER BY COUNT(*) DESC",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,msgId);
        while (sqlite3_step(st)==SQLITE_ROW){
            Json j=Json::object();
            j["emoji"]=(const char*)sqlite3_column_text(st,0);
            j["count"]=sqlite3_column_int64(st,1);
            arr.push_back(j);
        }
        sqlite3_finalize(st);
        return arr;
    }
    // Пометка «моя реакция» добавляется контроллером, где известен userId
    bool hasReaction(long long msgId, long long userId, const std::string& emoji){
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,msgId); sqlite3_bind_int64(st,2,userId);
        sqlite3_bind_text(st,3,emoji.c_str(),-1,SQLITE_TRANSIENT);
        bool ok=sqlite3_step(st)==SQLITE_ROW;
        sqlite3_finalize(st);
        return ok;
    }

    // --------------------------- ПРОСМОТРЫ (галочки ✓✓) --------------------------
    void markViewed(long long msgId, long long userId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "INSERT OR IGNORE INTO message_views(message_id,user_id,viewed_at) VALUES(?,?,?)",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,msgId); sqlite3_bind_int64(st,2,userId);
        sqlite3_bind_int64(st,3,(long long)time(nullptr));
        sqlite3_step(st); sqlite3_finalize(st);
    }

    // Отметить ПРОЧТЁННЫМИ все сообщения чата до теку момента (для ✓✓ в личке).
    // Вызывается из WsController когда собеседник открыл/активировал чат.
    void markReadAll(long long chatId, long long userId) {
        sqlite3_stmt* st = nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "INSERT OR IGNORE INTO message_views(message_id,user_id,viewed_at) "
            "SELECT id,?,? FROM messages WHERE chat_id=? AND sender_id!=? AND deleted=0",
            -1, &st, nullptr);
        sqlite3_bind_int64(st, 1, userId);
        sqlite3_bind_int64(st, 2, (long long)time(nullptr));
        sqlite3_bind_int64(st, 3, chatId);
        sqlite3_bind_int64(st, 4, userId);
        sqlite3_step(st); sqlite3_finalize(st);
    }

    // --------------------------- ЗАКРЕПЛЁННЫЕ СООБЩЕНИЯ ---------------------------
    void pin(long long chatId, long long msgId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"INSERT OR IGNORE INTO pinned(chat_id,message_id) VALUES(?,?)",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId); sqlite3_bind_int64(st,2,msgId);
        sqlite3_step(st); sqlite3_finalize(st);
    }
    void unpin(long long chatId, long long msgId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"DELETE FROM pinned WHERE chat_id=? AND message_id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId); sqlite3_bind_int64(st,2,msgId);
        sqlite3_step(st); sqlite3_finalize(st);
    }
    Json pinnedList(long long chatId) {
        Json arr=Json::array();
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "SELECT m.id,m.content,m.content_type,m.sender_id,u.name,m.created_at "
            "FROM pinned p JOIN messages m ON m.id=p.message_id "
            "LEFT JOIN users u ON u.id=m.sender_id WHERE p.chat_id=? ORDER BY m.id DESC",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId);
        while (sqlite3_step(st)==SQLITE_ROW){
            auto t=[&](int i)->std::string{auto p=sqlite3_column_text(st,i);return p?(const char*)p:"";};
            Json j=Json::object();
            j["id"]=sqlite3_column_int64(st,0); j["content"]=t(1); j["content_type"]=t(2);
            j["sender_id"]=sqlite3_column_int64(st,3); j["sender_name"]=t(4);
            j["created_at"]=sqlite3_column_int64(st,5);
            arr.push_back(j);
        }
        sqlite3_finalize(st);
        return arr;
    }

private:
    Database& db_;
};
