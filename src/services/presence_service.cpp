#include "presence_service.h"
#include <algorithm>
#include <sys/socket.h>

namespace cipher {

void PresenceService::addSocket(int64_t userId, int fd) {
    std::lock_guard<std::mutex> lock(mtx_);
    userSockets_[userId].insert(fd);
    socketUser_[fd] = userId;
}

bool PresenceService::removeSocket(int fd) {
    std::lock_guard<std::mutex> lock(mtx_);
    auto it = socketUser_.find(fd);
    if (it == socketUser_.end()) return false;
    int64_t uid = it->second;
    socketUser_.erase(it);
    auto uit = userSockets_.find(uid);
    if (uit != userSockets_.end()) {
        uit->second.erase(fd);
        if (uit->second.empty()) {
            userSockets_.erase(uit);
            return true; // полностью отключился
        }
    }
    return false;
}

std::vector<int> PresenceService::getSockets(int64_t userId) const {
    std::lock_guard<std::mutex> lock(mtx_);
    std::vector<int> out;
    auto it = userSockets_.find(userId);
    if (it != userSockets_.end()) {
        for (int fd : it->second) out.push_back(fd);
    }
    return out;
}

bool PresenceService::sendToUser(int64_t userId, const std::string& message) {
    std::lock_guard<std::mutex> lock(mtx_);
    auto it = userSockets_.find(userId);
    if (it == userSockets_.end() || it->second.empty()) return false;
    int fd = *it->second.begin();
    ssize_t n = send(fd, message.data(), message.size(), 0);
    (void)n;
    return true;
}

void PresenceService::sendToAllUserSockets(int64_t userId, const std::string& message) {
    std::lock_guard<std::mutex> lock(mtx_);
    auto it = userSockets_.find(userId);
    if (it == userSockets_.end()) return;
    for (int fd : it->second) {
        send(fd, message.data(), message.size(), 0);
    }
}

void PresenceService::sendToChatMembers(const std::vector<int64_t>& memberIds, const std::string& message, int64_t excluded) {
    std::lock_guard<std::mutex> lock(mtx_);
    for (int64_t uid : memberIds) {
        if (uid == excluded) continue;
        auto it = userSockets_.find(uid);
        if (it == userSockets_.end() || it->second.empty()) continue;
        int fd = *it->second.begin();
        send(fd, message.data(), message.size(), 0);
    }
}

void PresenceService::broadcast(const std::string& message, int64_t excluded) {
    std::lock_guard<std::mutex> lock(mtx_);
    for (auto& [uid, fds] : userSockets_) {
        if (uid == excluded) continue;
        for (int fd : fds) send(fd, message.data(), message.size(), 0);
    }
}

std::vector<int> PresenceService::allSockets() const {
    std::lock_guard<std::mutex> lock(mtx_);
    std::vector<int> out;
    for (auto& [fd, uid] : socketUser_) out.push_back(fd);
    return out;
}

int64_t PresenceService::userIdOfSocket(int fd) const {
    std::lock_guard<std::mutex> lock(mtx_);
    auto it = socketUser_.find(fd);
    return it != socketUser_.end() ? it->second : -1;
}

bool PresenceService::hasSocket(int fd) const {
    std::lock_guard<std::mutex> lock(mtx_);
    return socketUser_.count(fd) > 0;
}

} // namespace cipher
