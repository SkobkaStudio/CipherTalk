// =============================================================================
//  model/user_repository.h — CRUD пользователей и сессий (MODEL)
// =============================================================================
//  Репозиторий = единственный слой, который пишет SQL про таблицу users.
//  Контроллеры не знают SQL — они вызывают методы вроде findByUsername().
//  Все запросы используют подготовленные выражения (sqlite3_prepare) —
//  это защита от SQL-инъекций по умолчанию.
// =============================================================================
#pragma once
#include <string>
#include <vector>
#include <optional>
#include <ctime>
#include "database.h"
#include "../utils/json.h"
#include "../utils/crypto.h"

// Доменная структура «Пользователь» (1:1 соответствует таблице users)
struct User {
    long long id = 0;
    std::string username, passwordHash, name, bio, avatar, e2eePub;
    long long createdAt = 0, lastSeen = 0;
    bool online = false;

    // Сериализация в JSON для API. ВАЖНО: сюда никогда не попадают
    // passwordHash и приватные ключи — только публичные поля.
    Json toJson() const {
        Json j = Json::object();
        j["id"] = id;
        j["username"] = username;
        j["name"] = name;
        j["bio"] = bio;
        j["avatar"] = avatar;
        j["e2ee_pub"] = e2eePub;      // публичный RSA-ключ (для шифрования нам сообщений)
        j["online"] = online;
        j["last_seen"] = lastSeen;
        return j;
    }
};

class UserRepository {
public:
    explicit UserRepository(Database& db) : db_(db) {}

    // ---------------------------- ЧТЕНИЕ --------------------------------------
    std::optional<User> byId(long long id) { return rowToUser("id = ?", id); }
    std::optional<User> byUsername(const std::string& u) { return rowToUser("username = ?", u); }

    // Поиск людей по имени/логину (лупа в шапке TG). q без % — регистронезависимо.
    std::vector<Json> search(const std::string& q, long long meId, int limit = 20) {
        sqlite3_stmt* st = nullptr;
        std::string sql = "SELECT id,username,name,bio,avatar,e2ee_pub,online,last_seen FROM users "
                          "WHERE id!=? AND (username LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE) "
                          "ORDER BY online DESC, name LIMIT ?";
        sqlite3_prepare_v2(db_.raw(), sql.c_str(), -1, &st, nullptr);
        sqlite3_bind_int64(st, 1, meId);
        std::string like = "%" + q + "%";
        sqlite3_bind_text(st, 2, like.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 3, like.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 4, limit);
        std::vector<Json> out;
        while (sqlite3_step(st) == SQLITE_ROW) out.push_back(rowToJson(st));
        sqlite3_finalize(st);
        return out;
    }

    // Список id всех пользователей (для рассылки системных событий типа «новый аккаунт»)
    std::vector<long long> allIds() {
        std::vector<long long> out;
        sqlite3_stmt* st = nullptr;
        sqlite3_prepare_v2(db_.raw(), "SELECT id FROM users", -1, &st, nullptr);
        while (sqlite3_step(st) == SQLITE_ROW) out.push_back(sqlite3_column_int64(st, 0));
        sqlite3_finalize(st);
        return out;
    }

    // ---------------------------- СОЗДАНИЕ ------------------------------------
    // Возвращает id нового пользователя или пустую строку ошибки в optional.
    struct CreateResult { bool ok=false; long long id=0; std::string error; };
    CreateResult create(const std::string& username, const std::string& password,
                        const std::string& name, const std::string& e2eePub) {
        if (username.size() < 3 || username.size() > 32)
            return {false, 0, "Логин должен быть 3..32 символа"};
        for (char c : username)
            if (!isalnum((unsigned char)c) && c!='_') return {false,0,"Логин: только буквы, цифры и _"};
        if (password.size() < 4) return {false,0,"Пароль минимум 4 символа"};
        if (byUsername(username)) return {false,0,"Этот логин уже занят"};

        sqlite3_stmt* st = nullptr;
        std::string hash = crypto::hashPassword(password);
        std::string avatarColor = randomAvatarColor();
        sqlite3_prepare_v2(db_.raw(),
            "INSERT INTO users(username,password,name,bio,avatar,e2ee_pub,created_at,last_seen)"
            " VALUES(?,?,?,?,?,?,?,?)", -1, &st, nullptr);
        sqlite3_bind_text(st,1,username.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,2,hash.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,3,(name.empty()?username:name).c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,4,"",-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,5,avatarColor.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,6,e2eePub.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,7,(long long)time(nullptr));
        sqlite3_bind_int64(st,8,(long long)time(nullptr));
        int rc = sqlite3_step(st);
        sqlite3_finalize(st);
        if (rc != SQLITE_DONE) return {false,0,"Не удалось создать пользователя"};
        return {true, db_.lastInsertId(), ""};
    }

