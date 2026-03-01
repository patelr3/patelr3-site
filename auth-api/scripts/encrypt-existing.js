#!/usr/bin/env node
// Encrypt existing plaintext chat messages and thread summaries.
// Idempotent: skips already-encrypted rows and users who already have vault keys.
//
// Usage: CHAT_ENCRYPTION_KEY=<hex> DATABASE_URL=<url> node auth-api/scripts/encrypt-existing.js
import pg from "pg";
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const CHAT_ENCRYPTION_KEY = process.env.CHAT_ENCRYPTION_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!CHAT_ENCRYPTION_KEY || !DATABASE_URL) {
  console.error("CHAT_ENCRYPTION_KEY and DATABASE_URL are required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

function deriveServerKey(userId) {
  const masterKey = Buffer.from(CHAT_ENCRYPTION_KEY, "hex");
  const info = Buffer.from(`vault-key:${userId}`, "utf-8");
  return crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), info, KEY_BYTES);
}

function generateVaultKey() {
  return crypto.randomBytes(KEY_BYTES);
}

function encrypt(plaintext, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function wrapKey(vaultKey, wrappingKey) {
  return encrypt(vaultKey.toString("base64"), wrappingKey);
}

function isEncrypted(value) {
  if (!value || typeof value !== "string") return false;
  if (value.length < 40) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(value);
}

async function main() {
  console.log("Starting migration...");

  // 1. Get all users who have chat threads
  const { rows: users } = await pool.query(`
    SELECT DISTINCT u.id FROM users u
    JOIN chat_threads ct ON ct.user_id = u.id
  `);
  console.log(`Found ${users.length} users with chat data`);

  for (const user of users) {
    const userId = user.id;

    // Ensure vault key exists
    const { rows: vkRows } = await pool.query(
      `SELECT wrapped_key FROM user_vault_keys WHERE user_id = $1`,
      [userId]
    );

    let vaultKey;
    if (vkRows.length === 0) {
      vaultKey = generateVaultKey();
      const wrappingKey = deriveServerKey(userId);
      const wrapped = wrapKey(vaultKey, Buffer.from(wrappingKey));
      await pool.query(
        `INSERT INTO user_vault_keys (user_id, wrapped_key, key_type) VALUES ($1, $2, 'server')`,
        [userId, wrapped]
      );
      console.log(`  User ${userId}: created vault key`);
    } else {
      // Unwrap existing vault key
      const wrappingKey = deriveServerKey(userId);
      const data = Buffer.from(vkRows[0].wrapped_key, "base64");
      const iv = data.subarray(0, IV_BYTES);
      const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = data.subarray(IV_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(wrappingKey), iv);
      decipher.setAuthTag(tag);
      const b64 = decipher.update(ciphertext) + decipher.final("utf-8");
      vaultKey = Buffer.from(b64, "base64");
      console.log(`  User ${userId}: using existing vault key`);
    }

    // 2. Encrypt plaintext messages
    const { rows: threads } = await pool.query(
      `SELECT id FROM chat_threads WHERE user_id = $1`,
      [userId]
    );

    let msgCount = 0;
    let sumCount = 0;

    for (const thread of threads) {
      // Encrypt messages
      const { rows: messages } = await pool.query(
        `SELECT id, content FROM chat_messages WHERE thread_id = $1`,
        [thread.id]
      );
      for (const msg of messages) {
        if (isEncrypted(msg.content)) continue; // already encrypted
        const encrypted = encrypt(msg.content, vaultKey);
        await pool.query(
          `UPDATE chat_messages SET content = $1 WHERE id = $2`,
          [encrypted, msg.id]
        );
        msgCount++;
      }

      // Encrypt thread summary
      const { rows: sumRows } = await pool.query(
        `SELECT summary FROM chat_threads WHERE id = $1`,
        [thread.id]
      );
      const summary = sumRows[0]?.summary;
      if (summary && !isEncrypted(summary)) {
        const encrypted = encrypt(summary, vaultKey);
        await pool.query(
          `UPDATE chat_threads SET summary = $1 WHERE id = $2`,
          [encrypted, thread.id]
        );
        sumCount++;
      }
    }

    console.log(`  User ${userId}: encrypted ${msgCount} messages, ${sumCount} summaries`);
  }

  console.log("Migration complete");
  await pool.end();
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
