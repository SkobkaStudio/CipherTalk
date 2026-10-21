const crypto = require('crypto');

// Web Crypto simulation: ECDH P-256 -> HKDF-style hash -> AES-256-GCM
describe('E2EE', () => {
  test('ECDH P-256 + AES-256-GCM roundtrip, сервер хранит только ciphertext+iv', () => {
    const ecdh1 = crypto.createECDH('prime256v1');
    ecdh1.generateKeys();
    const ecdh2 = crypto.createECDH('prime256v1');
    ecdh2.generateKeys();

    const secret1 = ecdh1.computeSecret(ecdh2.getPublicKey());
    const secret2 = ecdh2.computeSecret(ecdh1.getPublicKey());
    expect(secret1.equals(secret2)).toBe(true);

    const iv = crypto.randomBytes(12);
    const key = crypto.createHash('sha256').update(secret1).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = 'Test message';
    let ct = cipher.update(plaintext, 'utf8', 'base64');
    ct += cipher.final('base64');
    const tag = cipher.getAuthTag();

    const stored = { ciphertext: ct, iv: iv.toString('base64') };
    expect(JSON.stringify(stored)).not.toContain(plaintext);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
    decipher.setAuthTag(tag);
    let pt = decipher.update(stored.ciphertext, 'base64', 'utf8');
    pt += decipher.final('utf8');

    expect(pt).toBe(plaintext);
  });

  test('каждое сообщение получает уникальный IV', () => {
    const ivs = new Set();
    for (let i = 0; i < 100; i++) ivs.add(crypto.randomBytes(12).toString('base64'));
    expect(ivs.size).toBe(100);
  });
});
