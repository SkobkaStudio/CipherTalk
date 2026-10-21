/**
 * Интеграционный тест клиентского сценария CipherTalk.
 *
 * Повторяет логику public/app.js: две стороны личного чата, собственный echo,
 * групповой ключ (wrap/unwrap), шифрование медиа, пересылка.
 *
 * Запуск: node tests/e2ee_client_flow.test.js
 */
const E2EE = require('../public/e2ee.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✅ ' + message);
  } else {
    failed++;
    console.log('  ❌ FAIL: ' + message);
  }
}

function section(title) {
  console.log('\n— ' + title + ' —');
}

// Клиентский слой: хранилище сессий в localStorage-подобном объекте
function makeStore() {
  const data = {};
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    remove: (k) => { delete data[k]; }
  };
}

function makeClient(name, store) {
  const client = {
    name,
    store,
    identity: null,
    sessions: {},
    groupBlobs: {},
    chatKeys: {},

    async init() {
      const saved = store.get('identity');
      if (saved) {
        this.identity = JSON.parse(saved);
      } else {
        this.identity = await E2EE.generateIdentity();
        store.set('identity', JSON.stringify(this.identity));
      }
      return this.identity;
    },

    saveSession(chatId, session) {
      const all = JSON.parse(store.get('sessions') || '{}');
      all[chatId] = E2EE.serializeSession(session);
      store.set('sessions', JSON.stringify(all));
    },

    loadSession(chatId) {
      const all = JSON.parse(store.get('sessions') || '{}');
      return all[chatId] ? E2EE.deserializeSession(all[chatId]) : null;
    },

    async getChatKey(chatId, peerPublicKey) {
      if (this.chatKeys[chatId]) return this.chatKeys[chatId];
      let session = this.loadSession(chatId);
      if (!session || session.peerPublicKey !== peerPublicKey) {
        session = await E2EE.createDirectSession(this.identity, peerPublicKey);
        this.saveSession(chatId, session);
      }
      this.chatKeys[chatId] = { kind: 'direct', session };
      return this.chatKeys[chatId];
    },

    async encrypt(chatKey, text, chatId) {
      if (chatKey.kind === 'group') {
        return E2EE.encryptGroup(chatKey.groupKey, text, String(chatId), 1);
      }
      const envelope = await E2EE.encryptDirect(chatKey.session, text, String(chatId));
      this.saveSession(chatId, chatKey.session);
      return envelope;
    },

    async decrypt(chatKey, payload, chatId, isOwn = false) {
      if (chatKey.kind === 'group') {
        return E2EE.decryptGroup(chatKey.groupKey, payload, String(chatId));
      }
      if (isOwn) {
        const text = await E2EE.decryptDirectOwn(chatKey.session, payload, String(chatId));
        this.saveSession(chatId, chatKey.session);
        return text;
      }
      const text = await E2EE.decryptDirect(chatKey.session, payload, String(chatId));
      this.saveSession(chatId, chatKey.session);
      return text;
    }
  };
  return client;
}

