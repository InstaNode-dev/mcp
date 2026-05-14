#!/usr/bin/env bash
# Integration test for instanode-mcp
# Usage: INSTANODE_API_URL=http://localhost:30080 ./test.sh
set -euo pipefail

BASE_URL="${INSTANODE_API_URL:-https://api.instanode.dev}"
MCP="node dist/index.js"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# Build first
npm run build --silent

echo "Testing instanode-mcp against $BASE_URL"
echo ""

# Test 1: initialize
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
RESP=$(printf "%s\n" "$INIT" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read().strip())
info = d['result']['serverInfo']
assert info['name'] == 'instanode.dev', f'wrong name: {info}'
" || fail "initialize failed"
pass "initialize returns correct serverInfo"

# Test 2: tools/list — expected tools present, dead tools absent
TOOLS_LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$TOOLS_LIST" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
tools = {t['name'] for t in d['result']['tools']}
expected = {
    'create_postgres', 'create_cache', 'create_nosql', 'create_queue',
    'create_storage', 'create_webhook',
    'create_deploy', 'list_deployments', 'get_deployment',
    'redeploy', 'delete_deployment',
    'claim_resource', 'claim_token',
    'list_resources', 'delete_resource', 'get_api_token',
}
missing = expected - tools
assert not missing, f'missing tools: {missing}'
dead = {
    'provision_cache', 'provision_queue', 'provision_storage',
    'provision_document_db', 'deploy_app', 'deploy_stack',
}
still_there = dead & tools
assert not still_there, f'dead tools still registered: {still_there}'
extra = tools - expected
assert not extra, f'unexpected tools registered: {extra}'
" || fail "tools/list missing expected tools or carrying dead ones"
pass "tools/list returns all 16 tools, no dead ones"

# Test 2b: tools/list — deploy management tools are registered and discoverable.
# Explicit assertion so the smoke test catches a regression on any single one.
RESP=$(printf "%s\n%s\n" "$INIT" "$TOOLS_LIST" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
tools = {t['name'] for t in d['result']['tools']}
for needed in ('create_deploy', 'list_deployments', 'get_deployment', 'redeploy', 'delete_deployment'):
    assert needed in tools, f'deploy tool not registered: {needed}'
" || fail "tools/list missing deploy tool(s)"
pass "tools/list includes create_deploy, list_deployments, get_deployment, redeploy, delete_deployment"

# Test 3: list_resources — no token, should surface auth-required message
LIST='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_resources","arguments":{}}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$LIST" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
text = d['result']['content'][0]['text']
assert 'INSTANODE_TOKEN' in text, f'unexpected: {text}'
" || fail "list_resources without token failed to surface auth message"
pass "list_resources without token returns auth-required message"

# Test 4: create_postgres with invalid (empty) name should be rejected by Zod
BAD_CREATE='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_postgres","arguments":{"name":""}}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$BAD_CREATE" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
# Zod failure comes back as an error, or as isError=True content
err = d.get('error') or (d.get('result') or {}).get('isError')
assert err, f'expected a validation error, got: {d}'
" || fail "create_postgres with empty name was accepted"
pass "create_postgres rejects empty name"

# Test 5: claim_resource is a pure helper — works without any API/network access.
# Accepts a raw JWT and builds the dashboard claim URL.
CLAIM='{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"claim_resource","arguments":{"upgrade_jwt":"ey.fake.jwt"}}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$CLAIM" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
text = d['result']['content'][0]['text']
assert '/start?t=ey.fake.jwt' in text, f'expected claim URL with JWT, got: {text}'
assert 'instanode' in text, f'expected dashboard host in URL, got: {text}'
" || fail "claim_resource did not build the expected claim URL"
pass "claim_resource builds dashboard claim URL from raw JWT"

# Test 5b: create_deploy without INSTANODE_TOKEN should surface the auth-required message.
# Uses a tiny fake base64 payload so we never hit the network for a real upload.
DEPLOY_NOAUTH='{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"create_deploy","arguments":{"tarball_base64":"H4sIAAAAAAAA","name":"smoke"}}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$DEPLOY_NOAUTH" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
text = d['result']['content'][0]['text']
assert 'INSTANODE_TOKEN' in text, f'expected auth-required text, got: {text}'
" || fail "create_deploy without token failed to surface auth message"
pass "create_deploy without token returns auth-required message"

# Test 6: claim_resource accepts a full /start?t= URL and re-extracts the JWT.
CLAIM_URL='{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"claim_resource","arguments":{"upgrade_jwt":"https://instanode.dev/start?t=ey.url.jwt"}}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$CLAIM_URL" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
text = d['result']['content'][0]['text']
assert '/start?t=ey.url.jwt' in text, f'expected JWT extracted from URL, got: {text}'
" || fail "claim_resource did not extract JWT from a full URL"
pass "claim_resource extracts JWT from a full /start?t= URL"

# Test 7: FIX-E #C6 — claim_resource MUST point at the API host (api.instanode.dev),
# NOT the dashboard host. /start is a route on the API. Earlier versions built
# https://instanode.dev/start?t=..., which 404'd (dashboard has no /start route;
# the dashboard's path is /claim).
CLAIM_API_HOST='{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"claim_resource","arguments":{"upgrade_jwt":"ey.host.jwt"}}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$CLAIM_API_HOST" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
text = d['result']['content'][0]['text']
# When BASE_URL is the default api.instanode.dev or a local override, the
# claim URL must originate on the API host, never the dashboard host.
assert 'api.instanode.dev/start' in text or 'localhost' in text or '127.0.0.1' in text or '://api.' in text, f'claim_resource should use API host, got: {text}'
" || fail "claim_resource still points at the wrong host (#C6)"
pass "claim_resource uses API host (api.instanode.dev) for /start"

# Test 8: FIX-E #C5 — claim_token now takes both upgrade_jwt AND email.
# Schema regression check: calling with the OLD shape (just token) should fail.
OLD_CLAIM='{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"claim_token","arguments":{"token":"00000000-0000-0000-0000-000000000000"}}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$OLD_CLAIM" | INSTANODE_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
# The old shape should be rejected (zod) or surface a missing-field error.
err = d.get('error') or (d.get('result') or {}).get('isError')
text = (d.get('result') or {}).get('content', [{}])[0].get('text', '') if d.get('result') else ''
assert err or 'email' in text.lower() or 'upgrade_jwt' in text.lower(), f'old claim_token shape should be rejected, got: {d}'
" || fail "claim_token still accepts the old single-token shape (#C5)"
pass "claim_token enforces new (upgrade_jwt, email) shape"

echo ""
echo "All tests passed."
