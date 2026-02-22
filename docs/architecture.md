# patelr3-site — Architecture

## Overview

A containerized personal website with Google OAuth sign-in, role-based access control (RBAC), and a micro-service architecture. Unauthenticated visitors see a public "About Me" page. After signing in via Google, additional tabs and backend services become available based on the user's assigned role.

The site also integrates with [actual-server-setup](https://github.com/patelr3/actual-server-setup) to provide per-user Actual Budget instances deployed as Azure Container Apps.

---

## High-Level Architecture

```
                        ┌──────────────┐
            Internet ──▶│    Nginx     │  (local dev only, port 80)
                        │  (Gateway)   │
                        └──────┬───────┘
                               │
                  ┌────────────┼─────────────┐
                  │            │             │
                  ▼            ▼             ▼
            ┌──────────┐ ┌──────────┐ ┌──────────────────┐
            │ Frontend │ │ Auth API │ │ Hello-World      │
            │ (React)  │ │(Express) │ │ Services         │
            │ :3000    │ │ :8000    │ │ :5000 / :5001    │
            └──────────┘ └────┬─────┘ └──────────────────┘
                              │
                 ┌────────────┼────────────┐
                 │                         │
            ┌────▼─────┐         ┌─────────▼──────────┐
            │ Postgres │         │   Finance API      │
            │  :5432   │         │ (actual-server-setup│
            └──────────┘         │  repo, Azure ACA)  │
                                 └─────────┬──────────┘
                                           │
                                 ┌─────────▼──────────┐
                                 │ Per-User Actual    │
                                 │ Budget ACA         │
                                 │ (ab-{user}-{hash}) │
                                 └────────────────────┘
```

### Production Architecture (Azure Container Apps)

In production, there is **no Nginx**. Each service runs as its own Azure Container App with direct HTTPS ingress. The frontend makes cross-origin API calls (CORS enabled) to the auth-api, which proxies deployment operations to the finance-api in a separate resource group.

```
                    Cloudflare (arayosun.com)
                           │
                    ┌──────▼───────┐
                    │  Frontend    │  patelr3-site-rg
                    │  ACA         │
                    └──────────────┘
                           │ CORS
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   ┌──────────┐     ┌──────────┐     ┌──────────────┐
   │ Auth API │     │ Hello    │     │ Hello        │
   │ ACA      │     │ World    │     │ Restricted   │
   └────┬─────┘     └──────────┘     └──────────────┘
        │
        │ X-Api-Key                  patelr3-finance-rg
        ▼
   ┌──────────┐     ┌──────────────────────────────┐
   │ Finance  │────▶│ Per-User ACAs               │
   │ API ACA  │     │ ab-{username}-{hash}         │
   └──────────┘     │ + Azure File Shares          │
                    │ + Blob Storage (backups)      │
                    └──────────────────────────────┘
```

---

## Services & Containers

| Container               | Language / Framework | Purpose                                             | Port  |
| ----------------------- | -------------------- | --------------------------------------------------- | ----- |
| **nginx**               | Nginx 1.25           | Reverse proxy, auth gate (local dev only)            | 80    |
| **frontend**            | React 18 (Vite)      | SPA — About Me, Dashboard, Admin, Account, Services  | 3000  |
| **auth-api**            | Node.js 20 Express   | Google OAuth 2.0, JWT, RBAC, deployment proxy         | 8000  |
| **hello-world**         | Node.js 20 Express   | Sample public micro-service                          | 5000  |
| **hello-world-restricted** | Node.js 20 Express | Sample restricted micro-service                      | 5001  |
| **postgres**            | PostgreSQL 16        | Users, roles, services, access requests               | 5432  |

---

## Authentication & Authorization

### OAuth 2.0 Flow (Google)

1. User clicks "Sign in with Google" on the frontend.
2. Frontend redirects to `GET /api/auth/login/google`.
3. Auth API (via Passport.js GoogleStrategy) redirects to Google's consent screen.
4. Google redirects back with an authorization code.
5. Auth API exchanges the code for user info, upserts in Postgres, and issues a signed JWT as an `HttpOnly`, `SameSite=Lax` cookie.
6. Frontend detects auth via `/api/auth/me` and renders the authenticated UI.

### Role-Based Access Control (RBAC)

| Role    | Access                                                        |
| ------- | ------------------------------------------------------------- |
| visitor | About Me page only (no sign-in required)                      |
| user    | Default role after first sign-in; basic services              |
| admin   | All services, admin panel (user management, service config)   |

- Roles are stored in `users.role` in Postgres.
- JWT payload includes `sub`, `email`, `name`, `role`.
- Nginx `auth_request` validates JWTs for protected routes (local dev).
- In production, auth-api middleware validates JWTs directly.

### Service Visibility & Access

Services are stored in a `services` table with `is_visible` and `is_restricted` flags. Admins can toggle visibility and restriction through the Admin Panel. These settings persist in the database and are **not overwritten** on redeployment (seed uses `ON CONFLICT DO NOTHING`).

- **Visible** services appear on the Dashboard for all authenticated users.
- **Restricted** services require explicit access grants (approved by admin).
- **Hidden** services (`is_visible = false`) don't appear on the Dashboard.

---

## Multi-Tenant Actual Budget

Each user can create their own Actual Budget instance via the ServicePage UI.

### Flow
1. User navigates to the Actual Budget service page.
2. Frontend calls `POST /auth/deployments/actualbudget` → auth-api.
3. Auth-api proxies to `POST /deployments/:userId` on finance-api (with API key).
4. Finance-api creates: Azure File Share → CAE storage link → Container App.
5. ACA name uses `ab-{username}-{4hex}` format (max 32 chars).
6. Maximum 10 user instances per resource group.

### Backup Strategy
- **Raw backup**: Monthly GitHub Actions cron copies all Azure File Share data to blob storage.
- **Export backup**: Monthly workflow creates Actual Budget export-format zips (metadata.json + db.sqlite per budget).
- **Retention**: Backups older than 6 months are automatically cleaned up.

---

## Database Schema (Postgres)

```sql
-- Users
CREATE TABLE users (
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
);

-- Services (admin-managed visibility)
CREATE TABLE services (
    id              SERIAL PRIMARY KEY,
    slug            VARCHAR(100) UNIQUE NOT NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    endpoint_url    VARCHAR(500),
    is_visible      BOOLEAN DEFAULT true,
    is_restricted   BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Access grants & requests
CREATE TABLE access_grants (user_id INT, service_id INT, PRIMARY KEY(user_id, service_id));
CREATE TABLE access_requests (id SERIAL, user_id INT, service_id INT, status VARCHAR(20));
```

---

## Environment Variables

| Variable                  | Description                                        |
| ------------------------- | -------------------------------------------------- |
| `GOOGLE_CLIENT_ID`        | Google OAuth 2.0 client ID                         |
| `GOOGLE_CLIENT_SECRET`    | Google OAuth 2.0 client secret                     |
| `JWT_SECRET`              | Secret key for signing JWTs                        |
| `POSTGRES_USER`           | Postgres username                                  |
| `POSTGRES_PASSWORD`       | Postgres password                                  |
| `POSTGRES_DB`             | Postgres database name                             |
| `FRONTEND_URL`            | Public URL of the frontend (for CORS/redirects)    |
| `FINANCE_API_URL`         | Internal URL of finance-api (deployment proxy)     |
| `FINANCE_API_KEY`         | Shared API key for finance-api authentication      |

---

## CI/CD

| Workflow           | Trigger               | What it does                                           |
| ------------------ | --------------------- | ------------------------------------------------------ |
| **CI**             | Push/PR to main       | Unit tests (matrix), frontend build, integration tests |
| **Deploy**         | Push to main          | Tests → Build images → Push to ACR → Deploy via Bicep  |
| **Dependabot**     | Weekly                | Auto-merge dependency PRs after CI passes              |

---

## VS Code Devcontainer

The `.devcontainer/` provides a fully configured development environment:

| Tool             | Version                                |
| ---------------- | -------------------------------------- |
| Node.js          | 20 LTS                                |
| Docker           | Docker-in-Docker devcontainer feature  |
| Docker Compose   | Included via Docker-in-Docker          |
| psql             | PostgreSQL client (apt)                |

**Usage:** Open in VS Code → "Reopen in Container" → `docker compose up --build`.
