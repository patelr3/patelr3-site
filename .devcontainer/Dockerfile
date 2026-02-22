FROM mcr.microsoft.com/devcontainers/javascript-node:20

# Docker Compose (for running the full stack)
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*
