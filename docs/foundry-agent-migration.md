# Foundry Agent Migration — OAuth Identity Passthrough

## Overview

We're migrating SunnieAI from **inline MCP tools with per-request JWT headers** to **Foundry Agent + OAuth Identity Passthrough**. This eliminates the auth-api streaming proxy (source of SSE parsing bugs) and lets Foundry handle tool auth natively via our OIDC IdP.

**Why migrate:**

- **Eliminate streaming proxy bugs** — auth-api currently proxies SSE streams from Foundry and injects JWT headers on each tool call. This has caused multiple issues with chunked encoding, partial events, and connection drops.
- **Simpler architecture** — Foundry manages the MCP connection (including OAuth token exchange) directly. Auth-api only needs to initiate the agent call.
- **Native per-user auth** — Foundry's OAuth identity passthrough performs a full OIDC flow per user session, so the MCP server receives a proper OIDC access token instead of a forwarded JWT.

---

## Architecture

### Before (Current)

```
User → Frontend → auth-api (SSE proxy) → Foundry Responses API
                      ↓ (injects JWT header per tool call)
                  Foundry Agent → MCP Server (validates JWT)
                      ↓
                  User's Actual Budget
```

### After (OAuth Identity Passthrough)

```
User → Frontend → auth-api → Foundry Agent SDK
                                  ↓
                              Foundry Agent
                                  ↓ (OAuth identity passthrough)
                              MCP Server (validates OIDC token)
                                  ↓
                              User's Actual Budget
```

Foundry handles the OAuth flow automatically:
1. When the agent needs to call an MCP tool, Foundry checks for a valid token for the user.
2. If no token exists, Foundry initiates the OIDC flow against our auth-api IdP.
3. The user is transparently authenticated (they're already logged in via Google through auth-api).
4. Foundry caches the token and includes it in all subsequent MCP tool calls.

---

## Portal Setup Steps

Set up the OAuth MCP connection in the Azure AI Foundry portal **before** running the setup script.

### 1. Navigate to the Project

Go to [ai.azure.com](https://ai.azure.com) → select project **arayosun-prod-eastus2**.

### 2. Add MCP Connection

1. Go to **Connected resources** (or **Tools** depending on portal version).
2. Click **Connect a tool** → **Custom** → **MCP**.
3. Configure:

| Field | Value |
|-------|-------|
| **Name** | `actual-budget-mcp` |
| **Server URL** | `https://www.arayosun.com/api/auth/mcp-server/mcp` |
| **Authentication** | OAuth Identity Passthrough → Custom OAuth |

### 3. Configure OAuth

| Field | Value |
|-------|-------|
| **Client ID** | `foundry-agent` |
| **Client Secret** | *(from AKV secret `oidc-foundry-client-secret`)* |
| **Authorization URL** | `https://www.arayosun.com/api/auth/oidc/authorize` |
| **Token URL** | `https://www.arayosun.com/api/auth/oidc/token` |
| **Refresh URL** | `https://www.arayosun.com/api/auth/oidc/token` |
| **Scopes** | `openid email profile` |

### 4. Save and Note Details

1. Click **Save** to create the connection.
2. **Copy the redirect URL** that Foundry generates — you'll need to register this as an allowed redirect URI in the OIDC client configuration.
3. **Note the connection name/ID** — you'll pass this to the setup script as `--mcp-connection-id`.

---

## Running the Setup Script

After the portal connection is created, re-register the agent to use the project connection instead of direct MCP URLs:

```bash
az login

# Install SDK if needed
pip install "azure-ai-projects>=2.0.0b4" azure-identity

# Run with the connection ID from the portal
python scripts/setup-foundry-agent.py \
  --mcp-connection-id <connection-id-from-portal>

# Or with a specific model
python scripts/setup-foundry-agent.py \
  --mcp-connection-id <connection-id-from-portal> \
  --model gpt-4.1
```

The script will print the agent name and ID after creation. These are stored in AKV and picked up by auth-api automatically on next deploy.

---

## Environment Variables

### New Variables

| Variable | Service | Source | Description |
|----------|---------|--------|-------------|
| `OIDC_FOUNDRY_CLIENT_SECRET` | auth-api | AKV `oidc-foundry-client-secret` | Client secret for the `foundry-agent` OIDC client |
| `FOUNDRY_MCP_CONNECTION_ID` | auth-api | AKV `foundry-mcp-connection-id` | Foundry project connection ID — enables Agent SDK path |
| `OIDC_JWKS_URL` | mcp-server | Static value | JWKS endpoint for validating OIDC tokens (`https://www.arayosun.com/api/auth/oidc/jwks`) |

### Existing Variables (unchanged)

| Variable | Service | Description |
|----------|---------|-------------|
| `FOUNDRY_PROJECT_ENDPOINT` | auth-api | Foundry project endpoint |
| `FOUNDRY_AGENT_NAME` | auth-api | Agent name (`sunnieai`) |
| `FOUNDRY_AGENT_ID` | auth-api | Agent ID |
| `MCP_SERVER_URL` | auth-api | MCP server URL (may become unused after migration) |

---

## Migration Checklist

### Before Migration

- [ ] **Create AKV secret** `oidc-foundry-client-secret` in `patelr3kvl3ytczhajsp7i` with a strong random value
- [ ] **Register OIDC client** `foundry-agent` in auth-api's OIDC IdP configuration with the client secret
- [ ] **Set up portal connection** following the portal steps above
- [ ] **Note the Foundry redirect URL** and add it to the OIDC client's allowed redirect URIs
- [ ] **Run the setup script** with `--mcp-connection-id` to re-register the agent

### Deploy

- [ ] **Deploy Bicep** — `main.bicep` now includes `OIDC_FOUNDRY_CLIENT_SECRET` for auth-api and `OIDC_JWKS_URL` for mcp-server
- [ ] **Verify ACA secrets** — confirm auth-api picks up the new secret (check container logs)

### After Migration

- [ ] **Test chat** — send a message via the SunnieAI chat and verify the agent calls MCP tools successfully
- [ ] **Verify OAuth flow** — check that Foundry performs the OIDC flow (auth-api logs should show `/oidc/authorize` and `/oidc/token` requests from Foundry)
- [ ] **Test tool calls** — verify the MCP server receives a valid OIDC access token (not a forwarded JWT)
- [ ] **Check error handling** — test with an expired session to ensure proper error messages
- [ ] **Monitor** — watch App Insights for errors in the first hour after migration

### Cleanup (after confirmed stable)

- [ ] Remove per-request JWT header injection from auth-api's Foundry proxy code
- [ ] Remove `MCP_SERVER_URL` from auth-api if no longer needed
- [ ] Update `docs/foundry-setup.md` with the new architecture details
