import pg from "pg";
import bcrypt from "bcryptjs";
import config from "./config.js";
import { encrypt, decrypt, isEncrypted } from "./crypto.js";

const pool = new pg.Pool({ connectionString: config.databaseUrl });

const ADMIN_EMAIL = "16patelr@gmail.com";

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      google_id       VARCHAR(255) UNIQUE,
      email           VARCHAR(255) UNIQUE NOT NULL,
      password_hash   VARCHAR(255),
      display_name    VARCHAR(255),
      avatar_url      TEXT,
      role            VARCHAR(50) DEFAULT 'user',
      last_login_at   TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add last_login_at if missing (existing DBs)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS services (
      id              SERIAL PRIMARY KEY,
      slug            VARCHAR(100) UNIQUE NOT NULL,
      name            VARCHAR(255) NOT NULL,
      description     TEXT DEFAULT '',
      endpoint_url    VARCHAR(500) NOT NULL,
      is_visible      BOOLEAN DEFAULT true,
      is_restricted   BOOLEAN DEFAULT false,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_service_access (
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      service_id  INT REFERENCES services(id) ON DELETE CASCADE,
      granted_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, service_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      service_id  INT REFERENCES services(id) ON DELETE CASCADE,
      status      VARCHAR(20) DEFAULT 'pending',
      reviewed_by INT REFERENCES users(id),
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, service_id, status)
    )
  `);

  // Seed default services
  await pool.query(`
    INSERT INTO services (slug, name, description, endpoint_url, is_visible, is_restricted)
    VALUES
      ('hello-world', 'Hello World', 'A sample micro-service running in its own container.', '/api/hello/', true, false),
      ('hello-world-restricted', 'Hello World (Restricted)', 'A restricted micro-service — request access to use it.', '/api/hello-restricted/', true, true),
      ('actualbudget', 'Actual Budget', 'Self-hosted personal finance manager.', '/services/actualbudget', false, true)
    ON CONFLICT (slug) DO NOTHING
  `);

  // Ensure admin user gets admin role if they already exist
  await pool.query(
    `UPDATE users SET role = 'admin', updated_at = NOW() WHERE email = $1 AND role != 'admin'`,
    [ADMIN_EMAIL]
  );

  // Auto-grant admin access to restricted services
  const adminUser = await pool.query("SELECT id FROM users WHERE email = $1", [ADMIN_EMAIL]);
  if (adminUser.rows.length > 0) {
    const adminId = adminUser.rows[0].id;
    const restrictedSvcs = await pool.query("SELECT id FROM services WHERE is_restricted = true");
    for (const svc of restrictedSvcs.rows) {
      await pool.query(
        `INSERT INTO user_service_access (user_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [adminId, svc.id]
      );
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      token       VARCHAR(255) UNIQUE NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // OIDC authorization codes (auth-api as OIDC IdP for ActualBudget instances)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oidc_auth_codes (
      code          VARCHAR(255) PRIMARY KEY,
      user_id       INT REFERENCES users(id) ON DELETE CASCADE,
      redirect_uri  TEXT NOT NULL,
      client_id     VARCHAR(255) NOT NULL,
      code_challenge TEXT,
      code_challenge_method VARCHAR(10),
      google_claims JSONB,
      expires_at    TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // OIDC access tokens (persistent, replaces in-memory store)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oidc_access_tokens (
      token       TEXT PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      claims      JSONB NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Widen token column if it was previously VARCHAR(255)
  await pool.query(`ALTER TABLE oidc_access_tokens ALTER COLUMN token TYPE TEXT`);

  // OIDC refresh tokens (for refresh_token grant)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oidc_refresh_tokens (
      token       TEXT PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      client_id   VARCHAR(255) NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Widen token column if it was previously VARCHAR(255)
  await pool.query(`ALTER TABLE oidc_refresh_tokens ALTER COLUMN token TYPE TEXT`);

  // Chat threads (user conversations)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id              SERIAL PRIMARY KEY,
      user_id         INT REFERENCES users(id) ON DELETE CASCADE,
      foundry_thread_id VARCHAR(255) NOT NULL DEFAULT '',
      title           VARCHAR(255) DEFAULT 'New conversation',
      summary         TEXT DEFAULT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Chat messages (local message storage for summarization)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id              SERIAL PRIMARY KEY,
      thread_id       INT REFERENCES chat_threads(id) ON DELETE CASCADE,
      role            VARCHAR(20) NOT NULL,
      content         TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add summary column if missing (migration for existing DBs)
  await pool.query(`
    ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS summary TEXT DEFAULT NULL
  `);

  // Per-user vault keys for chat encryption (Bitwarden-inspired)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_vault_keys (
      user_id     INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      wrapped_key TEXT NOT NULL,
      key_type    VARCHAR(20) NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed a test user in local dev only (no AUTH_API_URL set)
  if (!config.authApiUrl) {
    const existing = await pool.query("SELECT id FROM users WHERE email = 'test@local.dev'");
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash("TestPass123", 12);
      await pool.query(
        `INSERT INTO users (email, password_hash, display_name, role)
         VALUES ('test@local.dev', $1, 'Test User', 'user')
         ON CONFLICT (email) DO NOTHING`,
        [hash]
      );
    }
  }
}

