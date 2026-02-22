# patelr3-site

A containerized personal website with Google OAuth sign-in, role-based access control, and a micro-service architecture.

## Quick Start

```bash
# 1. Copy and fill in your Google OAuth credentials and secrets
cp .env.example .env

# 2. Build and start all containers
docker compose up --build

# 3. Open http://localhost in your browser
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system design.

### Services

| Service      | Tech               | Description                        |
| ------------ | ------------------ | ---------------------------------- |
| nginx        | Nginx 1.25         | Reverse proxy & auth gate          |
| frontend     | React 18 (Vite)    | SPA with About Me & Dashboard      |
| auth-api     | Node.js 20 Express | Google OAuth, JWT, RBAC            |
| hello-world  | Node.js 20 Express | Sample protected micro-service     |
| postgres     | PostgreSQL 16      | User accounts & roles              |

## Development

Open in VS Code and use **"Reopen in Container"** to get a fully configured devcontainer with Node 20, Docker-in-Docker, and psql.