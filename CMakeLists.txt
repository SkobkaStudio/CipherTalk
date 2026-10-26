cmake_minimum_required(VERSION 3.10)
project(CipherTalkServer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Позиционно-независимый код (полезно, если потребуется плагинность)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Заголовочные файлы OpenSSL / SQLite обычно уже в системных путях,
# но явно указываем, чтобы сборка была детерминированной.
include_directories(/usr/include
  src
  src/utils
  src/config
  src/db
  src/models
  src/services
  src/controllers
  src/middleware)

add_executable(ciphertalk
  main.cpp

  src/config/config.cpp
  src/utils/utils.cpp
  src/utils/mask.cpp
  src/utils/crowns.cpp
  src/db/database.cpp

  src/http_server.cpp
  src/websocket_frame.cpp

  src/services/encryption_service.cpp
  src/services/session_service.cpp
  src/services/presence_service.cpp
  src/services/ice_service.cpp
  src/services/sms_service.cpp
  src/services/websocket_service.cpp

  src/controllers/auth_controller.cpp
  src/controllers/chat_controller.cpp
  src/controllers/profile_controller.cpp

  src/middleware/auth.cpp
  src/middleware/security.cpp

  src/models/user.cpp
  src/models/chat.cpp
  src/models/message.cpp
  src/models/session.cpp
  src/models/file.cpp
  src/models/folder.cpp
)

target_compile_options(ciphertalk PRIVATE -Wall -Wextra -O2 -pthread)
target_link_libraries(ciphertalk PRIVATE sqlite3 ssl crypto pthread)

# Копируем .env и папку public/uploads рядом с бинарником при установке
install(TARGETS ciphertalk RUNTIME DESTINATION bin)
install(DIRECTORY public/ DESTINATION public)
install(DIRECTORY uploads/ DESTINATION uploads)
