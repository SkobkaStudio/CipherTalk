/**
 * Тесты криптографии CipherTalk E2EE (public/e2ee.js).
 *
 * Проверяются: ECDH P-256, AES-256-GCM, уникальность ключей и IV,
 * цепочечный ratchet, приём сообщений не по порядку, защита от подмены,
 * групповые ключи (wrap/unwrap), шифрование файлов, сериализация сессии.
 *
 * Запуск: node tests/e2ee_ratchet.test.js
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

(async () => {
  console.log('\n=== Тесты E2EE CipherTalk ===\n');

  const alice = await E2EE.generateIdentity();
  const bob = await E2EE.generateIdentity();
  const carol = await E2EE.generateIdentity();

  section('Идентичность и ECDH');
  assert(alice.publicKey && alice.privateKey, 'Пара ключей создана');
  assert(alice.publicKey !== bob.publicKey, 'Ключи разных пользователей различны');
  const sharedAB = await E2EE.ecdhSharedSecret(alice.privateKey, bob.publicKey);
  const sharedBA = await E2EE.ecdhSharedSecret(bob.privateKey, alice.publicKey);
  assert(Buffer.compare(Buffer.from(sharedAB), Buffer.from(sharedBA)) === 0,
    'ECDH симметричен: общий секрет совпадает у обеих сторон');
  const sharedAC = await E2EE.ecdhSharedSecret(alice.privateKey, carol.publicKey);
  assert(Buffer.compare(Buffer.from(sharedAB), Buffer.from(sharedAC)) !== 0,
    'Разные собеседники дают разные общие секреты');

  const sessionA = await E2EE.createDirectSession(alice, bob.publicKey);
  const sessionB = await E2EE.createDirectSession(bob, alice.publicKey);

  section('Сессия и направления ключей');
  assert(sessionA.sendChain !== sessionA.recvChain,
    'Ключ отправки и ключ приёма различаются (направленные цепочки)');
  assert(sessionA.sendChain === sessionB.recvChain,
    'Ключ отправки A совпадает с ключом приёма B');
  assert(sessionA.recvChain === sessionB.sendChain,
    'Ключ приёма A совпадает с ключом отправки B');

  section('Шифрование и расшифровка');
  const payloadA = await E2EE.encryptDirect(sessionA, 'Привет, Боб! Это секретный текст.', 'chat-1');
  assert(!!payloadA.content && !!payloadA.iv && !!payloadA.header, 'Сформирован конверт: content/iv/header');
  assert(!payloadA.content.includes('Привет'), 'Шифротекст не содержит открытого текста');
  const header = JSON.parse(payloadA.header);
  assert(header.v === 1 && header.n === 0 && !!header.s, 'Заголовок содержит версию, номер и соль');

  const plainA = await E2EE.decryptDirect(sessionB, payloadA, 'chat-1');
  assert(plainA === 'Привет, Боб! Это секретный текст.', 'B расшифровал сообщение A');

  const payloadB = await E2EE.encryptDirect(sessionB, 'Привет, Алис!', 'chat-1');
  const plainB = await E2EE.decryptDirect(sessionA, payloadB, 'chat-1');
  assert(plainB === 'Привет, Алис!', 'A расшифровал ответ B');

  section('Уникальность ключей и IV');
  const seenKeys = new Set();
  const seenIvs = new Set();
  let duplicates = 0;
  for (let i = 0; i < 25; i++) {
    const p = await E2EE.encryptDirect(sessionA, `сообщение ${i}`, 'chat-1');
    if (seenKeys.has(p.content)) duplicates++;
    seenKeys.add(p.content);
    if (seenIvs.has(p.iv)) duplicates++;
    seenIvs.add(p.iv);
  }
  assert(duplicates === 0, '25 сообщений: нет повторов шифротекста и IV');
  assert(seenIvs.size === 25, 'Каждому сообщению соответствует уникальный IV');

  section('Ratchet: шаг цепочки');
  const chainBefore = sessionA.sendChain;
  await E2EE.encryptDirect(sessionA, 'ещё одно', 'chat-1');
  assert(chainBefore !== sessionA.sendChain, 'Цепочка отправки продвинулась после отправки');
  const chainBeforeRecv = sessionB.recvChain;
  await E2EE.decryptDirect(sessionB, await E2EE.encryptDirect(sessionA, 'ещё одно', 'chat-1'), 'chat-1');
  assert(chainBeforeRecv !== sessionB.recvChain, 'Цепочка приёма продвинулась после приёма');

  section('Сообщения не по порядку');
  const sessionA2 = await E2EE.createDirectSession(alice, bob.publicKey);
  const sessionB2 = await E2EE.createDirectSession(bob, alice.publicKey);
  const p1 = await E2EE.encryptDirect(sessionA2, 'первое', 'chat-2');
  const p2 = await E2EE.encryptDirect(sessionA2, 'второе', 'chat-2');
  const p3 = await E2EE.encryptDirect(sessionA2, 'третье', 'chat-2');
  const outOfOrder = await E2EE.decryptDirect(sessionB2, p3, 'chat-2');
  assert(outOfOrder === 'третье', 'Принято опережающее сообщение (пропуск сохранён)');
  const late = await E2EE.decryptDirect(sessionB2, p1, 'chat-2');
  assert(late === 'первое', 'Отложенное сообщение расшифровано через skipped-ключи');
  const middle = await E2EE.decryptDirect(sessionB2, p2, 'chat-2');
  assert(middle === 'второе', 'Промежуточное отложенное сообщение расшифровано');

  section('Защита от подмены');
  const tamper = await E2EE.encryptDirect(sessionA, 'неприкосновенный текст', 'chat-3');
  let tamperBlocked = false;
  try {
    await E2EE.decryptDirect(sessionB, {
      content: tamper.content,
      iv: tamper.iv,
      header: JSON.stringify({ ...JSON.parse(tamper.header), n: 99 })
    }, 'chat-3');
  } catch (e) {
    tamperBlocked = true;
  }
  assert(tamperBlocked, 'Подмена заголовка (AAD) приводит к ошибке расшифровки');

  let wrongContextBlocked = false;
  try {
    const p = await E2EE.encryptDirect(sessionA, 'привязка к чату', 'chat-3');
    await E2EE.decryptDirect(sessionB, p, 'another-chat');
  } catch (e) {
    wrongContextBlocked = true;
  }
  assert(wrongContextBlocked, 'Сообщение не расшифровывается в другом чате (AAD c id чата)');

  let wrongKeyBlocked = false;
  const sessionC = await E2EE.createDirectSession(carol, bob.publicKey);
  try {
    await E2EE.decryptDirect(sessionC, payloadA, 'chat-1');
  } catch (e) {
    wrongKeyBlocked = true;
  }
  assert(wrongKeyBlocked, 'Чужой получатель не может расшифровать сообщение');

  section('Групповые ключи');
  const groupKey = E2EE.createGroupKey();
  assert(groupKey.length === 32, 'Ключ группы — 32 случайных байта');
  const wrappedForBob = await E2EE.wrapGroupKey(groupKey, alice, bob.publicKey);
  const wrappedForCarol = await E2EE.wrapGroupKey(groupKey, alice, carol.publicKey);
  assert(Buffer.compare(Buffer.from(wrappedForBob.ct), Buffer.from(wrappedForCarol.ct)) !== 0,
    'Каждому участнику ключ заворачивается отдельно');
  const unwrappedBob = await E2EE.unwrapGroupKey(wrappedForBob, bob, alice.publicKey);
  const unwrappedCarol = await E2EE.unwrapGroupKey(wrappedForCarol, carol, alice.publicKey);
  assert(Buffer.compare(Buffer.from(unwrappedBob), Buffer.from(groupKey)) === 0,
    'Участник распаковал свой ключ группы');
  assert(Buffer.compare(Buffer.from(unwrappedCarol), Buffer.from(groupKey)) === 0,
    'Второй участник распаковал ключ группы');

  const groupMsg = await E2EE.encryptGroup(groupKey, 'секрет группы', 'group-1', 1);
  const groupPlain = await E2EE.decryptGroup(groupKey, groupMsg, 'group-1');
  assert(groupPlain === 'секрет группы', 'Групповое сообщение расшифровывается ключом группы');

  let groupTamperBlocked = false;
  try {
    await E2EE.decryptGroup(groupKey, { ...groupMsg, content: groupMsg.content.slice(0, -6) + 'AAAAAA' }, 'group-1');
  } catch (e) {
    groupTamperBlocked = true;
  }
  assert(groupTamperBlocked, 'Подмена группового шифротекста обнаруживается');

  section('Файлы');
  const fileBytes = new Uint8Array(50000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = i % 251;
  const fileKey = E2EE.sessionFileKey(sessionA);
  const encryptedFile = await E2EE.encryptFile(fileKey, fileBytes);
  const decryptedFile = await E2EE.decryptFile(fileKey, encryptedFile);
  assert(decryptedFile.length === fileBytes.length &&
    Buffer.compare(Buffer.from(decryptedFile), Buffer.from(fileBytes)) === 0,
    'Файл зашифрован и расшифрован побайтно');

  section('Двусторонний обмен');
  const sA3 = await E2EE.createDirectSession(alice, bob.publicKey);
  const sB3 = await E2EE.createDirectSession(bob, alice.publicKey);
  let exchangeOk = true;
  for (let i = 0; i < 40; i++) {
    const fromA = i % 2 === 0;
    const sender = fromA ? sA3 : sB3;
    const receiver = fromA ? sB3 : sA3;
    const text = `реплика ${i} от ${fromA ? 'A' : 'B'}`;
    const env = await E2EE.encryptDirect(sender, text, 'chat-4');
    const back = await E2EE.decryptDirect(receiver, env, 'chat-4');
    if (back !== text) exchangeOk = false;
  }
  assert(exchangeOk, '40 двусторонних реплик расшифрованы без рассинхронизации цепочек');

  section('Сериализация сессии');
  const restored = E2EE.deserializeSession(E2EE.serializeSession(sessionA));
  assert(restored.sendChain === sessionA.sendChain && restored.recvChain === sessionA.recvChain,
    'Сессия сохраняется и восстанавливается без потери состояния');
  const payloadAfterRestore = await E2EE.encryptDirect(restored, 'после восстановления', 'chat-1');
  const decodedAfterRestore = await E2EE.decryptDirect(sessionB, payloadAfterRestore, 'chat-1');
  assert(decodedAfterRestore === 'после восстановления', 'Восстановленная сессия продолжает работать');

  console.log(`\n=== ИТОГ: passed=${passed}, failed=${failed} ===\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n💥 Критическая ошибка теста:', error);
  process.exit(1);
});
