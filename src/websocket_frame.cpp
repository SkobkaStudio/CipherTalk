#include "websocket_frame.h"
#include <cstring>
#include <algorithm>
#include <arpa/inet.h>
#include <netinet/in.h>

namespace cipher::ws {

std::vector<uint8_t> encodeFrame(const std::string& payload, Opcode opcode, bool fin) {
    std::vector<uint8_t> out;
    size_t len = payload.size();
    uint8_t b0 = (fin ? 0x80 : 0x00) | static_cast<uint8_t>(opcode);
    out.push_back(b0);

    uint8_t b1 = 0x00; // не маскируем сервер->клиент
    if (len < 126) {
        b1 |= static_cast<uint8_t>(len);
        out.push_back(b1);
    } else if (len <= 65535) {
        b1 |= 126;
        out.push_back(b1);
        uint16_t ext = htons(static_cast<uint16_t>(len));
        out.push_back((ext >> 8) & 0xFF);
        out.push_back(ext & 0xFF);
    } else {
        b1 |= 127;
        out.push_back(b1);
        uint64_t ext = htobe64(static_cast<uint64_t>(len));
        for (int i = 0; i < 8; ++i) out.push_back((ext >> ((7 - i) * 8)) & 0xFF);
    }
    out.insert(out.end(), payload.begin(), payload.end());
    return out;
}

DecodeResult decodeFrame(const uint8_t* data, size_t len) {
    DecodeResult res;
    if (len < 2) return res;
    Frame f;
    f.fin = (data[0] & 0x80) != 0;
    f.masked = (data[1] & 0x80) != 0;
    f.opcode = static_cast<Opcode>(data[0] & 0x0F);

    size_t offset = 2;
    size_t payloadLen = data[1] & 0x7F;
    if (payloadLen == 126) {
        if (len < 4) return res;
        payloadLen = ((size_t)data[2] << 8) | data[3];
        offset = 4;
    } else if (payloadLen == 127) {
        if (len < 10) return res;
        payloadLen = 0;
        for (int i = 0; i < 8; ++i) payloadLen = (payloadLen << 8) | data[2 + i];
        offset = 10;
    }

    if (f.masked) {
        if (len < offset + 4) return res;
        offset += 4;
    }

    if (len < offset + payloadLen) return res;

    res.consumed = offset + payloadLen;
    f.payload.assign(data + offset, data + offset + payloadLen);
    if (f.masked) {
        uint8_t mask[4];
        std::memcpy(mask, data + offset - 4, 4);
        for (size_t i = 0; i < f.payload.size(); ++i) f.payload[i] ^= mask[i % 4];
    }
    res.frame = f;
    return res;
}

std::vector<uint8_t> closeFrame(uint16_t code, const std::string& reason) {
    std::string payload;
    uint8_t codeBytes[2] = { static_cast<uint8_t>((code >> 8) & 0xFF), static_cast<uint8_t>(code & 0xFF) };
    payload.append(reinterpret_cast<const char*>(codeBytes), 2);
    payload.append(reason);
    return encodeFrame(payload, Opcode::CLOSE, true);
}

} // namespace cipher::ws
