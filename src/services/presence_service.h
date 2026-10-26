#pragma once

#include <map>
#include <set>
#include <vector>
#include <mutex>
#include <cstdint>
#include <string>
#include <functional>
#include <sys/socket.h>

namespace cipher {

class PresenceService {
public:
    using SocketPtr = int;

    // Добавить сокет пользователя
    void addSocket(int64_t userId, int fd);
    // Удалить сокет. Возвращает true, если у пользователя больше нет сокетов (полностью офлайн)
    bool removeSocket(int fd);
    std::vector<int> getSockets(int64_t userId) const;

    // Отправить конкретному пользователю (по первому доступному сокету)
    bool sendToUser(int64_t userId, const std::string& message);
    // Отправить всем сокетам пользователя
    void sendToAllUserSockets(int64_t userId, const std::string& message);

    // Отправить всем членам чата (кроме excluded)
    void sendToChatMembers(const std::vector<int64_t>& memberIds, const std::string& message, int64_t excluded = -1);

    // Отправить всем подключённым, кроме excluded
    void broadcast(const std::string& message, int64_t excluded = -1);

    // Получить все активные сокеты (для цикла опроса)
    std::vector<int> allSockets() const;
    // Получить userId по сокету
    int64_t userIdOfSocket(int fd) const;
    bool hasSocket(int fd) const;

private:
    mutable std::mutex mtx_;
    // userId -> set of fds
    std::map<int64_t, std::set<int>> userSockets_;
    // fd -> userId
    std::map<int, int64_t> socketUser_;
};

} // namespace cipher
