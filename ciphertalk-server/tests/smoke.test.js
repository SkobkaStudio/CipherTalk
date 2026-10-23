const http = require('http');
const fs = require('fs');
const path = require('path');
process.env.PORT = '3498';
process.env.DB_FILE = './test-smoke-db.json';
process.env.UPLOADS_DIR = './test-smoke-uploads';

// Удаляем остатки прошлого прогона до загрузки приложения:
// sessionService создаёт БД при require, и старый зашифрованный файл без ключа
// приводит к fail-closed.
for (const name of [
  'test-smoke-db.json', 'test-smoke-db.json.dbkey', 'test-smoke-db.json.tmp',
  'test-smoke-db.sqlite', 'test-smoke-db.sqlite-wal', 'test-smoke-db.sqlite-shm',
  'test-smoke-db.sqlite.dbkey'
]) {
  try { fs.unlinkSync(path.join(__dirname, '..', name)); } catch (e) { /* ignore */ }
}
try { fs.rmSync(path.join(__dirname, '..', 'test-smoke-uploads'), { recursive: true, force: true }); } catch (e) { /* ignore */ }

const App = require('../src/app');

jest.setTimeout(15000);

describe('CipherTalk smoke', () => {
  let server;
  let app;
  beforeAll((done) => {
    app = new App();
    server = app.start();
    const timer = setTimeout(() => {
      if (server.listening) done();
      else done(new Error('not listening'));
    }, 5000);
    server.on('listening', () => {
      clearTimeout(timer);
      done();
    });
  });
  afterAll((done) => {
    try {
      if (app) app.stop(() => done());
      else done();
    } catch (e) {
      done();
    }
  });
  test('health endpoint', (done) => {
    const port = server.address().port;
    http.get('http://127.0.0.1:' + port + '/api/health', (res) => {
      expect(res.statusCode).toBe(200);
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          expect(json.status).toBe('ok');
          done();
        } catch (e) {
          done(e);
        }
      });
    }).on('error', done);
  });
});
