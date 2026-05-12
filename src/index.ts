#!/usr/bin/env node
/**
 * instanode-mcp — MCP server for instanode.dev
 *
 * Exposes tools to AI coding agents (Claude Code, Cursor, Windsurf, etc.):
 *
 *   create_postgres    — provision an ephemeral Postgres database (with pgvector)
 *   create_cache       — provision a Redis cache (ACL-scoped user + namespace)
 *   create_nosql       — provision a MongoDB database (per-resource user + role)
 *   create_queue       — provision a NATS JetStream queue (publish/subscribe)
 *   create_storage     — provision an S3-compatible object storage bucket prefix
 *   create_webhook     — provision an inbound webhook receiver URL
 *   create_deploy      — upload a base64 gzip tarball (Dockerfile + source) and
 *                        deploy a container; returns a public URL in ~30s
 *
 *   claim_resource     — turn an anonymous upgrade JWT into the dashboard claim URL
 *                        the agent should direct the user to (no API call — pure helper)
 *   claim_token        — programmatically attach an anonymous resource to the
 *                        authenticated caller's account
 *
 *   list_resources     — list resources on the caller's account (requires INSTANODE_TOKEN)
 *   delete_resource    — permanently delete a resource (paid tier only)
 *   get_api_token      — mint a fresh bearer token for CLI / agent usage
 *
 *   list_deployments   — list all deployments for the caller's team
 *   get_deployment     — fetch a deployment by app id (for polling build status)
 *   redeploy           — trigger a rebuild + rolling update of an existing app
 *   delete_deployment  — tear down a running deployment
 *
 * Every create_* tool surfaces the API's `note` and `upgrade` fields so the
 * agent can show the user the exact CTA + claim URL needed to keep the
 * resource past the 24h anonymous TTL.
 *
 * Environment:
 *   INSTANODE_TOKEN          Optional. Bearer JWT from https://instanode.dev/dashboard.
 *                            Required for list_resources, claim_token, delete_resource,
 *                            get_api_token. Unlocks paid-tier semantics on create_*.
 *   INSTANODE_API_URL        Optional. Defaults to https://api.instanode.dev. Override
 *                            only when pointing at a local dev cluster.
 *   INSTANODE_DASHBOARD_URL  Optional. Defaults to https://instanode.dev. Used only
 *                            by claim_resource to build the claim URL.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ApiError,
  AuthRequiredError,
  InstantClient,
  type ProvisionLimits,
  type Resource,
} from "./client.js";

const client = new InstantClient();

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const pkgVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;

const server = new McpServer({
  name: "instanode.dev",
  version: pkgVersion,
});

/** Format an error thrown by the client into a short text block for the agent. */
function formatError(err: unknown): string {
  if (err instanceof AuthRequiredError) {
    return err.message;
  }
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return (
        "Request rejected (401 unauthorized). " +
        "Mint a token at https://instanode.dev/dashboard and set INSTANODE_TOKEN in your MCP server env."
      );
    }
    if (err.status === 403 && err.code === "paid_tier_only") {
      const upgrade = err.upgradeURL ?? "https://instanode.dev/pricing.html";
      return `Free-tier resource cannot be deleted — it will auto-expire in 24h.\nUpgrade for hard-delete: ${upgrade}`;
    }
    if (err.status === 429) {
      return (
        "Rate limited (5 anonymous provisions/day per /24 subnet). " +
        "Set INSTANODE_TOKEN to a paid bearer to remove the cap."
      );
    }
    if (err.code) {
      return `instanode.dev error (${err.status} ${err.code}): ${err.message}`;
    }
    return `instanode.dev error (${err.status}): ${err.message}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `instanode.dev error: ${msg}`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function formatLimits(limits: ProvisionLimits | undefined): string[] {
  const lines: string[] = [];
  if (!limits) return lines;
  if (typeof limits.storage_mb === "number") lines.push(`Storage: ${limits.storage_mb} MB`);
  if (typeof limits.connections === "number") lines.push(`Max connections: ${limits.connections}`);
  if (typeof limits.requests_stored === "number") lines.push(`Requests stored: ${limits.requests_stored}`);
  if (typeof limits.expires_in === "string") lines.push(`Expires in: ${limits.expires_in}`);
  return lines;
}

/**
 * Render the `note` + `upgrade` fields the API returned. Every anonymous
 * provision response carries these; the agent should surface them verbatim
 * so the end user sees the exact CTA + claim URL. Structurally typed so
 * it accepts both ProvisionResultBase and DeployResult.
 */
function appendUpgradeBlock(
  lines: string[],
  result: { note?: string; upgrade?: string }
): void {
  if (result.note) lines.push(`Note: ${result.note}`);
  if (result.upgrade) {
    lines.push(``, `Claim URL (direct the user here to keep this resource past 24h):`);
    lines.push(`  ${result.upgrade}`);
  }
}

// The single-character "name" schema reused by every create_* tool.
const nameArg = {
  name: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Human-readable label for this resource (1–64 chars). Surfaced on the dashboard. Example: 'prospector-agent', 'stripe-sandbox'."
    ),
};

// ── Tool: create_postgres ─────────────────────────────────────────────────────

server.tool(
  "create_postgres",
  `Provision a fresh Postgres database on instanode.dev (POST /db/new). pgvector is pre-installed.

