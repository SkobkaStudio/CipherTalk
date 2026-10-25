/**
 * stickers_crud.test.js — CRUD-тесты пользовательских стикеров.
 *
 * Проверяет:
 *   - методы БД (addUserSticker / getUserStickers / getUserStickerById / deleteUserSticker)
 *   - сервис StickerService (listForUser / getOwned / remove + удаление файла с диска)
 *   - HTTP-слой: GET/DELETE /api/stickers через реальное приложение
 *     (401 без токена, 404 чужой/несуществующий стикер).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.PORT = '3501';
process.env.DB_FILE = './test-stickers-crud-db.json';
process.env.UPLOADS_DIR = './test-stickers-crud-uploads';
process.env.DB_ENCRYPTION = 'false';

// Удаляем остатки прошлого прогона до загрузки приложения (fail-closed на старом ключе).
for (const name of [
  'test-stickers-crud-db.json', 'test-stickers-crud-db.json.dbkey', 'test-stickers-crud-db.json.tmp',
  'test-stickers-crud-db.sqlite', 'test-stickers-crud-db.sqlite-wal',
  'test-stickers-crud-db.sqlite-shm', 'test-stickers-crud-db.sqlite.dbkey'
]) {
  try { fs.unlinkSync(path.join(__dirname, '..', name)); } catch (e) { /* ignore */ }
}
try { fs.rmSync(path.join(__dirname, '..', 'test-stickers-crud-uploads'), { recursive: true, force: true }); } catch (e) { /* ignore */ }

const App = require('../src/app');
const User = require('../src/models/User');
const File = require('../src/models/File');
const UserSticker = require('../src/models/UserSticker');
const sessionService = require('../src/services/sessionService');
const { StickerService } = require('../src/services/stickerService');

jest.setTimeout(20000);

