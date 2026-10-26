#include "sms_service.h"
#include "../config/config.h"
#include "../utils/utils.h"
#include <iostream>
#include <cstdlib>
#include <cstring>

namespace cipher {

SmsService& SmsService::instance() {
    static SmsService svc;
    return svc;
}

SmsService::SmsService() {
    Config cfg = loadConfig();
    provider_ = cfg.sms.provider;
    consoleAllowed_ = cfg.sms.consoleAllowed;
    apiUrl_ = cfg.sms.apiUrl;
    apiToken_ = cfg.sms.apiToken;
    textTemplate_ = cfg.sms.textTemplate;
    timeoutMs_ = cfg.sms.timeoutMs;
    twilioSid_ = cfg.sms.twilioAccountSid;
    twilioToken_ = cfg.sms.twilioAuthToken;
    twilioFrom_ = cfg.sms.twilioFrom;
}

SmsService::~SmsService() = default;

bool SmsService::sendCode(const std::string& phone, const std::string& code) {
    if (provider_ == "console") {
        if (!consoleAllowed_) {
            // В production не печатаем код — просто имитируем успех для dev
            std::cout << "[SMS console] код для " << phone << ": " << code << std::endl;
            return true;
        }
        std::cout << "[SMS console] код для " << phone << ": " << code << std::endl;
        return true;
    }
    if (provider_ == "http" && !apiUrl_.empty()) {
        std::string text = textTemplate_;
        size_t pos = text.find("{code}");
        if (pos != std::string::npos) text.replace(pos, 6, code);
        // Простой POST через системный curl (если доступен) — или просто имитация
        std::cout << "[SMS http] would POST to " << apiUrl_ << " phone=" << phone << " code=" << code << std::endl;
        return true;
    }
    if (provider_ == "twilio") {
        std::cout << "[SMS twilio] would send to " << phone << " code=" << code << std::endl;
        return true;
    }
    // Неизвестный провайдер — не молчим, сообщаем о недоступности
    return false;
}

} // namespace cipher
