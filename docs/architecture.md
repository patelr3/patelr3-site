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
                  ┌────────────┼─────────────┬──────────┐
                  │            │             │          │
                  ▼            ▼             ▼          ▼
            ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
            │ Frontend │ │ Auth API │ │ Hello    │ │ MCP      │
            │ (React)  │ │(Express) │ │ Services │ │ Server   │
            │ :3000    │ │ :8000    │ │:5000/5001│ │ :8090    │
            └──────────┘ └────┬─────┘ └──────────┘ └────┬─────┘
                              │                         │
                 ┌────────────┼────────────┐            │
                 │                         │            │
            ┌────▼─────┐         ┌─────────▼────────┐   │
            │ Postgres │         │   Finance API    │◀──┘
            │  :5432   │         │ (actual-server-  │
            └──────────┘         │  setup repo)     │
                                 └─────────┬────────┘
                                           │
                                 ┌─────────▼──────────┐
                                 │ Per-User Actual    │
                                 │ Budget ACA         │
                                 │ (ab-{user}-{hash}) │
                                 └────────────────────┘
```

### Production Architecture (Azure Container Apps)

In production, the frontend container runs Nginx, which serves the SPA and reverse-proxies `/api/*` requests to the backend ACAs (same-origin). This keeps auth cookies first-party, avoiding third-party cookie blocks on mobile Safari (ITP) and mobile Edge.

```
                    Cloudflare (arayosun.com)
                           │
                    ┌──────▼───────┐
                    │  Frontend    │  patelr3-site-rg
                    │  ACA (Nginx) │
                    └──────┬───────┘
                           │ /api/* (same-origin proxy)
         ┌─────────────────┼─────────────────┬──────────┐
         ▼                 ▼                 ▼          ▼
   ┌──────────┐     ┌──────────┐     ┌──────────┐ ┌──────────┐
   │ Auth API │     │ Hello    │     │ Hello    │ │ MCP      │
   │ ACA      │     │ World    │     │Restricted│ │ Server   │
   └────┬─────┘     └──────────┘     └──────────┘ └────┬─────┘
        │                                              │
        │ X-Api-Key                  patelr3-finance-rg │
        ▼                                              ▼
   ┌──────────┐     ┌──────────────────────────────┐
   │ Finance  │────▶│ Per-User ACAs               │
   │ API ACA  │◀────│ ab-{username}-{hash}         │
   └──────────┘     │ + Azure File Shares          │
                    │ + Blob Storage (backups)      │
                    └──────────────────────────────┘

   ┌──────────────────────────────────────────────┐
   │ Azure AI Foundry Agent Service               │
   │ (MCP Client → calls MCP server tools)        │
   └──────────────────────────────────────────────┘
```

---

## Services & Containers

| Container               | Language / Framework | Purpose                                             | Port  |
| ----------------------- | -------------------- | --------------------------------------------------- | ----- |
| **nginx**               | Nginx 1.25           | Reverse proxy, auth gate (local dev only)            | 80    |
| **frontend**            | React 18 (Vite) + Nginx | SPA + API reverse proxy (same-origin in prod)     | 3000  |
| **auth-api**            | Node.js 20 Express   | Google OAuth 2.0, JWT, RBAC, OIDC IdP, deploy proxy  | 8000  |
| **mcp-server**          | Node.js 20 MCP SDK   | ActualBudget MCP server (Azure AI Foundry)           | 8090  |
| **hello-world**         | Node.js 20 Express   | Sample public micro-service                          | 5000  |
| **hello-world-restricted** | Node.js 20 Express | Sample restricted micro-service                      | 5001  |
| **postgres**            | PostgreSQL 16        | Users, roles, services, access requests               | 5432  |

> The MCP server code lives in [actual-server-setup/mcp-server](https://github.com/patelr3/actual-server-setup/tree/main/mcp-server) and is included in the local Docker Compose stack.

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

## OIDC Identity Provider

Auth-api acts as an **OpenID Connect Identity Provider** wrapping Google OAuth. This enables all ActualBudget instances to use a single Google OAuth redirect URI through auth-api.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/oidc/.well-known/openid-configuration` | GET | OIDC discovery document |
| `/api/auth/oidc/authorize` | GET | Redirects to Google OAuth |
| `/api/auth/oidc/callback` | GET | Google redirects here → issues auth code → redirects to AB |
| `/api/auth/oidc/token` | POST | Exchange auth code for ID + access tokens |
| `/api/auth/oidc/userinfo` | GET | Return user profile |
| `/api/auth/oidc/jwks` | GET | JSON Web Key Set for token verification |

### Flow

```
ActualBudget Instance                 auth-api (OIDC IdP)                  Google
       │                                     │                               │
       │──── authorize?redirect_uri=AB ──────▶│                               │
       │                                     │── redirect to Google OAuth ───▶│
       │                                     │                               │
       │                                     │◀── callback with Google code ──│
       │                                     │── exchange code for userinfo ─▶│
       │                                     │                               │
       │◀── redirect with OIDC auth code ────│                               │
       │                                     │                               │
       │──── POST /token (code) ────────────▶│                               │
       │◀── { id_token, access_token } ──────│                               │
       │                                     │                               │
       │──── GET /userinfo ─────────────────▶│                               │
       │◀── { sub, email, name } ────────────│                               │
```

### Key Details
- RSA key pair generated at startup (in-memory) for signing ID tokens (RS256)
- Authorization codes stored in Postgres (`oidc_auth_codes` table) with 5-minute TTL
- Access tokens stored in-memory with 1-hour TTL
- Supports PKCE (S256 and plain)
- Google redirect URI: `{FRONTEND_URL}/api/auth/oidc/callback` (single URI for all AB instances)

---

## ActualBudget MCP Server

The [MCP server](https://github.com/patelr3/actual-server-setup/tree/main/mcp-server) provides 21 tools for AI agents to manage budgets via the Model Context Protocol. It integrates with Azure AI Foundry Agent Service.

### Authentication Flow

```
Azure AI Foundry ──(Authorization: Bearer <user-jwt>)──▶ MCP Server
  │                                                         │
  │                                          validates JWT──│──▶ auth-api
  │                                                         │
  │                                     gets instance URL +─│──▶ finance-api
  │                                        service token    │
  │                                                         │
  │                                    @actual-app/api      │
  │                                    init({serverURL,     │
  │                                     sessionToken})──────│──▶ AB Instance
  │                                                         │
  │◀──────────── tool result ───────────────────────────────│
```

### Service Token Mechanism

ActualBudget instances use `ACTUAL_LOGIN_METHOD=openid` for web users. The MCP server uses a **service session token** for API access:

1. `entrypoint.sh` injects a never-expiring token into AB's SQLite `sessions` table after boot
2. Token is persisted to Azure File Share at `/persistent/.service-token`
3. Finance-api reads the token via `GET /deployments/:userId/token`
4. MCP server calls `api.init({ serverURL, sessionToken })` — natively supported by `@actual-app/api`
5. Session validation is **method-agnostic** (only checks token existence + expiry, not auth_method)

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

-- OIDC authorization codes (short-lived, for ActualBudget OpenID flow)
CREATE TABLE oidc_auth_codes (
    code            VARCHAR(255) PRIMARY KEY,
    user_id         INT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    client_id       VARCHAR(255) NOT NULL,
    code_challenge  VARCHAR(255),
    code_challenge_method VARCHAR(10),
    google_claims   JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes'
);
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
| `AUTH_API_UPSTREAM`       | Internal URL of auth-api (frontend nginx proxy)    |
| `HELLO_API_UPSTREAM`      | Internal URL of hello-world (frontend nginx proxy) |
| `HELLO_RESTRICTED_API_UPSTREAM` | Internal URL of hello-world-restricted       |
| `FINANCE_API_URL`         | Internal URL of finance-api (deployment proxy)     |
| `FINANCE_API_KEY`         | Shared API key for finance-api authentication      |
| `OIDC_CLIENT_ID`          | Client ID for OIDC provider (ActualBudget uses)    |
| `OIDC_CLIENT_SECRET`      | Client secret for OIDC provider                    |
| `FOUNDRY_PROJECT_ENDPOINT`| Azure AI Foundry project endpoint for SunnieAI     |
| `FOUNDRY_AGENT_ID`        | Registered Foundry agent ID for SunnieAI           |

**Production secrets** are stored in Azure Key Vault (`patelr3kvl3ytczhajsp7i`) and referenced by ACAs via `keyVaultUrl` + a shared user-assigned managed identity (`patelr3-kv-reader`). Updating a secret in AKV automatically propagates to all ACAs within 30 minutes.

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
