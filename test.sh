#!/usr/bin/env bash
# Integration test for @instant/mcp
# Usage: INSTANT_API_URL=http://localhost:32108 ./test.sh
set -euo pipefail

BASE_URL="${INSTANT_API_URL:-https://instant.dev}"
MCP="node dist/index.js"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

send_recv() {
  local msgs="$1"
  printf "%s\n" "$msgs" | INSTANT_API_URL="$BASE_URL" $MCP 2>/dev/null
}

# Build first
npm run build --silent

echo "Testing @instant/mcp against $BASE_URL"
echo ""

# Test 1: initialize
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
RESP=$(printf "%s\n" "$INIT" | INSTANT_API_URL="$BASE_URL" $MCP 2>/dev/null)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read().strip())
info = d['result']['serverInfo']
assert info['name'] == 'instant.dev', f'wrong name: {info}'
" || fail "initialize failed"
pass "initialize returns correct serverInfo"

# Test 2: tools/list — expected tools present
TOOLS_LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$TOOLS_LIST" | INSTANT_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
tools = {t['name'] for t in d['result']['tools']}
expected = {'list_my_resources', 'provision_database', 'provision_cache', 'provision_document_db', 'provision_queue', 'provision_storage', 'provision_webhook', 'deploy_app', 'deploy_stack'}
missing = expected - tools
assert not missing, f'missing tools: {missing}'
" || fail "tools/list missing expected tools"
pass "tools/list returns all 9 tools"

# Test 3: list_my_resources — no key
LIST='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_my_resources","arguments":{}}}'
RESP=$(printf "%s\n%s\n" "$INIT" "$LIST" | INSTANT_API_URL="$BASE_URL" $MCP 2>/dev/null | tail -1)
echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
text = d['result']['content'][0]['text']
assert 'INSTANT_API_KEY' in text, f'unexpected: {text}'
" || fail "list_my_resources without key failed"
pass "list_my_resources returns auth instructions when no key set"

echo ""
echo "All tests passed."
