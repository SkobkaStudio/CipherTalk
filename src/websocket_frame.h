#pragma once

#include <vector>
#include <string>
#include <cstdint>
#include <optional>

namespace cipher::ws {

enum Opcode : uint8_t {
    CONTINUATION = 0x0,
    TEXT = 0x1,
    BINARY = 0x2,
    CLOSE = 0x8,
    PING = 0x9,
    PONG = 0xA,
};

struct Frame {
    bool fin = true;
    bool masked = false;
    Opcode opcode = Opcode::TEXT;
    std::vector<uint8_t> payload;
};

struct DecodeResult {
    std::optional<Frame> frame;
    size_t consumed = 0;
};

// Кодировать фрейм для отправки клиенту (сервер не маскирует исходящие)
std::vector<uint8_t> encodeFrame(const std::string& payload, Opcode opcode = Opcode::TEXT, bool fin = true);
// Декодировать фрейм из буфера. consumed = сколько байт использовано (включая неполные -> 0).
DecodeResult decodeFrame(const uint8_t* data, size_t len);
// Закрывающий фрейм
std::vector<uint8_t> closeFrame(uint16_t code = 1000, const std::string& reason = "");

} // namespace cipher::ws
