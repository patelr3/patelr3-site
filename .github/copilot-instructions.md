# Copilot Agent Instructions

## Documentation Maintenance

**When making changes to the codebase, always update relevant documentation:**

1. **Root README.md** — Keep the services table, project structure, and quick-start instructions current.
2. **docs/architecture.md** — Update architecture diagrams, database schema, environment variables, and CI/CD sections when adding/removing services, changing auth flows, or modifying the deployment pipeline.
3. **docs/cloudflare-setup.md** — Update if domain or DNS configuration changes.
4. **.github/copilot-instructions.md** — Update if workflows or development conventions change.

## Local-First Development Workflow

**Always validate changes locally before pushing to main.**

**Keep the local stack running.** After testing, do not run `docker compose down`. Leave the stack up so it remains available for browsing and further development. Only stop it when explicitly asked.

When making code changes to any service (frontend, auth-api, hello-world, nginx, docker-compose, etc.):

1. **Rebuild containers** — Run `docker compose build` to rebuild any changed images.
2. **Restart the stack** — Run `docker compose down && docker compose up -d` to apply changes.
3. **Wait for services** — Allow a few seconds for containers to become healthy.
4. **Test locally** — Verify the affected functionality works on `localhost`:
   - Frontend: `curl -s -o /dev/null -w '%{http_code}' http://localhost` → 200
   - Auth (unauthenticated): `curl -s -o /dev/null -w '%{http_code}' http://localhost/api/auth/me` → 401
   - Hello-world (unauthenticated): `curl -s -o /dev/null -w '%{http_code}' http://localhost/api/hello/` → 401
   - Full login flow: register → login → access protected endpoints with cookie
5. **Run unit tests** — `npm test --prefix auth-api && npm test --prefix hello-world && npm test --prefix hello-world-restricted`
6. **Fix any issues** — If local tests fail, debug and fix before proceeding.
7. **Only then push** — Once the local deployment is confirmed working, commit and push to `main`.
8. **Leave the stack running** — Do not tear down after pushing.

**Do not push to main or trigger the GitHub Action unless the local deployment works as expected.**

## Project Architecture

- **Local dev** uses Nginx as a reverse proxy (all services on `localhost:80`). The frontend container also runs its own nginx with API proxy.
- **Production (ACA)** has no separate Nginx — the frontend container's nginx serves the SPA and reverse-proxies `/api/*` requests to backend ACAs (same-origin, no CORS needed).
- `docker-compose.yml` orchestrates 6 services: nginx, frontend, auth-api, hello-world, hello-world-restricted, postgres.
- Environment variables come from `.env` (see `.env.example` for the template).
- auth-api proxies deployment requests to the finance-api in patelr3/actual-server-setup.

## Service Visibility

Services are stored in the `services` Postgres table. Admin changes to `is_visible` and `is_restricted` persist across deployments — the seed uses `ON CONFLICT DO NOTHING`. **Do not change the seed to use `ON CONFLICT DO UPDATE`** or admin changes will be overwritten.

## Key Commands

| Task | Command |
|------|---------|
| Build all images | `docker compose build` |
| Start stack | `docker compose up -d` |
| Stop stack | `docker compose down` |
| Stop + wipe DB | `docker compose down -v` |
| View logs | `docker compose logs -f <service>` |
| Rebuild one service | `docker compose build <service> && docker compose up -d <service>` |
| Unit tests | `npm test --prefix auth-api` |
| Integration tests | `bash tests/integration.sh` |
| Copilot CLI | `copilot` (authenticate with `/login` on first use) |

## Related Repos

- **[actual-server-setup](https://github.com/patelr3/actual-server-setup)** — Finance infrastructure: finance-api, per-user Actual Budget ACAs, backup workflows.
