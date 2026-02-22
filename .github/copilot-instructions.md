# Copilot Agent Instructions

## Local-First Development Workflow

**Always validate changes locally before pushing to main.**

When making code changes to any service (frontend, auth-api, hello-world, nginx, docker-compose, etc.):

1. **Rebuild containers** — Run `docker compose build` to rebuild any changed images.
2. **Restart the stack** — Run `docker compose down && docker compose up -d` to apply changes.
3. **Wait for services** — Allow a few seconds for containers to become healthy.
4. **Test locally** — Verify the affected functionality works on `localhost`:
   - Frontend: `curl -s -o /dev/null -w '%{http_code}' http://localhost` → 200
   - Auth (unauthenticated): `curl -s -o /dev/null -w '%{http_code}' http://localhost/api/auth/me` → 401
   - Hello-world (unauthenticated): `curl -s -o /dev/null -w '%{http_code}' http://localhost/api/hello/` → 401
   - Full login flow: register → login → access protected endpoints with cookie
5. **Fix any issues** — If local tests fail, debug and fix before proceeding.
6. **Only then push** — Once the local deployment is confirmed working, commit and push to `main` to trigger the GitHub Actions CI/CD pipeline.

**Do not push to main or trigger the GitHub Action unless the local deployment works as expected.**

## Project Architecture

- **Local dev** uses Nginx as a reverse proxy (all services on `localhost:80`).
- **Production (ACA)** has no Nginx — services are exposed directly with CORS.
- `docker-compose.yml` orchestrates 5 services: nginx, frontend, auth-api, hello-world, postgres.
- Environment variables come from `.env` (see `.env.example` for the template).

## Key Commands

| Task | Command |
|------|---------|
| Build all images | `docker compose build` |
| Start stack | `docker compose up -d` |
| Stop stack | `docker compose down` |
| Stop + wipe DB | `docker compose down -v` |
| View logs | `docker compose logs -f <service>` |
| Rebuild one service | `docker compose build <service> && docker compose up -d <service>` |
