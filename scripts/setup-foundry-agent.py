#!/usr/bin/env python3
"""
Register/update the ActualBudget MCP agent in Azure AI Foundry.

Idempotent: creates the agent if it doesn't exist, updates it otherwise.
Supports adding models and MCP servers via command-line args.

Prerequisites:
  pip install azure-ai-projects azure-ai-agents azure-identity

Usage:
  # First deploy: creates agent
  python scripts/setup-foundry-agent.py

  # Update model or tools later — same command, idempotent
  python scripts/setup-foundry-agent.py --model gpt-4o-mini

  # Custom MCP server URL
  python scripts/setup-foundry-agent.py --mcp-url https://my-mcp.example.com

Environment variables:
  PROJECT_ENDPOINT  — Azure AI Foundry project endpoint
  MCP_SERVER_URL    — Public URL of the MCP server (default, overridden by --mcp-url)
"""

import argparse
import json
import os
import sys

from azure.ai.projects import AIProjectClient
from azure.ai.agents.models import McpTool
from azure.identity import DefaultAzureCredential

AGENT_NAME = "sunnieai-assistant"
STATE_FILE = os.path.join(os.path.dirname(__file__), ".foundry-agent-state.json")

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


def main():
    parser = argparse.ArgumentParser(description="Register/update SunnieAI agent in Azure AI Foundry")
    parser.add_argument("--model", default="gpt-4.1", help="Model deployment name (default: gpt-4.1)")
    parser.add_argument("--mcp-url", default=None, help="MCP server URL (overrides MCP_SERVER_URL env)")
    parser.add_argument("--agent-id", default=None, help="Existing agent ID to update (overrides state file)")
    parser.add_argument("--delete", action="store_true", help="Delete the existing agent")
    args = parser.parse_args()

    project_endpoint = os.environ.get("PROJECT_ENDPOINT")
    mcp_url = args.mcp_url or os.environ.get("MCP_SERVER_URL")

    if not project_endpoint:
        # Default to the known CognitiveServices project endpoint
        project_endpoint = "https://patelr3-openai-1.services.ai.azure.com/api/projects/patelr3-prod-1"
        print(f"  Using default PROJECT_ENDPOINT: {project_endpoint}")

    if not mcp_url and not args.delete:
        print("Error: MCP_SERVER_URL env or --mcp-url flag is required")
        sys.exit(1)

    client = AIProjectClient(
        credential=DefaultAzureCredential(),
        endpoint=project_endpoint,
    )

    state = load_state()
    agent_id = args.agent_id or state.get("agent_id")

    # Delete flow
    if args.delete:
        if agent_id:
            client.agents.delete_agent(agent_id)
            print(f"✓ Agent {agent_id} deleted")
            os.remove(STATE_FILE)
        else:
            print("No agent to delete (no state file)")
        return

    # Build MCP tool
    mcp_tool = McpTool(
        server_label="actualbudget",
        server_url=mcp_url,
        allowed_tools=MCP_TOOLS,
    )

    print(f"=== SunnieAI Agent Setup ===")
    print(f"Endpoint: {project_endpoint}")
    print(f"Model:    {args.model}")
    print(f"MCP URL:  {mcp_url}")
    print(f"Tools:    {len(MCP_TOOLS)}")
    print()

    if agent_id:
        # Update existing agent
        try:
            agent = client.agents.update_agent(
                agent_id,
                model=args.model,
                name=AGENT_NAME,
                instructions=INSTRUCTIONS,
                tools=mcp_tool.definitions,
            )
            print(f"✓ Agent updated (id: {agent.id})")
        except Exception as e:
            if "NotFound" in str(e):
                print(f"  Agent {agent_id} not found, creating new one...")
                agent_id = None
            else:
                raise

    if not agent_id:
        # Create new agent
        agent = client.agents.create_agent(
            model=args.model,
            name=AGENT_NAME,
            instructions=INSTRUCTIONS,
            tools=mcp_tool.definitions,
        )
        print(f"✓ Agent created (id: {agent.id})")

    # Save state for future updates
    save_state({
        "agent_id": agent.id,
        "model": args.model,
        "mcp_url": mcp_url,
        "tools": MCP_TOOLS,
    })

    print(f"  Name:  {agent.name}")
    print(f"  Model: {agent.model}")
    print(f"  State: saved to {STATE_FILE}")
    print()
    print("Agent ID for auth-api config:")
    print(f"  FOUNDRY_AGENT_ID={agent.id}")


if __name__ == "__main__":
    main()

