# Deployment

Azure Container Apps deployment using Bicep templates.

## Prerequisites

- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli) with Bicep
- Docker (for building and pushing images)
- A `.env` file at the repo root with secrets (see `.env.example`)

## Quick Deploy (Local)

```bash
# Login to Azure
az login

# Run the full deployment (infra + images + secrets)
./deployments/scripts/deploy.sh latest
```

## Individual Scripts

Each script can be run independently:

| Script | Usage | Purpose |
|--------|-------|---------|
| `deploy.sh` | `./deploy.sh [tag]` | Full deployment (runs all 3 below) |
| `deploy-infra.sh` | `./deploy-infra.sh <rg> [tag]` | Deploy Bicep templates (ACR, AKV, Container Apps) |
| `push-images.sh` | `./push-images.sh <acr> [tag]` | Build & push Docker images to ACR |
| `seed-secrets.sh` | `./seed-secrets.sh <kv>` | Upload `.env` secrets to Key Vault |

## Azure Resources Created

| Resource | Type | Purpose |
|----------|------|---------|
| `patelr3acr` | Container Registry (Basic) | Stores Docker images |
| `patelr3kv` | Key Vault | Stores secrets (OAuth creds, JWT, DB password) |
| `patelr3-cae` | Container Apps Environment | Shared runtime environment |
| `patelr3-frontend` | Container App (external) | React SPA — public ingress |
| `patelr3-auth-api` | Container App (internal) | Auth service |
| `patelr3-hello-world` | Container App (internal) | Sample protected service |
| `patelr3-postgres` | Container App (internal) | PostgreSQL database |

## CI/CD (GitHub Actions)

The workflow at `.github/workflows/deploy.yml` runs on every push to `main`:

1. **Build & push** all 3 service images to ACR (tagged with git SHA)
2. **Deploy Bicep** templates to update infrastructure
3. **Update Container App** revisions to the new image tag

### Authentication

Uses **OIDC federated credentials** (no passwords to rotate):
- Service principal: `patelr3-site-github-actions`
- Client ID, Tenant ID, and Subscription ID are hardcoded in the workflow (non-secret)

### Setup (one-time)

Set the 4 app secrets in your GitHub repo:

```bash
gh auth login
./deployments/scripts/setup-gh-secrets.sh
```

Or manually at **GitHub → Settings → Secrets → Actions**, add:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `JWT_SECRET`
- `POSTGRES_PASSWORD`

## Cloudflare DNS Setup

After deployment, get the frontend FQDN and create CNAME records in Cloudflare:

```
www   CNAME  patelr3-frontend.<region>.azurecontainerapps.io  (Proxied)
@     CNAME  patelr3-frontend.<region>.azurecontainerapps.io  (Proxied)
```

## CI/CD (GitHub Actions) — Scripts

The deployment scripts also read secrets from environment variables when `.env` is not present,
making them reusable in GitHub Actions or other CI systems.
