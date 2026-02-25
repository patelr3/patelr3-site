# Azure AI Foundry — ActualBudget MCP Integration

## Overview

The ActualBudget MCP server enables Azure AI Foundry agents to manage budgets through natural language. Users authenticate via their existing Google OAuth, and each user can only access their own ActualBudget instance.

## Prerequisites

1. **MCP server deployed** — `patelr3-mcp-server` ACA must be running
2. **Azure AI Foundry project** — Create a hub + project in Azure AI Foundry
3. **Model deployment** — Deploy a model (e.g., `gpt-4o`) in the project

## Setup

### Option A: Script (recommended)

```bash
pip install azure-ai-projects azure-ai-agents azure-identity

export PROJECT_ENDPOINT="https://<region>.api.azureml.ms/..."
export MCP_SERVER_URL="https://patelr3-mcp-server.<cae-domain>"
az login

python scripts/setup-foundry-agent.py
```

### Option B: Azure Portal

1. Go to [Azure AI Foundry](https://ai.azure.com)
2. Open your project → **Agents** → **Create agent**
3. Under **Tools**, click **Add tool** → **MCP Server**
4. Configure:
   - **Server label**: `actualbudget`
   - **Server URL**: `https://patelr3-mcp-server.<cae-domain>`
   - **Allowed tools**: Select all 21 tools
5. Save and test

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
