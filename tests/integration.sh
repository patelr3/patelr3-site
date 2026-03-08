#!/usr/bin/env bash
# Integration tests — run against a live docker-compose stack
# Usage: ./tests/integration.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost}"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1: $2"; }

json_field() {
  python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('$1',''))" 2>/dev/null
}

check_status() {
  local desc="$1" url="$2" expected="$3"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  if [ "$status" = "$expected" ]; then pass "$desc"; else fail "$desc" "expected $expected, got $status"; fi
}

check_json() {
  local desc="$1" url="$2" field="$3" expected="$4"
  local val
  val=$(curl -s "$url" | json_field "$field")
  if [ "$val" = "$expected" ]; then pass "$desc"; else fail "$desc" "expected '$expected', got '$val'"; fi
}

echo "=== Integration Tests ==="
echo ""

# ── Unauthenticated access ─────────────────────────────────────
echo "Unauthenticated Access:"
check_status "frontend serves HTML" "$BASE_URL" "200"
check_json "GET /auth/me returns unauthenticated" "$BASE_URL/api/auth/me" "error" "Not authenticated"
check_status "GET /auth/services without auth returns 401" "$BASE_URL/api/auth/services" "401"
check_status "hello-world without auth returns 401 (nginx gate)" "$BASE_URL/api/hello/" "401"

# ── Auth endpoints exist (Firebase tokens required for full flow) ──
echo ""
echo "Auth Endpoints (unauthenticated):"
check_status "GET /auth/me returns 401" "$BASE_URL/api/auth/me" "401"
check_status "POST /auth/services without auth returns 401" "$BASE_URL/api/auth/services" "401"

# ── MCP Server ──────────────────────────────────────────────────
echo ""
echo "MCP Server:"
check_json "MCP health check returns ok" "$BASE_URL/api/mcp/health" "status" "ok"

MCP_TOOLS=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  "$BASE_URL/api/mcp/mcp" | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read()).get('result',{}).get('tools',[])))" 2>/dev/null || echo "0")
if [ "$MCP_TOOLS" -gt "15" ]; then pass "MCP tools/list returns $MCP_TOOLS tools"; else fail "MCP tools/list" "expected >15 tools, got $MCP_TOOLS"; fi

MCP_UNAUTH=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"list_budgets","arguments":{}}}' \
  "$BASE_URL/api/mcp/mcp" | python3 -c "import sys,json; r=json.loads(sys.stdin.read()); print('auth_error' if r.get('result',{}).get('isError') and 'Authentication' in r.get('result',{}).get('content',[{}])[0].get('text','') else 'ok')" 2>/dev/null || echo "fail")
if [ "$MCP_UNAUTH" = "auth_error" ]; then pass "MCP tool call without auth returns auth error"; else fail "MCP tool call without auth" "expected auth error, got $MCP_UNAUTH"; fi

# ── OIDC Discovery ──────────────────────────────────────────────
echo ""
echo "OIDC Provider:"
check_status "OIDC discovery returns 200" "$BASE_URL/api/auth/oidc/.well-known/openid-configuration" "200"
check_status "OIDC JWKS returns 200" "$BASE_URL/api/auth/oidc/jwks" "200"

OIDC_ISSUER=$(curl -s "$BASE_URL/api/auth/oidc/.well-known/openid-configuration" | json_field "issuer")
if [ -n "$OIDC_ISSUER" ]; then pass "OIDC issuer is set ($OIDC_ISSUER)"; else fail "OIDC issuer" "empty"; fi

# ── Frontend nginx proxy (verifies proxy works without outer nginx) ──
echo ""
echo "Frontend Nginx Proxy (production-like):"
FE_SPA=$(docker compose exec -T frontend curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo "skip")
FE_AUTH=$(docker compose exec -T frontend curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/auth/me 2>/dev/null || echo "skip")
FE_HELLO=$(docker compose exec -T frontend curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/hello/ 2>/dev/null || echo "skip")
if [ "$FE_SPA" = "200" ]; then pass "frontend direct: SPA serves HTML"; else fail "frontend direct: SPA" "expected 200, got $FE_SPA"; fi
if [ "$FE_AUTH" = "401" ]; then pass "frontend direct: /api/auth/me proxied"; else fail "frontend direct: /api/auth/me" "expected 401, got $FE_AUTH"; fi
if [ "$FE_HELLO" = "401" ]; then pass "frontend direct: /api/hello/ proxied"; else fail "frontend direct: /api/hello/" "expected 401, got $FE_HELLO"; fi

# ── Summary ────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then exit 1; fi
