#pragma once

#include <string>
#include "../http_server.h"
#include "../db/database.h"

namespace cipher {

class ProfileController {
public:
    ProfileController();

    void updateProfile(const HttpRequest& req, HttpResponse& res);
    void getProfile(const HttpRequest& req, HttpResponse& res);
    void searchUsers(const HttpRequest& req, HttpResponse& res);

private:
    Database& db_;
};

} // namespace cipher
