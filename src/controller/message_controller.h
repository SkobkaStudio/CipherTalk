// =============================================================================
//  controller/message_controller.h — отправка/получка сообщений (CONTROLLER)
// =============================================================================
//  ВАЖНО ПРО E2EE: сервер хранит поле content «как есть» — это контейнер
//  {"iv":base64,"ct":base64}, зашифрованный AES-GCM на клиенте. Ключей сервера
//  нет, поэтому даже при компрометации БД переписка не читается.
//
//  Маршруты:
//    GET  /api/messages?chat_id=N&before_id=&limit=   -> история (по страницам)
//    POST /api/messages/send     {chat_id,content_type,content,reply_to}
//    POST /api/messages/edit     {message_id,content}
//    POST /api/messages/delete   {message_id}
//    POST /api/messages/react    {message_id,emoji}
//    POST /api/messages/view     {message_id}          -> галочка «прочитано» ✓✓
// =============================================================================
#pragma once
#include <string>
#include "../utils/http_server.h"
#include "../model/user_repository.h"
#include "../model/chat_repository.h"
#include "../model/message_repository.h"

class MessageController {
public:
    MessageController(HttpServer& srv, Database& db, UserRepository& users,
                      ChatRepository& chats, MessageRepository& msgs)
        : srv_(srv), db_(db), users_(users), chats_(chats), msgs_(msgs)
    { registerRoutes(); }

private:
    HttpServer& srv_;
    Database& db_;
    UserRepository& users_;
    ChatRepository& chats_;
    MessageRepository& msgs_;

    static long long jnum(const Json& b,const char*k){ return b[k].asInt(); }

    void registerRoutes() {
        // ---------- ИСТОРИЯ ЧАТА ----------
        srv_.route("GET","/api/messages",[this](HttpRequest& rq){
            if(!rq.userId) return HttpResponse::error("Не авторизован",401);
            long long chatId = atoll(rq.param("chat_id").c_str());
            long long before = atoll(rq.param("before_id","0").c_str());
            int limit = atoi(rq.param("limit","50").c_str());
            if (limit<=0||limit>200) limit=50;
            if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Нет доступа",403);

            Json arr = msgs_.list(chatId,limit,before);
            enrich(arr,rq.userId); // добавляем «mine» у реакций + метаданные вложений
            Json j=Json::object(); j["messages"]=arr;
            return HttpResponse::json(j);
        });

        // ---------- ОТПРАВКА ----------
        srv_.route("POST","/api/messages/send",[this](HttpRequest& rq){
            if(!rq.userId) return HttpResponse::error("Не авторизован",401);
            Json b=rq.json();
            long long chatId=jnum(b,"chat_id");
            if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Вы не в чате",403);
            if (!chats_.canPost(chatId,rq.userId)) return HttpResponse::error("В канале пишут только админы",403);

            std::string contentType=b["content_type"].asString();
            if(contentType.empty()) contentType="encrypted";
            std::string content=b["content"].asString();
            if(content.empty()) return HttpResponse::error("Пустое сообщение",400);

            long long id = msgs_.create(chatId,rq.userId,contentType,content,jnum(b,"reply_to"));
            auto created = msgs_.byId(id);

            // WS-рассылка всем участникам чата, кроме отправителя (он уже видит своё)
            Json ev=Json::object();
            ev["type"]="message";
            ev["message"]=created;
            for (long long uid : chats_.memberIds(chatId))
                if (uid!=rq.userId) srv_.sendToUser(uid,ev);

            Json j=Json::object(); j["message"]=created;
            return HttpResponse::json(j,201);
        });

        // ---------- РЕДАКТИРОВАНИЕ ----------
        srv_.route("POST","/api/messages/edit",[this](HttpRequest& rq){
            if(!rq.userId) return HttpResponse::error("Не авторизован",401);
            Json b=rq.json();
            long long msgId=jnum(b,"message_id");
            auto m=msgs_.byId(msgId);
            if (m.isNull()||!m.has("id")) return HttpResponse::error("Сообщение не найдено",404);
            if (m["sender_id"].asInt()!=rq.userId) return HttpResponse::error("Можно редактировать только свои",403);
            long long chatId=m["chat_id"].asInt();
            if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Нет доступа",403);

            msgs_.edit(msgId,rq.userId,b["content"].asString());
            auto updated=msgs_.byId(msgId);
            Json ev=Json::object(); ev["type"]="message_edited"; ev["message"]=updated;
            for (long long uid : chats_.memberIds(chatId))
                if (uid!=rq.userId) srv_.sendToUser(uid,ev);

            Json j=Json::object(); j["message"]=updated;
            return HttpResponse::json(j);
        });

        // ---------- УДАЛЕНИЕ ----------
        srv_.route("POST","/api/messages/delete",[this](HttpRequest& rq){
            if(!rq.userId) return HttpResponse::error("Не авторизован",401);
            Json b=rq.json();
            long long msgId=jnum(b,"message_id");
            auto m=msgs_.byId(msgId);
            if (m.isNull()||!m.has("id")) return HttpResponse::error("Сообщение не найдено",404);
            long long chatId=m["chat_id"].asInt();
            bool isOwner = chats_.roleOf(chatId,rq.userId)=="owner";
            if (m["sender_id"].asInt()!=rq.userId && !isOwner)
                return HttpResponse::error("Можно удалять только свои сообщения",403);

            msgs_.softDelete(msgId,rq.userId);
            Json ev=Json::object(); ev["type"]="message_deleted";
            ev["message_id"]=msgId; ev["chat_id"]=chatId;
            for (long long uid : chats_.memberIds(chatId))
                if (uid!=rq.userId) srv_.sendToUser(uid,ev);
            return HttpResponse::json(Json::object());
        });

        // ---------- РЕАКЦИИ ----------
        srv_.route("POST","/api/messages/react",[this](HttpRequest& rq){
            if(!rq.userId) return HttpResponse::error("Не авторизован",401);
            Json b=rq.json();
            long long msgId=jnum(b,"message_id");
            std::string emoji=b["emoji"].asString();
            if(emoji.empty()) return HttpResponse::error("Нужен emoji",400);
            auto m=msgs_.byId(msgId);
            if (m.isNull()||!m.has("id")) return HttpResponse::error("Сообщение не найдено",404);
            long long chatId=m["chat_id"].asInt();
            if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Нет доступа",403);

            msgs_.toggleReaction(msgId,rq.userId,emoji);
            Json reactions=withMine(msgs_.reactionsFor(msgId),msgId,rq.userId);

            Json ev=Json::object(); ev["type"]="reactions";
            ev["message_id"]=msgId; ev["chat_id"]=chatId; ev["reactions"]=reactions;
            srv_.sendToUsers(chats_.memberIds(chatId),ev);

            Json j=Json::object(); j["reactions"]=reactions;
            return HttpResponse::json(j);
        });

        // ---------- ПРОСМОТР СООБЩЕНИЯ (✓ -> ✓✓) ----------
        srv_.route("POST","/api/messages/view",[this](HttpRequest& rq){
            if(!rq.userId) return HttpResponse::error("Не авторизован",401);
            Json b=rq.json();
            long long msgId=jnum(b,"message_id");
            auto m=msgs_.byId(msgId);
            if (m.isNull()||!m.has("id")) return HttpResponse::error("Сообщение не найдено",404);
            long long chatId=m["chat_id"].asInt();
            if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Нет доступа",403);
            if (m["sender_id"].asInt()==rq.userId) return HttpResponse::json(Json::object()); // себе не отмечаем

            msgs_.markViewed(msgId,rq.userId);
            Json ev=Json::object(); ev["type"]="message_viewed";
            ev["message_id"]=msgId; ev["chat_id"]=chatId; ev["user_id"]=rq.userId;
            srv_.sendToUser(m["sender_id"].asInt(),ev); // только автору — он увидит вторую галочку
            return HttpResponse::json(Json::object());
        });
    }

