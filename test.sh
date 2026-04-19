#!/usr/bin/env bash
# Integration test for @instanode/mcp
# Usage: INSTANODE_API_URL=http://localhost:30080 ./test.sh
set -euo pipefail

BASE_URL="${INSTANODE_API_URL:-https://api.instanode.dev}"
MCP="node dist/index.js"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# Build first
npm run build --silent

echo "Testing @instanode/mcp against $BASE_URL"
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
expected = {'create_postgres', 'create_webhook', 'list_resources', 'claim_token', 'delete_resource', 'get_api_token'}
missing = expected - tools
assert not missing, f'missing tools: {missing}'
dead = {'provision_cache', 'provision_queue', 'provision_storage', 'provision_document_db', 'deploy_app', 'deploy_stack'}
still_there = dead & tools
assert not still_there, f'dead tools still registered: {still_there}'
" || fail "tools/list missing expected tools or carrying dead ones"
pass "tools/list returns all 6 tools, no dead ones"

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

echo ""
echo "All tests passed."
