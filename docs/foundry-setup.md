# Azure AI Foundry — SunnieAI Setup

## Overview

SunnieAI is a chat interface on patelr3-site that connects to Azure AI Foundry Agent Service. Users chat with an AI assistant that can access their Actual Budget data through MCP tools, with toggleable data source access.

## Prerequisites

1. **MCP server deployed** — `patelr3-mcp-server` ACA must be running
2. **Azure subscription** — with permissions to create AI Services resources
3. **Python 3.9+** — for agent registration script

## Deployment

### Automated (GitHub Actions)

Trigger the **"Deploy AI Foundry"** workflow from the Actions tab:
1. Go to **Actions** → **Deploy AI Foundry** → **Run workflow**
2. Select model (default: `gpt-4o`)
3. Workflow deploys Bicep infra + registers agent

### Local

```bash
pip install azure-ai-projects azure-ai-agents azure-identity
az login
./scripts/deploy-foundry.sh
```

### What gets deployed (Bicep)

| Resource | Type | Purpose |
|----------|------|---------|
| AI Services | `Microsoft.CognitiveServices/accounts` | OpenAI model hosting |
| Model deployment | `accounts/deployments` | gpt-4o (configurable) |
| AI Hub | `MachineLearningServices/workspaces` (kind: Hub) | Governance layer |
| AI Project | `MachineLearningServices/workspaces` (kind: Project) | SunnieAI workspace |
| Storage Account | `Microsoft.Storage` | Required by Hub |
| Key Vault | `Microsoft.KeyVault` | Required by Hub |

### After deployment

Set these environment variables in auth-api (ACA or `.env`):
```
FOUNDRY_PROJECT_ENDPOINT=<from Bicep output>
FOUNDRY_AGENT_ID=<from setup-foundry-agent.py output>
```

## Re-registration

**Re-run `setup-foundry-agent.py` when:**
- Adding new MCP servers or tools
- Changing the model (e.g., `--model gpt-4o-mini`)
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
