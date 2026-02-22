# patelr3-site — Architecture Plan

## Overview

A containerized personal website with Google OAuth sign-in, role-based access control, and a micro-service architecture. Unauthenticated visitors see a public "About Me" page. After signing in via Google, additional tabs and backend services become available based on the user's assigned role.

---

## High-Level Architecture

```
                    ┌──────────────┐
        Internet ──▶│    Nginx     │  (reverse proxy, port 80/443)
                    │  (Gateway)   │
                    └──────┬───────┘
                           │
              ┌────────────┼─────────────┐
              │            │             │
              ▼            ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────────┐
        │ Frontend │ │ Auth API │ │ Hello-World  │
        │ (React)  │ │(Express) │ │  Service     │
        │ :3000    │ │ :8000    │ │(Express:5000)│
        └──────────┘ └────┬─────┘ └──────────────┘
                          │
                     ┌────▼─────┐
                     │ Postgres │
                     │  :5432   │
                     └──────────┘
```

### Request Flow

1. **Nginx** receives all inbound traffic and routes by path prefix:
   - `/` → Frontend (React SPA)
   - `/api/auth/` → Auth API
   - `/api/hello/` → Hello-World service (protected)
2. The **Frontend** renders public pages (About Me) without auth. Protected pages redirect to the Google OAuth flow handled by the Auth API.
3. The **Auth API** issues a JWT after a successful Google sign-in. The JWT is stored as an `HttpOnly` cookie.
4. For protected routes, Nginx forwards the request only after the Auth API validates the JWT (via an `auth_request` sub-request).
5. The **Hello-World service** is a sample downstream micro-service that is only reachable through the authenticated gateway.

---

## Services & Containers

| Container        | Language / Framework | Purpose                                    | Port  |
| ---------------- | -------------------- | ------------------------------------------ | ----- |
| **nginx**        | Nginx 1.25           | Reverse proxy, TLS termination, auth gate  | 80    |
| **frontend**     | React 18 (Vite)      | SPA — About Me page, authenticated UI      | 3000  |
| **auth-api**     | Node.js 20 Express   | Google OAuth 2.0, JWT issuance, RBAC       | 8000  |
| **hello-world**  | Node.js 20 Express   | Sample protected micro-service             | 5000  |
| **postgres**     | PostgreSQL 16        | User accounts, roles, sessions             | 5432  |

---

## Technology Choices & Rationale

| Decision            | Choice               | Why                                                                  |
| ------------------- | -------------------- | -------------------------------------------------------------------- |
| Frontend framework  | React (Vite)         | Widely adopted, fast dev server, good ecosystem for SPA auth flows   |
| Auth backend        | Node.js Express      | Same runtime as frontend, Passport.js for OAuth, lightweight         |
| Hello-world service | Node.js Express      | Minimal boilerplate; demonstrates a separate service container       |
| Database            | PostgreSQL           | Robust, free, great driver support (pg)                              |
| Reverse proxy       | Nginx                | Industry standard, supports `auth_request` for JWT gate              |
| Containerisation    | Docker + Compose     | One `docker compose up` to run the full stack                        |
| Auth protocol       | OAuth 2.0 (Google)   | User requirement; standard OIDC flow via Google                      |
| Token format        | JWT (HttpOnly cookie)| Stateless verification, secure cookie storage                        |
| Dev environment     | VS Code Devcontainer | Consistent tooling (Node 20, Docker-in-Docker, psql) for all devs   |

---

## Authentication & Authorisation

### OAuth 2.0 Flow (Google)

1. User clicks "Sign in with Google" on the frontend.
2. Frontend redirects to `GET /api/auth/login/google`.
3. Auth API (via Passport.js GoogleStrategy) redirects the browser to Google's OAuth consent screen.
4. Google redirects back to `GET /api/auth/callback/google` with an authorization code.
5. Auth API exchanges the code for Google user info, upserts the user in Postgres, and returns a signed JWT as an `HttpOnly`, `SameSite=Lax` cookie.
6. Frontend detects the cookie (via a `/api/auth/me` call) and renders the authenticated UI.

### Role-Based Access Control (RBAC)

