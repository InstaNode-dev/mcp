# instanode-mcp

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
- **Container deployment** (`create_deploy`) → upload a base64 gzip tarball
  (Dockerfile + source), get back a public URL in ~30s. Bind any of the
  resources above by passing their tokens as `resource_bindings` — the API
  resolves tokens to connection URLs server-side.

Every anonymous resource auto-expires in 24h. The provision response carries
a `note` and `upgrade` field — the MCP server surfaces both verbatim so the
agent can show the user the exact CTA + claim URL needed to keep the
resource permanently. Run `claim_resource` on the returned `upgrade_jwt` to
get the dashboard claim URL.

## Install

### Claude Code

```bash
claude mcp add instanode -- npx -y instanode-mcp@latest
```

To authenticate (unlock paid-tier limits and the account-management tools):

```bash
claude mcp add instanode \
  --env INSTANODE_TOKEN=<paste from https://instanode.dev/dashboard> \
  -- npx -y instanode-mcp@latest
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "instanode": {
      "command": "npx",
      "args": ["-y", "instanode-mcp@latest"],
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
      "args": ["-y", "instanode-mcp@latest"],
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
    args: ["-y", "instanode-mcp@latest"]
    env:
      INSTANODE_TOKEN: "<optional>"
```

For a drop-in `CLAUDE.md` / `.cursorrules` that tells the agent exactly when
to reach for this MCP, see <https://instanode.dev/agent.html>.

## Environment

| Variable                  | Required | Default                       | Purpose                                                                                                                                                                                  |
|---------------------------|----------|-------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `INSTANODE_TOKEN`         | No       | —                             | Bearer JWT minted at <https://instanode.dev/dashboard>. Required for `list_resources`, `claim_token`, `delete_resource`, `get_api_token`, and all deploy tools (`create_deploy`, `list_deployments`, `get_deployment`, `redeploy`, `delete_deployment`). Unlocks paid-tier limits on every `create_*`. |
| `INSTANODE_API_URL`       | No       | `https://api.instanode.dev`   | Override the API base URL. Only set this for local development against a k3s cluster.                                                                                                    |
| `INSTANODE_DASHBOARD_URL` | No       | `https://instanode.dev`       | Override the dashboard host that `claim_resource` builds claim URLs against. Only set this for staging.                                                                                  |

## Tools

| Tool              | Description                                                                                                                                                       |
|-------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `create_postgres` | `POST /db/new` — Provision a Postgres database (pgvector included). Returns `connection_url` + the `note`/`upgrade` claim URL. `name` required.                   |
| `create_vector`   | `POST /vector/new` — Provision a pgvector-enabled Postgres database (embedding store). Returns `connection_url` + `extension`/`dimensions` + `note`/`upgrade`. `name` required; optional `dimensions` is a documentation hint. |
| `create_cache`    | `POST /cache/new` — Provision a Redis cache (ACL-scoped user + namespace). Returns `connection_url` + `note`/`upgrade`. `name` required.                          |
| `create_nosql`    | `POST /nosql/new` — Provision a MongoDB database (per-resource user + DB-scoped role). Returns `connection_url` + `note`/`upgrade`. `name` required.              |
| `create_queue`    | `POST /queue/new` — Provision a NATS JetStream queue (scoped subject namespace). Returns `connection_url` + `note`/`upgrade`. `name` required.                    |
| `create_storage`  | `POST /storage/new` — Provision an S3-compatible bucket prefix (DigitalOcean Spaces). Returns endpoint, access keys, prefix + `note`/`upgrade`. `name` required.  |
| `create_webhook`  | `POST /webhook/new` — Provision an inbound webhook receiver URL. Returns `receive_url` + `note`/`upgrade`. `name` required.                                       |
| `create_deploy`   | `POST /deploy/new` — Upload a base64 gzip tarball (with Dockerfile) and deploy a container. Returns `deploy_id`, `status`, `url`, `build_logs_url`. `name` required. Requires `INSTANODE_TOKEN`. |
| `list_deployments`| `GET /api/v1/deployments` — List all deployments on the caller's team. Requires `INSTANODE_TOKEN`.                                                                |
| `get_deployment`  | `GET /api/v1/deployments/:id` — Fetch one deployment (poll until `status="running"`). Requires `INSTANODE_TOKEN`.                                                 |
| `redeploy`        | `POST /deploy/:id/redeploy` — Rebuild + rolling update an existing deployment. Requires `INSTANODE_TOKEN`.                                                        |
| `delete_deployment` | `DELETE /deploy/:id` — Tear down a running deployment. Irreversible. Requires `INSTANODE_TOKEN`.                                                                |
| `claim_resource`  | Helper — turn an `upgrade_jwt` from any `create_*` response into the dashboard claim URL the user should click. No API call. No auth required.                    |
| `claim_token`     | `POST /claim` — Programmatic claim: attach an anonymous resource to the authenticated account using its `upgrade_jwt` + `email`. No auth required.                |
| `list_resources`  | `GET /api/v1/resources` — List resources on the caller's account. Requires `INSTANODE_TOKEN`.                                                                     |
| `delete_resource` | `DELETE /api/v1/resources/{token}` — Hard-delete a resource you own. Paid tier only. Requires `INSTANODE_TOKEN`.                                                  |
| `get_api_token`   | `POST /api/v1/auth/api-keys` — Mint a fresh bearer Personal Access Token (PAT). Requires an existing user-session `INSTANODE_TOKEN` (PATs cannot mint other PATs — the API returns 403 in that case). |

