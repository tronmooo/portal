import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
export const ENCRYPTED_PREFIX = 'enc:v1:';

let keyMissingWarned = false;

function tryGetKey(): Buffer | null {
  const k = process.env.FIELD_ENCRYPTION_KEY;
  if (!k) return null;
  // Accept hex (64 chars) or base64; final key must be 32 bytes.
  const buf = k.length === 64 ? Buffer.from(k, 'hex') : Buffer.from(k, 'base64');
  if (buf.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return buf;
}

export function encryptField(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = tryGetKey();
  if (!key) {
    if (!keyMissingWarned) {
      console.warn('[crypto-util] FIELD_ENCRYPTION_KEY not set — sensitive fields stored as plaintext. Set the env var to enable encryption.');
      keyMissingWarned = true;
    }
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTED_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptField(ciphertext: string): string {
  if (!ciphertext || !ciphertext.startsWith(ENCRYPTED_PREFIX)) return ciphertext;
  const key = tryGetKey();
  if (!key) {
    // Encrypted payload exists but no key configured — surface as failure
    // string rather than throwing so reads don't crash the app.
    return '[decryption failed: key not configured]';
  }
  const buf = Buffer.from(ciphertext.slice(ENCRYPTED_PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export const SENSITIVE_MEMORY_CATEGORIES = new Set([
  'credentials', 'financial', 'identity', 'banking', 'auth', 'password', 'secret',
]);

export function shouldEncryptMemory(category?: string | null): boolean {
  if (!category) return false;
  return SENSITIVE_MEMORY_CATEGORIES.has(category.toLowerCase());
}
