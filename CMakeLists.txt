# ============================================================
# Система сборки проекта CipherTalk — C++ мессенджер
# Требования: C++17, SQLite3, OpenSSL
# ============================================================
cmake_minimum_required(VERSION 3.10)
project(ciphertalk CXX)

# Стандарт языка C++17
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Режим отладки по умолчанию (для символов отладки)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug)
endif()

# Предупреждения компилятора
add_compile_options(-Wall -Wextra)

# Подключаем библиотеки: SQLite3 и OpenSSL
find_package(SQLite3 REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

# Все исходники приложения
file(GLOB_RECURSE SOURCES CONFIGURE_DEPENDS "src/*.cpp")

# Исполняемый файл messenger
add_executable(messenger ${SOURCES})

# Пути заголовков
target_include_directories(messenger PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${SQLite3_INCLUDE_DIRS}
    ${OPENSSL_INCLUDE_DIR}
)

# Линковка
target_link_libraries(messenger PRIVATE
    ${SQLite3_LIBRARIES}
    OpenSSL::Crypto
    Threads::Threads
)