### Container deployment (`create_deploy`)

Deploying is a single multipart/form-data POST with a base64-encoded gzip
tarball of the project (Dockerfile + source). The MCP tool handles the
encoding plumbing; the agent's job is just to construct the tarball.

**Building the tarball (any language):**

```python
import base64, subprocess
tar = subprocess.check_output(["tar", "czf", "-", "-C", project_dir, "."])
tarball_base64 = base64.b64encode(tar).decode()
```

```js
import { execFileSync } from "node:child_process";
const tar = execFileSync("tar", ["czf", "-", "-C", projectDir, "."]);
const tarball_base64 = tar.toString("base64");
```

Cap: 50 MB after decode. Honor `.dockerignore` — only ship what
`docker build` needs. The `name` field is required (1–64 chars,
letters/numbers/spaces/dashes) — it's the human-readable label shown
on the dashboard.

**Binding provisioned resources:**

Provision the resources first with `create_postgres` / `create_cache` / etc.
to get their tokens (UUIDs), then pass the tokens as `resource_bindings`:

```json
{
  "tarball_base64": "...",
  "name": "my-app",
  "port": 8080,
  "resource_bindings": {
    "DATABASE_URL": "<token from create_postgres>",
    "REDIS_URL":    "<token from create_cache>"
  }
}
```

The agent passes **resource tokens** (not connection URLs); the API
resolves each token to its connection URL server-side at deploy time. The
MCP server never pre-resolves tokens — pre-resolving would round-trip every
binding through `GET /credentials` and embed raw secrets into the tool
params, which the agent host may log.

**Polling:**

`create_deploy` returns `status="building"` immediately. Poll
`get_deployment({ id: deploy_id })` every few seconds until status flips to
`"running"` (typical: ~30s). At that point the `url` field is the live URL.

### Private deploys

Set `private: true` and pass `allowed_ips` to restrict access to specific IPs
or CIDR blocks at the Ingress. Useful when the agent is asked to deploy a
CRM, internal dashboard, or staging app that should only be reachable by the
user.

**Pro tier or higher required.** Hobby callers will see HTTP 402 with an
`agent_action` field — the MCP server surfaces the upgrade URL so the agent
can prompt the user to upgrade.

**Example prompt** (paste into Claude Code):

> "Deploy my CRM as a private app, only accessible from 1.2.3.4 and my office
> subnet 10.0.0.0/8"

The agent will then call:

```json
{
  "tarball_base64": "...",
  "name": "my-crm",
  "private": true,
  "allowed_ips": ["1.2.3.4", "10.0.0.0/8"]
}
```

`get_deployment` and `list_deployments` surface `private` + `allowed_ips`
back to the agent so it can confirm the policy to the user. To turn a
private deploy public, redeploy without the flags.

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

Rotate any time by calling `get_api_token`, which mints a fresh Personal Access Token via `POST /api/v1/auth/api-keys`. PATs are revocation-based (not time-bound). NOTE: PATs cannot mint other PATs — `get_api_token` requires a user-session token (sign in via the dashboard), not an existing PAT, otherwise the API returns 403.

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
