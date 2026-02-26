# DR0001 — ActualBudget MCP Server, OIDC Identity Provider & Azure AI Foundry Integration

**Status:** Implemented  
**Date:** 2026-02-24  
**Authors:** Ravi Patel, Copilot  

---

## Context

We needed to:
1. Let users sign into their per-user ActualBudget instances using their existing Google OAuth credentials from the patelr3-site — without registering a separate Google redirect URI per instance.
2. Enable AI agents (via Azure AI Foundry) to programmatically interact with ActualBudget data (budgets, accounts, transactions, etc.) on behalf of authenticated users.
3. Provide a chat interface ("SunnieAI") on the website powered by Azure AI Foundry Agent Service.

### Constraints
- ActualBudget supports either password or OpenID login, not both simultaneously (`max-one-method-allowed` error).
- Each per-user ActualBudget ACA instance needs an OIDC provider URL at boot time.
- Google Cloud Console limits redirect URIs — we cannot add one per user.
- Azure AI Foundry Agent Service connects to tools via the MCP (Model Context Protocol) over HTTP.

---

## Decision

### 1. Auth-API as OIDC Identity Provider

**Decision:** auth-api acts as an OpenID Connect Identity Provider (IdP) that wraps Google OAuth. All ActualBudget instances point to auth-api as their OIDC provider, achieving a **single redirect URI** regardless of how many instances exist.

**Endpoints added to auth-api (`auth-api/src/oidc.js`):**
- `GET /auth/oidc/.well-known/openid-configuration` — OIDC discovery document
- `GET /auth/oidc/authorize` — Authorization endpoint (redirects to Google OAuth, returns auth code)
- `POST /auth/oidc/token` — Token exchange (auth code → JWT id_token + access_token)
- `GET /auth/oidc/userinfo` — User info endpoint
- `GET /auth/oidc/jwks` — JSON Web Key Set for token verification
- `GET /auth/oidc/callback` — Google OAuth callback handler

**Key details:**
- Uses the `jose` npm package for JWT signing and JWKS generation
- Stores temporary auth codes in a `oidc_auth_codes` Postgres table (expires after 10 minutes)
- Issues JWT id_tokens with standard OIDC claims (sub, email, name, picture)
- Google redirect URI: `https://www.arayosun.com/api/auth/oidc/callback`

### 2. ActualBudget Deployment with OpenID Config

**Decision:** Each per-user ActualBudget ACA is configured with OpenID at creation time via environment variables injected by `finance-api/src/deploy.js`.

**Environment variables passed to each instance:**
- `ACTUAL_LOGIN_METHOD=openid`
- `ACTUAL_OPENID_DISCOVERY_URL=https://www.arayosun.com/api/auth/oidc/.well-known/openid-configuration`
- `ACTUAL_OPENID_CLIENT_ID=actualbudget`
- `ACTUAL_OPENID_CLIENT_SECRET=<from config>`
- `ACTUAL_OPENID_SERVER_HOSTNAME=<instance FQDN>`

**Service token injection:** `entrypoint.sh` injects a service session token into ActualBudget's SQLite `sessions` table on boot. This token is used for programmatic API access (MCP server). Session validation in ActualBudget is **method-agnostic** — tokens work regardless of whether the login method is password or OpenID.

**Token retrieval:** Finance-api exposes `GET /instance/:userId/token` that reads the service token from the Azure File Share, so the MCP server can retrieve it at runtime.

### 3. MCP Server for ActualBudget

**Decision:** Build a Node.js MCP server (`actual-server-setup/mcp-server/`) implementing the Model Context Protocol over HTTP streamable transport, providing AI agents full CRUD access to ActualBudget data.

**Architecture:**
```
Azure AI Foundry Agent
  → (Authorization: Bearer <user-JWT>) →
MCP Server (validates JWT, extracts userId)
  → (gets instance URL + service token from finance-api) →
@actual-app/api init({ serverURL, sessionToken })
  → executes tool → returns result
```

