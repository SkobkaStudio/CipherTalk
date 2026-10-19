class SMSService {
  /**
   * Провайдер SMS не подключён: код выводится в консоль сервера.
   * Для продакшена замените тело метода на вызов Twilio/Nexmo и т.п.
   */
  async sendCode(phone, code) {
    console.log(`\n🔐 CipherTalk - Код подтверждения:`);
    console.log(`📱 Номер: ${phone}`);
    console.log(`🔑 Код: ${code}`);
    console.log(`⏰ Действителен 5 минут\n`);

    return { success: true, phone };
  }
}

module.exports = new SMSService();