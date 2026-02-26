# Azure AI Foundry — SunnieAI Setup

## Overview

SunnieAI is a chat interface on patelr3-site that connects to Azure AI Foundry Agent Service (new Foundry experience). Uses the **Responses API** (not classic Assistants API) with client-managed conversation history and rolling summarization to keep context efficient. Users chat with an AI assistant that can access their Actual Budget data through MCP tools configured as **MCPTool**.

## Architecture

The Foundry resources use the **CognitiveServices** resource provider. The AI Services account and project are managed idempotently via `deployments/foundry.bicep`.

| Resource | Type | Name | Location |
|----------|------|------|----------|
| AI Services | `Microsoft.CognitiveServices/accounts` | `patelr3-openai-1` | westus |
| AI Project | `accounts/projects` | `patelr3-prod-1` | westus |
| Model deployment | `accounts/deployments` | `gpt-4.1` (Standard, 2025-04-14) | westus |
| Agent | New Foundry Agent | `sunnieai` (versioned) | — |

**Resource Group:** `patelr3-ai-rg`
**Project Endpoint:** `https://patelr3-openai-1.services.ai.azure.com/api/projects/patelr3-prod-1`

## API Architecture

| Aspect | Description |
|--------|-------------|
| Agent API | New Foundry `create_version()` (not classic `POST /assistants`) |
| Chat API | Responses API (`POST /responses`) — single call per message |
| Context | Client-managed with rolling summarization |
| Streaming | SSE with `response.output_text.delta` events |
| MCP tools | `MCPTool` via `azure-ai-projects` SDK |

### Conversation Summarization

Messages are stored locally in Postgres (`chat_messages` table). When a conversation exceeds 10 messages, older messages are summarized and the summary is sent as context with the last 6 messages. This prevents context window overflow on long conversations.

## Prerequisites

1. **MCP server deployed** — `patelr3-mcp-server` ACA must be running
2. **Azure subscription** — with permissions to create AI Services resources
3. **Python 3.9+** — for agent registration script

## Deployment

### Automated (GitHub Actions)

Trigger the **"Deploy AI Foundry"** workflow from the Actions tab:
1. Go to **Actions** → **Deploy AI Foundry** → **Run workflow**
2. Select model (default: `gpt-4.1`)
3. Workflow deploys Bicep infra, registers agent via `create_version()`, and stores outputs in AKV

The `deploy.yml` workflow automatically fetches `foundry-project-endpoint` and `foundry-agent-name` from AKV and passes them to auth-api.

### Local

```bash
az login
./scripts/deploy-foundry.sh

# Or manual:
export PROJECT_ENDPOINT="https://patelr3-openai-1.services.ai.azure.com/api/projects/patelr3-prod-1"
export MCP_SERVER_URL="https://patelr3-mcp-server.gentlebay-ad6f417d.westus2.azurecontainerapps.io"
pip install "azure-ai-projects>=2.0.0b4" azure-identity
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
- `foundry-agent-name` — registered agent name (e.g., `sunnieai`)

The `deploy.yml` workflow fetches these from AKV and passes them to auth-api as env vars.

## Re-registration

**Re-run `setup-foundry-agent.py` when:**
- Adding new MCP servers or tools
- Changing the model (e.g., `--model gpt-4.1-mini`)
- Updating agent instructions
- MCP server URL changes

The script uses `create_version()` — each run creates a new version of the agent.

## Authentication

### Token Scope

The Foundry v1 Responses API (`/openai/v1/responses`) requires `cognitiveservices.azure.com/.default` token scope. The ACA managed identity must have **Cognitive Services User** role on the AI Services resource.

**Important:** The GitHub Actions SP cannot assign RBAC roles (lacks `roleAssignments/write`). This role must be assigned manually:

```bash
az role assignment create \
  --assignee <auth-api-managed-identity-principal-id> \
  --role "Cognitive Services User" \
  --scope /subscriptions/34154ec0-9335-4f09-a67a-bda54a403a14/resourceGroups/patelr3-ai-rg/providers/Microsoft.CognitiveServices/accounts/patelr3-openai-1
```

Current auth-api principal ID: `509dcfdb-8624-4e86-9816-e328a1e1ee85`

### Auth Flow

Auth-api builds the input array with conversation context (summarized if long) and calls the Responses API with `agent_reference`. The MCP server authenticates via the user's JWT passed at agent setup time.

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

Auth-api sends a single Responses API call per user message:

```javascript
const response = await foundryFetch('/responses', {
  method: 'POST',
  body: JSON.stringify({
    input: [
      { role: 'user', content: 'Show me my spending this month' }
    ],
    model: 'gpt-4.1',
    stream: true,
    store: false,
    agent_reference: { name: 'sunnieai', version: '1', type: 'agent_reference' },
  }),
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
| PermissionDenied on agent create | SP needs `Cognitive Services User` role (not just Azure AI Developer) |
| Agent in classic only | Use `create_version()` via `azure-ai-projects>=2.0.0b4`, not `POST /assistants` |
| 401 "audience incorrect" | ACA identity needs `Cognitive Services User` role — assign manually (see Authentication section) |
| Context too large | Conversation summarization kicks in at >10 messages; reduce SUMMARY_THRESHOLD if needed |
