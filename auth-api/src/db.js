import pg from "pg";
import config from "./config.js";

const pool = new pg.Pool({ connectionString: config.databaseUrl });

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
}

export async function upsertGoogleUser(profile) {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE google_id = $1",
    [profile.id]
  );

  if (rows.length > 0) {
    const { rows: updated } = await pool.query(
      `UPDATE users SET display_name = $1, avatar_url = $2, updated_at = NOW()
       WHERE google_id = $3 RETURNING *`,
      [profile.displayName, profile.photos?.[0]?.value || "", profile.id]
    );
    return updated[0];
  }

  // Check if a local account with this email already exists — link it
  const { rows: existing } = await pool.query(
    "SELECT * FROM users WHERE email = $1",
    [profile.emails[0].value]
  );
  if (existing.length > 0) {
    const { rows: linked } = await pool.query(
      `UPDATE users SET google_id = $1, display_name = $2, avatar_url = $3, updated_at = NOW()
       WHERE email = $4 RETURNING *`,
      [profile.id, profile.displayName, profile.photos?.[0]?.value || "", profile.emails[0].value]
    );
    return linked[0];
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO users (google_id, email, display_name, avatar_url)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [
      profile.id,
      profile.emails[0].value,
      profile.displayName,
      profile.photos?.[0]?.value || "",
    ]
  );
  return inserted[0];
}

export async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}

export async function createLocalUser(email, passwordHash, displayName) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3) RETURNING *`,
    [email, passwordHash, displayName]
  );
  return rows[0];
}

export default pool;
