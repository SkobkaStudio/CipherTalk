// ============================================================
// Реализация минимального JSON-парсера и генератора
// Поддерживает плоские объекты {"ключ": "значение"|"число"}
// ============================================================
#include "utils/json.hpp"
#include <cctype>
#include <cstdio>
#include <cstdlib>

namespace json {

// Получить значение по ключу (пустая строка если нет)
std::string JsonObject::get(const std::string& key) const {
    auto it = kv.find(key);
    return it != kv.end() ? it->second : std::string();
}

// Добавить пару ключ-значение
void JsonObject::put(const std::string& key, const std::string& value) {
    ordered.emplace_back(key, value);
    kv[key] = value;
}

// Экранирование специальных символов по стандарту JSON
std::string escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    // Управляющие символы кодируем как \u00XX
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// ---- Внутренние помощники парсера ----

// Пропустить пробельные символы
static void skipWs(const std::string& t, size_t& i) {
    while (i < t.size() && std::isspace(static_cast<unsigned char>(t[i]))) ++i;
}

// Разобрать строку в кавычках с поддержкой экранирования.
// Возвращает false при ошибке синтаксиса.
static bool parseString(const std::string& t, size_t& i, std::string& out) {
    if (i >= t.size() || t[i] != '"') return false;
    ++i; // пропускаем открывающую кавычку
    out.clear();
    while (i < t.size()) {
        char c = t[i++];
        if (c == '"') return true;               // закрывающая кавычка
        if (c == '\\') {                          // экранированный символ
            if (i >= t.size()) return false;
            char e = t[i++];
            switch (e) {
                case '"':  out += '"';  break;
                case '\\': out += '\\'; break;
                case '/':  out += '/';  break;
                case 'n':  out += '\n'; break;
                case 'r':  out += '\r'; break;
                case 't':  out += '\t'; break;
                case 'b':  out += '\b'; break;
                case 'f':  out += '\f'; break;
                case 'u': {
                    // \uXXXX — поддерживаем только базовую латиницу/ASCII
                    if (i + 4 > t.size()) return false;
                    std::string hex = t.substr(i, 4);
                    i += 4;
                    long code = std::strtol(hex.c_str(), nullptr, 16);
                    if (code < 0x80) out += static_cast<char>(code);
                    else {
                        // Кодируем UTF-8 из кодовой точки (до BMP)
                        if (code < 0x800) {
                            out += static_cast<char>(0xC0 | (code >> 6));
                            out += static_cast<char>(0x80 | (code & 0x3F));
                        } else {
                            out += static_cast<char>(0xE0 | (code >> 12));
                            out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
                            out += static_cast<char>(0x80 | (code & 0x3F));
                        }
                    }
                    break;
                }
                default: return false;
            }
        } else {
            out += c;
        }
    }
    return false; // незакрытая строка
}

// Пропустить произвольное JSON-значение (чтобы не падать на вложенных
// объектах/массивах — они нам не нужны, но текст должен разбираться).
static bool skipValue(const std::string& t, size_t& i) {
    skipWs(t, i);
    if (i >= t.size()) return false;
    char c = t[i];
    if (c == '{' || c == '[') {
        // Считаем глубину вложенности и пропускаем блок целиком
        char open = c, close = (c == '{') ? '}' : ']';
        int depth = 0;
        bool inStr = false;
        for (; i < t.size(); ++i) {
            char ch = t[i];
            if (inStr) {
                if (ch == '\\') ++i;
                else if (ch == '"') inStr = false;
                continue;
            }
            if (ch == '"') inStr = true;
            else if (ch == open) ++depth;
            else if (ch == close) { --depth; if (depth == 0) { ++i; return true; } }
        }
        return false;
    }
    if (c == '"') { std::string tmp; return parseString(t, i, tmp); }
    // Число / true / false / null — читаем до разделителя
    size_t start = i;
    while (i < t.size() && t[i] != ',' && t[i] != '}' && t[i] != ']' &&
           !std::isspace(static_cast<unsigned char>(t[i]))) ++i;
    return i > start;
}

// Разобрать текст JSON в плоский объект
bool parse(const std::string& text, JsonObject& out) {
    size_t i = 0;
    skipWs(text, i);
    if (i >= text.size() || text[i] != '{') return false;
    ++i;
    skipWs(text, i);
    if (i < text.size() && text[i] == '}') return true; // пустой объект

    while (i < text.size()) {
        skipWs(text, i);
        std::string key;
        if (!parseString(text, i, key)) return false;
        skipWs(text, i);
        if (i >= text.size() || text[i] != ':') return false;
        ++i;
        skipWs(text, i);

        std::string value;
        if (i < text.size() && text[i] == '"') {
            if (!parseString(text, i, value)) return false;
        } else {
            // Скалярное значение (число, bool, null) или структура
            size_t start = i;
            if (!skipValue(text, i)) return false;
            value = text.substr(start, i - start);
        }
        out.kv[key] = value;
        out.ordered.emplace_back(key, value);

        skipWs(text, i);
        if (i < text.size() && text[i] == ',') { ++i; continue; }
        if (i < text.size() && text[i] == '}') return true;
        return false;
    }
    return false;
}

// Сериализовать объект в JSON-строку
std::string dump(const JsonObject& obj) {
    std::string out = "{";
    for (size_t k = 0; k < obj.ordered.size(); ++k) {
        if (k) out += ",";
        out += "\"" + escape(obj.ordered[k].first) + "\":";
        out += "\"" + escape(obj.ordered[k].second) + "\"";
    }
    out += "}";
    return out;
}

} // namespace json
