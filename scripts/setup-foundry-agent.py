#!/usr/bin/env python3
"""
Register/update the ActualBudget MCP agent in Azure AI Foundry.

Idempotent: creates the agent if it doesn't exist, updates it otherwise.
Uses REST API directly (azure-ai-agents SDK removed McpTool in v1.1.0).

Prerequisites:
  pip install azure-identity

Usage:
  # First deploy: creates agent
  python scripts/setup-foundry-agent.py

  # Update model or tools later — same command, idempotent
  python scripts/setup-foundry-agent.py --model gpt-4.1-mini

  # Custom MCP server URL
  python scripts/setup-foundry-agent.py --mcp-url https://my-mcp.example.com

  # Force re-creation (e.g., after switching classic → new Foundry)
  python scripts/setup-foundry-agent.py --recreate

Environment variables:
  PROJECT_ENDPOINT  — Azure AI Foundry project endpoint
  MCP_SERVER_URL    — Public URL of the MCP server (default, overridden by --mcp-url)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

from azure.identity import DefaultAzureCredential

AGENT_NAME = "sunnieai-assistant"
STATE_FILE = os.path.join(os.path.dirname(__file__), ".foundry-agent-state.json")
API_VERSION = "v1"

MCP_TOOLS = [
    "list_budgets", "load_budget", "get_budget_summary",
    "get_accounts", "create_account", "close_account",
    "get_transactions", "create_transaction", "update_transaction",
    "delete_transaction", "import_transactions",
    "get_categories", "create_category", "update_category", "delete_category",
    "get_payees", "create_payee",
    "get_schedules", "create_schedule",
    "get_rules", "create_rule",
]

INSTRUCTIONS = (
    "You are SunnieAI, a personal finance assistant. "
    "You have access to the user's Actual Budget data through MCP tools. "
    "Use the available tools to help manage budgets, accounts, transactions, "
    "categories, and more. Always start by listing budgets and loading one "
    "before performing other operations. Be precise with monetary amounts "
    "and dates. Confirm destructive actions before executing. "
    "Be friendly, concise, and helpful."
)


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def foundry_request(endpoint, path, token, method="GET", body=None):
    """Make a REST request to the Foundry Agent API."""
    url = f"{endpoint}/{path}?api-version={API_VERSION}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        raise RuntimeError(f"HTTP {e.code}: {error_body}") from e


def main():
    parser = argparse.ArgumentParser(description="Register/update SunnieAI agent in Azure AI Foundry")
    parser.add_argument("--model", default="gpt-4.1", help="Model deployment name (default: gpt-4.1)")
    parser.add_argument("--mcp-url", default=None, help="MCP server URL (overrides MCP_SERVER_URL env)")
    parser.add_argument("--agent-id", default=None, help="Existing agent ID to update (overrides state file)")
    parser.add_argument("--recreate", action="store_true", help="Force creation of a new agent (ignores existing state)")
    parser.add_argument("--delete", action="store_true", help="Delete the existing agent")
    args = parser.parse_args()

    project_endpoint = os.environ.get("PROJECT_ENDPOINT")
    mcp_url = args.mcp_url or os.environ.get("MCP_SERVER_URL")

    if not project_endpoint:
        project_endpoint = "https://patelr3-openai-1.services.ai.azure.com/api/projects/patelr3-prod-1"
        print(f"  Using default PROJECT_ENDPOINT: {project_endpoint}")

    if not mcp_url and not args.delete:
        print("Error: MCP_SERVER_URL env or --mcp-url flag is required")
        sys.exit(1)

    # Get Azure token
    credential = DefaultAzureCredential()
    token = credential.get_token("https://ai.azure.com/.default").token

    state = load_state()
    agent_id = args.agent_id or state.get("agent_id")
    if args.recreate:
        agent_id = None

    # Delete flow
    if args.delete:
        if agent_id:
            foundry_request(project_endpoint, f"assistants/{agent_id}", token, method="DELETE")
            print(f"✓ Agent {agent_id} deleted")
            os.remove(STATE_FILE)
        else:
            print("No agent to delete (no state file)")
        return

    # MCP tool definition (REST API format — type: "mcp" as a Tool)
    mcp_tool_def = {
        "type": "mcp",
        "server_label": "actualbudget",
        "server_url": f"{mcp_url}/mcp",
        "allowed_tools": MCP_TOOLS,
    }

    agent_body = {
        "model": args.model,
        "name": AGENT_NAME,
        "instructions": INSTRUCTIONS,
        "tools": [mcp_tool_def],
    }

    print(f"=== SunnieAI Agent Setup ===")
    print(f"Endpoint: {project_endpoint}")
    print(f"Model:    {args.model}")
    print(f"MCP URL:  {mcp_url}/mcp")
    print(f"Tools:    {len(MCP_TOOLS)} allowed MCP tools")
    print()

    if agent_id:
        try:
            agent = foundry_request(
                project_endpoint, f"assistants/{agent_id}", token,
                method="POST", body=agent_body,
            )
            print(f"✓ Agent updated (id: {agent['id']})")
        except RuntimeError as e:
            if "404" in str(e) or "NotFound" in str(e):
                print(f"  Agent {agent_id} not found, creating new one...")
                agent_id = None
            else:
                raise

    if not agent_id:
        agent = foundry_request(
            project_endpoint, "assistants", token,
            method="POST", body=agent_body,
        )
        print(f"✓ Agent created (id: {agent['id']})")

    save_state({
        "agent_id": agent["id"],
        "model": args.model,
        "mcp_url": mcp_url,
        "tools": MCP_TOOLS,
    })

    print(f"  Name:  {agent.get('name')}")
    print(f"  Model: {agent.get('model')}")
    print(f"  State: saved to {STATE_FILE}")
    print()
    print("Agent ID for auth-api config:")
    print(f"  FOUNDRY_AGENT_ID={agent['id']}")


if __name__ == "__main__":
    main()

