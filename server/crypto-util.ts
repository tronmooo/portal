import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
export const ENCRYPTED_PREFIX = 'enc:v1:';

let keyMissingWarned = false;

let cachedKey: Buffer | null | undefined = undefined;

function tryGetKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  let k = process.env.FIELD_ENCRYPTION_KEY;
  if (!k) { cachedKey = null; return null; }
  // Strip accidental whitespace/quotes that some env-var systems include.
  k = k.trim().replace(/^['"]|['"]$/g, '');
  // Try hex first (64 chars = 32 bytes), fall back to base64.
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(k)) {
    buf = Buffer.from(k, 'hex');
  } else {
    try { buf = Buffer.from(k, 'base64'); } catch { buf = null; }
  }
  if (!buf || buf.length !== 32) {
    console.error('[crypto-util] FIELD_ENCRYPTION_KEY did not decode to 32 bytes (got ' + (buf ? buf.length : 'null') + '). Encryption disabled.');
    cachedKey = null;
    return null;
  }
  cachedKey = buf;
  return buf;
}

// Test-only — clears the cached key so tests can rebind env vars.
export function _resetCryptoKeyCacheForTesting() { cachedKey = undefined; }

export function encryptField(plaintext: string): string {
  if (!plaintext) return plaintext;
  let key: Buffer | null;
  try { key = tryGetKey(); } catch { key = null; }
  if (!key) {
    if (!keyMissingWarned) {
      console.warn('[crypto-util] FIELD_ENCRYPTION_KEY not configured — sensitive fields stored as plaintext. Set a 32-byte hex key to enable encryption.');
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
  let key: Buffer | null;
  try { key = tryGetKey(); } catch { key = null; }
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
