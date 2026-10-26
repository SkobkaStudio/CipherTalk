// =============================================================================
//  controller/auth_controller.h — регистрация / вход / выход (CONTROLLER)
// =============================================================================
//  MVC: контроллер принимает HTTP-запрос, вызывает модель (UserRepository),
//  формирует HttpResponse. Здесь же — выдача cookie sid (сессия «остаться в системе»).
//
//  Маршруты:
//    POST /api/register {username,password,name,e2ee_pub} -> Set-Cookie sid + user
//    POST /api/login    {username,password}               -> Set-Cookie sid + user
//    POST /api/logout                                     -> удаляет сессию и cookie
//    GET  /api/me                                         -> текущий пользователь
// =============================================================================
#pragma once
#include <string>
#include "../utils/http_server.h"
#include "../model/user_repository.h"

class AuthController {
public:
    AuthController(HttpServer& srv, UserRepository& users) : srv_(srv), users_(users) { registerRoutes(); }

private:
    HttpServer& srv_;
    UserRepository& users_;

    void registerRoutes() {
        // ---------------- РЕГИСТРАЦИЯ ----------------
        srv_.route("POST","/api/register",[this](HttpRequest& rq){
            Json b = rq.json();
            std::string username = enc::trim(b["username"].asString());
            std::string password = b["password"].asString();
            std::string name     = b["name"].asString();
            // Публичный RSA-ключ клиента. ПРИВАТНЫЙ КЛЮЧ НИКОГДА не покидает браузер!
            std::string e2eePub  = b["e2ee_pub"].asString();

            auto res = users_.create(username,password,name,e2eePub);
            if (!res.ok) return HttpResponse::error(res.error,400);

            // Сразу логиним: создаём токен сессии, кладём в реестр сервера и ставим cookie
            std::string token = users_.createSession(res.id);
            srv_.sessions[token] = res.id;
            HttpResponse r = HttpResponse::json(userJson(res.id),201);
            r.extraHeaders.push_back(sessionCookie(token,true));
            return r;
        });

        // ---------------- ВХОД ----------------
        srv_.route("POST","/api/login",[this](HttpRequest& rq){
            Json b = rq.json();
            auto u = users_.byUsername(enc::trim(b["username"].asString()));
            // Единое сообщение ошибки — чтобы не подсказывать злоумышленнику, занят ли логин
            if (!u || !crypto::verifyPassword(b["password"].asString(), u->passwordHash))
                return HttpResponse::error("Неверный логин или пароль",401);

            std::string token = users_.createSession(u->id);
            srv_.sessions[token] = u->id;
            users_.setOnline(u->id,true);

            HttpResponse r = HttpResponse::json(userJson(u->id));
            r.extraHeaders.push_back(sessionCookie(token,true));
            return r;
        });

        // ---------------- ВЫХОД ----------------
        srv_.route("POST","/api/logout",[this](HttpRequest& rq){
            std::string token = rq.cookies.count("sid")?rq.cookies["sid"]:"";
            if (!token.empty()) {
                users_.dropSession(token);
                std::lock_guard<std::mutex> lk(srv_.sessionsMtx);
                srv_.sessions.erase(token);
            }
            HttpResponse r = HttpResponse::json(Json::object());
            r.extraHeaders.push_back(sessionCookie("",false)); // «протухшая» cookie
            return r;
        });

        // ---------------- ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ ----------------
        srv_.route("GET","/api/me",[this](HttpRequest& rq){
            if (!rq.userId) return HttpResponse::error("Не авторизован",401);
            return HttpResponse::json(userJson(rq.userId));
        });

        // ---------------- РЕДАКТИРОВАНИЕ ПРОФИЛЯ (имя / bio / цвет аватара) ----
        srv_.route("POST","/api/profile",[this](HttpRequest& rq){
            if (!rq.userId) return HttpResponse::error("Не авторизован",401);
            Json b = rq.json();
            auto u = users_.byId(rq.userId);
            if (!u) return HttpResponse::error("Пользователь не найден",404);
            std::string name  = b.has("name")  ? b["name"].asString()  : u->name;
            std::string bio   = b.has("bio")   ? b["bio"].asString()   : u->bio;
            std::string avat  = b.has("avatar")? b["avatar"].asString(): u->avatar;
            users_.updateProfile(rq.userId, name, bio, avat);
            // Если клиент принёс новый публичный ключ — обновим его тоже
            if (b.has("e2ee_pub") && !b["e2ee_pub"].asString().empty())
                users_.updateE2eePub(rq.userId, b["e2ee_pub"].asString());
            return HttpResponse::json(userJson(rq.userId));
        });
    }

    Json userJson(long long id) {
        Json j = Json::object();
        auto u = users_.byId(id);
        if (u) j["user"] = u->toJson();
        return j;
    }

    // Кука httpOnly — JavaScript её не прочитает (защита от XSS-кражи сессии).
    // Max-Age=30 дней: «оставаться в системе», как в Telegram Web.
    static std::string sessionCookie(const std::string& token, bool alive) {
        return "Set-Cookie: sid=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
               (alive ? "2592000" : "0");
    }
};
