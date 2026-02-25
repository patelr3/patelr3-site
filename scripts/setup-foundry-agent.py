#!/usr/bin/env python3
"""
Register the ActualBudget MCP server with Azure AI Foundry Agent Service.

Prerequisites:
  1. Azure AI Foundry project (hub + project) with a model deployed (e.g. gpt-4o)
  2. MCP server deployed to ACA with public HTTPS endpoint
  3. pip install azure-ai-projects azure-identity

Usage:
  export PROJECT_ENDPOINT="https://<region>.api.azureml.ms/..."
  export MCP_SERVER_URL="https://patelr3-mcp-server.<cae-domain>"
  python scripts/setup-foundry-agent.py
"""

import os
import sys

from azure.ai.projects import AIProjectClient
from azure.ai.agents.models import McpTool
from azure.identity import DefaultAzureCredential

PROJECT_ENDPOINT = os.environ.get("PROJECT_ENDPOINT")
MCP_SERVER_URL = os.environ.get("MCP_SERVER_URL")

if not PROJECT_ENDPOINT or not MCP_SERVER_URL:
    print("Required environment variables:")
    print("  PROJECT_ENDPOINT  — Azure AI Foundry project endpoint")
    print("  MCP_SERVER_URL    — Public URL of the deployed MCP server")
    print()
    print("Example:")
    print('  export PROJECT_ENDPOINT="https://eastus2.api.azureml.ms/..."')
    print('  export MCP_SERVER_URL="https://patelr3-mcp-server.icytree-0e39e2f3.westus2.azurecontainerapps.io"')
    sys.exit(1)

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


def main():
    print("=== Azure AI Foundry — ActualBudget MCP Agent Setup ===")
    print(f"Endpoint: {PROJECT_ENDPOINT}")
    print(f"MCP URL:  {MCP_SERVER_URL}")
    print()

    client = AIProjectClient(
        credential=DefaultAzureCredential(),
        endpoint=PROJECT_ENDPOINT,
    )

    # Create MCP tool pointing to our server
    mcp_tool = McpTool(
        server_label="actualbudget",
        server_url=MCP_SERVER_URL,
        allowed_tools=MCP_TOOLS,
    )
    mcp_tool.set_approval_mode("never")
    mcp_tool.update_headers("Accept", "application/json, text/event-stream")
    mcp_tool.update_headers("Content-Type", "application/json")

    # Create the agent
    agent = client.agents.create_agent(
        model="gpt-4o",
        name="actualbudget-assistant",
        instructions=(
            "You are a personal finance assistant with access to the user's "
            "Actual Budget data. Use the available tools to help manage budgets, "
            "accounts, transactions, categories, and more. Always start by listing "
            "budgets and loading one before performing other operations. Be precise "
            "with monetary amounts and dates. Confirm destructive actions before executing."
        ),
        tools=mcp_tool.definitions,
    )

    print(f"✓ Agent created successfully!")
    print(f"  ID:    {agent.id}")
    print(f"  Name:  {agent.name}")
    print(f"  Model: {agent.model}")
    print(f"  Tools: {len(MCP_TOOLS)} MCP tools registered")
    print()
    print("To use this agent in a run, pass the user's JWT as a custom header:")
    print()
    print("  mcp_tool.update_headers('Authorization', f'Bearer {user_jwt}')")
    print("  run = client.agents.runs.create(")
    print("      thread_id=thread.id,")
    print("      agent_id=agent.id,")
    print("      tool_resources=mcp_tool.resources,")
    print("  )")


if __name__ == "__main__":
    main()
