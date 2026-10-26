// =============================================================================
//  controller/chat_controller.h — чаты, группы, каналы, контакты (CONTROLLER)
// =============================================================================
//  Маршруты (все требуют авторизации — проверяем rq.userId):
//    GET  /api/chats                          -> список диалогов пользователя
//    POST /api/chats/private   {user_id}      -> открыть/найти личку с человеком
//    POST /api/chats/group     {title,about,user_ids[]} -> создать группу
//    POST /api/chats/channel   {title,about}  -> создать канал
//    POST /api/chats/join      {invite}       -> вступить по ссылке-приглашению
//    GET  /api/chats/members?chat_id=N        -> участники + моя роль
//    POST /api/chats/add-member    {chat_id,user_id}
//    POST /api/chats/remove-member {chat_id,user_id}
//    POST /api/chats/set-role      {chat_id,user_id,role}
//    POST /api/chats/update        {chat_id,title,about}
//    POST /api/chats/delete        {chat_id}
//    POST /api/chats/read          {chat_id}  -> сброс непрочитанных
//    GET  /api/chats/pinned?chat_id=N         -> закреплённые сообщения
//    POST /api/chats/pin           {chat_id,message_id}
//    POST /api/chats/unpin         {chat_id,message_id}
//    GET  /api/users/search?q=...             -> лупа по людям
//    GET  /api/contacts                         -> адресная книга
//    POST /api/contacts/add {user_id}            -> добавить контакт
// =============================================================================
#pragma once
#include <string>
#include "../utils/http_server.h"
#include "../model/user_repository.h"
#include "../model/chat_repository.h"
#include "../model/message_repository.h"

class ChatController {
public:
    ChatController(HttpServer& srv, Database& db,
                   UserRepository& users, ChatRepository& chats, MessageRepository& msgs)
        : srv_(srv), db_(db), users_(users), chats_(chats), msgs_(msgs)
    { registerRoutes(); }

private:
    HttpServer& srv_;
    Database& db_;
    UserRepository& users_;
    ChatRepository& chats_;
    MessageRepository& msgs_;

    // Помощник: требует авторизацию. Возвращает true, если всё ок,
    // иначе сам заполняет out ошибкой 401.
    bool needAuth(HttpRequest& rq, HttpResponse& err) {
        if (!rq.userId) { err = HttpResponse::error("Не авторизован",401); return false; }
        return true;
    }
    static long long jnum(const Json& b, const char* k){ return b[k].asInt(); }

    void registerRoutes() {
        // ---------- СПИСОК ЧАТОВ (левая колонка «диалоги») ----------
        srv_.route("GET","/api/chats",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json j = Json::object();
            j["chats"] = chats_.listForUser(rq.userId);
            return HttpResponse::json(j);
        });