export async function upsertGoogleUser(profile) {
  const email = profile.emails[0].value;
  const role = email === ADMIN_EMAIL ? "admin" : "user";

  const { rows } = await pool.query(
    "SELECT * FROM users WHERE google_id = $1",
    [profile.id]
  );

  if (rows.length > 0) {
    const { rows: updated } = await pool.query(
      `UPDATE users SET display_name = $1, avatar_url = $2, role = $3, updated_at = NOW()
       WHERE google_id = $4 RETURNING *`,
      [profile.displayName, profile.photos?.[0]?.value || "", role, profile.id]
    );
    return updated[0];
  }

  const { rows: existing } = await pool.query(
    "SELECT * FROM users WHERE email = $1",
    [email]
  );
  if (existing.length > 0) {
    const { rows: linked } = await pool.query(
      `UPDATE users SET google_id = $1, display_name = $2, avatar_url = $3, role = $4, updated_at = NOW()
       WHERE email = $5 RETURNING *`,
      [profile.id, profile.displayName, profile.photos?.[0]?.value || "", role, email]
    );
    return linked[0];
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO users (google_id, email, display_name, avatar_url, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [profile.id, email, profile.displayName, profile.photos?.[0]?.value || "", role]
  );
  return inserted[0];
}

export async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}

export async function createLocalUser(email, passwordHash, displayName) {
  const role = email === ADMIN_EMAIL ? "admin" : "user";
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [email, passwordHash, displayName, role]
  );
  return rows[0];
}

// ── Service queries ────────────────────────────────────────────

export async function listServices() {
  const { rows } = await pool.query("SELECT * FROM services ORDER BY id");
  return rows;
}

export async function getServiceBySlug(slug) {
  const { rows } = await pool.query("SELECT * FROM services WHERE slug = $1", [slug]);
  return rows[0] || null;
}

export async function updateService(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`);
    vals.push(v);
  }
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE services SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return rows[0];
}

// ── Access control queries ─────────────────────────────────────

export async function getUserAccess(userId) {
  const { rows } = await pool.query(
    "SELECT service_id FROM user_service_access WHERE user_id = $1",
    [userId]
  );
  return rows.map((r) => r.service_id);
}

export async function grantAccess(userId, serviceId) {
  await pool.query(
    `INSERT INTO user_service_access (user_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, serviceId]
  );
}

export async function createAccessRequest(userId, serviceId) {
  // Remove any previously denied request so user can re-request
  await pool.query(
    `DELETE FROM access_requests WHERE user_id = $1 AND service_id = $2 AND status = 'denied'`,
    [userId, serviceId]
  );
  const { rows } = await pool.query(
    `INSERT INTO access_requests (user_id, service_id) VALUES ($1, $2)
     ON CONFLICT (user_id, service_id, status) DO NOTHING
     RETURNING *`,
    [userId, serviceId]
  );
  return rows[0];
}

