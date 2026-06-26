class SMSService {
  constructor() {
    // Здесь можно добавить интеграцию с реальным SMS-провайдером
    this.provider = 'console'; // 'console', 'twilio', 'nexmo'
  }

  async sendCode(phone, code) {
    // Логируем код в консоль для разработки
    console.log(`\n🔐 CipherTalk - Код подтверждения:`);
    console.log(`📱 Номер: ${phone}`);
    console.log(`🔑 Код: ${code}`);
    console.log(`⏰ Действителен 5 минут\n`);

    // Здесь можно добавить реальную отправку SMS
    // Например, через Twilio, Nexmo, etc.
    
    return {
      success: true,
      provider: this.provider,
      phone
    };
  }

  setProvider(provider) {
    this.provider = provider;
    // Инициализация провайдера
  }
}

module.exports = new SMSService();