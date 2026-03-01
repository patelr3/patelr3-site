# Chat Encryption Architecture

This document describes how SunnieAI chat messages are encrypted at rest in PostgreSQL, following a layered key model inspired by [Bitwarden's security architecture](https://bitwarden.com/help/bitwarden-security-white-paper/).

## Overview

All chat message content and thread summaries are encrypted with **AES-256-GCM** (authenticated encryption) before being stored in the database. Each user has a unique **vault key** that encrypts only their data, ensuring per-user isolation.

## Key Hierarchy

```
Server Master Key (CHAT_ENCRYPTION_KEY)
  └─ HKDF-SHA256(master, "vault-key:{userId}")  →  Per-user Wrapping Key
       └─ AES-256-GCM wraps  →  Random User Vault Key
            ├─ Encrypts chat_messages.content
            └─ Encrypts chat_threads.summary
```

### Components

| Component | Description | Storage |
|-----------|------------|---------|
| **Server Master Key** | 256-bit hex-encoded secret | AKV (`chat-encryption-key`), env var `CHAT_ENCRYPTION_KEY` |
| **Per-user Wrapping Key** | Derived via HKDF(master, userId) | Never stored — derived on demand |
| **User Vault Key** | Random 256-bit key, unique per user | Wrapped (encrypted) in `user_vault_keys` table |

### How It Works

1. **Account creation**: A random 256-bit vault key is generated
2. **Wrapping**: The vault key is encrypted (wrapped) with a user-specific wrapping key derived from the master key via HKDF-SHA256
3. **Storage**: The wrapped vault key is stored in the `user_vault_keys` table
4. **Runtime**: On each request, the vault key is unwrapped using HKDF(master, userId), then used to encrypt/decrypt chat content

## Threat Model

| Threat | Protection |
|--------|-----------|
| **Database-only breach** | ✅ Messages encrypted with AES-256-GCM. Vault keys are wrapped — attacker gets ciphertext only. |
| **Database + master key breach** | ⚠️ Attacker can derive wrapping keys and unwrap vault keys to decrypt messages. |
| **Per-user isolation** | ✅ Each user has a unique vault key — compromising one user's data does not expose others (unless master key is also compromised). |
| **Data at rest** | ✅ All sensitive content is encrypted in PostgreSQL. |
| **Data in transit** | ✅ TLS between client and server. Internal traffic within ACA is not encrypted but runs on a private VNET. |

### Not Zero-Knowledge

This is **encryption at rest**, not end-to-end zero-knowledge encryption. The server decrypts messages in memory to:
- Build conversation context for Azure AI Foundry (Responses API)
- Generate rolling summaries of older messages
- Serve message history to the frontend

True zero-knowledge is not feasible when the AI service needs message content to function.

## What Gets Encrypted

| Field | Encrypted? | Reason |
|-------|-----------|--------|
| `chat_messages.content` | ✅ Yes | User and assistant messages — the primary sensitive data |
| `chat_threads.summary` | ✅ Yes | AI-generated summaries of conversation history |
| `chat_threads.title` | ❌ No | User-chosen label, not conversational content |
| `chat_messages.role` | ❌ No | Structural metadata ("user" or "assistant") |
| IDs, timestamps | ❌ No | Structural metadata needed for queries |

## Backward Compatibility

The system auto-detects whether a value is encrypted (base64 format check) or plaintext. This allows:
- Gradual migration — existing plaintext data continues to work
- The migration script (`auth-api/scripts/encrypt-existing.js`) encrypts existing data in place
- New data is always encrypted when `CHAT_ENCRYPTION_KEY` is set

## Logging Policy

Structured logs (`auth-api/src/logger.js`) **never include message content**. Only metadata is logged:
- Status codes, event types, thread IDs, response IDs
- MCP tool call names, attempt numbers
- Error messages (from Foundry, not from users)

This policy is enforced by the logger's design — it only accepts structured attribute objects, and chat.js only passes metadata keys.

## Key Rotation

### Master Key Rotation

1. Generate a new master key: `openssl rand -hex 32`
2. Run the re-wrap script (decrypt vault keys with old master, re-wrap with new)
3. Update AKV secret `chat-encryption-key` with the new value
4. Deploy a new revision to pick up the new key

### Per-User Key Issues

If a user's vault key is corrupted or lost:
1. Generate a new vault key for the user
2. Old encrypted messages become unrecoverable
3. New messages are encrypted with the new vault key

## Configuration

| Env Var | Required | Description |
|---------|----------|-------------|
| `CHAT_ENCRYPTION_KEY` | No | 256-bit hex key (`openssl rand -hex 32`). If unset, chat is stored unencrypted. |

The key is stored in Azure Key Vault as `chat-encryption-key` and referenced via AKV references in the ACA deployment (Bicep).

## Future Enhancements

- **Password-derived wrapping**: For users with passwords, wrap the vault key with PBKDF2(password, email, 100K iterations) instead of server-derived HKDF. This would protect password users even if the master key is compromised. Requires caching the unwrapped vault key in-session since the server doesn't have the password at runtime.
- **Client-side decryption**: Move decryption to the frontend for true zero-knowledge. Would require architectural changes to how Foundry context is built.
- **Key escrow**: Allow admin recovery of user vault keys for compliance purposes.
