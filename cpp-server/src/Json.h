#pragma once
// Минимальный JSON-модуль (парсер + сериализатор) без внешних зависимостей.
// Используется всеми контроллерами сервера CipherTalk.
#include <string>
#include <vector>
#include <map>
#include <memory>
#include <stdexcept>
#include <cstdint>
#include <sstream>
#include <cmath>

namespace json {

class Value;
using Array  = std::vector<Value>;
using Object = std::map<std::string, Value>;

enum class Type { Null, Bool, Int, Double, String, Array, Object };

class Value {
public:
    Value() : type_(Type::Null) {}
    Value(std::nullptr_t) : type_(Type::Null) {}
    Value(bool b) : type_(Type::Bool), bool_(b) {}
    Value(int i) : type_(Type::Int), int_(i) {}
    Value(long i) : type_(Type::Int), int_(i) {}
    Value(long long i) : type_(Type::Int), int_(i) {}
    Value(unsigned i) : type_(Type::Int), int_(static_cast<long long>(i)) {}
    Value(double d) : type_(Type::Double), dbl_(d) {}
    Value(const char* s) : type_(Type::String), str_(s ? s : "") {}
    Value(const std::string& s) : type_(Type::String), str_(s) {}
    Value(std::string&& s) : type_(Type::String), str_(std::move(s)) {}
    Value(const Array& a) : type_(Type::Array), arr_(a) {}
    Value(const Object& o) : type_(Type::Object), obj_(o) {}

    static Value makeArray()  { Value v; v.type_ = Type::Array;  return v; }
    static Value makeObject() { Value v; v.type_ = Type::Object; return v; }

    Type type() const { return type_; }
    bool isNull()   const { return type_ == Type::Null; }
    bool isBool()   const { return type_ == Type::Bool; }
    bool isInt()    const { return type_ == Type::Int; }
    bool isNumber() const { return type_ == Type::Int || type_ == Type::Double; }
    bool isString() const { return type_ == Type::String; }
    bool isArray()  const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    bool        asBool()   const { return bool_; }
    long long   asInt()    const { return type_ == Type::Double ? static_cast<long long>(dbl_) : int_; }
    double      asDouble() const { return type_ == Type::Int ? static_cast<double>(int_) : dbl_; }
    const std::string& asString() const { return str_; }
    const Array&  asArray()  const { return arr_; }
    const Object& asObject() const { return obj_; }

    // Доступ по ключу для объектов (для парсинга). Возвращает null-значение, если ключа нет.
    const Value& operator[](const std::string& key) const {
        static const Value null_value;
        auto it = obj_.find(key);
        return it == obj_.end() ? null_value : it->second;
    }
    // Вставка/замена значения в объекте
    void set(const std::string& key, const Value& v) {
        if (type_ != Type::Object) { type_ = Type::Object; }
        obj_[key] = v;
    }
    bool has(const std::string& key) const { return type_ == Type::Object && obj_.count(key) > 0; }
    void push_back(const Value& v) {
        if (type_ != Type::Array) { type_ = Type::Array; }
        arr_.push_back(v);
    }
    size_t size() const {
        switch (type_) {
            case Type::Array:  return arr_.size();
            case Type::Object: return obj_.size();
            case Type::String: return str_.size();
            default: return 0;
        }
    }
    const Value& at(size_t i) const { return arr_.at(i); }

    std::string dump() const {
        std::ostringstream os;
        write(os);
        return os.str();
    }

    void write(std::ostream& os) const {
        switch (type_) {
            case Type::Null:   os << "null"; break;
            case Type::Bool:   os << (bool_ ? "true" : "false"); break;
            case Type::Int:    os << int_; break;
            case Type::Double: {
                if (!std::isfinite(dbl_)) { os << "null"; }
                else { std::ostringstream tmp; tmp.precision(17); tmp << dbl_; os << tmp.str(); }
                break;
            }
            case Type::String: escape(str_, os); break;
            case Type::Array: {
                os << '[';
                for (size_t i = 0; i < arr_.size(); ++i) {
                    if (i) os << ',';
                    arr_[i].write(os);
                }
                os << ']';
                break;
            }
            case Type::Object: {
                os << '{';
                bool first = true;
                for (const auto& kv : obj_) {
                    if (!first) os << ',';
                    first = false;
                    escape(kv.first, os);
                    os << ':';
                    kv.second.write(os);
                }
                os << '}';
                break;
            }
        }
    }

private:
    static void escape(const std::string& s, std::ostream& os) {
        os << '"';
        for (unsigned char c : s) {
            switch (c) {
                case '"':  os << "\\\""; break;
                case '\\': os << "\\\\"; break;
                case '\n': os << "\\n";  break;
                case '\r': os << "\\r";  break;
                case '\t': os << "\\t";  break;
                case '\b': os << "\\b";  break;
                case '\f': os << "\\f";  break;
                default:
                    if (c < 0x20) {
                        char buf[8];
                        snprintf(buf, sizeof(buf), "\\u%04x", c);
                        os << buf;
                    } else {
                        os << static_cast<char>(c);
                    }
            }
        }
        os << '"';
    }

