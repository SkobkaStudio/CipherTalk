#pragma once

#include <string>
#include <vector>

namespace cipher {

class SmsService {
public:
    static SmsService& instance();

    SmsService();
    ~SmsService();

    // Отправить код. Возвращает true при успехе.
    bool sendCode(const std::string& phone, const std::string& code);

    const std::string& provider() const { return provider_; }
    bool consoleAllowed() const { return consoleAllowed_; }

private:
    std::string provider_;
    bool consoleAllowed_ = false;
    std::string apiUrl_;
    std::string apiToken_;
    std::string textTemplate_;
    int timeoutMs_ = 10000;
    std::string twilioSid_, twilioToken_, twilioFrom_;
};

} // namespace cipher
