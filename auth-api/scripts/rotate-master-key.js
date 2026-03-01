#!/usr/bin/env node
// Rotate the chat encryption master key by re-wrapping all user vault keys.
// The underlying vault keys (and all encrypted data) remain unchanged.
//
// Usage:
//   DRY RUN (default):
//     OLD_KEY=<hex> NEW_KEY=<hex> DATABASE_URL=<url> node auth-api/scripts/rotate-master-key.js
//
//   EXECUTE:
//     OLD_KEY=<hex> NEW_KEY=<hex> DATABASE_URL=<url> node auth-api/scripts/rotate-master-key.js --execute
import pg from "pg";
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const OLD_KEY = process.env.OLD_KEY;
const NEW_KEY = process.env.NEW_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const EXECUTE = process.argv.includes("--execute");

if (!OLD_KEY || !NEW_KEY || !DATABASE_URL) {
  console.error("Required env vars: OLD_KEY, NEW_KEY, DATABASE_URL");
  process.exit(1);
}

if (OLD_KEY.length !== 64 || NEW_KEY.length !== 64) {
  console.error("Keys must be 64-char hex strings (256-bit)");
  process.exit(1);
}

if (OLD_KEY === NEW_KEY) {
  console.error("OLD_KEY and NEW_KEY must be different");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

function deriveWrappingKey(masterKeyHex, userId) {
  const masterKey = Buffer.from(masterKeyHex, "hex");
  const info = Buffer.from(`vault-key:${userId}`, "utf-8");
  return crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), info, KEY_BYTES);
}

function decrypt(encoded, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  const data = Buffer.from(encoded, "base64");
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = data.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf-8");
}

function encrypt(plaintext, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

async function main() {
  console.log(`Mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
  console.log("");

  const { rows } = await pool.query(
    `SELECT user_id, wrapped_key, key_type FROM user_vault_keys`
  );
  console.log(`Found ${rows.length} vault keys to rotate`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const { user_id, wrapped_key, key_type } = row;
    try {
      if (key_type !== "server") {
        console.log(`  User ${user_id}: skipped (key_type=${key_type}, not server-derived)`);
        skipped++;
        continue;
      }

      // Unwrap with old key
      const oldWrapping = deriveWrappingKey(OLD_KEY, user_id);
      const vaultKeyB64 = decrypt(wrapped_key, Buffer.from(oldWrapping));

      // Re-wrap with new key
      const newWrapping = deriveWrappingKey(NEW_KEY, user_id);
      const newWrapped = encrypt(vaultKeyB64, Buffer.from(newWrapping));

      if (EXECUTE) {
        await pool.query(
          `UPDATE user_vault_keys SET wrapped_key = $1 WHERE user_id = $2`,
          [newWrapped, user_id]
        );
        console.log(`  User ${user_id}: rotated ✓`);
      } else {
        console.log(`  User ${user_id}: would rotate (dry run)`);
      }
      success++;
    } catch (err) {
      console.error(`  User ${user_id}: FAILED — ${err.message}`);
      failed++;
    }
  }

  console.log("");
  console.log(`Results: ${success} rotated, ${skipped} skipped, ${failed} failed`);

  if (failed > 0) {
    console.error("Some users failed — old key is still valid for those users.");
    console.error("Do NOT update AKV until all users are rotated successfully.");
    process.exit(1);
  }

  if (!EXECUTE && success > 0) {
    console.log("");
    console.log("This was a dry run. Re-run with --execute to apply changes.");
  }

  await pool.end();
}

main().catch(err => {
  console.error("Rotation failed:", err);
  process.exit(1);
});
