// =============================================================================
//  controller/ws_controller.h — живой канал WebSocket (CONTROLLER)
// =============================================================================
//  HTTP REST отвечает на «разовые» запросы, а WebSocket держит ПОСТОЯННОЕ
//  соединение браузера с сервером. Через него летят:
//     * новые сообщения в реальном времени (без опроса сервера);
//     * статусы «печатает…»;
//     * отметки о прочтении (✓ -> ✓✓);
//     * онлайн/офлайн (зелёная точка);
//     * системные события (вас добавили в группу и т.п.).
//
//  Протокол поверх WS — простой JSON с полем "type":
//     клиент -> сервер : {type:"typing", chat_id:N}
//                        {type:"ping"}
//     сервер -> клиент : {type:"message", message:{...}}  и т.д.
//
//  Авторизация: cookie sid браузер автоматически передаёт при handshake WS,
//  HttpServer разбирает её и проставляет client->userId ещё до onWsOpen.
// =============================================================================
#pragma once
#include <string>
#include "../utils/http_server.h"
#include "../model/user_repository.h"
#include "../model/chat_repository.h"
#include "../model/message_repository.h"

class WsController {
public:
    WsController(HttpServer& srv, UserRepository& users, ChatRepository& chats, MessageRepository& msgs)
        : srv_(srv), users_(users), chats_(chats), msgs_(msgs)
    {
        // ---- новый клиент открыл соединение: помечаем его «в сети» ----
        srv_.onWsOpen = [this](WsClient* c) {
            if (!c->userId) return;                      // не авторизован — молча игнорируем
            users_.setOnline(c->userId, true);
            broadcastPresence(c->userId, true);          // всем друзьям: «он появился»
            // Отправим самому клиенту приветствие со списком тех, кто онлайн
            Json ev = Json::object();
            ev["type"] = "hello";
            Json arr = Json::array();
            for (long long id : srv_.onlineUsers()) arr.push_back(Json(id));
            ev["online"] = arr;
            c->sendText(ev.dump());
        };

        // ---- соединение закрылось: помечаем «не в сети» ----
        srv_.onWsClose = [this](WsClient* c) {
            if (!c->userId) return;
            // Если это последнее соединение юзера — он офлайн
            bool stillOnline = false;
            for (long long id : srv_.onlineUsers()) if (id == c->userId) stillOnline = true;
            if (!stillOnline) {
                users_.setOnline(c->userId, false);
                broadcastPresence(c->userId, false);
            }
        };

        // ---- пришло текстовое сообщение от клиента ----
        srv_.onWsMessage = [this](WsClient* c, const std::string& raw) {
            if (!c->userId) return;
            Json j;
            try { j = Json::parse(raw); } catch (...) { return; } // мусор игнорируем
            std::string type = j["type"].asString();

            // «печатает…» — пересылаем остальным участникам чата
            if (type == "typing") {
                long long chatId = j["chat_id"].asInt();
                if (!chats_.isMember(chatId, c->userId)) return;   // защита: только участники
                Json ev = Json::object();
                ev["type"] = "typing";
                ev["chat_id"] = chatId;
                ev["user_id"] = c->userId;
                ev["user_name"] = users_.byId(c->userId) ? users_.byId(c->userId)->name : "";
                for (long long uid : chats_.memberIds(chatId))
                    if (uid != c->userId) srv_.sendToUser(uid, ev);
            }
            // «прочитал чат» — то же самое, что POST /api/chats/read, но через WS быстрее
            else if (type == "read") {
                long long chatId = j["chat_id"].asInt();
                if (!chats_.isMember(chatId, c->userId)) return;
                msgs_.markReadAll(chatId, c->userId);              // галочки ✓✓ по всему чату
                chats_.markRead(chatId, c->userId);                // сброс счётчика непрочитанных
                Json ev = Json::object();
                ev["type"] = "read";
                ev["chat_id"] = chatId;
                ev["user_id"] = c->userId;
                srv_.sendToUsers(chats_.memberIds(chatId), ev);
            }
            // ping — отвечаем pong'ом (браузер использует для keep-alive)
            else if (type == "ping") {
                Json ev = Json::object(); ev["type"] = "pong";
                c->sendText(ev.dump());
            }
        };
    }

private:
    HttpServer& srv_;
    UserRepository& users_;
    ChatRepository& chats_;
    MessageRepository& msgs_;

    // Разослать всем онлайн-пользователям событие смены присутствия
    void broadcastPresence(long long userId, bool online) {
        Json ev = Json::object();
        ev["type"] = "presence";
        ev["user_id"] = userId;
        ev["online"] = online;
        for (long long id : srv_.onlineUsers()) srv_.sendToUser(id, ev);
    }
};
