#pragma once

#include <string>
#include "../http_server.h"
#include "../db/database.h"

namespace cipher {

class ChatController {
public:
    ChatController();

    void getUserChats(const HttpRequest& req, HttpResponse& res);
    void getMessages(const HttpRequest& req, HttpResponse& res);
    void getPinnedMessages(const HttpRequest& req, HttpResponse& res);
    void createGroup(const HttpRequest& req, HttpResponse& res);
    void addMember(const HttpRequest& req, HttpResponse& res);
    void getFolders(const HttpRequest& req, HttpResponse& res);
    void createFolder(const HttpRequest& req, HttpResponse& res);
    void updateFolder(const HttpRequest& req, HttpResponse& res);
    void deleteFolder(const HttpRequest& req, HttpResponse& res);
    void uploadFile(const HttpRequest& req, HttpResponse& res);
    void health(const HttpRequest& req, HttpResponse& res);
    void iceServers(const HttpRequest& req, HttpResponse& res);

private:
    Database& db_;
};

} // namespace cipher