        // ---------- ОТКРЫТЬ ЛИЧНЫЙ ЧАТ ----------
        srv_.route("POST","/api/chats/private",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            long long peer = jnum(b,"user_id");
            if (!users_.byId(peer)) return HttpResponse::error("Пользователь не найден",404);
            long long id = chats_.createPrivate(rq.userId,peer);
            // Системное сообщение «Диалог создан» видно только участникам
            Json j = Json::object(); j["chat_id"]=id;
            j["chat"] = chats_.info(id);
            return HttpResponse::json(j);
        });

        // ---------- СОЗДАНИЕ ГРУППЫ ----------
        srv_.route("POST","/api/chats/group",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            std::string title = b["title"].asString();
            if (title.empty()) return HttpResponse::error("Название группы обязательно",400);
            long long id = chats_.createGroup(rq.userId,title,b["about"].asString());
            // Добавляем выбранных участников и шлём им системные уведомления через WS
            for (auto& v : b["user_ids"].items()) {
                long long uid = v.asInt();
                if (users_.byId(uid)) {
                    chats_.addMember(id,uid,"member");
                    notifyService(id,uid,rq.userId);
                }
            }
            Json j = Json::object(); j["chat_id"]=id; j["chat"]=chats_.info(id);
            return HttpResponse::json(j);
        });

        // ---------- СОЗДАНИЕ КАНАЛА ----------
        srv_.route("POST","/api/chats/channel",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            std::string title = b["title"].asString();
            if (title.empty()) return HttpResponse::error("Название канала обязательно",400);
            long long id = chats_.createChannel(rq.userId,title,b["about"].asString());
            Json j = Json::object(); j["chat_id"]=id; j["chat"]=chats_.info(id);
            return HttpResponse::json(j);
        });

        // ---------- ВСТУПИТЬ ПО ССЫЛКЕ-ПРИГЛАШЕНИЮ ----------
        srv_.route("POST","/api/chats/join",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            long long id = chats_.findByInvite(b["invite"].asString());
            if (!id) return HttpResponse::error("Приглашение не найдено",404);
            chats_.addMember(id,rq.userId,"member");
            Json j = Json::object(); j["chat_id"]=id; j["chat"]=chats_.info(id);
            return HttpResponse::json(j);
        });

        // ---------- УЧАСТНИКИ ----------
        srv_.route("GET","/api/chats/members",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            long long chatId = atoll(rq.param("chat_id").c_str());
            if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Нет доступа",403);
            Json j = Json::object();
            j["members"] = chats_.membersInfo(chatId);
            // Публичные E2EE-ключи участников в порядке списка members —
            // фронтенд шифрует session key «под каждого» по этому же порядку,
            // а получатель находит СВОЮ позицию по id. Это нужно для E2EE в группах.
            {
                Json keys = Json::array();
                for (const auto& m : j["members"].items()) {
                    auto u = users_.byId(m["id"].asInt());
                    keys.push_back(Json(u ? u->e2eePub : std::string("")));
                }
                j["member_keys"] = keys;
            }
            j["my_index"] = 0;   // позиция меня в members (для расшифровки ek[my_index])
            {
                const auto& ms = j["members"].items();
                for (size_t i = 0; i < ms.size(); ++i)
                    if (ms[i]["id"].asInt() == rq.userId) { j["my_index"] = (long long)i; break; }
            }
            j["my_role"] = chats_.roleOf(chatId,rq.userId);
            j["chat"] = chats_.info(chatId);
            return HttpResponse::json(j);
        });

        // Добавить участника может любой участник (в TG — все, кроме приватных каналов)
        srv_.route("POST","/api/chats/add-member",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            long long chatId=jnum(b,"chat_id"), uid=jnum(b,"user_id");
            if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Нет доступа",403);
            if (!users_.byId(uid)) return HttpResponse::error("Нет такого пользователя",404);
            chats_.addMember(chatId,uid,"member");
            notifyService(chatId,uid,rq.userId);
            return HttpResponse::json(Json::object());
        });

        // Удалить участника — только админ/владелец; владельца удалить нельзя
        srv_.route("POST","/api/chats/remove-member",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            long long chatId=jnum(b,"chat_id"), uid=jnum(b,"user_id");
            std::string myRole=chats_.roleOf(chatId,rq.userId);
            if (myRole!="owner"&&myRole!="admin") return HttpResponse::error("Только админ",403);
            if (chats_.roleOf(chatId,uid)=="owner") return HttpResponse::error("Нельзя удалить владельца",403);
            chats_.removeMember(chatId,uid);
            return HttpResponse::json(Json::object());
        });

        // Назначить/снять админа — только владелец
        srv_.route("POST","/api/chats/set-role",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            long long chatId=jnum(b,"chat_id"), uid=jnum(b,"user_id");
            std::string role=b["role"].asString();
            if (chats_.roleOf(chatId,rq.userId)!="owner") return HttpResponse::error("Только владелец",403);
            if (role!="admin"&&role!="member") return HttpResponse::error("Неверная роль",400);
            chats_.setRole(chatId,uid,role);
            return HttpResponse::json(Json::object());
        });

        // Изменить название/описание — админ или владелец
        srv_.route("POST","/api/chats/update",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            long long chatId=jnum(b,"chat_id");
            std::string myRole=chats_.roleOf(chatId,rq.userId);
            if (myRole!="owner"&&myRole!="admin") return HttpResponse::error("Только админ",403);
            chats_.updateInfo(chatId,b["title"].asString(),b["about"].asString());
            broadcastChatUpdate(chatId);
            return HttpResponse::json(Json::object());
        });

        // Удалить чат — только владелец
        srv_.route("POST","/api/chats/delete",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            long long chatId=jnum(b,"chat_id");
            if (chats_.roleOf(chatId,rq.userId)!="owner") return HttpResponse::error("Только владелец",403);
            auto members = chats_.memberIds(chatId);
            chats_.deleteChat(chatId);
            Json ev=Json::object(); ev["type"]="chat_deleted"; ev["chat_id"]=chatId;
            srv_.sendToUsers(members,ev);
            return HttpResponse::json(Json::object());
        });

        // ---------- ПРОЧИТАНО (сброс счётчика непрочитанных) ----------
        srv_.route("POST","/api/chats/read",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b = rq.json();
            long long chatId=jnum(b,"chat_id");
            chats_.markRead(chatId,rq.userId);
            // Сообщаем собеседникам, что мы прочитали — они увидят «✓✓»
            Json ev=Json::object(); ev["type"]="read"; ev["chat_id"]=chatId; ev["user_id"]=rq.userId;
            srv_.sendToUsers(chats_.memberIds(chatId),ev);
            return HttpResponse::json(Json::object());
        });

        // ---------- ЗАКРЕПЛЁННЫЕ СООБЩЕНИЯ ----------
        srv_.route("GET","/api/chats/pinned",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            long long chatId = atoll(rq.param("chat_id").c_str());
            Json j=Json::object(); j["pinned"]=msgs_.pinnedList(chatId);
            return HttpResponse::json(j);
        });
        srv_.route("POST","/api/chats/pin",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b=rq.json();
            long long chatId=jnum(b,"chat_id"), msgId=jnum(b,"message_id");
            std::string r=chats_.roleOf(chatId,rq.userId);
            if (r!="owner"&&r!="admin") return HttpResponse::error("Только админ",403);
            msgs_.pin(chatId,msgId);
            broadcastChatUpdate(chatId);
            return HttpResponse::json(Json::object());
        });
        srv_.route("POST","/api/chats/unpin",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b=rq.json();
            long long chatId=jnum(b,"chat_id"), msgId=jnum(b,"message_id");
            std::string r=chats_.roleOf(chatId,rq.userId);
            if (r!="owner"&&r!="admin") return HttpResponse::error("Только админ",403);
            msgs_.unpin(chatId,msgId);
            broadcastChatUpdate(chatId);
            return HttpResponse::json(Json::object());
        });

        // ---------- ПОИСК ЛЮДЕЙ (лупа) ----------
        srv_.route("GET","/api/users/search",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            std::string q = rq.param("q");
            Json j=Json::object();
            j["users"] = q.empty()? Json::array() : Json(users_.search(q,rq.userId));
            return HttpResponse::json(j);
        });

        // ---------- КОНТАКТЫ ----------
        srv_.route("GET","/api/contacts",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json arr=Json::array();
            sqlite3_stmt* st=nullptr;
            sqlite3_prepare_v2(db_.raw(),
              "SELECT u.id,u.username,u.name,u.avatar,u.online,u.last_seen FROM contacts c "
              "JOIN users u ON u.id=c.contact_id WHERE c.owner_id=? ORDER BY u.name",-1,&st,nullptr);
            sqlite3_bind_int64(st,1,rq.userId);
            while (sqlite3_step(st)==SQLITE_ROW){
                auto t=[&](int i)->std::string{auto p=sqlite3_column_text(st,i);return p?(const char*)p:"";};
                Json j=Json::object();
                j["id"]=sqlite3_column_int64(st,0); j["username"]=t(1); j["name"]=t(2);
                j["avatar"]=t(3); j["online"]=sqlite3_column_int(st,4)!=0;
                j["last_seen"]=sqlite3_column_int64(st,5);
                arr.push_back(j);
            }
            sqlite3_finalize(st);
            Json j=Json::object(); j["contacts"]=arr;
            return HttpResponse::json(j);
        });
        srv_.route("POST","/api/contacts/add",[this](HttpRequest& rq){
            HttpResponse err; if(!needAuth(rq,err)) return err;
            Json b=rq.json();
            long long uid=jnum(b,"user_id");
            if (!users_.byId(uid)) return HttpResponse::error("Нет такого пользователя",404);
            sqlite3_stmt* st=nullptr;
            sqlite3_prepare_v2(db_.raw(),"INSERT OR IGNORE INTO contacts(owner_id,contact_id) VALUES(?,?)",
                -1,&st,nullptr);
            sqlite3_bind_int64(st,1,rq.userId); sqlite3_bind_int64(st,2,uid);
            sqlite3_step(st); sqlite3_finalize(st);
            return HttpResponse::json(Json::object());
        });
    }

    // ---------- помощники рассылки WebSocket-событий ----------

    // Системное уведомление пользователю: «вас добавили в группу»
    void notifyService(long long chatId, long long userId, long long byUserId) {
        auto u = users_.byId(byUserId);
        Json ev=Json::object();
        ev["type"]="service";
        ev["chat_id"]=chatId;
        ev["text"]=std::string(u?u->name:"Кто-то")+" добавил вас в \""+chats_.info(chatId)["title"].asString()+"\"";
        srv_.sendToUser(userId,ev);
    }
    // Обновление метаданных чата летит всем участникам (обновим шапку/список)
    void broadcastChatUpdate(long long chatId) {
        Json ev=Json::object();
        ev["type"]="chat_updated";
        ev["chat_id"]=chatId;
        ev["chat"]=chats_.info(chatId);
        srv_.sendToUsers(chats_.memberIds(chatId),ev);
    }
};