export async function listAccessRequests(statusFilter) {
  const { rows } = await pool.query(
    `SELECT ar.*, u.email AS user_email, u.display_name AS user_name, s.name AS service_name, s.slug AS service_slug
     FROM access_requests ar
     JOIN users u ON ar.user_id = u.id
     JOIN services s ON ar.service_id = s.id
     WHERE ar.status = $1
     ORDER BY ar.created_at`,
    [statusFilter || "pending"]
  );
  return rows;
}

export async function updateAccessRequest(requestId, status, reviewerId) {
  const { rows } = await pool.query(
    `UPDATE access_requests SET status = $1, reviewed_by = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status, reviewerId, requestId]
  );
  return rows[0];
}

export async function getUserPendingRequests(userId) {
  const { rows } = await pool.query(
    "SELECT service_id FROM access_requests WHERE user_id = $1 AND status = 'pending'",
    [userId]
  );
  return rows.map((r) => r.service_id);
}

// ── User management queries ────────────────────────────────────

export async function findUserById(id) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function listUsers() {
  const { rows } = await pool.query(
    "SELECT id, email, display_name, role, last_login_at, created_at FROM users ORDER BY id"
  );
  return rows;
}

export async function updateUserRole(userId, role) {
  const { rows } = await pool.query(
    `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, display_name, role`,
    [role, userId]
  );
  return rows[0];
}

export async function updateUserPassword(userId, passwordHash) {
  await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [passwordHash, userId]
  );
}

export async function touchLastLogin(userId) {
  await pool.query(
    `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
    [userId]
  );
}

export async function deleteUser(userId) {
  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  return rowCount > 0;
}

// ── Password reset token queries ───────────────────────────────

export async function createResetToken(userId, token, expiresAt) {
  // Remove any existing tokens for this user
  await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);
  const { rows } = await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) RETURNING *`,
    [userId, token, expiresAt]
  );
  return rows[0];
}

export async function findResetToken(token) {
  const { rows } = await pool.query(
    `SELECT prt.*, u.email FROM password_reset_tokens prt
     JOIN users u ON prt.user_id = u.id
     WHERE prt.token = $1 AND prt.expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

export async function deleteResetToken(token) {
  await pool.query("DELETE FROM password_reset_tokens WHERE token = $1", [token]);
}

// ── OIDC authorization code queries ────────────────────────────

export async function storeOidcAuthCode(code, userId, redirectUri, clientId, codeChallenge, codeChallengeMethod, googleClaims) {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  await pool.query(
    `INSERT INTO oidc_auth_codes (code, user_id, redirect_uri, client_id, code_challenge, code_challenge_method, google_claims, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [code, userId, redirectUri, clientId, codeChallenge, codeChallengeMethod, JSON.stringify(googleClaims), expiresAt]
  );
}

export async function consumeOidcAuthCode(code) {
  const { rows } = await pool.query(
    `DELETE FROM oidc_auth_codes WHERE code = $1 AND expires_at > NOW() RETURNING *`,
    [code]
  );
  return rows[0] || null;
}

// ── OIDC access token queries ──────────────────────────────────

export async function storeOidcAccessToken(token, userId, claims, expiresAt) {
  await pool.query(
    `INSERT INTO oidc_access_tokens (token, user_id, claims, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, userId, JSON.stringify(claims), expiresAt]
  );
}

export async function getOidcAccessToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM oidc_access_tokens WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

export async function deleteExpiredOidcTokens() {
  await pool.query(`DELETE FROM oidc_access_tokens WHERE expires_at <= NOW()`);
  await pool.query(`DELETE FROM oidc_refresh_tokens WHERE expires_at <= NOW()`);
  await pool.query(`DELETE FROM oidc_auth_codes WHERE expires_at <= NOW()`);
}

// ── OIDC refresh token queries ─────────────────────────────────

