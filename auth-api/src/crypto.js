// Bitwarden-inspired per-user encryption for chat messages.
// 2-layer model: per-user vault key wrapped by a password-derived or server-derived key.
// All encryption uses AES-256-GCM (authenticated encryption).
import crypto from "node:crypto";
import config from "./config.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32; // 256-bit
const PBKDF2_ITERATIONS = 100_000;

// ── Key generation ─────────────────────────────────────────────

/** Generate a random 256-bit vault key */
export function generateVaultKey() {
  return crypto.randomBytes(KEY_BYTES);
}

/**
 * Derive a wrapping key from a user's password + email (PBKDF2-SHA256).
 * Mirrors Bitwarden's master key derivation.
 */
export function derivePasswordKey(password, email) {
  const salt = Buffer.from(email.toLowerCase().trim(), "utf-8");
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, "sha256");
}

/**
 * Derive a wrapping key from the server master key + userId (HKDF-SHA256).
 * Used for OAuth users who have no password.
 */
export function deriveServerKey(userId) {
  const masterKey = Buffer.from(config.chatEncryptionKey, "hex");
  const info = Buffer.from(`vault-key:${userId}`, "utf-8");
  return crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), info, KEY_BYTES);
}

// ── Symmetric encryption (AES-256-GCM) ────────────────────────

/** Encrypt plaintext with a 256-bit key. Returns base64 string: iv + tag + ciphertext */
export function encrypt(plaintext, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a base64 string produced by encrypt(). Returns plaintext string. */
export function decrypt(encoded, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  const data = Buffer.from(encoded, "base64");
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = data.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf-8");
}

// ── Vault key wrapping ─────────────────────────────────────────

/** Wrap (encrypt) a vault key with a wrapping key. Returns base64 string. */
export function wrapKey(vaultKey, wrappingKey) {
  return encrypt(vaultKey.toString("base64"), wrappingKey);
}

/** Unwrap (decrypt) a vault key. Returns Buffer. */
export function unwrapKey(wrappedKey, wrappingKey) {
  const b64 = decrypt(wrappedKey, wrappingKey);
  return Buffer.from(b64, "base64");
}

// ── Detection helper ───────────────────────────────────────────

/** Check if a string looks like an encrypted value (base64 with min length) */
export function isEncrypted(value) {
  if (!value || typeof value !== "string") return false;
  // Minimum: 12 (iv) + 16 (tag) + 1 (min ciphertext) = 29 bytes → ~40 chars base64
  // Also reject values that look like normal text (contain spaces, newlines)
  if (value.length < 40) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(value);
}
