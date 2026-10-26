cmake_minimum_required(VERSION 3.16)
project(ciphertalk_server CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra)

find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)
find_package(ZLIB REQUIRED)

# --- SQLiteCpp (обёртка над sqlite3 API: Database/Statement/bind) ---
add_library(SQLiteCpp STATIC
    third_party/SQLiteCpp/Backup.cpp
    third_party/SQLiteCpp/Column.cpp
    third_party/SQLiteCpp/Database.cpp
    third_party/SQLiteCpp/Exception.cpp
    third_party/SQLiteCpp/Savepoint.cpp
    third_party/SQLiteCpp/Statement.cpp
    third_party/SQLiteCpp/Transaction.cpp
)
target_include_directories(SQLiteCpp PUBLIC include)
target_include_directories(SQLiteCpp SYSTEM PUBLIC third_party/SQLiteCpp/include)
target_link_libraries(SQLiteCpp PUBLIC sqlcipher OpenSSL::Crypto ZLIB::ZLIB)

# --- сервер ---
add_executable(ciphertalk-server
    src/main.cpp
    src/Database.cpp
    src/HttpServer.cpp
    src/AuthController.cpp
    src/ProfileController.cpp
    src/ChatController.cpp
    src/WsController.cpp
)
target_include_directories(ciphertalk-server PRIVATE src)
target_link_libraries(ciphertalk-server PRIVATE
    SQLiteCpp
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
)