    // ---------- доводка ответа «для фронта» ----------
    void enrich(Json& arr, long long meId) {
        for (size_t i=0;i<arr.size();++i) {
            Json& item = arr.itemsRef()[i];
            long long mid=item["id"].asInt();
            if (item["reactions"].isArray())
                item["reactions"] = withMine(item["reactions"], mid, meId);
            // Прикрепляем метаданные вложения (filename/mime/storage_key), если оно есть
            Json att = attachmentFor(mid);
            if (!att.isNull()) item["attachment"]=att;
        }
    }

    // Пометка «моё» для каждой реакции: нужен список эмодзи этого пользователя
    Json withMine(const Json& reactions, long long msgId, long long meId) {
        Json out = Json::array();
        for (auto& r : reactions.items()) {
            Json x = r; // копия
            x["mine"] = hasMyReaction(msgId, meId, r["emoji"].asString());
            out.push_back(x);
        }
        return out;
    }
    bool hasMyReaction(long long msgId, long long userId, const std::string& emoji){
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,msgId); sqlite3_bind_int64(st,2,userId);
        sqlite3_bind_text(st,3,emoji.c_str(),-1,SQLITE_TRANSIENT);
        bool ok=sqlite3_step(st)==SQLITE_ROW;
        sqlite3_finalize(st);
        return ok;
    }
    Json attachmentFor(long long msgId) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "SELECT id,filename,mime,size,storage_key FROM attachments WHERE message_id=? ORDER BY id DESC LIMIT 1",
            -1,&st,nullptr);
        sqlite3_bind_int64(st,1,msgId);
        Json j=Json::object();
        if (sqlite3_step(st)==SQLITE_ROW){
            auto t=[&](int i)->std::string{auto p=sqlite3_column_text(st,i);return p?(const char*)p:"";};
            j["id"]=sqlite3_column_int64(st,0); j["filename"]=t(1); j["mime"]=t(2);
            j["size"]=sqlite3_column_int64(st,3); j["url"]="/files/"+t(4)+"/"+t(1);
        } else j=Json(); // null, если вложения нет
        sqlite3_finalize(st);
        return j;
    }
};