    Type type_;
    bool bool_ = false;
    long long int_ = 0;
    double dbl_ = 0.0;
    std::string str_;
    Array arr_;
    Object obj_;
};

// ---------------- Парсер ----------------
class ParseError : public std::runtime_error {
public:
    explicit ParseError(const std::string& msg) : std::runtime_error("JSON parse error: " + msg) {}
};

class Parser {
public:
    explicit Parser(const std::string& text) : t_(text) {}

    Value parse() {
        skipWs();
        Value v = parseValue();
        skipWs();
        if (pos_ != t_.size()) throw ParseError("trailing characters at offset " + std::to_string(pos_));
        return v;
    }

private:
    const std::string& t_;
    size_t pos_ = 0;

    [[noreturn]] void fail(const std::string& msg) const {
        throw ParseError(msg + " at offset " + std::to_string(pos_));
    }
    char peek() const { return pos_ < t_.size() ? t_[pos_] : '\0'; }
    char next() { if (pos_ >= t_.size()) fail("unexpected end of input"); return t_[pos_++]; }
    void expect(char c) { if (next() != c) fail(std::string("expected '") + c + "'"); }
    void skipWs() {
        while (pos_ < t_.size()) {
            char c = t_[pos_];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++pos_;
            else break;
        }
    }

    Value parseValue() {
        skipWs();
        char c = peek();
        switch (c) {
            case '{': return parseObject();
            case '[': return parseArray();
            case '"': return Value(parseString());
            case 't': case 'f': return parseBool();
            case 'n': return parseNull();
            default:  return parseNumber();
        }
    }

    Value parseObject() {
        expect('{');
        Object obj;
        skipWs();
        if (peek() == '}') { ++pos_; return Value(obj); }
        while (true) {
            skipWs();
            std::string key = parseString();
            skipWs();
            expect(':');
            obj[key] = parseValue();
            skipWs();
            char c = next();
            if (c == ',') continue;
            if (c == '}') break;
            fail("expected ',' or '}' in object");
        }
        return Value(obj);
    }

    Value parseArray() {
        expect('[');
        Array arr;
        skipWs();
        if (peek() == ']') { ++pos_; return Value(arr); }
        while (true) {
            arr.push_back(parseValue());
            skipWs();
            char c = next();
            if (c == ',') continue;
            if (c == ']') break;
            fail("expected ',' or ']' in array");
        }
        return Value(arr);
    }

    std::string parseString() {
        expect('"');
        std::string out;
        while (true) {
            char c = next();
            if (c == '"') break;
            if (c != '\\') { out += c; continue; }
            char e = next();
            switch (e) {
                case '"':  out += '"';  break;
                case '\\': out += '\\'; break;
                case '/':  out += '/';  break;
                case 'b':  out += '\b'; break;
                case 'f':  out += '\f'; break;
                case 'n':  out += '\n'; break;
                case 'r':  out += '\r'; break;
                case 't':  out += '\t'; break;
                case 'u': {
                    unsigned cp = parseHex4();
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        // суррогатная пара
                        if (next() != '\\' || next() != 'u') fail("bad surrogate pair");
                        unsigned lo = parseHex4();
                        if (lo < 0xDC00 || lo > 0xDFFF) fail("bad low surrogate");
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: fail("bad escape sequence");
            }
        }
        return out;
    }

    unsigned parseHex4() {
        unsigned v = 0;
        for (int i = 0; i < 4; ++i) {
            char c = next();
            v <<= 4;
            if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
            else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
            else fail("bad hex digit in \\u escape");
        }
        return v;
    }

    static void appendUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) out += static_cast<char>(cp);
        else if (cp < 0x800) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    Value parseBool() {
        if (t_.compare(pos_, 4, "true") == 0)  { pos_ += 4; return Value(true); }
        if (t_.compare(pos_, 5, "false") == 0) { pos_ += 5; return Value(false); }
        fail("invalid literal");
    }
    Value parseNull() {
        if (t_.compare(pos_, 4, "null") == 0) { pos_ += 4; return Value(nullptr); }
        fail("invalid literal");
    }
    Value parseNumber() {
        size_t start = pos_;
        if (peek() == '-' || peek() == '+') ++pos_;
        bool is_double = false;
        while (pos_ < t_.size()) {
            char c = t_[pos_];
            if (c >= '0' && c <= '9') { ++pos_; }
            else if (c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+') { is_double = (c == '.') || is_double; ++pos_; }
            else break;
        }
        if (start == pos_) fail("invalid value");
        std::string num = t_.substr(start, pos_ - start);
        try {
            if (!is_double) return Value(static_cast<long long>(stoll(num)));
            return Value(stod(num));
        } catch (...) { fail("invalid number '" + num + "'"); }
    }
};

inline Value parse(const std::string& text) { return Parser(text).parse(); }

} // namespace json
