FROM mcr.microsoft.com/devcontainers/javascript-node:20

# System tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# GitHub Copilot CLI
RUN npm install -g @github/copilot
