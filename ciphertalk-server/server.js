const App = require('./src/app');

let app;
try {
  app = new App();
} catch (err) {
  // Чаще всего — нечитаемая БД или потерянный ключ шифрования.
  // Не стартуем с пустой базой: это затерло бы исходные данные.
  console.error('\n❌ Не удалось запустить CipherTalk:');
  console.error('   ' + (err && err.message ? err.message : err));
  console.error('   Проверьте файл БД и ключ (.dbkey), либо задайте DB_ENCRYPTION=false для старого формата.\n');
  process.exit(1);
}

app.start();

module.exports = app;
