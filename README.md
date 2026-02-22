# patelr3-site

A containerized personal website with Google OAuth sign-in, role-based access control (RBAC), and a micro-service architecture. Deployed to Azure Container Apps with CI/CD via GitHub Actions.

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

| Service               | Tech               | Description                                     |
| --------------------- | ------------------ | ----------------------------------------------- |
| nginx                 | Nginx 1.25         | Reverse proxy & auth gate (local dev only)       |
| frontend              | React 18 (Vite)    | SPA — About Me, Dashboard, Admin Panel           |
| auth-api              | Node.js 20 Express | Google OAuth, JWT, RBAC, deployment proxy         |
| hello-world           | Node.js 20 Express | Sample public micro-service                      |
| hello-world-restricted| Node.js 20 Express | Sample restricted micro-service                  |
| postgres              | PostgreSQL 16      | User accounts, roles, services, access requests  |

### Multi-Tenant Finance Services

This repo integrates with [actual-server-setup](https://github.com/patelr3/actual-server-setup) to provide per-user Actual Budget instances. The auth-api proxies deployment requests to the finance-api middleman service, which manages Azure Container Apps for each user.

## Deployment

Production is deployed to **Azure Container Apps** via GitHub Actions:

- **CI** (`.github/workflows/ci.yml`) — Runs unit tests, frontend build, and integration tests on every push/PR to `main`.
- **Deploy** (`.github/workflows/deploy.yml`) — Builds Docker images, pushes to ACR, deploys via Bicep.
- **Dependabot** — Automated dependency updates with auto-merge on CI pass.

Custom domain: `arayosun.com` via Cloudflare (see [docs/cloudflare-setup.md](docs/cloudflare-setup.md)).

## Development

Open in VS Code and use **"Reopen in Container"** to get a fully configured devcontainer with Node 20, Docker-in-Docker, and psql.

### Testing

```bash
# Unit tests (per service)
npm test --prefix auth-api
npm test --prefix hello-world
npm test --prefix hello-world-restricted

# Integration tests (requires running docker-compose stack)
bash tests/integration.sh
```

## Project Structure

```
patelr3-site/
├── .devcontainer/          ← VS Code devcontainer config
├── .github/
│   ├── workflows/          ← CI, Deploy, Dependabot auto-merge
│   ├── dependabot.yml      ← Automated dependency updates
│   └── copilot-instructions.md
├── auth-api/               ← Auth + RBAC + deployment proxy
│   ├── src/
│   │   ├── app.js          ← Express routes (auth, services, deployments)
│   │   ├── config.js       ← Environment config
│   │   └── db.js           ← PostgreSQL schema & seed
│   └── tests/
├── frontend/               ← React SPA
│   └── src/
│       ├── App.jsx         ← Routes, navbar, footer
│       ├── api.js          ← API endpoint helpers
│       └── pages/          ← AboutMe, Dashboard, Admin, Account, ServicePage
├── hello-world/            ← Sample micro-service
├── hello-world-restricted/ ← Sample restricted micro-service
├── nginx/                  ← Reverse proxy (local dev only)
├── deployments/            ← Bicep templates & deploy scripts
├── tests/                  ← Integration test scripts
├── docs/                   ← Architecture & setup guides
└── docker-compose.yml
```