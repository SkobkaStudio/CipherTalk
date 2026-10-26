#pragma once

#include <string>
#include "../http_server.h"
#include "../db/database.h"
#include "../services/session_service.h"
#include "../services/sms_service.h"
#include "../services/encryption_service.h"

namespace cipher {

class AuthController {
public:
    AuthController();

    void sendCode(const HttpRequest& req, HttpResponse& res);
    void verifyCode(const HttpRequest& req, HttpResponse& res);
    void registerUser(const HttpRequest& req, HttpResponse& res);
    void login(const HttpRequest& req, HttpResponse& res);
    void loginWithCode(const HttpRequest& req, HttpResponse& res);
    void logout(const HttpRequest& req, HttpResponse& res);
    void me(const HttpRequest& req, HttpResponse& res);
    void listSessions(const HttpRequest& req, HttpResponse& res);
    void revokeSession(const HttpRequest& req, HttpResponse& res);
    void checkUsername(const HttpRequest& req, HttpResponse& res);

private:
    Database& db_;
    SessionService& sessionService_;
    SmsService& smsService_;
    EncryptionService& enc_;

    std::string normalizePhone(const std::string& raw);
    bool consumeRegisterProof(const std::string& phone, const std::string& verifyToken);
    bool consumeLoginProof(const std::string& phone, const std::string& loginToken, int64_t& userId);
};

} // namespace cipher
