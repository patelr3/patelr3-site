#!/usr/bin/env python3
"""
Register/update the SunnieAI agent in Azure AI Foundry (new experience).

Uses the azure-ai-projects SDK with create_version() to create agents
that appear in the new Foundry portal (not classic).

Prerequisites:
  pip install "azure-ai-projects>=2.0.0b4" azure-identity

Usage:
  python scripts/setup-foundry-agent.py
  python scripts/setup-foundry-agent.py --model gpt-4.1-mini
  python scripts/setup-foundry-agent.py --mcp-url https://my-mcp.example.com

Environment variables:
  PROJECT_ENDPOINT  — Azure AI Foundry project endpoint
  MCP_SERVER_URL    — Public URL of the MCP server (overridden by --mcp-url)
"""

import argparse
import json
import os
import sys

from azure.identity import DefaultAzureCredential

AGENT_NAME = "sunnieai"
STATE_FILE = os.path.join(os.path.dirname(__file__), ".foundry-agent-state.json")

INSTRUCTIONS = (
    "You are SunnieAI, a personal finance assistant. "
    "You have access to the user's Actual Budget data through MCP tools. "
    "Use the available tools to help manage budgets, accounts, transactions, "
    "categories, and more. Always start by listing budgets and loading one "
    "before performing other operations. "
    "IMPORTANT: All monetary amounts from the API are in CENTS (integer). "
    "Divide by 100 to display dollars (e.g. 150000 = $1,500.00). "
    "When creating or updating transactions, convert dollars to cents (multiply by 100). "
    "Be precise with monetary amounts and dates. "
    "Confirm destructive actions before executing. "
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
    args = parser.parse_args()

    project_endpoint = os.environ.get("PROJECT_ENDPOINT")
    mcp_url = args.mcp_url or os.environ.get("MCP_SERVER_URL")

    if not project_endpoint:
        project_endpoint = "https://patelr3-openai-centralus.services.ai.azure.com/api/projects/patelr3-prod-centralus"
        print(f"  Using default PROJECT_ENDPOINT: {project_endpoint}")

    if not mcp_url:
        print("Error: MCP_SERVER_URL env or --mcp-url flag is required")
        sys.exit(1)

    print(f"=== SunnieAI Agent Setup (New Foundry) ===")
    print(f"Endpoint: {project_endpoint}")
    print(f"Model:    {args.model}")
    print(f"MCP URL:  {mcp_url}/mcp")
    print()

    # Import SDK (deferred so --help works without SDK installed)
    from azure.ai.projects import AIProjectClient
    from azure.ai.projects.models import PromptAgentDefinition, MCPTool

    credential = DefaultAzureCredential()
    project_client = AIProjectClient(
        endpoint=project_endpoint,
        credential=credential,
    )

    # Configure MCP tool
    mcp_tool = MCPTool(
        server_label="actual-budget-mcp",
        server_url=f"{mcp_url}/mcp",
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
        "mcp_url": mcp_url,
    })

    print(f"  State: saved to {STATE_FILE}")
    print()
    print("Agent name for auth-api config:")
    print(f"  FOUNDRY_AGENT_NAME={agent_name}")


if __name__ == "__main__":
    main()

