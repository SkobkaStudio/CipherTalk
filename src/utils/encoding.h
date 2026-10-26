// =============================================================================
//  utils/encoding.h — base64, hex, URL-decode и мелкие строковые помощники
// =============================================================================
//  Base64 нужен для: бинарных данных в JSON (хэши сообщений, nonce AES-GCM),
//  а также для WebSocket handshake (ключ Sec-WebSocket-Accept = base64(SHA1)).
// =============================================================================
#pragma once
#include <string>
#include <vector>
#include <cstdint>
#include <algorithm>

namespace enc {

static const char* B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// base64_encode("Man") -> "TWFu"
inline std::string base64Encode(const std::string& in) {
    std::string out;
    int val = 0, bits = -6;
    for (unsigned char c : in) {
        val = (val << 8) + c;
        bits += 8;
        while (bits >= 0) {
            out += B64CHARS[(val >> bits) & 0x3F];
            bits -= 6;
        }
    }
    if (bits > -6) out += B64CHARS[((val << 8) >> (bits + 8)) & 0x3F];
    while (out.size() % 4) out += '=';
    return out;
}

// base64_decode("TWFu") -> "Man" (символы вне алфавита просто игнорируются)
inline std::string base64Decode(const std::string& in) {
    std::vector<int> d(256, -1);
    for (int i = 0; i < 64; i++) d[(int)B64CHARS[i]] = i;
    std::string out;
    int val = 0, bits = -8;
    for (unsigned char c : in) {
        if (c == '=') break;
        if (d[c] == -1) continue;
        val = (val << 6) + d[c];
        bits += 6;
        if (bits >= 0) { out += char((val >> bits) & 0xFF); bits -= 8; }
    }
    return out;
}

// hex_encode("\x0A\xff") -> "0aff" — используется для хэшей паролей и токенов
inline std::string hexEncode(const std::string& in) {
    static const char* h = "0123456789abcdef";
    std::string out; out.reserve(in.size()*2);
    for (unsigned char c : in){ out+=h[c>>4]; out+=h[c&15]; }
    return out;
}
inline std::string hexDecode(const std::string& in) {
    auto v=[](char c)->int{
        if(c>='0'&&c<='9')return c-'0';
        if(c>='a'&&c<='f')return c-'a'+10;
        if(c>='A'&&c<='F')return c-'A'+10;
        return 0;
    };
    std::string out;
    for(size_t i=0;i+1<in.size();i+=2) out += char((v(in[i])<<4)|v(in[i+1]));
    return out;
}

// URL-декодирование (%D0%9F -> "П") — нужно для query-параметров и путей статики
inline std::string urlDecode(const std::string& s) {
    std::string out;
    for (size_t i=0;i<s.size();++i){
        if (s[i]=='%' && i+2<s.size()) { out += char(std::stoi(s.substr(i+1,2),nullptr,16)); i+=2; }
        else if (s[i]=='+') out += ' ';
        else out += s[i];
    }
    return out;
}

inline std::string toLower(std::string s){
    std::transform(s.begin(),s.end(),s.begin(),[](unsigned char c){return (char)tolower(c);});
    return s;
}
inline bool startsWith(const std::string& s, const std::string& p){
    return s.size()>=p.size() && s.compare(0,p.size(),p)==0;
}
inline std::string trim(const std::string& s){
    size_t a=s.find_first_not_of(" \t\r\n"); if(a==std::string::npos) return "";
    size_t b=s.find_last_not_of(" \t\r\n");
    return s.substr(a,b-a+1);
}

} // namespace enc