Returns a standard postgres:// connection URL that any driver can use directly
as DATABASE_URL — no wrapper SDK, no setup. The 'name' field is required (the
human label surfaced on the dashboard).

Without INSTANODE_TOKEN: anonymous tier — 10 MB, 2 connections, expires in 24h,
capped at 5 provisions/day per /24 subnet. The response includes a 'note' and
'upgrade' (claim) URL; surface both to the user so they know how to keep it.
With INSTANODE_TOKEN (paid): hobby/pro/team limits per the user's plan, permanent.

Store the connection_url in an env var (DATABASE_URL); do not hardcode it.`,
  nameArg,
  async ({ name }) => {
    try {
      const result = await client.createPostgres(name);
      const lines = [
        `Postgres database provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      lines.push(
        ``,
        `Use directly as DATABASE_URL (add .env to .gitignore):`,
        `  DATABASE_URL=${result.connection_url}`,
        ``,
        `pgvector is ready — no CREATE EXTENSION needed.`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: create_cache ────────────────────────────────────────────────────────

server.tool(
  "create_cache",
  `Provision a fresh Redis cache on instanode.dev (POST /cache/new).

Returns a redis:// connection URL backed by a per-resource ACL user with a
scoped key namespace — multiple tenants share the same Redis cluster safely.
Drop in as REDIS_URL with any Redis client (ioredis, node-redis, go-redis, etc.).

Without INSTANODE_TOKEN: anonymous tier — 5 MB, 24h TTL. The response carries
'note' + 'upgrade' (claim URL) — surface both verbatim.
With INSTANODE_TOKEN (paid): hobby 25 MB / pro 256 MB / team unlimited, permanent.

The 'name' field is required.`,
  nameArg,
  async ({ name }) => {
    try {
      const result = await client.createCache(name);
      const lines = [
        `Redis cache provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      lines.push(
        ``,
        `Use directly as REDIS_URL:`,
        `  REDIS_URL=${result.connection_url}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: create_nosql ────────────────────────────────────────────────────────

server.tool(
  "create_nosql",
  `Provision a fresh MongoDB database on instanode.dev (POST /nosql/new).

Returns a mongodb:// connection URL backed by a per-resource Mongo user with a
role scoped to that single database. Drop in as MONGODB_URI with the official
mongodb driver (mongoose, pymongo, etc.).

Without INSTANODE_TOKEN: anonymous tier — 5 MB, 2 connections, 24h TTL.
'note' + 'upgrade' fields in the response surface the claim URL.
With INSTANODE_TOKEN (paid): hobby 100 MB / pro 2 GB / team unlimited, permanent.

The 'name' field is required.`,
  nameArg,
  async ({ name }) => {
    try {
      const result = await client.createNoSQL(name);
      const lines = [
        `MongoDB database provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      lines.push(
        ``,
        `Use directly as MONGODB_URI:`,
        `  MONGODB_URI=${result.connection_url}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: create_queue ────────────────────────────────────────────────────────

server.tool(
  "create_queue",
  `Provision a fresh NATS JetStream queue on instanode.dev (POST /queue/new).

Returns a nats:// connection URL backed by a per-resource NATS user with a
scoped subject namespace. JetStream is enabled — use it for durable streams,
pub/sub, or work queues. Drop in as NATS_URL with the nats.js / nats.go /
nats.py client.

Without INSTANODE_TOKEN: anonymous tier — 24h TTL, basic message quotas.
With INSTANODE_TOKEN (paid): tier-scaled quotas, permanent.

The 'name' field is required.`,
  nameArg,
  async ({ name }) => {
    try {
      const result = await client.createQueue(name);
      const lines = [
        `NATS JetStream queue provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      lines.push(
        ``,
        `Use directly as NATS_URL:`,
        `  NATS_URL=${result.connection_url}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: create_storage ──────────────────────────────────────────────────────

server.tool(
  "create_storage",
  `Provision a fresh S3-compatible object storage bucket prefix on instanode.dev
(POST /storage/new). Backed by DigitalOcean Spaces with a per-resource access
key, secret key, and prefix isolation under a shared bucket.

Returns endpoint, access_key_id, secret_access_key, prefix, and a public
connection_url. Drop in to the AWS SDK (any language) by setting:
  AWS_ACCESS_KEY_ID=<access_key_id>
  AWS_SECRET_ACCESS_KEY=<secret_access_key>
  AWS_ENDPOINT_URL=<endpoint>
  AWS_REGION=us-east-1  (or whatever the endpoint requires)
and uploading under the returned prefix.

Without INSTANODE_TOKEN: anonymous tier — 24h TTL enforced by the object store
lifecycle policy (objects auto-delete). Response carries 'note' + 'upgrade'
(claim URL) — surface both verbatim so the user can keep their objects past 24h.
With INSTANODE_TOKEN (paid): tier-scaled storage limits, permanent.

The 'name' field is required.`,
  nameArg,
  async ({ name }) => {
    try {
      const result = await client.createStorage(name);
      const lines = [
        `Object storage bucket prefix provisioned.`,
        `Token:             ${result.token}`,
        `Name:              ${result.name ?? name}`,
        `Tier:              ${result.tier}`,
        `Endpoint:          ${result.endpoint}`,
        `Bucket URL:        ${result.connection_url}`,
        `Prefix:            ${result.prefix}`,
        `Access key ID:     ${result.access_key_id}`,
        `Secret access key: ${result.secret_access_key}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      lines.push(
        ``,
        `S3-compatible — use with the AWS SDK in any language:`,
        `  AWS_ACCESS_KEY_ID=${result.access_key_id}`,
        `  AWS_SECRET_ACCESS_KEY=${result.secret_access_key}`,
        `  AWS_ENDPOINT_URL=${result.endpoint}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: create_webhook ──────────────────────────────────────────────────────

server.tool(
  "create_webhook",
  `Provision an inbound webhook receiver URL on instanode.dev (POST /webhook/new).

Returns a receive_url that accepts any HTTP method from any sender and stores
each request (method, headers, body, received_at). GET the same URL to pull
back the stored log. The 'name' field is required.

Useful for: testing Stripe/GitHub/Slack webhooks locally, inspecting payloads
during development, building integrations without exposing a local port.

Without INSTANODE_TOKEN: anonymous tier — up to 100 requests stored, 24h TTL.
'note' + 'upgrade' fields in the response carry the claim URL — surface both.
With INSTANODE_TOKEN (paid): 1000+ stored per tier, permanent.`,
  nameArg,
  async ({ name }) => {
    try {
      const result = await client.createWebhook(name);
      const lines = [
        `Webhook receiver provisioned.`,
        `Token:       ${result.token}`,
        `Name:        ${result.name ?? name}`,
        `Tier:        ${result.tier}`,
        `Receive URL: ${result.receive_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      lines.push(
        ``,
        `Point any provider at the receive_url; GET it to pull stored requests:`,
        `  curl -X POST ${result.receive_url} -d '{"event":"test"}'`,
        `  curl ${result.receive_url}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: claim_resource ──────────────────────────────────────────────────────

server.tool(
  "claim_resource",
  `Turn an anonymous resource's upgrade JWT into the dashboard claim URL the
agent should direct the user to. NO API call — pure helper: builds
https://instanode.dev/start?t=<jwt> from the JWT the create_* tools return in
the 'upgrade_jwt' field.

Use this when:
  1. You just provisioned an anonymous resource via create_postgres /
     create_cache / etc.
  2. The user wants to keep it past 24h (upgrade to a paid plan, or just claim
     it on a free authenticated account so it's visible on their dashboard).
  3. You want to give them a single clickable URL rather than a long JWT string.

The MCP server cannot complete the claim for the user — it requires a browser
session for OAuth login. Show the URL and tell the user to click it.

If you (the agent) already have INSTANODE_TOKEN set, use 'claim_token' instead
to claim programmatically.`,
  {
    upgrade_jwt: z
      .string()
      .min(1)
      .describe(
        "The 'upgrade_jwt' field returned by any create_* tool (or the raw JWT from the 'upgrade' URL). Required."
      ),
  },
  async ({ upgrade_jwt }) => {
    const trimmed = upgrade_jwt.trim();
    // Accept either a raw JWT or a full https://...start?t=<jwt> URL.
    let jwt = trimmed;
    try {
      const u = new URL(trimmed);
      const t = u.searchParams.get("t");
      if (t) jwt = t;
    } catch {
      // Not a URL — assume it's a raw JWT, which is the common case.
    }
    const dashboard = client.dashboardURL();
    const claimURL = `${dashboard}/start?t=${encodeURIComponent(jwt)}`;
    const lines = [
      `Claim URL ready. Direct the user here to keep the resource past 24h:`,
      ``,
      `  ${claimURL}`,
      ``,
      `What happens when they click it:`,
      `  1. GET /start?t=<jwt> on the API redirects them to the dashboard /claim page.`,
      `  2. They sign in with GitHub or Google (or magic link).`,
      `  3. The resource is attached to their account. Free tier keeps it visible;`,
      `     paid tier (hobby/pro/team) makes it permanent and lifts anonymous limits.`,
      ``,
      `If you have INSTANODE_TOKEN set, call 'claim_token' instead to attach`,
      `the resource programmatically without a browser round-trip.`,
    ];
    return textResult(lines.join("\n"));
  }
);

// ── Tool: claim_token ─────────────────────────────────────────────────────────

server.tool(
  "claim_token",
  `Attach an anonymous resource (returned by any create_* tool) to the
authenticated caller's account programmatically (POST /api/me/claim).
Idempotent — re-claiming a token you already own returns the same payload.

For paid callers, the resource's tier is upgraded to the team's plan tier
('hobby'/'pro'/'team') and its expiry is cleared. For free authenticated
callers, the resource stays anonymous-tier but is now visible on the
dashboard.

Requires INSTANODE_TOKEN. If you don't have one (typical agent flow), use
'claim_resource' instead to get a URL the user can click in their browser.

Pass the resource's 'token' field (UUID), not the upgrade JWT.`,
  {
    token: z
      .string()
      .min(1)
      .describe(
        "Resource token (UUID) returned in the 'token' field by any create_* tool."
      ),
  },
  async ({ token }) => {
    try {
      const result = await client.claimToken(token);
      const lines = [
        `Token claimed.`,
        `Resource type: ${result.resource_type}`,
        `Token:         ${result.token}`,
        `Tier:          ${result.tier}`,
        `Status:        ${result.status}`,
      ];
      if (result.name) lines.push(`Name: ${result.name}`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: list_resources ──────────────────────────────────────────────────────

server.tool(
  "list_resources",
  `List resources on the caller's instanode.dev account, newest first
(GET /api/me/resources).

Requires INSTANODE_TOKEN to be set. Mint one at https://instanode.dev/dashboard.

Returns each resource's type (postgres/cache/nosql/queue/storage/webhook),
token, tier, status, name, and expiry.`,
  {},
  async () => {
    try {
      const items: Resource[] = await client.listResources();
      if (items.length === 0) {
        return textResult(
          "No resources on this account yet.\n\nUse create_postgres, create_cache, create_nosql, create_queue, create_storage, or create_webhook to provision one."
        );
      }
      const rows = items.map((r) => {
        const parts = [
          `[${r.resource_type}] ${r.token}`,
          `  tier:    ${r.tier}`,
          `  status:  ${r.status}`,
        ];
        if (r.name) parts.push(`  name:    ${r.name}`);
        if (r.expires_at) parts.push(`  expires: ${r.expires_at}`);
        if (r.created_at) parts.push(`  created: ${r.created_at}`);
        return parts.join("\n");
      });
      return textResult(
        [`${items.length} resource(s) on this account:`, "", ...rows].join("\n")
      );
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: delete_resource ─────────────────────────────────────────────────────

server.tool(
  "delete_resource",
  `Permanently delete one of the caller's resources
(DELETE /api/me/resources/{token}). Drops the underlying Postgres/Mongo
database, Redis ACL user, NATS user, storage prefix, or clears the webhook's
request log, then marks the row status='deleted'.

Paid tier only. Free-tier and anonymous resources auto-expire in 24h and
cannot be deleted manually — the tool will surface the upgrade URL.

Requires INSTANODE_TOKEN.`,
  {
    token: z
      .string()
      .min(1)
      .describe("Resource token (UUID) to delete."),
  },
  async ({ token }) => {
    try {
      const result = await client.deleteResource(token);
      const lines = [
        `Resource deleted.`,
        `Token:  ${result.token ?? token}`,
        `Status: ${result.status ?? "deleted"}`,
      ];
      if (result.message) lines.push(`Message: ${result.message}`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: get_api_token ───────────────────────────────────────────────────────

server.tool(
  "get_api_token",
  `Mint a fresh 30-day bearer JWT for the authenticated caller and return it
as plain text (GET /api/me/token). The user should paste the returned token
into their MCP server config as INSTANODE_TOKEN (or export it as an env var
for CLI use).

Requires an existing INSTANODE_TOKEN (or a session cookie, though session
cookies aren't available in this transport). This is primarily useful for
rotating an expiring token.`,
  {},
  async () => {
    try {
      const result = await client.getApiToken();
      const lines = [
        `New bearer token minted.`,
        `Expires in: ${result.expires_in} seconds (~${Math.round(result.expires_in / 86400)} days)`,
        ``,
        `Token:`,
        result.token,
        ``,
        `Set it in your MCP server config:`,
        `  "env": { "INSTANODE_TOKEN": "<token above>" }`,
        ``,
        `Or export it in your shell:`,
        `  export INSTANODE_TOKEN=<token above>`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: create_deploy ───────────────────────────────────────────────────────

server.tool(
  "create_deploy",
  `Create a new deploy. Optionally set \`private: true\` + \`allowed_ips: ['1.2.3.4', '10.0.0.0/8']\` to restrict access to specific IPs. Requires Pro tier or higher. Useful when an agent is asked to deploy a CRM, internal dashboard, or staging app that should only be reachable by the user.

Deploys a containerized application on instanode.dev (POST /deploy/new).

The agent base64-encodes a gzip tarball of the user's project (must contain a
Dockerfile at the root), passes it as 'tarball_base64', and the API builds +
deploys + returns a public URL in ~30s. Build is asynchronous: the initial
response carries status="building"; poll 'get_deployment' with the returned
'deploy_id' until status becomes "running" or "failed".

Tarball construction (agent side, runtime depends on language):
  tar = subprocess.check_output(["tar", "czf", "-", "-C", project_dir, "."])
  tarball_base64 = base64.b64encode(tar).decode()
Cap: 50 MB after base64 decode. Include only what 'docker build' needs;
respect .dockerignore.

Resource bindings: pass 'resource_bindings' as a map of env var name →
resource token (UUID), e.g.
  { "DATABASE_URL": "<token from create_postgres>", "REDIS_URL": "<token from create_cache>" }
The API resolves each token to its connection URL server-side and injects
the resolved URL into the container at deploy time. The MCP server does NOT
pre-resolve tokens — that would round-trip every binding through
GET /credentials and embed raw secrets in the tool params, which the agent
host may log.

Env vars: 'env_vars' takes plaintext values or vault://env/KEY refs (the
vault is per-team, per-env; rotate without redeploying). 'env_vars' and
'resource_bindings' are merged before being sent to the API; on collision,
'resource_bindings' wins.

Private deploys: set 'private: true' and pass 'allowed_ips' (IPs or CIDR
blocks) to restrict access at the Ingress. Pro tier or higher is required —
hobby tier returns 402 with an agent_action prompting the user to upgrade.

Requires INSTANODE_TOKEN (anonymous tier cannot deploy).`,
  {
    tarball_base64: z
      .string()
      .min(1)
      .describe(
        "Base64-encoded gzip tarball of the project directory (must include a Dockerfile at the root). <50 MB after decode."
      ),
    name: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Optional friendly label (1–64 chars). Defaults to a server-generated slug."),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("Container HTTP port. Default 8080."),
    env: z
      .string()
      .optional()
      .describe(
        "Deploy environment scope: 'production' (default), 'staging', or 'development'. Each scope has its own vault and env_vars."
      ),
    env_vars: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Env vars to inject into the container. Values may be plaintext or 'vault://env/KEY' refs (the API decrypts them at deploy time)."
      ),
    resource_bindings: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Map of env var name → resource token UUID (e.g. { DATABASE_URL: '<postgres token>' }). The API resolves each token to its connection URL server-side. DO NOT pass raw connection URLs here — use create_postgres/create_cache/etc. to get tokens, then bind them."
      ),
    private: z
      .boolean()
      .optional()
      .describe(
        "When true, the deploy is only reachable from IPs in 'allowed_ips'. Requires Pro tier or higher — anonymous and hobby callers get HTTP 402 with an agent_action prompting the user to upgrade. Use for CRMs, internal dashboards, staging apps."
      ),
    allowed_ips: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "IP / CIDR allowlist enforced at the Ingress when 'private' is true. Examples: ['1.2.3.4', '10.0.0.0/8', '203.0.113.42/32']. Required when private=true; ignored otherwise. If Track A's backend lands with a renamed field (e.g. 'allowed_cidrs'), this MCP tool will surface the 400 verbatim — see PR body."
      ),
  },
  async (params) => {
    try {
      const result = await client.createDeploy(params);
      const lines = [
        `Deployment accepted (build is asynchronous).`,
        `Deploy ID:      ${result.deploy_id}`,
        `Status:         ${result.status}`,
        result.url
          ? `URL:            ${result.url}`
          : `URL:            (pending — poll get_deployment until status="running")`,
        `Build logs:     ${result.build_logs_url}`,
      ];
      if (result.item.private) {
        lines.push(`Private:        true`);
        const ips = result.item.allowed_ips ?? params.allowed_ips ?? [];
        if (ips.length > 0) {
          lines.push(`Allowed IPs:    ${ips.join(", ")}`);
        }
      }
      appendUpgradeBlock(lines, result);
      lines.push(
        ``,
        `Poll for terminal status:`,
        `  get_deployment({ id: "${result.deploy_id}" })`,
        ``,
        `When status="running", the live URL is ready. Typical build time ~30s.`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: list_deployments ────────────────────────────────────────────────────

server.tool(
  "list_deployments",
  `List deployments on the caller's team (GET /api/v1/deployments).

Returns each deployment's app_id, tier, status (building/running/failed/...),
live URL, port, and the deploy env scope (production/staging/...).

Requires INSTANODE_TOKEN.`,
  {},
  async () => {
    try {
      const result = await client.listDeployments();
      if (!result.items || result.items.length === 0) {
        return textResult(
          "No deployments on this team yet.\n\nUse create_deploy to ship one — pass a base64 gzip tarball of your project (must include a Dockerfile)."
        );
      }
      const rows = result.items.map((d) => {
        const parts = [
          `[${d.app_id}] status=${d.status}`,
          `  url:    ${d.url || "(pending)"}`,
          `  tier:   ${d.tier}`,
          `  port:   ${d.port}`,
        ];
        if (d.environment) parts.push(`  env:    ${d.environment}`);
        if (d.private) {
          const ips = d.allowed_ips && d.allowed_ips.length > 0 ? ` (${d.allowed_ips.join(", ")})` : "";
          parts.push(`  private: true${ips}`);
        }
        if (d.created_at) parts.push(`  created: ${d.created_at}`);
        if (d.error) parts.push(`  error:  ${d.error}`);
        return parts.join("\n");
      });
      return textResult(
        [`${result.total} deployment(s) on this team:`, "", ...rows].join("\n")
      );
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: get_deployment ──────────────────────────────────────────────────────

server.tool(
  "get_deployment",
  `Fetch one deployment by its app id (GET /api/v1/deployments/:id).

Use this after create_deploy to poll until status="running" (typically ~30s
after the initial 202). Returns the same shape as list_deployments for a
single record.

Requires INSTANODE_TOKEN.`,
  {
    id: z
      .string()
      .min(1)
      .describe("Deployment app id (returned as 'deploy_id' by create_deploy)."),
  },
  async ({ id }) => {
    try {
      const result = await client.getDeployment(id);
      const d = result.item;
      const lines = [
        `Deployment ${d.app_id}`,
        `Status:      ${d.status}`,
        `URL:         ${d.url || "(pending)"}`,
        `Tier:        ${d.tier}`,
        `Port:        ${d.port}`,
      ];
      if (d.environment) lines.push(`Environment: ${d.environment}`);
      if (d.private) {
        lines.push(`Private:     true`);
        if (d.allowed_ips && d.allowed_ips.length > 0) {
          lines.push(`Allowed IPs: ${d.allowed_ips.join(", ")}`);
        }
      }
      if (d.error) lines.push(`Error:       ${d.error}`);
      if (d.created_at) lines.push(`Created:     ${d.created_at}`);
      if (d.updated_at) lines.push(`Updated:     ${d.updated_at}`);
      if (d.env && Object.keys(d.env).length > 0) {
        const visible = Object.keys(d.env).filter((k) => !k.startsWith("_"));
        if (visible.length > 0) {
          lines.push(``, `Env vars (${visible.length}):`);
          for (const k of visible) {
            lines.push(`  ${k}=${d.env[k]}`);
          }
        }
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: redeploy ────────────────────────────────────────────────────────────

server.tool(
  "redeploy",
  `Trigger a rebuild + rolling update of an existing deployment
(POST /deploy/:id/redeploy). Useful after updating env vars via the
dashboard, rotating a vault secret, or when the underlying image needs
a refresh. The tarball from the original deploy is reused.

Status flips back to "building"; poll get_deployment until it returns
to "running".

Requires INSTANODE_TOKEN.`,
  {
    id: z
      .string()
      .min(1)
      .describe("Deployment app id (returned as 'deploy_id' by create_deploy)."),
  },
  async ({ id }) => {
    try {
      const result = await client.redeploy(id);
      const d = result.item;
      const lines = [
        `Redeploy accepted for ${d.app_id}.`,
        `Status: ${d.status}`,
      ];
      if (d.url) lines.push(`URL:    ${d.url}`);
      lines.push(``, `Poll get_deployment({ id: "${d.app_id}" }) until status="running".`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Tool: delete_deployment ───────────────────────────────────────────────────

server.tool(
  "delete_deployment",
  `Tear down a running deployment (DELETE /deploy/:id). Stops the container,
releases compute, removes the public URL, and marks the deployment row
deleted. Irreversible.

Requires INSTANODE_TOKEN.`,
  {
    id: z
      .string()
      .min(1)
      .describe("Deployment app id (returned as 'deploy_id' by create_deploy)."),
  },
  async ({ id }) => {
    try {
      const result = await client.deleteDeployment(id);
      const lines = [
        `Deployment deleted.`,
        `ID:     ${result.id ?? id}`,
        `Token:  ${result.token ?? id}`,
        `Status: ${result.status ?? "deleted"}`,
      ];
      if (result.message) lines.push(`Message: ${result.message}`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(formatError(err));
    }
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
