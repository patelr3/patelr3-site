# Cloudflare + Azure Domain Setup

Complete guide to connect a custom domain to Azure Container Apps.

## Step 1: Get the Frontend FQDN

```bash
az containerapp show --name patelr3-frontend --resource-group patelr3-site-rg \
  --query 'properties.configuration.ingress.fqdn' -o tsv
```

## Step 2: Get the Domain Verification Token

```bash
az containerapp show --name patelr3-frontend --resource-group patelr3-site-rg \
  --query 'properties.customDomainVerificationId' -o tsv
```

## Step 3: Add DNS Records in Cloudflare

Go to **Cloudflare Dashboard → your-domain.com → DNS → Records** and add:

### Verification TXT records (required by Azure)

| Type  | Name        | Content                              | Proxy     |
|-------|-------------|--------------------------------------|-----------|
| `TXT` | `asuid.www` | `<domain-verification-token>`        | DNS only  |
| `TXT` | `asuid`     | `<domain-verification-token>`        | DNS only  |

### CNAME records (route traffic to Azure)

| Type    | Name  | Target               | Proxy                          |
|---------|-------|----------------------|--------------------------------|
| `CNAME` | `www` | `<frontend-fqdn>`   | **DNS only** (grey cloud) initially |
| `CNAME` | `@`   | `<frontend-fqdn>`   | **DNS only** (grey cloud) initially |

> ⚠️ Keep proxy OFF (grey cloud) initially so Azure can verify ownership and provision certificates.

## Step 4: Bind Domains in Azure

After the DNS records propagate (~1-2 minutes), run:

```bash
# Add www.your-domain.com
az containerapp hostname add \
  --name patelr3-frontend \
  --resource-group patelr3-site-rg \
  --hostname www.your-domain.com

# Add your-domain.com (root)
az containerapp hostname add \
  --name patelr3-frontend \
  --resource-group patelr3-site-rg \
  --hostname your-domain.com

# Provision managed TLS certificates
az containerapp hostname bind \
  --name patelr3-frontend \
  --resource-group patelr3-site-rg \
  --hostname www.your-domain.com \
  --environment patelr3-cae \
  --validation-method CNAME

az containerapp hostname bind \
  --name patelr3-frontend \
  --resource-group patelr3-site-rg \
  --hostname your-domain.com \
  --environment patelr3-cae \
  --validation-method CNAME
```

## Step 5: Enable Cloudflare Proxy

After Azure certificates are provisioned (check with `az containerapp hostname list`):

1. Go back to **Cloudflare DNS** and toggle both CNAME records to **Proxied** (orange cloud)
2. Go to **SSL/TLS → Overview** and set mode to **Full (strict)**

## Step 6: Update Google OAuth Redirect URI

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Edit your OAuth 2.0 Client ID
2. Add authorized redirect URI: `https://www.your-domain.com/api/auth/callback/google`
3. Remove or keep the localhost one for local dev

## Verification

```bash
curl -s -o /dev/null -w "%{http_code}" https://www.your-domain.com/
# Should return 200
```
