# Cloudflare + Azure Domain Setup

Complete guide to connect `arayosun.com` to Azure Container Apps.

## Frontend FQDN
```
patelr3-frontend.gentlebay-ad6f417d.westus2.azurecontainerapps.io
```

## Step 1: Add DNS Records in Cloudflare

Go to **Cloudflare Dashboard → arayosun.com → DNS → Records** and add all 4 records:

### Verification TXT records (required by Azure)

| Type  | Name              | Content                                                          | Proxy     |
|-------|-------------------|------------------------------------------------------------------|-----------|
| `TXT` | `asuid.www`       | `CAD5E97203EDE3062FA3D8CD8B7499EE757F66085A6FD6870E30124030627C0B` | DNS only  |
| `TXT` | `asuid`           | `CAD5E97203EDE3062FA3D8CD8B7499EE757F66085A6FD6870E30124030627C0B` | DNS only  |

### CNAME records (route traffic to Azure)

| Type    | Name  | Target                                                              | Proxy         |
|---------|-------|---------------------------------------------------------------------|---------------|
| `CNAME` | `www` | `patelr3-frontend.gentlebay-ad6f417d.westus2.azurecontainerapps.io` | **DNS only** (grey cloud) |
| `CNAME` | `@`   | `patelr3-frontend.gentlebay-ad6f417d.westus2.azurecontainerapps.io` | **DNS only** (grey cloud) |

> ⚠️ Keep proxy OFF (grey cloud) initially so Azure can verify ownership and provision certificates.

## Step 2: Bind Domains in Azure

After the DNS records propagate (~1-2 minutes), run:

```bash
# Add www.arayosun.com
az containerapp hostname add \
  --name patelr3-frontend \
  --resource-group patelr3-site-rg \
  --hostname www.arayosun.com

# Add arayosun.com (root)
az containerapp hostname add \
  --name patelr3-frontend \
  --resource-group patelr3-site-rg \
  --hostname arayosun.com

# Provision managed TLS certificates
az containerapp hostname bind \
  --name patelr3-frontend \
  --resource-group patelr3-site-rg \
  --hostname www.arayosun.com \
  --environment patelr3-cae \
  --validation-method CNAME

az containerapp hostname bind \
  --name patelr3-frontend \
  --resource-group patelr3-site-rg \
  --hostname arayosun.com \
  --environment patelr3-cae \
  --validation-method CNAME
```

## Step 3: Enable Cloudflare Proxy

After Azure certificates are provisioned (check with `az containerapp hostname list`):

1. Go back to **Cloudflare DNS** and toggle both CNAME records to **Proxied** (orange cloud)
2. Go to **SSL/TLS → Overview** and set mode to **Full (strict)**

## Step 4: Update Google OAuth Redirect URI

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Edit your OAuth 2.0 Client ID
2. Add authorized redirect URI: `https://www.arayosun.com/api/auth/callback/google`
3. Remove or keep the localhost one for local dev

## Verification

```bash
curl -s -o /dev/null -w "%{http_code}" https://www.arayosun.com/
# Should return 200

curl -s -o /dev/null -w "%{http_code}" https://arayosun.com/
# Should return 200 (or 301 redirect to www)
```