let server;
let app;
let db;
let token;
let base;

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      base + urlPath,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers
        }
      },
      (res) => {
        let out = '';
        res.on('data', (d) => (out += d));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(out); } catch (e) { /* пустое тело */ }
          resolve({ status: res.statusCode, json, raw: out });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll((done) => {
  app = new App();
  server = app.start();
  const finish = () => {
    base = 'http://127.0.0.1:' + server.address().port;
    db = app.db;

    // Два тестовых пользователя напрямую в БД + сессия для первого.
    const alice = db.addUser(new User({ phone: '+70000000001', first_name: 'Alice' }));
    db.addUser(new User({ phone: '+70000000002', first_name: 'Bob' }));
    token = sessionService.create(alice.id).token;
    done();
  };
  const timer = setTimeout(() => {
    if (server.listening) finish();
    else done(new Error('not listening'));
  }, 8000);
  server.on('listening', () => {
    clearTimeout(timer);
    finish();
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

// Вспомогательная фабрика: файл-заглушка на диске + записи files/user_stickers.
function seedSticker(userId, opts = {}) {
  const filename = 'sticker-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const uploadsDir = require('../src/config').uploadsPath;
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // «PNG»
  const file = db.addFile(new File({
    filename,
    original_name: opts.originalName || 'sticker.png',
    size: 4,
    mimetype: opts.mimetype || 'image/png',
    uploader_id: userId
  }));
  const sticker = db.addUserSticker(new UserSticker({
    id: db.nextId('user_stickers'),
    user_id: userId,
    file_id: file.id,
    name: opts.name || 'Тест',
    animated: !!opts.animated,
    created_at: Date.now()
  }));
  return { sticker, file, filePath: path.join(uploadsDir, filename) };
}

describe('database.js: методы стикеров', () => {
  test('addUserSticker возвращает нормализованную строку и сохраняет её', () => {
    const alice = db.findUserByPhone('+70000000001');
    const { file } = seedSticker(alice.id, { name: 'Кот' });
    const s = db.addUserSticker(new UserSticker({
      id: db.nextId('user_stickers'),
      user_id: String(alice.id),       // строка -> должна стать числом
      file_id: String(file.id),
      name: 'Кот',
      animated: true,
      created_at: 123
    }));
    expect(s.user_id).toBe(alice.id);
    expect(s.file_id).toBe(file.id);
    expect(s.animated).toBe(1);
    const read = db.getUserStickerById(s.id);
    expect(read.name).toBe('Кот');
    expect(read.created_at).toBe(123);
  });

  test('getUserStickers отдаёт только стикеры пользователя, новые сверху', () => {
    const alice = db.findUserByPhone('+70000000001');
    const bob = db.findUserByPhone('+70000000002');
    seedSticker(alice.id, { name: 'A1' });
    const second = seedSticker(alice.id, { name: 'A2' });
    seedSticker(bob.id, { name: 'B1' });

    const list = db.getUserStickers(alice.id);
    expect(list.every((s) => s.user_id === alice.id)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(2);
    // ORDER BY created_at DESC — последний созданный должен быть первым
    expect(list[0].id).toBe(second.sticker.id);
  });

  test('getUserStickerById: несуществующий id -> null', () => {
    expect(db.getUserStickerById(999999)).toBeNull();
  });

  test('deleteUserSticker удаляет свой и не трогает чужой', () => {
    const alice = db.findUserByPhone('+70000000001');
    const bob = db.findUserByPhone('+70000000002');
    const mine = seedSticker(alice.id);
    const theirs = seedSticker(bob.id);

    expect(db.deleteUserSticker(theirs.sticker.id, alice.id)).toBe(false);
    expect(db.getUserStickerById(theirs.sticker.id)).not.toBeNull();

    expect(db.deleteUserSticker(mine.sticker.id, alice.id)).toBe(true);
    expect(db.getUserStickerById(mine.sticker.id)).toBeNull();
  });
});

describe('stickerService.js', () => {
  test('listForUser собирает DTO со ссылкой на файл', () => {
    const alice = db.findUserByPhone('+70000000001');
    const service = new StickerService(db);
    const { sticker, file } = seedSticker(alice.id, { name: 'DTO' });
    const dto = service.listForUser(alice.id).find((s) => s.id === sticker.id);
    expect(dto).toBeTruthy();
    expect(dto.name).toBe('DTO');
    expect(dto.fileId).toBe(file.id);
    expect(dto.url).toBe('/uploads/' + file.filename);
    expect(dto.animated).toBe(false);
  });

  test('getOwned: свой — ок, чужой/несуществующий — null', () => {
    const alice = db.findUserByPhone('+70000000001');
    const bob = db.findUserByPhone('+70000000002');
    const service = new StickerService(db);
    const mine = seedSticker(alice.id);
    const theirs = seedSticker(bob.id);
    expect(service.getOwned(mine.sticker.id, alice.id)).toBeTruthy();
    expect(service.getOwned(theirs.sticker.id, alice.id)).toBeNull();
    expect(service.getOwned(999999, alice.id)).toBeNull();
  });

  test('remove удаляет запись, строку files и файл с диска', () => {
    const alice = db.findUserByPhone('+70000000001');
    const service = new StickerService(db);
    const { sticker, file, filePath } = seedSticker(alice.id);
    expect(fs.existsSync(filePath)).toBe(true);

    expect(service.remove(sticker.id, alice.id)).toBe(true);
    expect(db.getUserStickerById(sticker.id)).toBeNull();
    expect(db.files.find((f) => f.id === file.id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);

    // Повторное удаление -> false (уже нет)
    expect(service.remove(sticker.id, alice.id)).toBe(false);
  });
});

describe('HTTP /api/stickers (GET/DELETE)', () => {
  test('без токена — 401', async () => {
    const res = await request('GET', '/api/stickers');
    expect(res.status).toBe(401);
  });

  test('GET со списком возвращает стикеры текущего пользователя', async () => {
    const alice = db.findUserByPhone('+70000000001');
    const { sticker } = seedSticker(alice.id, { name: 'HttpTest' });
    const res = await request('GET', '/api/stickers', null, {
      Authorization: 'Bearer ' + token
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.stickers)).toBe(true);
    expect(res.json.stickers.find((s) => s.id === sticker.id)).toBeTruthy();
  });

  test('DELETE чужого стикера — 404, своего — 200', async () => {
    const bob = db.findUserByPhone('+70000000002');
    const alice = db.findUserByPhone('+70000000001');
    const theirs = seedSticker(bob.id);
    const mine = seedSticker(alice.id);

    const denied = await request('DELETE', '/api/stickers/' + theirs.sticker.id, null, {
      Authorization: 'Bearer ' + token
    });
    expect(denied.status).toBe(404);
    expect(db.getUserStickerById(theirs.sticker.id)).not.toBeNull();

    const ok = await request('DELETE', '/api/stickers/' + mine.sticker.id, null, {
      Authorization: 'Bearer ' + token
    });
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    expect(db.getUserStickerById(mine.sticker.id)).toBeNull();
  });

  test('DELETE несуществующего / нечислового id — 400/404', async () => {
    const res1 = await request('DELETE', '/api/stickers/999999', null, {
      Authorization: 'Bearer ' + token
    });
    expect(res1.status).toBe(404);
    const res2 = await request('DELETE', '/api/stickers/abc', null, {
      Authorization: 'Bearer ' + token
    });
    expect(res2.status).toBe(400);
  });
});
