// =============================================================================
//  model/chat_repository.h — чаты, группы, каналы, участники (MODEL)
// =============================================================================
//  Типы чатов (как в Telegram):
//    private — личка между двумя людьми (создаётся автоматически при «написать»)
//    group   — группа: участники могут писать, есть владелец/админы, ссылка-приглашение
//    channel — канал: пишет только владелец/админы, остальные читают
//  Непрочитанные считаются по chat_members.last_read (поле обновляет WS-контроллер).
// =============================================================================
#pragma once
#include <string>
#include <vector>
#include <ctime>
#include "database.h"
#include "../utils/json.h"
#include "../utils/crypto.h"

class ChatRepository {
public:
    explicit ChatRepository(Database& db) : db_(db) {}

    // --------------------------- СОЗДАНИЕ ЧАТОВ --------------------------------

    // Личный чат с человеком. Если диалог уже существует — вернём его id (идемпотентно).
    long long createPrivate(long long a, long long b) {
        sqlite3_stmt* st=nullptr;
        // ищем существующий private-чат, где ровно эти два участника
        sqlite3_prepare_v2(db_.raw(),
            "SELECT c.id FROM chats c JOIN chat_members m1 ON m1.chat_id=c.id AND m1.user_id=? "
            "JOIN chat_members m2 ON m2.chat_id=c.id AND m2.user_id=? WHERE c.type='private'",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,a); sqlite3_bind_int64(st,2,b);
        long long existing=0;
        if (sqlite3_step(st)==SQLITE_ROW) existing=sqlite3_column_int64(st,0);
        sqlite3_finalize(st);
        if (existing) return existing;

        long long id = insertChat("private","", "", "", 0);
        addMember(id,a,"owner");
        addMember(id,b,"member");
        return id;
    }

    // Группа: title + описание; owner становится участником с ролью owner.
    long long createGroup(long long ownerId, const std::string& title, const std::string& about) {
        std::string invite = "+" + crypto::randomToken(6); // аналог ссылки-приглашения
        long long id = insertChat("group", title, about, invite, ownerId);
        addMember(id, ownerId, "owner");
        return id;
    }
    // Канал — то же, что группа, но type='channel'
    long long createChannel(long long ownerId, const std::string& title, const std::string& about) {
        std::string invite = "+" + crypto::randomToken(6);
        long long id = insertChat("channel", title, about, invite, ownerId);
        addMember(id, ownerId, "owner");
        return id;
    }

