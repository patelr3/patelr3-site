#!/usr/bin/env python3
"""
Register/update the SunnieAI agent in Azure AI Foundry (new experience).

Uses the azure-ai-projects SDK with create_version() to create agents
that appear in the new Foundry portal (not classic).

Prerequisites:
  pip install "azure-ai-projects>=2.0.0b4" azure-identity

Usage:
  python scripts/setup-foundry-agent.py --mcp-connection-id <connection-id>
  python scripts/setup-foundry-agent.py --mcp-connection-id <id> --model gpt-4.1-mini

Environment variables:
  PROJECT_ENDPOINT  — Azure AI Foundry project endpoint
"""

import argparse
import json
import os
import sys

from azure.identity import DefaultAzureCredential

AGENT_NAME = "sunnieai"
STATE_FILE = os.path.join(os.path.dirname(__file__), ".foundry-agent-state.json")

INSTRUCTIONS = """\
You are SunnieAI, a personal finance assistant. You have access to the user's \
Actual Budget data through MCP tools. Use the available tools to help manage \
budgets, accounts, transactions, categories, and more.

## Date Awareness
- You do NOT know today's date from your training data — it is unreliable.
- To determine the current date, look at the timestamps on recent transactions \
returned by MCP tools (e.g. the most recent transaction dates).
- Never assume or hallucinate the current date. If you need it and have no \
transaction data yet, ask the user or load recent transactions first.

## Monetary Amounts — CRITICAL
- **ALL amounts from Actual Budget tools are integers in CENTS** \
(e.g. 150000 = $1,500.00, -4299 = -$42.99).
- You MUST divide by 100 before displaying any amount to the user.
- You MUST multiply by 100 when writing amounts back via tools.
- Negative amounts = expenses/outflows; positive amounts = income/inflows.
- Never display raw cent values to the user. Always format as dollars \
(e.g. "$1,500.00", not "150000").

## Budget Workflow
- Always call `list_budgets` first, then `load_budget` before any other \
operations.
- A budget must be **synced to the server** before it appears in \
`list_budgets`. If a user says they just created a budget but it doesn't \
show up, advise them to:
  1. Open the budget in Actual Budget
  2. Go to Settings → scroll to the "Sync" section
  3. Ensure sync is enabled and the budget has been uploaded to the server
- Each `load_budget` call opens a sync connection. Always load a budget \
before querying its accounts, transactions, or categories.

## Accounts
- Account balances are running totals in cents.
- "Off-budget" accounts (like investment or tracking accounts) are not \
included in budget calculations.
- Closing an account does not delete it — it hides it from active views \
but preserves history.

## Transactions
- Transactions use category IDs, not names. Call `get_categories` to map \
IDs to human-readable names.
- Transfer transactions appear in both the source and destination accounts.
- When listing transactions, use date filters to avoid overwhelming results. \
Default to the current month if the user doesn't specify a range.
- Split transactions have a parent transaction with multiple \
sub-transactions, each with its own category.

## Categories
- Categories are organized into groups. Each category belongs to exactly \
one group.
- Budget amounts are set per-category per-month.
- "Income" categories work differently — they represent money coming in, \
not spending targets.

## Common Issues
- **"Budget not found"**: The sync ID may be wrong, or the budget hasn't \
been synced. Ask the user to check sync settings.
- **Empty transaction list**: The user may need to specify a wider date \
range, or the account may have no transactions.
- **Tool timeout**: Large queries (e.g. all transactions for a year) may \
time out. Suggest narrowing the date range.
- **Auth errors on tool calls**: The user's session may have expired. \
Suggest refreshing the page and trying again.

## Best Practices
- When summarizing spending, group by category and show totals in dollars.
- For budget overviews, show budgeted vs. actual for the current month.
- Always confirm before creating, updating, or deleting any data.
- If a tool call fails, explain the error in plain language and suggest \
next steps.
- Be friendly, concise, and helpful.\
"""


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Register/update SunnieAI agent in Azure AI Foundry")
    parser.add_argument("--model", default="gpt-4.1", help="Model deployment name (default: gpt-4.1)")
    parser.add_argument(
        "--mcp-connection-id",
        default=None,
        help="Project connection ID for the OAuth MCP connection (from Foundry portal)",
    )
    args = parser.parse_args()

    project_endpoint = os.environ.get("PROJECT_ENDPOINT")
    mcp_connection_id = args.mcp_connection_id

    if not project_endpoint:
        project_endpoint = "https://arayosun-prod-eastus2-resource.services.ai.azure.com/api/projects/arayosun-prod-eastus2"
        print(f"  Using default PROJECT_ENDPOINT: {project_endpoint}")

    if not mcp_connection_id:
        print("Error: --mcp-connection-id is required (the project connection ID from the Foundry portal)")
        sys.exit(1)

    print(f"=== SunnieAI Agent Setup (New Foundry) ===")
    print(f"Endpoint:      {project_endpoint}")
    print(f"Model:         {args.model}")
    print(f"MCP Connection: {mcp_connection_id}")
    print()

    # Import SDK (deferred so --help works without SDK installed)
    from azure.ai.projects import AIProjectClient
    from azure.ai.projects.models import PromptAgentDefinition, MCPTool

    credential = DefaultAzureCredential()
    project_client = AIProjectClient(
        endpoint=project_endpoint,
        credential=credential,
    )

    # Configure MCP tool with project connection (OAuth identity passthrough)
    mcp_tool = MCPTool(
        server_label="actual-budget-mcp",
        project_connection_id=mcp_connection_id,
        require_approval="never",
    )

    # Create agent version (idempotent — new version if agent exists)
    definition = PromptAgentDefinition(
        model=args.model,
        instructions=INSTRUCTIONS,
        tools=[mcp_tool],
    )

    print(f"Creating agent version: {AGENT_NAME} ...")
    agent = project_client.agents.create_version(
        agent_name=AGENT_NAME,
        definition=definition,
    )

    agent_name = agent.name if hasattr(agent, 'name') else AGENT_NAME
    agent_version = agent.version if hasattr(agent, 'version') else '1'
    agent_id = agent.id if hasattr(agent, 'id') else f"{agent_name}:{agent_version}"

    print(f"✓ Agent created/updated")
    print(f"  Name:    {agent_name}")
    print(f"  Version: {agent_version}")
    print(f"  ID:      {agent_id}")

    save_state({
        "agent_name": agent_name,
        "agent_version": agent_version,
        "agent_id": agent_id,
        "model": args.model,
        "mcp_connection_id": mcp_connection_id,
    })

    print(f"  State: saved to {STATE_FILE}")
    print()
    print("Agent name and ID for auth-api config:")
    print(f"  FOUNDRY_AGENT_NAME={agent_name}")
    print(f"  FOUNDRY_AGENT_ID={agent_id}")


if __name__ == "__main__":
    main()

