import pg from "pg";
import config from "./config.js";
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

  // Add firebase_uid column for Firebase migration
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(255) UNIQUE
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

  // Rename buddyburn → burnbuddy (safe: user_service_access uses integer FK)
  await pool.query(`UPDATE services SET slug = 'burnbuddy' WHERE slug = 'buddyburn'`);

  // Seed default services
  await pool.query(`
    INSERT INTO services (slug, name, description, endpoint_url, is_visible, is_restricted)
    VALUES
      ('hello-world', 'Hello World', 'A sample micro-service running in its own container.', '/api/hello/', true, false),
      ('hello-world-restricted', 'Hello World (Restricted)', 'A restricted micro-service — request access to use it.', '/api/hello-restricted/', true, true),
      ('actualbudget', 'Actual Budget', 'Self-hosted personal finance manager.', '/services/actualbudget', false, true),
      ('burnbuddy', 'BurnBuddy', 'An app that helps buddies burn calories. Workout with your workout partner anywhere, anytime together!', 'https://burnbuddy.arayosun.com', true, false)
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      endpoint_url = EXCLUDED.endpoint_url
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

}

export async function upsertFirebaseUser(firebaseUser) {
  const { uid, email, name, picture } = firebaseUser;
  const displayName = name || firebaseUser.display_name || email?.split("@")[0] || "User";
  const role = email === ADMIN_EMAIL ? "admin" : "user";

  // Try to find existing user by firebase_uid
  const { rows: existing } = await pool.query(
    "SELECT * FROM users WHERE firebase_uid = $1",
    [uid]
  );
  if (existing.length > 0) {
    // Update display name and avatar on each login
    const { rows: updated } = await pool.query(
      `UPDATE users SET display_name = COALESCE($1, display_name), avatar_url = COALESCE($2, avatar_url), 
       last_login_at = NOW(), updated_at = NOW() WHERE firebase_uid = $3 RETURNING *`,
      [displayName, picture || "", uid]
    );
    return updated[0];
  }

  // Try to find by email (migration from old system)
  if (email) {
    const { rows: byEmail } = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );
    if (byEmail.length > 0) {
      // Link existing account to Firebase UID
      const { rows: linked } = await pool.query(
        `UPDATE users SET firebase_uid = $1, display_name = COALESCE($2, display_name), 
         avatar_url = COALESCE($3, avatar_url), role = $4, last_login_at = NOW(), updated_at = NOW()
         WHERE email = $5 RETURNING *`,
        [uid, displayName, picture || "", role, email]
      );
      return linked[0];
    }
  }

  // Create new user
  const { rows: inserted } = await pool.query(
    `INSERT INTO users (firebase_uid, email, display_name, avatar_url, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [uid, email || "", displayName, picture || "", role]
  );
  return inserted[0];
}

export async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] || null;
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

export async function revokeAccess(userId, serviceId) {
  const { rowCount } = await pool.query(
    "DELETE FROM user_service_access WHERE user_id = $1 AND service_id = $2",
    [userId, serviceId]
  );
  return rowCount > 0;
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

export default pool;
