#pragma once
// ============================================================
// Контроллер WebSocket: обработка апгрейда соединения /ws,
// аутентификация по токену, цикл чтения кадров клиента.
// ============================================================
#include "utils/http_server.hpp"

namespace ws_controller {

// Обработчик апгрейда HTTP-соединения на WebSocket (путь /ws).
// Регистрируется в HttpServer через wsRoute().
void handleUpgrade(int clientFd, const HttpRequest& req);

} // namespace ws_controller
