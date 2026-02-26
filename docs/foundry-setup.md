# Azure AI Foundry — SunnieAI Setup

## Overview

SunnieAI is a chat interface on patelr3-site that connects to Azure AI Foundry Agent Service (new Foundry experience). Users chat with an AI assistant that can access their Actual Budget data through MCP tools configured as **Tools** (not Knowledge), with toggleable data source access.

## Architecture

The Foundry resources use the **CognitiveServices** resource provider. The AI Services account and project are managed idempotently via `deployments/foundry.bicep`.

| Resource | Type | Name | Location |
|----------|------|------|----------|
| AI Services | `Microsoft.CognitiveServices/accounts` | `patelr3-openai-1` | westus |
| AI Project | `accounts/projects` | `patelr3-prod-1` | westus |
| Model deployment | `accounts/deployments` | `gpt-4.1` (Standard, 2025-04-14) | westus |
| Agent | Foundry Agent | `sunnieai-assistant` | — |

**Resource Group:** `patelr3-ai-rg`  
**Project Endpoint:** `https://patelr3-openai-1.services.ai.azure.com/api/projects/patelr3-prod-1`

## Prerequisites

1. **MCP server deployed** — `patelr3-mcp-server` ACA must be running
2. **Azure subscription** — with permissions to create AI Services resources
3. **Python 3.9+** — for agent registration script (optional — can use `az rest` directly)

## Deployment

### Automated (GitHub Actions)

Trigger the **"Deploy AI Foundry"** workflow from the Actions tab:
1. Go to **Actions** → **Deploy AI Foundry** → **Run workflow**
2. Select model (default: `gpt-4.1`)
3. Workflow deploys Bicep infra, registers agent, and stores outputs in AKV

The `deploy.yml` workflow (main site deploy) automatically fetches `foundry-project-endpoint` and `foundry-agent-id` from AKV and passes them to auth-api.

### Local

```bash
# Option 1: deploy-foundry.sh (deploys infra + registers agent)
az login
./scripts/deploy-foundry.sh

# Option 2: Manual steps
az deployment group create \
  --resource-group patelr3-ai-rg \
  --template-file deployments/foundry.bicep \
  --parameters deployments/foundry-parameters.json

# Then register/update agent:
export PROJECT_ENDPOINT="https://patelr3-openai-1.services.ai.azure.com/api/projects/patelr3-prod-1"
export MCP_SERVER_URL="https://patelr3-mcp-server.gentlebay-ad6f417d.westus2.azurecontainerapps.io"
pip install azure-identity
python scripts/setup-foundry-agent.py
```

### What gets deployed (Bicep)

| Resource | Type | Purpose |
|----------|------|---------|
| AI Services | `Microsoft.CognitiveServices/accounts` | OpenAI model hosting |
| Model deployment | `accounts/deployments` | gpt-4.1 Standard (configurable) |
| AI Project | `accounts/projects` | SunnieAI workspace |
| RBAC role assignment | `Microsoft.Authorization/roleAssignments` | Cognitive Services User for auth-api |

### After deployment

Foundry values are automatically stored in AKV (`patelr3kvl3ytczhajsp7i`):
- `foundry-project-endpoint` — project API URL
- `foundry-agent-id` — registered agent ID

The `deploy.yml` workflow fetches these from AKV and passes them to auth-api as env vars.

## Re-registration

**Re-run `setup-foundry-agent.py` when:**
- Adding new MCP servers or tools
- Changing the model (e.g., `--model gpt-4.1-mini`)
- Switching between classic and new Foundry (use `--recreate` to force a new agent)
- Updating agent instructions
- MCP server URL changes

The script is **idempotent** — it updates the existing agent instead of creating a new one (state stored in `scripts/.foundry-agent-state.json`).

## Authentication Flow

```
User (browser) ─── Google OAuth ──→ auth-api ──→ JWT cookie
                                                    │
AI Foundry Agent ←── user provides JWT ─────────────┘
     │
     │ tool_resources: { actualbudget: { headers: { Authorization: "Bearer <jwt>" } } }
     ▼
MCP Server ──→ validates JWT ──→ gets AB instance + token ──→ executes tool
```

Each run passes the user's auth-api JWT as a custom header. The MCP server:
1. Validates the JWT to identify the user
2. Calls finance-api to get the user's AB instance URL + service token
3. Connects via `@actual-app/api` with the service token
4. Executes the requested tool and returns results

## Available Tools (21)

| Category | Tools |
|----------|-------|
| Budgets | `list_budgets`, `load_budget`, `get_budget_summary` |
| Accounts | `get_accounts`, `create_account`, `close_account` |
| Transactions | `get_transactions`, `create_transaction`, `update_transaction`, `delete_transaction`, `import_transactions` |
| Categories | `get_categories`, `create_category`, `update_category`, `delete_category` |
| Payees | `get_payees`, `create_payee` |
| Schedules | `get_schedules`, `create_schedule` |
| Rules | `get_rules`, `create_rule` |

## Usage Example

After agent setup, create a thread and run:

```javascript
// Create thread
const thread = await client.threads.create();

// Add user message
await client.messages.create(thread.id, {
  role: "user",
  content: "Show me my spending this month by category"
});

// Run with user's JWT passed as MCP header
const run = await client.runs.create(thread.id, {
  agent_id: agent.id,
  tool_resources: {
    actualbudget: {
      headers: { Authorization: `Bearer ${userJwt}` }
    }
  }
});
```

The agent will automatically:
1. Call `list_budgets` to find the user's budget
2. Call `load_budget` to open it
3. Call `get_transactions` with the current month's date range
4. Call `get_categories` to map category IDs to names
5. Summarize spending by category in natural language

## Troubleshooting

| Issue | Fix |
|-------|-----|
| 401 from MCP server | Check JWT is valid and not expired |
| No budgets found | Ensure user has deployed an AB instance |
| Tool timeout (50s) | Large transaction queries may timeout; use date filters |
| Connection refused | Verify MCP server ACA is running and externally accessible |
| NetworkAcls required | Add `networkAcls: { defaultAction: 'Allow' }` to CognitiveServices Bicep properties |
| Model SKU error | Use `GlobalStandard` SKU for gpt-4.1 (not `Standard`) |
