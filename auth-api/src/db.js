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
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
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
      ('hello-world-restricted', 'Hello World (Restricted)', 'A restricted micro-service — request access to use it.', '/api/hello-restricted/', true, true)
    ON CONFLICT (slug) DO NOTHING
  `);

  // Ensure admin user gets admin role if they already exist
  await pool.query(
    `UPDATE users SET role = 'admin', updated_at = NOW() WHERE email = $1 AND role != 'admin'`,
    [ADMIN_EMAIL]
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      token       VARCHAR(255) UNIQUE NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
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
    "SELECT id, email, display_name, role, created_at FROM users ORDER BY id"
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

export default pool;