**Key technical decisions:**
- **Auth:** User JWT passed as `Authorization: Bearer` header. MCP server validates it using the same JWT secret as auth-api, extracts `userId`.
- **API client:** Uses `@actual-app/api` with `init({ serverURL, sessionToken })` — the `SessionTokenAuthConfig` variant. No password needed.
- **Stateless:** Each tool call connects, executes, and disconnects. Must complete within 50s (Foundry timeout).
- **Transport:** HTTP streamable (required by Azure AI Foundry Agent Service).

**21 tools implemented across 7 modules:**

| Module | Tools |
|--------|-------|
| Budgets | `list_budgets`, `load_budget`, `get_budget_months`, `get_budget_month` |
| Accounts | `list_accounts`, `create_account`, `update_account`, `close_account` |
| Transactions | `get_transactions`, `add_transactions`, `update_transaction`, `delete_transaction` |
| Categories | `list_categories`, `create_category`, `update_category`, `delete_category` |
| Payees | `list_payees`, `create_payee` |
| Rules | `list_rules` |
| Schedules | `list_schedules` |

### 4. Docker & ACA Deployment

**Decision:** MCP server runs as a container in both local dev (docker-compose) and production (Azure Container App).

- **Docker-compose:** `mcp-server` service built from `./actual-server-setup/mcp-server`, port 8090
- **Production ACA:** `patelr3-mcp-server`, deployed via Bicep (`deployments/main.bicep`), `minReplicas: 1`
- **CI/CD:** Deploy workflow updated with `--recurse-submodules` for the git submodule

### 5. Azure AI Foundry Registration

**Decision:** Register the MCP server with Azure AI Foundry Agent Service to power the SunnieAI chat interface.

**Infrastructure (Bicep — `deployments/foundry.bicep`):**
- Azure AI Hub + Project + AI Services account
- GPT-4o model deployment
- Deployed to separate resource group (`patelr3-ai-rg`, East US 2)

**Agent registration (`scripts/setup-foundry-agent.py`):**
- Uses `azure-ai-projects` Python SDK
- Registers MCP server URL as a tool source
- Configures per-run `Authorization: Bearer <JWT>` header for user isolation

**SunnieAI frontend (`frontend/src/pages/SunnieAI.jsx`):**
- Chat interface that proxies to the Foundry agent via auth-api
- Auth-api forwards requests to Foundry's Agent Service API

---

## Consequences

### Positive
- **Single redirect URI** for all ActualBudget instances — no Google Console changes per user
- **Full AI access** to budget data via standardized MCP protocol
- **Reusable OIDC provider** — auth-api can serve as IdP for other services in the future
- **User isolation** — each Foundry agent run only accesses the authenticated user's data
- **Method-agnostic tokens** — OpenID for web UI and service tokens for API coexist

### Negative / Trade-offs
- **Added complexity** — auth-api now has OIDC responsibilities beyond its original scope
- **Foundry dependency** — SunnieAI requires Azure AI Foundry (paid service, East US 2 region)
- **Cold start** — MCP server needs to connect to AB instance per tool call (mitigated by `minReplicas: 1`)
- **Python script** for Foundry agent registration (only Python file in a Node.js repo)

### Risks
- ActualBudget upstream changes to session token validation could break MCP access
- Azure AI Foundry Agent Service is relatively new — API stability uncertain
- OIDC provider implementation is minimal (no refresh tokens, no PKCE) — sufficient for AB but not a general-purpose IdP

---

## Related Files

**patelr3-site:**
- `auth-api/src/oidc.js` — OIDC Identity Provider endpoints
- `auth-api/tests/oidc.test.js` — OIDC unit tests
- `frontend/src/pages/SunnieAI.jsx` — AI chat interface
- `deployments/main.bicep` — MCP server ACA definition
- `deployments/foundry.bicep` — Azure AI Foundry infrastructure
- `scripts/setup-foundry-agent.py` — Foundry agent registration
- `docs/foundry-setup.md` — Foundry setup guide

**actual-server-setup (submodule):**
- `mcp-server/` — MCP server (21 tools, tests, Dockerfile)
- `finance-api/src/deploy.js` — OpenID env var injection, token retrieval endpoint
- `entrypoint.sh` — Service token injection into AB SQLite
