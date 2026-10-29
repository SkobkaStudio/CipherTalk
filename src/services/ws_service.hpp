#pragma once
// ============================================================
// Сервис WebSocket (RFC 6455) поверх POSIX-сокетов.
// - Handshake: вычисление Sec-WebSocket-Accept (SHA-1 + base64)
// - Кадрирование фреймов TEXT для клиентов сервера
// - WsManager: реестр активных соединений по userId, рассылка
// ============================================================
#include <string>
#include <vector>
#include <map>
#include <mutex>
#include <cstdint>

// ---- Низкоуровневые помощники протокола ----

// Вычислить значение заголовка Sec-WebSocket-Accept по ключу клиента
std::string wsComputeAccept(const std::string& secWebSocketKey);

// Закодировать UTF-8 текст в текстовый WebSocket-фрейм (для отправки клиенту)
std::string wsEncodeTextFrame(const std::string& payload);

// Прочитать один кадр из сокета (с обработкой маскирования клиентом).
// Возвращает true при успешном чтении; opcode: 0x1=text, 0x8=close, 0x9=ping.
bool wsReadFrame(int fd, std::string& payload, uint8_t& opcode);

// Отправить текстовый кадр в сокет
bool wsSendText(int fd, const std::string& text);

// ---- Менеджер соединений ----

class WsManager {
public:
    // Зарегистрировать соединение пользователя (fd)
    void addConnection(int64_t userId, int fd);

    // Удалить соединение по fd
    void removeConnection(int fd);

    // Отправить JSON-текст всем соединениям указанного пользователя
    void sendToUser(int64_t userId, const std::string& jsonText);

    // Отправить JSON-текст всем участникам чата (кроме отправителя)
    // chatMembers — список id участников
    void sendToChat(const std::vector<int64_t>& chatMembers,
                    int64_t exceptUserId,
                    const std::string& jsonText);

    // Сколько сейчас активных fd
    size_t connectionCount();

    // Глобальный синглтон менеджера
    static WsManager& instance();

private:
    std::mutex mtx_;
    std::multimap<int64_t, int> userToFd_; // userId -> список fd
};
