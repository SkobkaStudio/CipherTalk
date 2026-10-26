# =============================================================================
#  CMakeLists.txt — сборка сервера мессенджера
# =============================================================================
#  Зависимости системы: g++ (C++17), libsqlite3-dev, libssl-dev (OpenSSL)
#
#  Сборка:
#      cmake -B build -DCMAKE_BUILD_TYPE=Release
#      cmake --build build -j
#      ./build/messenger 3000
# =============================================================================
cmake_minimum_required(VERSION 3.16)
project(messenger CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_compile_options(-Wall -Wextra -O2)

find_package(OpenSSL REQUIRED)   # нужен для PBKDF2/SHA-256 (utils/crypto.h)
find_library(SQLITE3_LIB sqlite3 REQUIRED)

# Один исполняемый файл: вся логика в заголовках + main.cpp
add_executable(messenger src/main.cpp)

target_link_libraries(messenger PRIVATE
    ${SQLITE3_LIB}
    OpenSSL::SSL
    OpenSSL::Crypto
    pthread            # стандартные потоки для пула соединений
)
