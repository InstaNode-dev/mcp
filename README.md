# @instant/mcp

MCP server for [instant.dev](https://instant.dev) — lets AI agents (Claude Code, etc.) provision databases, caches, queues, storage, webhooks, and deployments without any human input.

## Install

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "instant": {
      "command": "npx",
      "args": ["@instant/mcp"]
    }
  }
}
```

That's it. No account required to start.

## Tools

### `list_my_resources`

List all instant.dev resources for the authenticated team.

Requires `INSTANT_API_KEY` in the environment. Without a key, returns instructions for signing up.

### `provision_database`

Provision a PostgreSQL database (with pgvector).

### `provision_cache`

Provision a Redis cache instance.

### `provision_document_db`

Provision a MongoDB document database.

### `provision_queue`

Provision a NATS JetStream queue.

### `provision_storage`

Provision S3-compatible object storage.

### `provision_webhook`

Provision a webhook receiver URL.

### `deploy_app`

Deploy a containerized app from a directory containing a Dockerfile.

### `deploy_stack`

Deploy a multi-service stack from an `instant.yaml` manifest.

## Authentication

Set `INSTANT_API_KEY` to use authenticated features (permanent resources, `list_my_resources`):

```json
{
  "mcpServers": {
    "instant": {
      "command": "npx",
      "args": ["@instant/mcp"],
      "env": {
        "INSTANT_API_KEY": "inst_live_..."
      }
    }
  }
}
```

Without a key, anonymous provisions expire after 24h. Sign up at [instant.dev/start](https://instant.dev/start) to claim them permanently.

## Development

```bash
# Install
npm install

# Build
npm run build

# Test (requires a running instant.dev server)
INSTANT_API_URL=http://localhost:32108 bash test.sh
```