    // ---------------------------- ОБНОВЛЕНИЕ -----------------------------------
    void updateProfile(long long id, const std::string& name, const std::string& bio, const std::string& avatar) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"UPDATE users SET name=?, bio=?, avatar=? WHERE id=?",-1,&st,nullptr);
        sqlite3_bind_text(st,1,name.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,2,bio.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,3,avatar.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,4,id);
        sqlite3_step(st); sqlite3_finalize(st);
    }
    // Обновление публичного E2EE-ключа (например, при смене устройства)
    void updateE2eePub(long long id, const std::string& pemBase64) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"UPDATE users SET e2ee_pub=? WHERE id=?",-1,&st,nullptr);
        sqlite3_bind_text(st,1,pemBase64.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,2,id);
        sqlite3_step(st); sqlite3_finalize(st);
    }
    // Онлайн-статус обновляет WebSocket-контроллер при connect/disconnect
    void setOnline(long long id, bool online) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "UPDATE users SET online=?, last_seen=? WHERE id=?",-1,&st,nullptr);
        sqlite3_bind_int(st,1,online?1:0);
        sqlite3_bind_int64(st,2,(long long)time(nullptr));
        sqlite3_bind_int64(st,3,id);
        sqlite3_step(st); sqlite3_finalize(st);
    }

    // ---------------------------- СЕССИИ ---------------------------------------
    // Создаём случайный токен и кладём в БД + в куку (persistent login, как «остаться в системе»)
    std::string createSession(long long userId) {
        std::string token = crypto::randomToken(32);
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)",-1,&st,nullptr);
        sqlite3_bind_text(st,1,token.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_int64(st,2,userId);
        sqlite3_bind_int64(st,3,(long long)time(nullptr));
        sqlite3_step(st); sqlite3_finalize(st);
        return token;
    }
    std::optional<long long> sessionUser(const std::string& token) {
        if (token.empty()) return std::nullopt;
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"SELECT user_id FROM sessions WHERE token=?",-1,&st,nullptr);
        sqlite3_bind_text(st,1,token.c_str(),-1,SQLITE_TRANSIENT);
        std::optional<long long> res;
        if (sqlite3_step(st)==SQLITE_ROW) res = sqlite3_column_int64(st,0);
        sqlite3_finalize(st);
        return res;
    }
    void dropSession(const std::string& token) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),"DELETE FROM sessions WHERE token=?",-1,&st,nullptr);
        sqlite3_bind_text(st,1,token.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_step(st); sqlite3_finalize(st);
    }

private:
    Database& db_;

    static std::string randomAvatarColor() {
        static const char* colors[] = {"#e17076","#eda86c","#a58ac9","#6fb1e0",
                                       "#7bc862","#6ec9cb","#ee7aae","#faa774"};
        return colors[rand()%8]; // цветной круглый аватар, как в Telegram
    }

    // Общий SELECT одной записи по условию "поле = значение"
    template<typename T>
    std::optional<User> rowToUser(const std::string& where, T value) {
        sqlite3_stmt* st=nullptr;
        std::string sql = "SELECT id,username,name,bio,avatar,e2ee_pub,online,last_seen,created_at,password"
                          " FROM users WHERE " + where;
        sqlite3_prepare_v2(db_.raw(), sql.c_str(), -1, &st, nullptr);
        bind(st,1,value);
        std::optional<User> u;
        if (sqlite3_step(st)==SQLITE_ROW) {
            User x;
            x.id=sqlite3_column_int64(st,0);
            x.username=(const char*)col(st,1);
            x.name=(const char*)col(st,2);
            x.bio=(const char*)col(st,3);
            x.avatar=(const char*)col(st,4);
            x.e2eePub=(const char*)col(st,5);
            x.online=sqlite3_column_int(st,6)!=0;
            x.lastSeen=sqlite3_column_int64(st,7);
            x.createdAt=sqlite3_column_int64(st,8);
            x.passwordHash=(const char*)col(st,9);
            u = x;
        }
        sqlite3_finalize(st);
        return u;
    }
    static const unsigned char* col(sqlite3_stmt* st,int i){ return sqlite3_column_text(st,i); }
    static void bind(sqlite3_stmt* st,int idx,long long v){ sqlite3_bind_int64(st,idx,v); }
    static void bind(sqlite3_stmt* st,int idx,const std::string& v){ sqlite3_bind_text(st,idx,v.c_str(),-1,SQLITE_TRANSIENT); }

    // Строка результата поиска -> компактный JSON (без пароля!)
    static Json rowToJson(sqlite3_stmt* st) {
        Json j = Json::object();
        j["id"]=sqlite3_column_int64(st,0);
        j["username"]=(const char*)sqlite3_column_text(st,1);
        j["name"]=(const char*)sqlite3_column_text(st,2);
        j["bio"]=(const char*)sqlite3_column_text(st,3);
        j["avatar"]=(const char*)sqlite3_column_text(st,4);
        j["e2ee_pub"]=(const char*)sqlite3_column_text(st,5);
        j["online"]=sqlite3_column_int(st,6)!=0;
        j["last_seen"]=sqlite3_column_int64(st,7);
        return j;
    }
};
