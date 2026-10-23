/**
 * Проверка SMS-провайдера (замена заглушки «код всегда печатается в лог»).
 *
 * - console-провайдер в production запрещён (код не утекает в логи);
 * - http-провайдер реально шлёт запрос с кодом и телефоном;
 * - без настроенного провайдера код не создаётся, клиент получает 503.
 *
 * Запуск: node tests/sms_provider_test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}

// Запуск кода в отдельном процессе с нужным окружением
// Асинхронный запуск: родительский процесс не блокируется, поэтому
// локальный HTTP-сервер в тесте успевает обслужить запрос ребёнка.
function runNode(code, env = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], {
      cwd: ROOT,
      env: { ...process.env, ...env }
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, status: code });
    });
  });
}

async function main() {
  console.log('\n— console-провайдер в production запрещён —');
  const prod = await runNode(`
    const sms = require('${path.join(ROOT, 'src/services/smsService.js')}');
    sms.sendCode('+79990000000', '123456')
      .then(r => { console.log('RESULT:resolved:' + JSON.stringify(r)); })
      .catch(e => { console.log('RESULT:rejected:' + e.message); });
  `, { NODE_ENV: 'production', SMS_PROVIDER: 'console' });
  check(/RESULT:rejected/.test(prod.out), 'в production console-провайдер бросает ошибку');
  check(!/Код подтверждения: 123456/.test(prod.out), 'код НЕ печатается в лог в production');
  check(!/123456/.test(prod.out), 'код вообще не упоминается в выводе в production');

  console.log('\n— Явное разрешение для тестов —');
  const allowed = await runNode(`
    const sms = require('${path.join(ROOT, 'src/services/smsService.js')}');
    sms.sendCode('+79990000000', '654321')
      .then(r => { console.log('RESULT:resolved:' + JSON.stringify(r)); })
      .catch(e => { console.log('RESULT:rejected:' + e.message); });
  `, { NODE_ENV: 'production', SMS_PROVIDER: 'console', SMS_CONSOLE_ALLOW: 'true' });
  check(/RESULT:resolved/.test(allowed.out), 'SMS_CONSOLE_ALLOW=true разрешает console в production');
  check(/Код подтверждения: 654321/.test(allowed.out), 'в режиме разработки код печатается (это осознанно)');

  console.log('\n— http-провайдер —');
  let captured = null;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const httpRes = await runNode(`
    const sms = require('${path.join(ROOT, 'src/services/smsService.js')}');
    sms.sendCode('+79991234567', '112233')
      .then(r => { console.log('RESULT:resolved:' + JSON.stringify(r)); })
      .catch(e => { console.log('RESULT:rejected:' + e.message); });
  `, {
    NODE_ENV: 'production',
    SMS_PROVIDER: 'http',
    SMS_API_URL: `http://127.0.0.1:${port}/sms`,
    SMS_API_TOKEN: 'secret-token'
  });
  check(/RESULT:resolved/.test(httpRes.out), 'http-провайдер отправляет код');
  check(!!captured && captured.method === 'POST', 'используется POST');
  check(!!captured && captured.url === '/sms', 'запрос идёт на SMS_API_URL');
  check(!!captured && /"code"\s*:\s*"112233"/.test(captured.body), 'в теле запроса есть код');
  check(!!captured && /"phone"\s*:\s*"\+79991234567"/.test(captured.body), 'в теле запроса есть телефон');
  check(!!captured && captured.headers.authorization === 'Bearer secret-token',
    'токен провайдера передаётся в заголовке');
  check(!/secret-token/.test(httpRes.out), 'токен не печатается в лог');

  console.log('\n— Ошибка провайдера —');
  srv.close();
  const failing = await runNode(`
    const sms = require('${path.join(ROOT, 'src/services/smsService.js')}');
    sms.sendCode('+79990000000', '445566')
      .then(r => { console.log('RESULT:resolved:' + JSON.stringify(r)); })
      .catch(e => { console.log('RESULT:rejected:' + e.message.slice(0, 80)); });
  `, {
    NODE_ENV: 'production',
    SMS_PROVIDER: 'http',
    SMS_API_URL: 'http://127.0.0.1:1/sms'
  });
  check(/RESULT:rejected/.test(failing.out), 'недоступный провайдер => ошибка');

  console.log('\n— Неизвестный провайдер —');
  const unknown = await runNode(`
    const sms = require('${path.join(ROOT, 'src/services/smsService.js')}');
    sms.sendCode('+79990000000', '445566')
      .then(r => { console.log('RESULT:resolved:' + JSON.stringify(r)); })
      .catch(e => { console.log('RESULT:rejected:' + e.message.slice(0, 60)); });
  `, { NODE_ENV: 'production', SMS_PROVIDER: 'smsc' });
  check(/RESULT:rejected/.test(unknown.out), 'неизвестный провайдер отклоняется');

  console.log('\n— Контроллер: код не создаётся при недоступном провайдере —');
  const dbFile = path.join(ROOT, 'test-sms-db.json');
  for (const suffix of ['', '.key', '.jwt-secret', '.dbkey']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (e) {}
  }
  const sqliteFile = dbFile.replace(/\.json$/, '.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(sqliteFile + suffix); } catch (e) {}
  }
  const ctrl = await runNode(`
    process.env.DB_FILE = ${JSON.stringify(dbFile)};
    process.env.PORT = '3461';
    process.env.NODE_ENV = 'production';
    process.env.SMS_PROVIDER = 'http';
    process.env.SMS_API_URL = 'http://127.0.0.1:1/sms';
    const http = require('http');
    const App = require('${path.join(ROOT, 'src/app.js')}');
    const app = new App();
    const server = app.start();
    setTimeout(async () => {
      setTimeout(() => { console.log('RESULT:timeout'); process.exit(2); }, 8000);
      const body = JSON.stringify({ phone: '+79995556677' });
      const req = http.request({
        hostname: '127.0.0.1', port: 3461, path: '/api/send-code',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          const { getDatabase } = require('${path.join(ROOT, 'src/db/database.js')}');
          const db = getDatabase();
          console.log('RESULT:' + res.statusCode + ':' + text + ':codes=' + db.verificationCodes.length);
        });
      });
      req.write(body);
      req.end();
      // Второй запрос сразу после неудачи: cooldown не должен блокировать повтор.
      req.on('error', () => {});
      setTimeout(() => {
        const req2 = http.request({
          hostname: '127.0.0.1', port: 3461, path: '/api/send-code',
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
        }, res2 => {
          const chunks2 = [];
          res2.on('data', c => chunks2.push(c));
          res2.on('end', () => {
            const { getDatabase } = require('${path.join(ROOT, 'src/db/database.js')}');
            const db = getDatabase();
            console.log('RESULT2:' + res2.statusCode + ':codes=' + db.verificationCodes.length);
            db.stopAutoSave();
            try { app.wsService && app.wsService.stop(); } catch (e) {}
            server.close();
            process.exit(0);
          });
        });
        req2.write(body);
        req2.end();
      }, 300);
    }, 400);
  `);
  check(/RESULT:503/.test(ctrl.out), 'при недоступном провайдере API отвечает 503');
  check(/codes=0/.test(ctrl.out), 'код подтверждения не создан при ошибке отправки');
  if (!/RESULT2:503/.test(ctrl.out)) console.log('   [debug] ' + ctrl.out.trim().slice(0, 400));
  check(/RESULT2:503/.test(ctrl.out),
    'повторный запрос сразу после неудачи не блокируется cooldown-ом (503, а не 429)');

  for (const suffix of ['', '.key', '.jwt-secret', '.dbkey']) {
    try { fs.unlinkSync(dbFile + suffix); } catch (e) {}
  }
  const sqliteFileEnd = dbFile.replace(/\.json$/, '.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(sqliteFileEnd + suffix); } catch (e) {}
  }
  try { fs.rmSync(path.join(ROOT, 'test-sms-uploads'), { recursive: true, force: true }); } catch (e) {}

  console.log(`\n=== ИТОГО: passed=${passed}, failed=${failed} ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
