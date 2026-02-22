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
  local desc="$1" url="$2" expected="$3" cookies="${4:-}"
  local status
  if [ -n "$cookies" ]; then
    status=$(curl -s -o /dev/null -w "%{http_code}" -b "$cookies" "$url")
  else
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  fi
  if [ "$status" = "$expected" ]; then pass "$desc"; else fail "$desc" "expected $expected, got $status"; fi
}

check_json() {
  local desc="$1" url="$2" field="$3" expected="$4" cookies="${5:-}"
  local val
  if [ -n "$cookies" ]; then
    val=$(curl -s -b "$cookies" "$url" | json_field "$field")
  else
    val=$(curl -s "$url" | json_field "$field")
  fi
  if [ "$val" = "$expected" ]; then pass "$desc"; else fail "$desc" "expected '$expected', got '$val'"; fi
}

echo "=== Integration Tests ==="
echo ""
COOKIE_JAR="/tmp/integration-cookies-$$"

# ── Unauthenticated access ─────────────────────────────────────
echo "Unauthenticated Access:"
check_status "frontend serves HTML" "$BASE_URL" "200"
check_json "GET /auth/me returns unauthenticated" "$BASE_URL/api/auth/me" "authenticated" "False"
check_status "GET /auth/services without auth returns 401" "$BASE_URL/api/auth/services" "401"
check_status "hello-world without auth returns 401 (nginx gate)" "$BASE_URL/api/hello/" "401"

# ── Registration & Login ───────────────────────────────────────
echo ""
echo "Registration & Login:"

REG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"inttest@test.dev","password":"IntTest123","displayName":"Int Test"}' \
  -c "$COOKIE_JAR")
if [ "$REG_STATUS" = "201" ] || [ "$REG_STATUS" = "409" ]; then
  pass "POST /auth/register (status $REG_STATUS)"
else
  fail "POST /auth/register" "expected 201 or 409, got $REG_STATUS"
fi

# Login if already registered
if [ "$REG_STATUS" = "409" ]; then
  LOGIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"email":"inttest@test.dev","password":"IntTest123"}' \
    -c "$COOKIE_JAR")
  if [ "$LOGIN_STATUS" = "200" ]; then pass "POST /auth/login fallback"; else fail "POST /auth/login" "got $LOGIN_STATUS"; fi
fi

# Verify login validation
BAD_LOGIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"inttest@test.dev","password":"wrong"}')
if [ "$BAD_LOGIN" = "401" ]; then pass "POST /auth/login rejects bad password"; else fail "bad login" "expected 401, got $BAD_LOGIN"; fi

# ── Authenticated access ───────────────────────────────────────
echo ""
echo "Authenticated Access:"
check_json "GET /auth/me returns authenticated" "$BASE_URL/api/auth/me" "authenticated" "True" "$COOKIE_JAR"
check_json "GET /auth/account returns email" "$BASE_URL/api/auth/account" "email" "inttest@test.dev" "$COOKIE_JAR"
check_status "GET /auth/services returns 200" "$BASE_URL/api/auth/services" "200" "$COOKIE_JAR"

# hello-world through nginx (now authenticated)
check_json "hello-world returns service name" "$BASE_URL/api/hello/" "service" "hello-world" "$COOKIE_JAR"
check_json "hello-world-restricted returns service" "$BASE_URL/api/hello-restricted/" "service" "hello-world-restricted" "$COOKIE_JAR"

# Health checks (services behind nginx need auth; use direct docker ports or check via auth)
check_json "hello-world /health via auth" "$BASE_URL/api/hello/health" "status" "ok" "$COOKIE_JAR"
check_json "hello-world-restricted /health via auth" "$BASE_URL/api/hello-restricted/health" "status" "ok" "$COOKIE_JAR"

# ── Logout ─────────────────────────────────────────────────────
echo ""
echo "Logout:"
curl -s -o /dev/null -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$BASE_URL/api/auth/logout" -L --max-redirs 0 2>/dev/null || true
pass "GET /auth/logout completes"
check_json "GET /auth/me after logout returns unauthenticated" "$BASE_URL/api/auth/me" "authenticated" "False" "$COOKIE_JAR"

# Cleanup
rm -f "$COOKIE_JAR"

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