    // --------------------------- УЧАСТНИКИ -------------------------------------
    void addMember(long long chatId, long long userId, const std::string& role="member") {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "INSERT OR IGNORE INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId); sqlite3_bind_int64(st,2,userId);
        sqlite3_bind_text(st,3,role.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,4,(long long)time(nullptr));
        sqlite3_step(st); sqlite3_finalize(st);
    }
    void removeMember(long long chatId, long long userId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"DELETE FROM chat_members WHERE chat_id=? AND user_id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId); sqlite3_bind_int64(st,2,userId);
        sqlite3_step(st); sqlite3_finalize(st);
    }
    bool isMember(long long chatId, long long userId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId); sqlite3_bind_int64(st,2,userId);
        bool ok = sqlite3_step(st)==SQLITE_ROW;
        sqlite3_finalize(st);
        return ok;
    }
    std::string roleOf(long long chatId, long long userId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"SELECT role FROM chat_members WHERE chat_id=? AND user_id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId); sqlite3_bind_int64(st,2,userId);
        std::string r="";
        if (sqlite3_step(st)==SQLITE_ROW) r=(const char*)sqlite3_column_text(st,0);
        sqlite3_finalize(st);
        return r;
    }
    void setRole(long long chatId, long long userId, const std::string& role) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"UPDATE chat_members SET role=? WHERE chat_id=? AND user_id=?",-1,&st,nullptr);
        sqlite3_bind_text(st,1,role.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,2,chatId); sqlite3_bind_int64(st,3,userId);
        sqlite3_step(st); sqlite3_finalize(st);
    }
    bool canPost(long long chatId, long long userId) {
        std::string type = chatType(chatId);
        if (type!="channel") return true;                 // в группах и личках пишут все
        std::string r = roleOf(chatId,userId);            // в канале — только owner/admin
        return r=="owner"||r=="admin";
    }

    // Список id участников — используется для WS-рассылки нового сообщения
    std::vector<long long> memberIds(long long chatId) {
        std::vector<long long> out;
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"SELECT user_id FROM chat_members WHERE chat_id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId);
        while (sqlite3_step(st)==SQLITE_ROW) out.push_back(sqlite3_column_int64(st,0));
        sqlite3_finalize(st);
        return out;
    }
    // Полная информация об участниках (для окна «Информация о группе»)
    Json membersInfo(long long chatId) {
        Json arr = Json::array();
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "SELECT u.id,u.username,u.name,u.avatar,u.online,u.last_seen,m.role "
            "FROM chat_members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? ORDER BY m.role='owner' DESC, m.role='admin' DESC, u.name",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId);
        while (sqlite3_step(st)==SQLITE_ROW) {
            Json j=Json::object();
            j["id"]=sqlite3_column_int64(st,0);
            j["username"]=(const char*)sqlite3_column_text(st,1);
            j["name"]=(const char*)sqlite3_column_text(st,2);
            j["avatar"]=(const char*)sqlite3_column_text(st,3);
            j["online"]=sqlite3_column_int(st,4)!=0;
            j["last_seen"]=sqlite3_column_int64(st,5);
            j["role"]=(const char*)sqlite3_column_text(st,6);
            arr.push_back(j);
        }
        sqlite3_finalize(st);
        return arr;
    }

    // --------------------------- ПРОСМОТР ЧАТОВ ----------------------------------
    // «Список чатов» слева как в TG: тип, название, второй участник, последнее сообщение,
    // счётчик непрочитанных. Реализовано одним SQL с подзапросами — быстро и без N+1.
    Json listForUser(long long userId) {
        Json arr = Json::array();
        sqlite3_stmt* st=nullptr;
        const char* sql =
          "SELECT c.id, c.type, c.title, c.about, c.avatar, c.owner_id, c.invite_link, "
          "  (SELECT COUNT(*) FROM messages msg WHERE msg.chat_id=c.id AND msg.deleted=0 AND msg.id > m.last_read) AS unread, "
          "  (SELECT other.id FROM chat_members om JOIN users other ON other.id=om.user_id "
          "     WHERE om.chat_id=c.id AND om.user_id != ? LIMIT 1) AS peer_id, "
          "  (SELECT other.name FROM chat_members om JOIN users other ON other.id=om.user_id "
          "     WHERE om.chat_id=c.id AND om.user_id != ? LIMIT 1) AS peer_name, "
          "  (SELECT other.avatar FROM chat_members om JOIN users other ON other.id=om.user_id "
          "     WHERE om.chat_id=c.id AND om.user_id != ? LIMIT 1) AS peer_avatar, "
          "  (SELECT other.online FROM chat_members om JOIN users other ON other.id=om.user_id "
          "     WHERE om.chat_id=c.id AND om.user_id != ? LIMIT 1) AS peer_online, "
          "  (SELECT msg.content FROM messages msg WHERE msg.chat_id=c.id AND msg.deleted=0 ORDER BY msg.id DESC LIMIT 1) AS last_content, "
          "  (SELECT msg.created_at FROM messages msg WHERE msg.chat_id=c.id AND msg.deleted=0 ORDER BY msg.id DESC LIMIT 1) AS last_time, "
          "  (SELECT msg.sender_id FROM messages msg WHERE msg.chat_id=c.id AND msg.deleted=0 ORDER BY msg.id DESC LIMIT 1) AS last_sender, "
          "  m.role "
          "FROM chats c JOIN chat_members m ON m.chat_id=c.id AND m.user_id=? "
          "ORDER BY (SELECT IFNULL(MAX(msg.id),0) FROM messages msg WHERE msg.chat_id=c.id) DESC";
        sqlite3_prepare_v2(db_.raw(), sql, -1, &st, nullptr);
        sqlite3_bind_int64(st,1,userId); sqlite3_bind_int64(st,2,userId);
        sqlite3_bind_int64(st,3,userId); sqlite3_bind_int64(st,4,userId);
        sqlite3_bind_int64(st,5,userId);
        while (sqlite3_step(st)==SQLITE_ROW) {
            auto textCol=[&](int i)->std::string{
                const unsigned char* p=sqlite3_column_text(st,i); return p?(const char*)p:"";
            };
            Json j=Json::object();
            j["id"]=sqlite3_column_int64(st,0);
            j["type"]=textCol(1);
            j["title"]=textCol(2);
            j["about"]=textCol(3);
            j["avatar"]=textCol(4);
            j["owner_id"]=sqlite3_column_int64(st,5);
            j["invite_link"]=textCol(6);
            j["unread"]=sqlite3_column_int64(st,7);
            j["peer_id"]=sqlite3_column_int64(st,8);
            j["peer_name"]=textCol(9);
            j["peer_avatar"]=textCol(10);
            j["peer_online"]=sqlite3_column_int(st,11)!=0;
            j["last_message_preview"]=textCol(12); // сервер НЕ умеет это расшифровать — фронт покажет 🔒
            j["last_time"]=sqlite3_column_int64(st,13);
            j["last_sender_id"]=sqlite3_column_int64(st,14);
            j["my_role"]=textCol(15);
            // Для private-чатов название берём из имени собеседника
            if (j["type"].asString()=="private" && j["peer_name"].isString())
                j["display_title"]=j["peer_name"];
            else j["display_title"]=j["title"];
            arr.push_back(j);
        }
        sqlite3_finalize(st);
        return arr;
    }

    Json info(long long chatId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "SELECT id,type,title,about,avatar,owner_id,invite_link FROM chats WHERE id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId);
        Json j=Json::object();
        if (sqlite3_step(st)==SQLITE_ROW){
            auto t=[&](int i)->std::string{auto p=sqlite3_column_text(st,i);return p?(const char*)p:"";};
            j["id"]=sqlite3_column_int64(st,0); j["type"]=t(1); j["title"]=t(2);
            j["about"]=t(3); j["avatar"]=t(4); j["owner_id"]=sqlite3_column_int64(st,5);
            j["invite_link"]=t(6);
        }
        sqlite3_finalize(st);
        return j;
    }
    std::string chatType(long long chatId){ return info(chatId)["type"].asString(); }

    // Поиск чата по ссылке-приглашению (функция «присоединиться по ссылке»)
    long long findByInvite(const std::string& link) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"SELECT id FROM chats WHERE invite_link=?",-1,&st,nullptr);
        sqlite3_bind_text(st,1,link.c_str(),-1,SQLITE_TRANSIENT);
        long long id=0;
        if (sqlite3_step(st)==SQLITE_ROW) id=sqlite3_column_int64(st,0);
        sqlite3_finalize(st);
        return id;
    }

    void updateInfo(long long chatId, const std::string& title, const std::string& about) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"UPDATE chats SET title=?, about=? WHERE id=?",-1,&st,nullptr);
        sqlite3_bind_text(st,1,title.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,2,about.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,3,chatId);
        sqlite3_step(st); sqlite3_finalize(st);
    }
    void deleteChat(long long chatId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"DELETE FROM chats WHERE id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId);
        sqlite3_step(st); sqlite3_finalize(st);
    }

    // Прочтение: сдвигаем last_read до максимального id в чате -> «непрочитанные» обнуляются
    void markRead(long long chatId, long long userId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "UPDATE chat_members SET last_read=(SELECT IFNULL(MAX(id),0) FROM messages WHERE chat_id=?)"
            " WHERE chat_id=? AND user_id=?",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId); sqlite3_bind_int64(st,2,chatId); sqlite3_bind_int64(st,3,userId);
        sqlite3_step(st); sqlite3_finalize(st);
    }

private:
    Database& db_;

    long long insertChat(const std::string& type, const std::string& title,
                         const std::string& about, const std::string& invite, long long ownerId) {
        sqlite3_stmt* st=nullptr;
        static const char* colors[]={"#e17076","#eda86c","#a58ac9","#6fb1e0","#7bc862","#6ec9cb"};
        sqlite3_prepare_v2(db_.raw(),
            "INSERT INTO chats(type,title,about,avatar,owner_id,invite_link,created_at) VALUES(?,?,?,?,?,?,?)",
            -1,&st,nullptr);
        sqlite3_bind_text(st,1,type.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,2,title.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,3,about.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,4,colors[rand()%6],-1,SQLITE_TRANSIENT);
        if (ownerId) sqlite3_bind_int64(st,5,ownerId); else sqlite3_bind_null(st,5);
        sqlite3_bind_text(st,6,invite.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,7,(long long)time(nullptr));
        sqlite3_step(st); sqlite3_finalize(st);
        return db_.lastInsertId();
    }
};
