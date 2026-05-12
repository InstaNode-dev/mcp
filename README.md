# @instanode/mcp

MCP server for [instanode.dev](https://instanode.dev). Lets AI coding agents
(Claude Code, Cursor, Windsurf, Continue, etc.) provision the full bundle of
ephemeral developer infrastructure over HTTPS — no Docker, no signup required
for the free anonymous tier.

One tool call per resource type, each returning a drop-in connection string:

- **Postgres** (`create_postgres`) → `postgres://...` with pgvector pre-installed
- **Redis** (`create_cache`) → `redis://...` with ACL-scoped user + namespace
- **MongoDB** (`create_nosql`) → `mongodb://...` with role scoped to the DB
- **NATS JetStream** (`create_queue`) → `nats://...` with scoped subject namespace
- **S3-compatible storage** (`create_storage`) → endpoint + keys + prefix
  (backed by DigitalOcean Spaces)
- **Webhook receiver** (`create_webhook`) → public URL that stores every
  inbound request

Every anonymous resource auto-expires in 24h. The provision response carries
a `note` and `upgrade` field — the MCP server surfaces both verbatim so the
agent can show the user the exact CTA + claim URL needed to keep the
resource permanently. Run `claim_resource` on the returned `upgrade_jwt` to
get the dashboard claim URL.

## Install

### Claude Code

```bash
claude mcp add instanode -- npx -y @instanode/mcp@latest
```

To authenticate (unlock paid-tier limits and the account-management tools):

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

| Variable                  | Required | Default                       | Purpose                                                                                                                                                                                  |
|---------------------------|----------|-------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `INSTANODE_TOKEN`         | No       | —                             | Bearer JWT minted at <https://instanode.dev/dashboard>. Required for `list_resources`, `claim_token`, `delete_resource`, and `get_api_token`. Unlocks paid-tier limits on every `create_*`. |
| `INSTANODE_API_URL`       | No       | `https://api.instanode.dev`   | Override the API base URL. Only set this for local development against a k3s cluster.                                                                                                    |
| `INSTANODE_DASHBOARD_URL` | No       | `https://instanode.dev`       | Override the dashboard host that `claim_resource` builds claim URLs against. Only set this for staging.                                                                                  |

## Tools

| Tool              | Description                                                                                                                                                       |
|-------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `create_postgres` | `POST /db/new` — Provision a Postgres database (pgvector included). Returns `connection_url` + the `note`/`upgrade` claim URL. `name` required.                   |
| `create_cache`    | `POST /cache/new` — Provision a Redis cache (ACL-scoped user + namespace). Returns `connection_url` + `note`/`upgrade`. `name` required.                          |
| `create_nosql`    | `POST /nosql/new` — Provision a MongoDB database (per-resource user + DB-scoped role). Returns `connection_url` + `note`/`upgrade`. `name` required.              |
| `create_queue`    | `POST /queue/new` — Provision a NATS JetStream queue (scoped subject namespace). Returns `connection_url` + `note`/`upgrade`. `name` required.                    |
| `create_storage`  | `POST /storage/new` — Provision an S3-compatible bucket prefix (DigitalOcean Spaces). Returns endpoint, access keys, prefix + `note`/`upgrade`. `name` required.  |
| `create_webhook`  | `POST /webhook/new` — Provision an inbound webhook receiver URL. Returns `receive_url` + `note`/`upgrade`. `name` required.                                       |
| `claim_resource`  | Helper — turn an `upgrade_jwt` from any `create_*` response into the dashboard claim URL the user should click. No API call. No auth required.                    |
| `claim_token`     | `POST /api/me/claim` — Programmatic claim: attach an anonymous resource to the authenticated account by its UUID `token`. Requires `INSTANODE_TOKEN`.             |
| `list_resources`  | `GET /api/me/resources` — List resources on the caller's account. Requires `INSTANODE_TOKEN`.                                                                     |
| `delete_resource` | `DELETE /api/me/resources/{token}` — Hard-delete a resource you own. Paid tier only. Requires `INSTANODE_TOKEN`.                                                  |
| `get_api_token`   | `GET /api/me/token` — Mint a fresh 30-day bearer JWT (for rotation). Requires an existing `INSTANODE_TOKEN`.                                                      |

### How anonymous → claimed works

Every `create_*` tool returns three fields the agent should treat as
load-bearing:

- `token` — the resource UUID (used for `claim_token` and `delete_resource`).
- `note` — a one-sentence human-readable CTA, already mentions the upgrade URL.
- `upgrade` — the full claim URL (`https://instanode.dev/start?t=<jwt>`). The
  user clicks it, signs in with GitHub/Google or a magic link, and the
  resource is attached to their account.

`upgrade_jwt` is also returned for callers that want to build their own UI
around the claim flow. The `claim_resource` tool accepts that JWT and
returns the same dashboard URL — useful if the agent wants to re-surface the
claim URL later in the conversation after the original response has scrolled
out of context.

## Example agent interactions

### 1. "I need a Postgres for this project"

> **You:** Claude, I need a Postgres database for this project.
>
> **Claude:** *calls* `create_postgres({ name: "my-side-project" })`
>
> Returns a `connection_url` like `postgres://usr_a1b2:...@pg.instanode.dev:5432/db_a1b2?sslmode=require`,
> plus `note: "Works for 24h free. Claim to keep — from $9/mo: https://instanode.dev/start?t=..."`.
>
> **Claude then:** writes `DATABASE_URL=...` to `.env`, adds `.env` to
> `.gitignore`, runs the migrations, **and shows the user the claim URL
> verbatim** so they know how to keep the database past 24h.

### 2. "Spin up a Redis cache for rate limiting"

> **You:** Add a Redis cache so I can rate-limit my API.
>
> **Claude:** *calls* `create_cache({ name: "api-ratelimit" })`
>
> Returns a `connection_url` like `redis://usr_b2c3:...@redis.instanode.dev:6379/0`.

### 3. "Set up a webhook to catch Stripe events"

> **You:** Give me a webhook URL I can point Stripe at.
>
> **Claude:** *calls* `create_webhook({ name: "stripe-sandbox" })`
>
> Returns a `receive_url` that captures every request. `curl $receive_url`
> pulls back the stored log.

### 4. "Object storage for user uploads"

> **You:** I need S3-compatible storage for uploaded avatars.
>
> **Claude:** *calls* `create_storage({ name: "user-avatars" })`
>
> Returns endpoint, access key, secret key, and prefix. Claude wires the
> AWS SDK with the returned credentials.

### 5. "Make last night's database permanent"

> **You:** I want to keep the database you made yesterday past 24h.
>
> **Claude (no INSTANODE_TOKEN):** *calls*
> `claim_resource({ upgrade_jwt: "<the upgrade_jwt from yesterday's response>" })`
> → shows you the dashboard claim URL. You click it, sign in, the resource
> is attached.
>
> **Claude (with INSTANODE_TOKEN):** *calls*
> `claim_token({ token: "a1b2c3d4-..." })` → resource is now linked to the
> authenticated account, no browser round-trip needed.

## Authentication

The anonymous tier works without any setup. To unlock paid limits, permanent
resources, and the account-management tools (`list_resources`,
`delete_resource`, `claim_token`, `get_api_token`):

1. Sign up at <https://instanode.dev> with GitHub.
2. Visit the dashboard and copy your bearer token.
3. Set it as `INSTANODE_TOKEN` in the MCP server's `env` block (see examples
   above).

Rotate any time by calling `get_api_token`, which mints a fresh 30-day JWT.

## Development

```bash
npm install
npm run build
# Integration test (optional — requires a running instanode.dev server.
# For local k8s, port-forward first: kubectl port-forward -n instant svc/instant-api 8080:8080):
INSTANODE_API_URL=http://localhost:8080 npm test
```

## License

MIT — (c) instanode.dev
