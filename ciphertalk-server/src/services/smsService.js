const config = require('../config');

/**
 * Отправка SMS с кодом подтверждения.
 *
 * Провайдеры:
 *  - console — вывод кода в лог сервера. Разрешён только в разработке
 *    (или при явном SMS_CONSOLE_ALLOW=true). В production код в логи не пишется.
 *  - http    — generic HTTP-провайдер: POST JSON {phone, code, text} на SMS_API_URL.
 *  - twilio  — Twilio Messages API (Basic auth по SID/TOKEN).
 *
 * Если провайдер не настроен или отправка не удалась — sendCode бросает
 * исключение, и контроллер не создаёт код подтверждения (иначе пользователь
 * получил бы «код отправлен», которого никто не отправил).
 */
class SmsService {
  constructor() {
    this.provider = (config.sms.provider || 'console').toLowerCase();
  }

  isConsoleAllowed() {
    if (config.sms.consoleAllowed) return true;
    return process.env.NODE_ENV !== 'production';
  }

  buildText(code) {
    const template = config.sms.textTemplate || 'CipherTalk: ваш код {code}';
    return template.replace('{code}', code);
  }

  async sendCode(phone, code) {
    switch (this.provider) {
      case 'http':
        return this.sendHttp(phone, code);
      case 'twilio':
        return this.sendTwilio(phone, code);
      case 'console':
        return this.sendConsole(phone, code);
      default:
        throw new Error(`Неизвестный SMS-провайдер: ${this.provider}`);
    }
  }

  async sendConsole(phone, code) {
    if (!this.isConsoleAllowed()) {
      throw new Error(
        'SMS-провайдер не настроен: в production вывод кода в консоль запрещён ' +
        '(задайте SMS_PROVIDER=http|twilio или SMS_CONSOLE_ALLOW=true для тестов)'
      );
    }
    console.log('\n' + '='.repeat(60));
    console.log('[SMS/console] Код подтверждения: ' + code);
    console.log('Телефон: ' + phone);
    console.log('='.repeat(60) + '\n');
    return { success: true, provider: 'console' };
  }

  async sendHttp(phone, code) {
    const url = config.sms.apiUrl;
    if (!url) throw new Error('SMS_API_URL не задан');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.sms.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (config.sms.apiToken) headers.Authorization = 'Bearer ' + config.sms.apiToken;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          phone,
          code,
          text: this.buildText(code),
          source: 'ciphertalk'
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`SMS-провайдер ответил ${res.status}: ${body.slice(0, 200)}`);
      }
      return { success: true, provider: 'http' };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendTwilio(phone, code) {
    const sid = config.sms.twilioAccountSid;
    const token = config.sms.twilioAuthToken;
    const from = config.sms.twilioFrom;
    if (!sid || !token || !from) {
      throw new Error('Не заданы TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.sms.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + auth
        },
        body: new URLSearchParams({
          To: phone,
          From: from,
          Body: this.buildText(code)
        }).toString(),
        signal: controller.signal
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Twilio ответил ${res.status}: ${body.slice(0, 200)}`);
      }
      return { success: true, provider: 'twilio' };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = new SmsService();