(async () => {
  console.log('\n=== Клиентский сценарий CipherTalk ===\n');

  const storeA = makeStore();
  const storeB = makeStore();
  const alice = makeClient('Алиса', storeA);
  const bob = makeClient('Борис', storeB);

  await alice.init();
  await bob.init();

  section('Личный чат: обмен сообщениями');
  const keyA = await alice.getChatKey(10, bob.identity.publicKey);
  const keyB = await bob.getChatKey(10, alice.identity.publicKey);

  const env1 = await alice.encrypt(keyA, 'Привет! Это первое секретное сообщение.', 10);
  const plain1 = await bob.decrypt(keyB, env1, 10);
  assert(plain1 === 'Привет! Это первое секретное сообщение.',
    'Борис расшифровал сообщение Алисы');

  const env2 = await bob.encrypt(keyB, 'Привет! Ответ Бориса.', 10);
  const plain2 = await alice.decrypt(keyA, env2, 10);
  assert(plain2 === 'Привет! Ответ Бориса.', 'Алиса расшифровала ответ Бориса');

  section('Собственный echo (сообщение сервер возвращает отправителю)');
  const ownPlain = await alice.decrypt(keyA, env2 === null ? env1 : {
    content: env1.content,
    iv: env1.iv,
    header: env1.header
  }, 10, true);
  assert(ownPlain === 'Привет! Это первое секретное сообщение.',
    'Алиса расшифровала собственное сообщение через decryptDirectOwn');

  section('Продолжение переписки после своего echo');
  const env3 = await alice.encrypt(keyA, 'Второе сообщение Алисы', 10);
  const plain3 = await bob.decrypt(keyB, env3, 10);
  assert(plain3 === 'Второе сообщение Алисы',
    'Цепочка приёма Бориса не сбилась после собственного echo');
  const env4 = await bob.encrypt(keyB, 'Ответ Бориса #2', 10);
  const plain4 = await alice.decrypt(keyA, env4, 10);
  assert(plain4 === 'Ответ Бориса #2', 'Алиса приняла второй ответ');

  section('Восстановление сессии после перезагрузки страницы');
  const aliceReloaded = makeClient('Алиса', storeA);
  await aliceReloaded.init();
  const keyReloaded = await aliceReloaded.getChatKey(10, bob.identity.publicKey);
  const env5 = await bob.encrypt(keyB, 'Сообщение после перезагрузки Алисы', 10);
  const plain5 = await aliceReloaded.decrypt(keyReloaded, env5, 10);
  assert(plain5 === 'Сообщение после перезагрузки Алисы',
    'Сессия восстановлена из localStorage и продолжила работу');

  section('Групповой чат: ключ создаётся создателем');
  const groupKey = E2EE.createGroupKey();
  const wrappedForBob = await E2EE.wrapGroupKey(groupKey, alice.identity, bob.identity.publicKey);
  const wrappedForAlice = await E2EE.wrapGroupKey(groupKey, alice.identity, alice.identity.publicKey);
  const bobGroupKey = await E2EE.unwrapGroupKey(wrappedForBob, bob.identity, alice.identity.publicKey);
  const aliceGroupKey = await E2EE.unwrapGroupKey(wrappedForAlice, alice.identity, alice.identity.publicKey);
  assert(Buffer.compare(Buffer.from(bobGroupKey), Buffer.from(aliceGroupKey)) === 0,
    'Оба участника получили одинаковый групповой ключ');

  const gEnvA = await E2EE.encryptGroup(aliceGroupKey, 'Привет всем в группе!', '20', 1);
  const gPlainB = await E2EE.decryptGroup(bobGroupKey, gEnvA, '20');
  assert(gPlainB === 'Привет всем в группе!', 'Групповое сообщение расшифровано участником');

  const gEnvB = await E2EE.encryptGroup(bobGroupKey, 'И всем привет!', '20', 1);
  const gPlainA = await E2EE.decryptGroup(aliceGroupKey, gEnvB, '20');
  assert(gPlainA === 'И всем привет!', 'Обратное групповое сообщение расшифровано');

  section('Медиа: отдельный файловый ключ');
  const media = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const encMedia = await E2EE.encryptFile(E2EE.sessionFileKey(keyA.session), media);
  const decMedia = await E2EE.decryptFile(E2EE.sessionFileKey(keyB.session), encMedia);
  assert(Buffer.compare(Buffer.from(media), Buffer.from(decMedia)) === 0,
    'Файл расшифрован ключом второй стороны');
  const encMedia2 = await E2EE.encryptFile(E2EE.sessionFileKey(keyA.session), media);
  const encMedia3 = await E2EE.encryptFile(E2EE.sessionFileKey(keyA.session), media);
  assert(encMedia2.iv !== encMedia3.iv && encMedia2.data !== encMedia3.data,
    'Каждое шифрование файла даёт уникальные IV и шифротекст');

  section('Пересылка: расшифровка локально, шифрование под целевой чат');
  const original = 'Секрет, который пересылают';
  const envOrig = await alice.encrypt(keyA, original, 10);
  const plainOrig = await bob.decrypt(keyB, envOrig, 10);
  const envFwd = await alice.encrypt(keyA, plainOrig, 30);
  const keyTarget = await bob.getChatKey(30, alice.identity.publicKey);
  const plainFwd = await bob.decrypt(keyTarget, envFwd, 30);
  assert(plainFwd === original, 'Пересланное сообщение читается в целевом чате');

  section('Защита от подмены контекста');
  const envBad = await alice.encrypt(keyA, 'Проверка AAD', 10);
  let aadBlocked = false;
  try {
    await bob.decrypt(keyB, envBad, 99);
  } catch (e) {
    aadBlocked = true;
  }
  assert(aadBlocked, 'Сообщение не расшифровывается в другом чате (AAD)');

  section('Итог');
  console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\n❌ Критическая ошибка:', err);
  process.exit(1);
});