export async function storeOidcRefreshToken(token, userId, clientId, expiresAt) {
  await pool.query(
    `INSERT INTO oidc_refresh_tokens (token, user_id, client_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, userId, clientId, expiresAt]
  );
}

export async function consumeOidcRefreshToken(token) {
  const { rows } = await pool.query(
    `DELETE FROM oidc_refresh_tokens WHERE token = $1 AND expires_at > NOW() RETURNING *`,
    [token]
  );
  return rows[0] || null;
}

// ── Vault key queries ──────────────────────────────────────────

export async function storeVaultKey(userId, wrappedKey, keyType) {
  await pool.query(
    `INSERT INTO user_vault_keys (user_id, wrapped_key, key_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET wrapped_key = $2, key_type = $3`,
    [userId, wrappedKey, keyType]
  );
}

export async function getWrappedVaultKey(userId) {
  const { rows } = await pool.query(
    `SELECT wrapped_key, key_type FROM user_vault_keys WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// ── Chat thread queries ────────────────────────────────────────

export async function createThread(userId, title) {
  const { rows } = await pool.query(
    `INSERT INTO chat_threads (user_id, foundry_thread_id, title)
     VALUES ($1, '', $2) RETURNING *`,
    [userId, title]
  );
  return rows[0];
}

// Keep for backward compat — delegates to createThread
export async function getOrCreateThread(userId, foundryThreadId, title) {
  const { rows } = await pool.query(
    `INSERT INTO chat_threads (user_id, foundry_thread_id, title)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, foundryThreadId, title]
  );
  return rows[0];
}

export async function getUserThreads(userId) {
  const { rows } = await pool.query(
    `SELECT id, foundry_thread_id, title, created_at, updated_at
     FROM chat_threads WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId]
  );
  return rows;
}

export async function deleteThread(userId, threadId) {
  // Try by foundry_thread_id first (legacy), then by id
  let { rows } = await pool.query(
    `DELETE FROM chat_threads WHERE user_id = $1 AND foundry_thread_id = $2 RETURNING *`,
    [userId, threadId]
  );
  if (!rows[0] && !isNaN(threadId)) {
    ({ rows } = await pool.query(
      `DELETE FROM chat_threads WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, Number(threadId)]
    ));
  }
  return rows[0] || null;
}

export async function getThreadById(threadId) {
  const { rows } = await pool.query(
    `SELECT * FROM chat_threads WHERE id = $1`,
    [threadId]
  );
  return rows[0] || null;
}

// ── Chat message queries ───────────────────────────────────────

export async function addChatMessage(threadId, role, content, vaultKey = null) {
  const stored = vaultKey ? encrypt(content, vaultKey) : content;
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (thread_id, role, content)
     VALUES ($1, $2, $3) RETURNING *`,
    [threadId, role, stored]
  );
  // Touch updated_at on the thread
  await pool.query(
    `UPDATE chat_threads SET updated_at = NOW() WHERE id = $1`,
    [threadId]
  );
  return rows[0];
}

export async function getChatMessages(threadId, vaultKey = null) {
  const { rows } = await pool.query(
    `SELECT id, role, content, created_at FROM chat_messages
     WHERE thread_id = $1 ORDER BY created_at ASC`,
    [threadId]
  );
  if (vaultKey) {
    for (const row of rows) {
      if (isEncrypted(row.content)) {
        row.content = decrypt(row.content, vaultKey);
      }
    }
  }
  return rows;
}

export async function getChatMessageCount(threadId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM chat_messages WHERE thread_id = $1`,
    [threadId]
  );
  return rows[0].count;
}

export async function updateThreadSummary(threadId, summary, vaultKey = null) {
  const stored = vaultKey ? encrypt(summary, vaultKey) : summary;
  await pool.query(
    `UPDATE chat_threads SET summary = $2, updated_at = NOW() WHERE id = $1`,
    [threadId, stored]
  );
}

export async function getThreadSummary(threadId, vaultKey = null) {
  const { rows } = await pool.query(
    `SELECT summary FROM chat_threads WHERE id = $1`,
    [threadId]
  );
  const raw = rows[0]?.summary || null;
  if (raw && vaultKey && isEncrypted(raw)) {
    return decrypt(raw, vaultKey);
  }
  return raw;
}

export default pool;
