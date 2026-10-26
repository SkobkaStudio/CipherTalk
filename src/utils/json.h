// =============================================================================
//  utils/json.h — минимальный JSON-парсер и генератор (без внешних библиотек)
// =============================================================================
//  Зачем: сервер принимает и отдаёт JSON (REST API + события через WebSocket).
//  Вместо тяжёлой библиотеки типа nlohmann/json написан компактный класс Json,
//  который умеет всё необходимое: читать строку -> дерево, и дерево -> строку.
//
//  Типы значений (enum Type):
//    Null   — null
//    Bool   — true/false
//    Number — целые и дробные числа (хранятся как double)
//    String — строка (UTF-8)
//    Array  — массив   (внутри std::vector<Json>)
//    Object — объект   (внутри std::map<std::string, Json>, ключи отсортированы)
//
//  Использование:
//      Json j = Json::parse(R"({"a":1,"b":[2,3]})");
//      int a = j["a"].asInt();                  // доступ к полю объекта
//      Json out = Json::object();
//      out["ok"] = Json(true);                  // запись поля
//      std::string s = out.dump();              // сериализация в строку
// =============================================================================
#pragma once
#include <string>
#include <vector>
#include <map>
#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <cctype>
#include <cstdio>
#include <sstream>
#include <stdexcept>

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    // ------------------------------ конструкторы ----------------------------
    Json() : type_(Type::Null) {}
    Json(std::nullptr_t) : type_(Type::Null) {}
    Json(bool b) : type_(Type::Bool), bool_(b) {}
    Json(int i) : type_(Type::Number), num_(i) {}
    Json(long long i) : type_(Type::Number), num_((double)i) {}
    Json(double d) : type_(Type::Number), num_(d) {}
    Json(const char* s) : type_(Type::String), str_(s ? s : "") {}
    Json(std::string s) : type_(Type::String), str_(std::move(s)) {}
    Json(std::vector<Json> a) : type_(Type::Array), arr_(std::move(a)) {}

    // ------------------------------ предикаты типов -------------------------
    Type type() const { return type_; }
    bool isNull()   const { return type_ == Type::Null; }
    bool isBool()   const { return type_ == Type::Bool; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isString() const { return type_ == Type::String; }
    bool isArray()  const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    // ------------------------------ приведение --------------------------------
    const std::string& asString() const { static const std::string e; return type_==Type::String?str_:e; }
    double asDouble() const {
        if (type_==Type::Number) return num_;
        if (type_==Type::Bool)   return bool_?1:0;
        if (type_==Type::String) return atof(str_.c_str());
        return 0;
    }
    long long asInt() const { return (long long)asDouble(); }
    bool asBool() const {
        if (type_==Type::Bool) return bool_;
        if (type_==Type::Number) return num_!=0;
        if (type_==Type::String) return !str_.empty();
        return type_!=Type::Null;
    }

    // ------------------------------ доступ к элементам ------------------------
    Json& operator[](const std::string& key) {
        if (type_ != Type::Object) { type_ = Type::Object; }
        return obj_[key];
    }
    const Json& operator[](const std::string& key) const {
        static const Json nullJson;
        auto it = obj_.find(key);
        return it==obj_.end() ? nullJson : it->second;
    }
    bool has(const std::string& key) const { return obj_.count(key)>0; }

    void push_back(Json v) {
        if (type_ != Type::Array) { type_ = Type::Array; }
        arr_.push_back(std::move(v));
    }
    size_t size() const {
        if (type_==Type::Array)  return arr_.size();
        if (type_==Type::Object) return obj_.size();
        return 0;
    }
    const Json& at(size_t i) const { return arr_.at(i); }
    const std::vector<Json>& items() const { return arr_; }
    std::vector<Json>& itemsRef() { return arr_; }           // изменяемый обход массива
    const std::map<std::string,Json>& fields() const { return obj_; }

    static Json array()  { Json j; j.type_=Type::Array;  return j; }
    static Json object() { Json j; j.type_=Type::Object; return j; }

    // ============================ СЕРИАЛИЗАЦИЯ ==============================
    std::string dump() const { std::string o; write(o); return o; }
    std::string pretty(int indent=2) const { std::string o; writePretty(o,0,indent); return o; }

    void write(std::string& o) const {
        switch (type_) {
            case Type::Null:   o += "null"; break;
            case Type::Bool:   o += bool_ ? "true" : "false"; break;
            case Type::Number: {
                if (num_ == (double)(long long)num_ && std::fabs(num_) < 1e15)
                    o += std::to_string((long long)num_);
                else { std::stringstream ss; ss.precision(15); ss<<num_; o += ss.str(); }
                break;
            }
            case Type::String: escapeInto(o, str_); break;
            case Type::Array: {
                o += '[';
                for (size_t i=0;i<arr_.size();++i){ if(i)o+=','; arr_[i].write(o);}
                o += ']'; break;
            }
            case Type::Object: {
                o += '{';
                bool first=true;
                for (auto& kv : obj_) {
                    if(!first) o+=','; first=false;
                    escapeInto(o,kv.first); o+=':'; kv.second.write(o);
                }
                o += '}'; break;
            }
        }
    }
    void writePretty(std::string& o, int level, int step) const {
        auto pad=[&](int l){ o.append(l*step,' '); };
        switch (type_) {
            case Type::Array: {
                if (arr_.empty()){o+="[]";break;}
                o+="[\n";
                for (size_t i=0;i<arr_.size();++i){
                    pad(level+step); arr_[i].writePretty(o,level+step,step);
                    if(i+1<arr_.size())o+=','; o+='\n';
                }
                pad(level); o+=']'; break;
            }
            case Type::Object: {
                if (obj_.empty()){o+="{}";break;}
                o+="{\n";
                size_t i=0;
                for (auto& kv:obj_){
                    pad(level+step); escapeInto(o,kv.first); o+=": ";
                    kv.second.writePretty(o,level+step,step);
                    if(++i<obj_.size())o+=','; o+='\n';
                }
                pad(level); o+='}'; break;
            }
            default: write(o);
        }
    }

    // ============================ ПАРСЕР (текст -> объект) ====================
    static Json parse(const std::string& s) {
        Parser p(s); p.skipWs();
        Json v = p.value();
        p.skipWs();
        return v;
    }

private:
    Type type_;
    bool bool_=false;
    double num_=0;
    std::string str_;
    std::vector<Json> arr_;
    std::map<std::string, Json> obj_;

    static void escapeInto(std::string& o, const std::string& s) {
        o += '"';
        for (unsigned char c : s) {
            switch (c) {
                case '"':  o += "\\\""; break;
                case '\\': o += "\\\\"; break;
                case '\n': o += "\\n";  break;
                case '\r': o += "\\r";  break;
                case '\t': o += "\\t";  break;
                case '\b': o += "\\b";  break;
                case '\f': o += "\\f";  break;
                default:
                    if (c < 0x20) { char buf[8]; snprintf(buf,sizeof buf,"\\u%04x",c); o+=buf; }
                    else o += (char)c;
            }
        }
        o += '"';
    }

    // ---------- внутренний рекурсивный спуск-парсер ----------
    struct Parser {
        const std::string& s; size_t i = 0;
        Parser(const std::string& src):s(src){}

        [[noreturn]] void fail(const std::string& msg){ throw std::runtime_error("JSON error: "+msg); }
        void skipWs(){ while(i<s.size() && (s[i]==' '||s[i]=='\n'||s[i]=='\t'||s[i]=='\r')) ++i; }
        char peek(){ return i<s.size()?s[i]:'\0'; }

        Json value(){
            skipWs();
            char c = peek();
            if (c=='{') return object();
            if (c=='[') return array();
            if (c=='"') return Json(string());
            if (s.compare(i,4,"true")==0){ i+=4; return Json(true); }
            if (s.compare(i,5,"false")==0){i+=5; return Json(false);}
            if (s.compare(i,4,"null")==0) { i+=4; return Json(); }
            return number();
        }
        Json object(){
            Json j = Json::object();
            ++i;
            skipWs();
            if (peek()=='}'){ ++i; return j; }
            while (true) {
                skipWs();
                if (peek()!='"') fail("expected string key");
                std::string key = string();
                skipWs();
                if (peek()!=':') fail("expected ':'");
                ++i;
                j.obj_[key] = value();
                skipWs();
                char c = peek();
                if (c==','){ ++i; continue; }
                if (c=='}'){ ++i; break; }
                fail("expected ',' or '}'");
            }
            return j;
        }
        Json array(){
            Json j = Json::array();
            ++i;
            skipWs();
            if (peek()==']'){ ++i; return j; }
            while (true) {
                j.arr_.push_back(value());
                skipWs();
                char c = peek();
                if (c==','){ ++i; continue; }
                if (c==']'){ ++i; break; }
                fail("expected ',' or ']'");
            }
            return j;
        }
        std::string string(){
            ++i;
            std::string out;
            while (i < s.size()) {
                char c = s[i++];
                if (c=='"') return out;
                if (c=='\\') {
                    if (i>=s.size()) fail("bad escape");
                    char e = s[i++];
                    switch(e){
                        case '"': out+='"'; break;
                        case '\\':out+='\\';break;
                        case '/': out+='/'; break;
                        case 'n': out+='\n';break;
                        case 'r': out+='\r';break;
                        case 't': out+='\t';break;
                        case 'b': out+='\b';break;
                        case 'f': out+='\f';break;
                        case 'u': {
                            if (i+4>s.size()) fail("bad \\u");
                            unsigned cp = (unsigned)strtoul(s.substr(i,4).c_str(),nullptr,16);
                            i+=4;
                            if (cp>=0xD800 && cp<=0xDBFF && i+6<=s.size() && s.compare(i,2,"\\u")==0){
                                unsigned lo=(unsigned)strtoul(s.substr(i+2,4).c_str(),nullptr,16);
                                if (lo>=0xDC00 && lo<=0xDFFF){ i+=6; cp=0x10000+((cp-0xD800)<<10)+(lo-0xDC00); }
                            }
                            appendUtf8(out,cp);
                            break;
                        }
                        default: fail("unknown escape");
                    }
                } else out += c;
            }
            fail("unterminated string");
        }
        static void appendUtf8(std::string& out, unsigned cp){
            if (cp<0x80) out+=(char)cp;
            else if (cp<0x800){ out+=(char)(0xC0|(cp>>6));  out+=(char)(0x80|(cp&0x3F)); }
            else if (cp<0x10000){ out+=(char)(0xE0|(cp>>12)); out+=(char)(0x80|((cp>>6)&0x3F)); out+=(char)(0x80|(cp&0x3F)); }
            else { out+=(char)(0xF0|(cp>>18)); out+=(char)(0x80|((cp>>12)&0x3F)); out+=(char)(0x80|((cp>>6)&0x3F)); out+=(char)(0x80|(cp&0x3F)); }
        }
        Json number(){
            size_t start=i;
            while (i<s.size() && (isdigit((unsigned char)s[i])||s[i]=='-'||s[i]=='+'||s[i]=='.'||s[i]=='e'||s[i]=='E')) ++i;
            if (start==i) fail("expected number");
            return Json(atof(s.substr(start,i-start).c_str()));
        }
    };
};
