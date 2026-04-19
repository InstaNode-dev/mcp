# @instanode/mcp

MCP server for [instanode.dev](https://instanode.dev). Lets AI coding agents
(Claude Code, Cursor, Windsurf, Continue, etc.) provision ephemeral Postgres
databases and webhook receivers over HTTPS — no Docker, no signup required
for the free tier.

- One tool call → one `postgres://` URL, usable immediately as `DATABASE_URL`.
- pgvector is pre-installed on every database.
- Free tier: 10 MB / 2 conn / 24h TTL. Paid (optional): 500 MB / 5 conn /
  permanent, unlocked by setting `INSTANODE_TOKEN`.

## Install

### Claude Code

```bash
claude mcp add instanode -- npx -y @instanode/mcp@latest
```

To authenticate (unlock paid tier, `list_resources`, `delete_resource`):

```bash
claude mcp add instanode \
  --env INSTANODE_TOKEN=<paste from https://instanode.dev/dashboard> \
  -- npx -y @instanode/mcp@latest
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "instanode": {
      "command": "npx",
      "args": ["-y", "@instanode/mcp@latest"],
      "env": {
        "INSTANODE_TOKEN": "<optional — paste from dashboard for paid tier>"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "instanode": {
      "command": "npx",
      "args": ["-y", "@instanode/mcp@latest"],
      "env": {
        "INSTANODE_TOKEN": "<optional>"
      }
    }
  }
}
```

### Continue.dev

Add to your `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: instanode
    command: npx
    args: ["-y", "@instanode/mcp@latest"]
    env:
      INSTANODE_TOKEN: "<optional>"
```

For a drop-in `CLAUDE.md` / `.cursorrules` that tells the agent exactly when
to reach for this MCP, see <https://instanode.dev/agent.html>.

## Environment

| Variable            | Required | Default                        | Purpose                                                                                                     |
|---------------------|----------|--------------------------------|-------------------------------------------------------------------------------------------------------------|
| `INSTANODE_TOKEN`   | No       | —                              | Bearer JWT minted at <https://instanode.dev/dashboard>. Required for `list_resources`, `claim_token`, `delete_resource`, `get_api_token`. Unlocks paid-tier limits on `create_*`. |
| `INSTANODE_API_URL` | No       | `https://api.instanode.dev`    | Override the API base URL. Only set this for local development.                                             |

## Tools

| Tool              | Description                                                                                       |
|-------------------|---------------------------------------------------------------------------------------------------|
| `create_postgres` | Provision a Postgres database (pgvector included). Returns a `postgres://` URL. `name` required.  |
| `create_webhook`  | Provision an inbound webhook receiver URL. `name` required.                                       |
| `list_resources`  | List resources on the caller's account. Requires `INSTANODE_TOKEN`.                               |
| `claim_token`     | Attach an anonymous token to the authenticated account. Requires `INSTANODE_TOKEN`.               |
| `delete_resource` | Hard-delete a resource you own. Paid tier only. Requires `INSTANODE_TOKEN`.                       |
| `get_api_token`   | Mint a fresh 30-day bearer JWT (for rotation). Requires an existing `INSTANODE_TOKEN`.            |

## Example agent interactions

### 1. "I need a Postgres for this project"

> **You:** Claude, I need a Postgres database for this project.
>
> **Claude:** *calls* `create_postgres({ name: "my-side-project" })`
>
> Returns a `connection_url` like `postgres://usr_a1b2:...@pg.instanode.dev:5432/db_a1b2?sslmode=require`.
>
> **Claude then:** writes `DATABASE_URL=...` to `.env`, adds `.env` to
> `.gitignore`, runs your migrations.

### 2. "Set up a webhook to catch Stripe events"

> **You:** Give me a webhook URL I can point Stripe at.
>
> **Claude:** *calls* `create_webhook({ name: "stripe-sandbox" })`
>
> Returns a `receive_url` that captures every request. `curl $receive_url`
> pulls back the stored log.

### 3. "Make last night's database permanent"

> **You:** I want to keep the database you made yesterday past 24h.
>
> **Claude:** *(with `INSTANODE_TOKEN` set)* *calls*
> `claim_token({ token: "a1b2c3d4-..." })` → resource is now linked to your
> account with `tier=paid` and no expiry.

## Authentication

The free tier works without any setup. To unlock permanent resources, paid
limits, and the `list_resources` / `delete_resource` tools:

1. Sign up at <https://instanode.dev> with GitHub.
2. Visit the dashboard and copy your bearer token.
3. Set it as `INSTANODE_TOKEN` in the MCP server's `env` block (see examples
   above).

Rotate any time by calling `get_api_token`, which mints a fresh 30-day JWT.

## Development

```bash
npm install
npm run build
# Integration test (optional — requires a running instanode.dev server):
INSTANODE_API_URL=http://localhost:30080 npm test
```

## License

MIT — (c) instanode.dev
