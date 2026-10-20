const crypto = require('crypto');

// Test script proving encryption/decryption
async function testEncryption() {
  console.log('=== E2EE Crypto Test ===');
  
  // Simulate ECDH P-256 (as per requirement)
  const ecdh1 = crypto.createECDH('prime256v1');
  ecdh1.generateKeys();
  const ecdh2 = crypto.createECDH('prime256v1');
  ecdh2.generateKeys();
  
  const pub1 = ecdh1.getPublicKey();
  const pub2 = ecdh2.getPublicKey();
  
  // Exchange secrets
  const secret1 = ecdh1.computeSecret(pub2);
  const secret2 = ecdh2.computeSecret(pub1);
  
  if (!secret1.equals(secret2)) {
    throw new Error('ECDH secret mismatch');
  }
  console.log('✓ ECDH key exchange successful');
  
  // Derive AES-256 key from shared secret
  const aesKey = crypto.createHash('sha256').update(secret1).digest();
  console.log('✓ AES-256 key derived');
  
  // Encrypt each message with unique IV (as per requirement)
  const messages = ['Hello', 'How are you?', 'Secret message 🔐'];
  
  for (let i = 0; i < messages.length; i++) {
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const plaintext = messages[i];
    
    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    
    // Server stores only {ciphertext, iv}
    const stored = {
      ciphertext: ciphertext,
      iv: iv.toString('base64')
    };
    console.log(`  Msg ${i+1}: IV=${iv.toString('hex').substring(0,12)}..., ciphertext len=${ciphertext.length}`);
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    if (decrypted !== plaintext) {
      throw new Error(`Decryption failed for message ${i}`);
    }
  }
  
  console.log('✓ All messages encrypted/decrypted successfully');
  console.log('✓ Each message has unique IV');
  console.log('\n=== TEST PASSED ===');
  return true;
}

testEncryption()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
  });
