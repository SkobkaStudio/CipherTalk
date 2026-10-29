#pragma once
// ============================================================
// Утилиты для работы с JSON (минимальный парсер и генератор)
// Используется для разбора тела HTTP-запросов и формирования
// ответов API без внешних зависимостей
// ============================================================
#include <string>
#include <map>
#include <vector>

namespace json {

// Простой JSON-объект: карта строка->строка.
// Поддерживаются только скалярные значения (числа как строки),
// что достаточно для нашего API.
struct JsonObject {
    // Упорядоченные пары ключ-значение (для генерации)
    std::vector<std::pair<std::string, std::string>> ordered;
    // Быстрый доступ по ключу (для парсинга)
    std::map<std::string, std::string> kv;

    // Получить значение по ключу, если отсутствует — пустая строка
    std::string get(const std::string& key) const;

    // Проверить наличие ключа
    bool has(const std::string& key) const { return kv.count(key) > 0; }

    // Добавить пару ключ-значение (в конец списка)
    void put(const std::string& key, const std::string& value);
};

// Экранировать строку для вставки в JSON
std::string escape(const std::string& s);

// Разобрать JSON-текст в JsonObject.
// При синтаксической ошибке возвращает false.
bool parse(const std::string& text, JsonObject& out);

// Сериализовать JsonObject в строку JSON
std::string dump(const JsonObject& obj);

} // namespace json