| Role      | Access                                               |
| --------- | ---------------------------------------------------- |
| `visitor` | About Me page only (no sign-in required)             |
| `user`    | Default role after first Google sign-in; access to basic services (e.g., Hello-World) |
| `admin`   | Full access to all services and admin panel          |

- Roles are stored in the `users` table in Postgres.
- The JWT payload includes the user's role.
- Nginx's `auth_request` directive calls `/api/auth/verify` which checks the JWT and returns `200` (allow) or `401/403` (deny) based on the required role for the upstream path.

---

## Database Schema (Postgres)

```sql
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    google_id     VARCHAR(255) UNIQUE NOT NULL,
    email         VARCHAR(255) UNIQUE NOT NULL,
    display_name  VARCHAR(255),
    avatar_url    TEXT,
    role          VARCHAR(50) DEFAULT 'user',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Project Directory Structure

```
patelr3-site/
├── .devcontainer/
│   ├── devcontainer.json         ← VS Code devcontainer config
│   └── Dockerfile                ← Dev image (Node 20, Docker-in-Docker, psql)
├── docker-compose.yml
├── docs/
│   └── architecture.md          ← this file
├── nginx/
│   └── nginx.conf               ← reverse proxy config
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx
│       ├── pages/
│       │   ├── AboutMe.jsx      ← public landing page
│       │   └── Dashboard.jsx    ← authenticated home (tabs for services)
│       └── components/
│           └── Navbar.jsx
├── auth-api/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js             ← Express entry point
│       ├── config.js            ← env vars (Google client ID/secret, JWT secret)
│       └── db.js                ← pg pool, user table, upsert logic
├── hello-world/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js             ← Express "Hello, <user>!" endpoint
└── .env.example                 ← template for secrets
```

---

## Nginx Routing & Auth Gate

```nginx
# Simplified nginx.conf sketch

# Public — no auth needed
location / {
    proxy_pass http://frontend:3000;
}

# Auth API — public (handles its own auth)
location /api/auth/ {
    proxy_pass http://auth-api:8000;
}

# Protected micro-services — require valid JWT
location /api/hello/ {
    auth_request /api/auth/verify;
    proxy_pass http://hello-world:5000;
}
```

- `auth_request` issues a sub-request to `/api/auth/verify`.
- The verify endpoint reads the JWT cookie, validates it, and returns `200` or `401`.

---

## Environment Variables (`.env`)

| Variable                  | Description                              |
| ------------------------- | ---------------------------------------- |
| `GOOGLE_CLIENT_ID`        | Google OAuth 2.0 client ID               |
| `GOOGLE_CLIENT_SECRET`    | Google OAuth 2.0 client secret           |
| `JWT_SECRET`              | Secret key for signing JWTs              |
| `POSTGRES_USER`           | Postgres username                        |
| `POSTGRES_PASSWORD`       | Postgres password                        |
| `POSTGRES_DB`             | Postgres database name                   |
| `FRONTEND_URL`            | Public URL of the frontend (for redirects)|

---

## How to Run

```bash
# 1. Copy and fill in secrets
cp .env.example .env

# 2. Start all containers
docker compose up --build

# 3. Open http://localhost in a browser
```

---

## Future Considerations

- **TLS**: Add Let's Encrypt via Certbot sidecar or Traefik for automatic HTTPS.
- **Additional services**: New micro-services follow the same pattern — add a container, a proxy route, and an `auth_request` guard.
- **CI/CD**: GitHub Actions to build & push images, deploy to a cloud provider.
- **Rate limiting & logging**: Add to Nginx or use an API gateway like Kong/Traefik.

---

## VS Code Devcontainer

The `.devcontainer/` directory provides a fully configured development environment:

| Tool               | Version / Source                                |
| ------------------ | ----------------------------------------------- |
| **Node.js**        | 20 LTS (base image)                             |
| **npm**            | Bundled with Node 20                            |
| **Docker**         | Docker-in-Docker devcontainer feature           |
| **Docker Compose** | Included via Docker-in-Docker feature           |
| **psql**           | PostgreSQL client installed via apt              |

**VS Code extensions** (auto-installed):
- ESLint
- Prettier (default formatter, format-on-save enabled)
- Docker

**Usage:** Open the repo in VS Code → "Reopen in Container" → all tooling is ready. Run `docker compose up --build` from the integrated terminal to start the full stack.
