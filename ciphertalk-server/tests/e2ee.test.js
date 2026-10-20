const crypto = require('crypto');

// Web Crypto simulation test
async function testE2EEWeb() {
  // Simulate ECDH P-256
  const ecdh1 = crypto.createECDH('prime256v1');
  ecdh1.generateKeys();
  const ecdh2 = crypto.createECDH('prime256v1');
  ecdh2.generateKeys();
  
  const secret = ecdh1.computeSecret(ecdh2.getPublicKey());
  
  // AES-256-GCM
  const iv = crypto.randomBytes(12); // Unique IV
  const key = crypto.createHash('sha256').update(secret).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = 'Test message';
  let ct = cipher.update(plaintext, 'utf8', 'base64');
  ct += cipher.final('base64');
  
  const tag = cipher.getAuthTag();
  
  // Server stores only {ciphertext, iv} conceptually
  const stored = {
    ciphertext: ct,
    iv: iv.toString('base64')
  };
  
  // Decrypt
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
  decipher.setAuthTag(tag);
  let pt = decipher.update(stored.ciphertext, 'base64', 'utf8');
  pt += decipher.final('utf8');
  
  if (pt !== plaintext) throw new Error('Failed');
  return true;
}

testE2EEWeb().then(r => {
  console.log('E2EE test:', r ? 'PASSED' : 'FAILED');
  process.exit(r ? 0 : 1);
}).catch(e => {
  console.error('E2EE test FAILED:', e);
  process.exit(1);
});
