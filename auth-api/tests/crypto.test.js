import { jest } from "@jest/globals";

// Set a test encryption key before importing crypto module
process.env.CHAT_ENCRYPTION_KEY = "a".repeat(64); // 256-bit hex key

const {
  generateVaultKey,
  derivePasswordKey,
  deriveServerKey,
  wrapKey,
  unwrapKey,
  encrypt,
  decrypt,
  isEncrypted,
} = await import("../src/crypto.js");

describe("crypto module", () => {
  describe("generateVaultKey", () => {
    it("generates a 32-byte buffer", () => {
      const key = generateVaultKey();
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    });

    it("generates unique keys", () => {
      const k1 = generateVaultKey();
      const k2 = generateVaultKey();
      expect(k1.equals(k2)).toBe(false);
    });
  });

  describe("derivePasswordKey", () => {
    it("produces a 32-byte key from password and email", () => {
      const key = derivePasswordKey("mypassword", "user@example.com");
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    });

    it("is deterministic for same inputs", () => {
      const k1 = derivePasswordKey("pass", "a@b.com");
      const k2 = derivePasswordKey("pass", "a@b.com");
      expect(k1.equals(k2)).toBe(true);
    });

    it("differs for different passwords", () => {
      const k1 = derivePasswordKey("pass1", "a@b.com");
      const k2 = derivePasswordKey("pass2", "a@b.com");
      expect(k1.equals(k2)).toBe(false);
    });

    it("differs for different emails", () => {
      const k1 = derivePasswordKey("pass", "a@b.com");
      const k2 = derivePasswordKey("pass", "c@d.com");
      expect(k1.equals(k2)).toBe(false);
    });
  });

  describe("deriveServerKey", () => {
    it("produces a deterministic key from userId", () => {
      const k1 = deriveServerKey(42);
      const k2 = deriveServerKey(42);
      expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(true);
    });

    it("produces different keys for different users", () => {
      const k1 = deriveServerKey(1);
      const k2 = deriveServerKey(2);
      expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
    });
  });

  describe("encrypt / decrypt", () => {
    it("roundtrips plaintext correctly", () => {
      const key = generateVaultKey();
      const plaintext = "Hello, SunnieAI! 🌞";
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext each time (random IV)", () => {
      const key = generateVaultKey();
      const c1 = encrypt("same", key);
      const c2 = encrypt("same", key);
      expect(c1).not.toBe(c2);
    });

    it("fails with wrong key", () => {
      const k1 = generateVaultKey();
      const k2 = generateVaultKey();
      const encrypted = encrypt("secret", k1);
      expect(() => decrypt(encrypted, k2)).toThrow();
    });

    it("handles empty string", () => {
      const key = generateVaultKey();
      const encrypted = encrypt("", key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe("");
    });

    it("handles long content", () => {
      const key = generateVaultKey();
      const long = "x".repeat(100_000);
      const encrypted = encrypt(long, key);
      expect(decrypt(encrypted, key)).toBe(long);
    });
  });

  describe("wrapKey / unwrapKey", () => {
    it("roundtrips a vault key", () => {
      const vaultKey = generateVaultKey();
      const wrappingKey = generateVaultKey();
      const wrapped = wrapKey(vaultKey, wrappingKey);
      const unwrapped = unwrapKey(wrapped, wrappingKey);
      expect(unwrapped.equals(vaultKey)).toBe(true);
    });

    it("fails to unwrap with wrong wrapping key", () => {
      const vaultKey = generateVaultKey();
      const k1 = generateVaultKey();
      const k2 = generateVaultKey();
      const wrapped = wrapKey(vaultKey, k1);
      expect(() => unwrapKey(wrapped, k2)).toThrow();
    });
  });

  describe("isEncrypted", () => {
    it("returns true for encrypted values", () => {
      const key = generateVaultKey();
      const encrypted = encrypt("test", key);
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it("returns false for plaintext", () => {
      expect(isEncrypted("Hello world")).toBe(false);
      expect(isEncrypted("This is a chat message.")).toBe(false);
    });

    it("returns false for null/empty", () => {
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted("")).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
    });

    it("returns false for short base64", () => {
      expect(isEncrypted("aGVsbG8=")).toBe(false); // "hello" in base64
    });
  });

  describe("per-user isolation", () => {
    it("different users cannot decrypt each other's data", () => {
      const vk1 = generateVaultKey();
      const vk2 = generateVaultKey();
      const msg = "My financial data";
      const encrypted = encrypt(msg, vk1);
      expect(() => decrypt(encrypted, vk2)).toThrow();
    });
  });

  describe("vault key re-wrap", () => {
    it("re-wrapping preserves the vault key", () => {
      const vaultKey = generateVaultKey();
      const oldWrapping = derivePasswordKey("old-pass", "user@test.com");
      const newWrapping = derivePasswordKey("new-pass", "user@test.com");

      const wrapped1 = wrapKey(vaultKey, oldWrapping);
      const unwrapped = unwrapKey(wrapped1, oldWrapping);
      const wrapped2 = wrapKey(unwrapped, newWrapping);
      const final = unwrapKey(wrapped2, newWrapping);

      expect(final.equals(vaultKey)).toBe(true);
    });

    it("data encrypted before re-wrap is still decryptable", () => {
      const vaultKey = generateVaultKey();
      const message = "encrypted before password change";
      const encrypted = encrypt(message, vaultKey);

      // Re-wrap the vault key (doesn't change the vault key itself)
      const oldWrapping = derivePasswordKey("old", "u@t.com");
      const newWrapping = derivePasswordKey("new", "u@t.com");
      const wrapped = wrapKey(vaultKey, oldWrapping);
      const unwrapped = unwrapKey(wrapped, oldWrapping);
      wrapKey(unwrapped, newWrapping); // re-wrap

      // Same vault key, so old encrypted data still decrypts
      expect(decrypt(encrypted, vaultKey)).toBe(message);
    });
  });

  describe("master key rotation", () => {
    it("re-wrapping with new server key preserves vault key", () => {
      // Simulate: old master → wrap, new master → re-wrap
      const vaultKey = generateVaultKey();
      const oldWrapping = deriveServerKey(42);
      const wrapped = wrapKey(vaultKey, Buffer.from(oldWrapping));

      // Unwrap with old
      const unwrapped = unwrapKey(wrapped, Buffer.from(oldWrapping));
      expect(unwrapped.equals(vaultKey)).toBe(true);

      // Change the master key env var to simulate rotation
      const origKey = process.env.CHAT_ENCRYPTION_KEY;
      process.env.CHAT_ENCRYPTION_KEY = "b".repeat(64);
      const newWrapping = deriveServerKey(42);

      // Re-wrap with new
      const reWrapped = wrapKey(unwrapped, Buffer.from(newWrapping));
      const finalKey = unwrapKey(reWrapped, Buffer.from(newWrapping));
      expect(finalKey.equals(vaultKey)).toBe(true);

      // Restore
      process.env.CHAT_ENCRYPTION_KEY = origKey;
    });

    it("encrypted data survives master key rotation", () => {
      const vaultKey = generateVaultKey();
      const messages = ["Hello", "How is my budget?", "Thanks!"];
      const encrypted = messages.map(m => encrypt(m, vaultKey));

      // Simulate rotation (vault key stays the same, only wrapping changes)
      const oldWrapping = deriveServerKey(7);
      const wrapped = wrapKey(vaultKey, Buffer.from(oldWrapping));
      const unwrapped = unwrapKey(wrapped, Buffer.from(oldWrapping));

      process.env.CHAT_ENCRYPTION_KEY = "c".repeat(64);
      const newWrapping = deriveServerKey(7);
      wrapKey(unwrapped, Buffer.from(newWrapping));
      process.env.CHAT_ENCRYPTION_KEY = "a".repeat(64);

      // All messages still decrypt with the same vault key
      const decrypted = encrypted.map(e => decrypt(e, vaultKey));
      expect(decrypted).toEqual(messages);
    });
  });
});
