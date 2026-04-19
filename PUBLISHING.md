# Publishing @instanode/mcp

End-to-end checklist for pushing a new version out to every registry we
care about. Do steps in order — smithery + the MCP registry both pull
from npm, so npm must land first.

## 0. Pre-flight

From `mcp/`:

```bash
# Make sure TypeScript builds cleanly.
npm run build

# Make sure server.json still validates against the live registry schema.
mcp-publisher validate server.json

# Inspect exactly what will be published to npm.
npm pack --dry-run
```

Expected: build is silent, `server.json is valid`, and the pack dry-run lists
`dist/`, `README.md`, `LICENSE`, and `package.json` — no stray files.

Bump `version` in both `package.json` and `server.json` if this is a real
release. Commit the bump so the git tree is clean before publishing.

## 1. npm (blocking — all other registries pull from here)

You should be logged in as `instanode`:

```bash
npm whoami            # should print: instanode
npm publish --access public
```

The `--access public` flag is required for scoped packages (`@instanode/...`)
that start life private by default on npm.

Verify it landed:

```bash
npm view @instanode/mcp version
```

## 2. MCP Registry (registry.modelcontextprotocol.io)

The modern MCP registry is API-based, not a PR to
`modelcontextprotocol/servers`. You authenticate with GitHub (the
`io.github.instanode-dev/mcp` namespace in `server.json` proves
org ownership automatically) and then push.

```bash
mcp-publisher login github
# Follow the device-code prompt. Opens your browser, confirms the GitHub
# org membership, writes ~/.mcpregistry_token.

mcp-publisher publish
# Reads ./server.json, submits to the registry. Response includes the
# listing URL on modelcontextprotocol.io/registry.
```

If you need to retract or mark a version deprecated later:

```bash
mcp-publisher status --version 0.7.1 deprecated
```

## 3. smithery.ai

smithery scans the repo at `InstaNode-dev/mcp` on push; the `smithery.yaml`
at the repo root is the source of truth for install UX. There's also a
one-time connection step to claim the listing.

1. Visit https://smithery.ai/
2. Sign in with GitHub (use the `InstaNode-dev` org account).
3. Go to "New Server" → enter the GitHub URL `InstaNode-dev/mcp`.
4. smithery picks up `smithery.yaml` and publishes the listing.

After the first connection, subsequent pushes to the mcp repo trigger
automatic re-index within ~15 minutes.

## 4. mcp.so

mcp.so is a community-indexed directory; they either pick up new servers
automatically from npm + the MCP registry, or via a submission form.

- Auto-pickup path: once published on both npm and the MCP registry, the
  listing typically appears within 24 hours with no action required.
- Manual submit (faster): https://mcp.so/submit — paste the GitHub URL.

## 5. Cursor's MCP directory

Cursor indexes from the MCP registry. After step 2 lands, the server will
appear at https://cursor.com/mcp within ~24 hours. No separate action.

## Post-publish verification

```bash
# Regular user install path (what a dev finds in Claude Code docs)
npx -y @instanode/mcp@latest --version

# Registry URL (should resolve to a listing page)
open https://registry.modelcontextprotocol.io/v0/servers/io.github.instanode-dev/mcp
```

If either fails, roll forward: bump the patch version, fix the bug, re-run
from step 1. npm doesn't allow overwriting published versions.
