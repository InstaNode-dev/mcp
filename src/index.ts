#!/usr/bin/env node
/**
 * instanode-mcp — MCP server for instanode.dev
 *
 * Exposes tools to AI coding agents (Claude Code, Cursor, Windsurf, etc.):
 *
 *   create_postgres    — provision an ephemeral Postgres database (with pgvector)
 *   create_vector      — provision a pgvector-enabled Postgres database (embedding store)
 *   create_cache       — provision a Redis cache (ACL-scoped user + namespace)
 *   create_nosql       — provision a MongoDB database (per-resource user + role)
 *   create_queue       — provision a NATS JetStream queue (publish/subscribe)
 *   create_storage     — provision an S3-compatible object storage bucket prefix
 *   create_webhook     — provision an inbound webhook receiver URL
 *   create_deploy      — upload a base64 gzip tarball (Dockerfile + source) and
 *                        deploy a container; returns a public URL in ~30s.
 *                        Pass `redeploy: true` with the same name to update an
 *                        existing deployment IN PLACE (same app_id + URL).
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
 *   get_deployment_events — read the failure-timeline autopsy (kind/reason/exit_code/
 *                        hint/last_lines) for a deployment so the agent can
 *                        self-correct a broken Dockerfile (auth required)
 *   redeploy           — push updated code to an existing deployment by id;
 *                        requires a fresh tarball (api never reuses the original).
 *                        Prefer `create_deploy({name, redeploy:true})` when you
 *                        have the name; use this when you only have the deploy id.
 *   delete_deployment  — tear down a running deployment
 *
 *   get_capabilities   — read the live per-tier capability matrix (storage /
 *                        connection / deployment caps per tier) so an agent can
 *                        plan a provision BEFORE a call 402s (auth optional)
 *
 *   ── operate (drive the full bundle lifecycle, not just create it) ──
 *   set_vault_key      — write a secret to the team vault (PUT .../vault/:env/:key)
 *                        so a deploy can reference it as vault://env/KEY
 *   rotate_vault_key   — rotate a vault secret's value (POST .../rotate); distinct
 *                        audit action from a plain write
 *   update_deploy_env  — merge env vars into an existing deployment
 *                        (PATCH /deploy/:id/env); redeploy to apply
 *   update_stack_env   — merge env vars into an existing stack
 *                        (PATCH /stacks/:slug/env); redeploy to apply
 *   presign_storage    — mint a short-lived (≤1h) presigned S3 URL scoped to a
 *                        storage prefix (POST /storage/:token/presign)
 *   pause_resource     — suspend a resource without deleting it (Pro+)
 *   resume_resource    — un-pause a suspended resource (Pro+)
 *   rotate_credentials — rotate a resource's password, returns the new
 *                        connection_url (POST .../rotate-credentials)
 *   wake_deployment    — explicitly wake a scaled-to-zero deployment
 *                        (POST /deploy/:id/wake; 501 when the flag is off)
 *   create_lead        — submit an enterprise contact form (POST /api/v1/leads)
 *                        when the user needs capacity beyond Pro (dedicated
 *                        infra, SSO, compliance). No auth required.
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
  type TierCapability,
  type DeploymentEvent,
} from "./client.js";
import { nameSchema, NAME_PATTERN } from "./name_schema.js";

const client = new InstantClient();

/**
 * Resolve the package.json version once at module-init. Falls back to "dev"
 * if the file isn't where we expect — same defensive pattern as the
 * User-Agent resolver in client.ts, so unit tests that import this module
 * from a non-canonical build path (e.g. `dist-test/src/index.js`, two dirs
 * removed from the package.json instead of one) don't crash before any
 * test code runs. The production binary path (`dist/index.js`) is one
 * level under the repo root, so the resolve always finds the file.
 */
function resolvePkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")).version as string) ?? "dev";
  } catch {
    return "dev";
  }
}

const pkgVersion = resolvePkgVersion();

const server = new McpServer({
  name: "instanode.dev",
  version: pkgVersion,
});

/**
 * Format an error thrown by the client into a short text block for the agent.
 *
 * FIX-E #C7: when the API returns an error envelope carrying `agent_action`,
 * surface it verbatim — it's a sentence the platform copy-edited specifically
 * for the LLM to read aloud to the user. Previously the MCP discarded
 * `agent_action` entirely and the LLM had to guess at the right action from a
 * generic "API error 402" string, which often produced wrong-by-default
 * suggestions (e.g. "try again" on a tier-gate that won't resolve without an
 * upgrade). Format:
 *
 *   {short status summary}
 *
 *   Action: {agent_action verbatim}
 *
 *   Upgrade: {upgrade_url, when present}
 *   Claim:   {claim_url, when present}
 */
export function formatError(err: unknown): string {
  if (err instanceof AuthRequiredError) {
    return err.message;
  }
  if (err instanceof ApiError) {
    // Build the headline. We keep this short — `agent_action` does the real
    // work below.
    let headline: string;
    if (err.status === 401) {
      headline =
        "Request rejected (401 unauthorized). " +
        "Mint a token at https://instanode.dev/dashboard and set INSTANODE_TOKEN in your MCP server env.";
    } else if (err.status === 403 && err.code === "paid_tier_only") {
      headline =
        "Free-tier resource cannot be deleted — it will auto-expire in 24h.";
    } else if (
      // BugBash B16 F5 (regression of task #171): the api returns
      //   403 forbidden  "PAT creation requires a user session, not another PAT"
      // (api/internal/handlers/api_keys.go Create()) when a PAT (the canonical
      // INSTANODE_TOKEN) tries to mint another PAT. The previous formatError
      // fell through to the generic "instanode.dev error (403 forbidden)"
      // path, leaving the agent guessing why rotation kept failing.
      //
      // Detect via three independent signals so a future api-side rename of
      // either the code or the message doesn't silently regress this path:
      //   (a) explicit code === pat_cannot_mint_pat (some envs / mocks use this)
      //   (b) generic code === forbidden + message names PAT/session
      //   (c) message contains the canonical sentence "PAT creation requires
      //       a user session"
      err.status === 403 &&
      (err.code === "pat_cannot_mint_pat" ||
        ((err.code === "forbidden" || !err.code) &&
          typeof err.message === "string" &&
          (/PAT creation requires a user session/i.test(err.message) ||
            (/Personal Access Token/i.test(err.message) &&
              /session/i.test(err.message)))))
    ) {
      headline =
        "Cannot mint a new API key from another API key.\n\n" +
        "The api enforces a one-step trust chain: a Personal Access Token (PAT) can only be created by a browser session JWT, not by another PAT. Your current INSTANODE_TOKEN appears to be a PAT, so this tool cannot rotate it for you.\n\n" +
        "Fix: open https://instanode.dev/dashboard/settings (or the equivalent in your env), sign in with your email/SSO (this gives the browser a session JWT), click 'Create API Key', and paste the new key into your MCP server's INSTANODE_TOKEN env var. Then revoke the old key from the same page.";
    } else if (err.status === 429) {
      headline =
        "Rate limited (5 anonymous provisions/day per /24 subnet). " +
        "Set INSTANODE_TOKEN to a paid bearer to remove the cap.";
    } else if (err.code) {
      headline = `instanode.dev error (${err.status} ${err.code}): ${err.message}`;
    } else {
      headline = `instanode.dev error (${err.status}): ${err.message}`;
    }

    const lines: string[] = [headline];
    if (err.agentAction && err.agentAction.length > 0) {
      lines.push("", `Action: ${err.agentAction}`);
    }
    // Surface retry_after_seconds when the api asks the caller to back off
    // (429 + transient-backpressure envelopes) so the agent waits the right
    // amount of time instead of hammering or guessing.
    if (typeof err.retryAfterSeconds === "number" && err.retryAfterSeconds >= 0) {
      lines.push(`Retry after: ${err.retryAfterSeconds}s`);
    }
    if (err.upgradeURL && err.upgradeURL.length > 0) {
      lines.push(`Upgrade: ${err.upgradeURL}`);
    }
    if (err.claimURL && err.claimURL.length > 0) {
      lines.push(`Claim:   ${err.claimURL}`);
    }
    // Always last: the support / log-correlation id. An agent or user can quote
    // it when reporting the failure so the operator can grep it in the api logs.
    if (err.requestId && err.requestId.length > 0) {
      lines.push(`Request ID: ${err.requestId}`);
    }
    return lines.join("\n");
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `instanode.dev error: ${msg}`;
}

/**
 * Wrap text in a CallToolResult. `isError` defaults to false (a SUCCESS result).
 * The MCP spec distinguishes a tool-execution FAILURE from a success by the
 * `isError: true` flag on the result — a host/agent reads it to know the
 * operation did not happen. Success results MUST NOT set it. Use `errorResult`
 * (below) for the failure path so the flag is applied uniformly.
 */
export function textResult(text: string, isError = false) {
  const result: { content: { type: "text"; text: string }[]; isError?: boolean } = {
    content: [{ type: "text" as const, text }],
  };
  if (isError) result.isError = true;
  return result;
}

/**
 * The shared failure-rendering path for every tool. Maps a thrown error
 * (ApiError / AuthRequiredError / plain Error) to a CallToolResult whose
 * `isError` is true, so MCP hosts and agents can distinguish a tool FAILURE
 * (the operation did not happen) from a SUCCESS.
 *
 * Per the MCP spec a tool-execution failure is reported IN the result via
 * `isError: true` — not as a protocol-level error. Every api-side failure the
 * MCP maps (402 upgrade-required, 403 permission, 404 not-found, 409 conflict,
 * 429 rate-limit, 5xx, 501) is a tool failure: the requested operation did not
 * complete. A 402/403 "upgrade/permission required" is still a failure (the
 * provision/deploy did not happen) — the agent_action text is preserved by
 * formatError so the agent still gets the path forward.
 *
 * Centralising here means all ~40 tool catch blocks get the flag uniformly via
 * `return errorResult(err)` instead of `return textResult(formatError(err))`.
 */
export function errorResult(err: unknown) {
  return textResult(formatError(err), true);
}

export function formatLimits(limits: ProvisionLimits | undefined): string[] {
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
export function appendUpgradeBlock(
  lines: string[],
  result: { note?: string; upgrade?: string }
): void {
  if (result.note) lines.push(`Note: ${result.note}`);
  if (result.upgrade) {
    lines.push(``, `Claim URL (direct the user here to keep this resource past 24h):`);
    lines.push(`  ${result.upgrade}`);
  }
}

/**
 * Surface `ignored_fields` — unknown request-body keys the api silently dropped
 * (api D7 / #283). When an agent sends a hallucinated param (e.g. `region`,
 * `size`), the api ignores it and echoes the dropped key(s) so the caller
 * learns the param had no effect and stops resending it. No-op on a clean
 * request (absent or empty array). Shared across every provision tool.
 */
export function appendIgnoredFields(
  lines: string[],
  result: { ignored_fields?: string[] }
): void {
  const ignored = result.ignored_fields;
  if (Array.isArray(ignored) && ignored.length > 0) {
    lines.push(
      ``,
      `Note: the api ignored ${ignored.length} unknown field(s) you sent: ${ignored.join(", ")}. ` +
        `They had no effect — remove them or check the tool schema for the correct param names.`
    );
  }
}

// The single "name" schema reused by every create_* tool. BugBash B16 F2
// (regression of task #173): mirrors the api's ^[A-Za-z0-9][A-Za-z0-9 _-]*$
// regex via the shared nameSchema, so bad input is rejected at the Zod
// boundary with a precise message instead of round-tripping to the api as
// a 400 invalid_name.
const nameArg = {
  name: nameSchema,
};

// Shared `env` field surfaced on every provisioning tool. CLI-MCP FINDING-8:
// before this, the MCP dropped `env` entirely on every provisioning call, so
// the api silently landed every anonymous-ish call in the "development" bucket
// (mig 026 / CLAUDE.md convention #11) — agents had no way to ask for a
// `staging` or `production` resource through MCP. Adding it here means: (a)
// the param surfaces in tools/list, so an LLM can populate it; (b) the
// client passes it through to the api; (c) the response echoes it (`env`
// field on every /<resource>/new body since mig 026) so the agent can confirm
// which bucket the resource landed in. Omitting `env` keeps the existing
// behavior (server-side default `development`).
// BUG-MCP-003/010: the API enforces `env` against ^[a-z0-9-]{1,32}$
// (see api/internal/handlers/env.go + the `invalid_env` 400 branch).
// Pre-fix the MCP schema declared `env` as a bare `z.string()`, so a
// hostile agent could send `env=HACKERLAND` or `env=<33-chars>` and the
// validation failure only surfaced from the API (extra round trip +
// confusing error path). Enforcing here matches the API regex one-shot
// and surfaces a clean zod error to the calling agent. The regex is
// kept in a single constant so the api/CLI/dashboard stay in lockstep.
const ENV_REGEX = /^[a-z0-9-]{1,32}$/;
const envSchema = z
  .string()
  .regex(
    ENV_REGEX,
    "env must match ^[a-z0-9-]{1,32}$ (lowercase letters, digits, dashes; 1-32 chars; e.g. development, staging, production)"
  )
  .optional()
  .describe(
    "Resource environment scope: 'development' (server default — see CLAUDE.md convention #11 / migration 026), 'staging', or 'production'. Format: ^[a-z0-9-]{1,32}$ — lowercase letters, digits, and dashes only. Omitting `env` lands the resource in 'development' (lowest stakes). The response echoes the resolved `env` so callers can confirm the bucket."
  );

// BUG-MCP-024/025: client-side UUID validation for resource tokens and
// deployment ids. The API itself rejects malformed tokens with a 400 +
// `invalid_token` envelope, but catching it client-side surfaces a precise
// zod error to the calling agent (no wasted round-trip, no opaque API error
// string). Accepts canonical 8-4-4-4-12 form, case-insensitive.
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// BUG-MCP-043: a deployment's public identifier (`app_id` / `token`, returned
// as `deploy_id` by create_deploy) is NOT a UUID — the api's generateAppID()
// (api/internal/handlers/deploy.go) is hex.EncodeToString of 4 random bytes =>
// exactly 8 lowercase hex chars. The openapi route params for /deploy/{id},
// /deploy/{id}/events, /deploy/{id}/wake, and /api/v1/deployments/{id} are bare
// `{type: string}`. A canonical-UUID regex therefore REJECTS every real
// deployment id client-side (zod -32602) before the request reaches the api,
// breaking the entire manage-the-deploy loop (status/events/redeploy/delete/
// env/wake) through MCP. This regex matches the real format so the validation
// error message stays precise while accepting genuine ids.
const APP_ID_REGEX = /^[0-9a-f]{8}$/;

// BUG-MCP-022: client-side IP-or-CIDR validation for the `allowed_ips` field
// on create_deploy. Accepts:
//   - IPv4 address (e.g. "203.0.113.42")
//   - IPv4 CIDR    (e.g. "10.0.0.0/8")
//   - IPv6 address (e.g. "2001:db8::1")
//   - IPv6 CIDR    (e.g. "2001:db8::/32")
// Loose-but-targeted — full RFC 5952 grammar would be heavy for a ~15-line
// gain; the API still does authoritative validation. Goal here is to catch
// obvious typos (`192.168.1`, `::/0g`) before the multipart upload.
export function isIPOrCIDR(s: string): boolean {
  if (s.length === 0 || s.length > 64) return false;
  // Split off optional CIDR mask.
  const slash = s.indexOf("/");
  const host = slash >= 0 ? s.slice(0, slash) : s;
  const maskStr = slash >= 0 ? s.slice(slash + 1) : "";
  // IPv4 host check.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    for (let i = 1; i <= 4; i++) {
      const n = Number(v4[i]);
      if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    }
    if (slash < 0) return true;
    const m = Number(maskStr);
    return Number.isInteger(m) && m >= 0 && m <= 32;
  }
  // IPv6 host check (very loose — hex groups separated by ':' with at most
  // one '::'). Forbid anything non-hex / non-':' / non-'.' (IPv4-mapped).
  if (!/^[0-9a-fA-F:.]+$/.test(host)) return false;
  if ((host.match(/::/g) ?? []).length > 1) return false;
  // Must contain at least one ':' to be considered v6.
  if (!host.includes(":")) return false;
  if (slash < 0) return true;
  const m = Number(maskStr);
  return Number.isInteger(m) && m >= 0 && m <= 128;
}

const uuidSchema = z
  .string()
  .regex(
    UUID_REGEX,
    "must be a UUID in canonical 8-4-4-4-12 form (e.g. 8b1f3c9e-...-...)"
  );

// deployIdSchema validates the 8-char hex `app_id`/`token` used to address a
// deployment (see APP_ID_REGEX above). DISTINCT from uuidSchema: resource
// tokens are real UUIDs, deployment ids are 8-hex. Used only by the six
// deployment-by-id tools (get_deployment, get_deployment_events, redeploy,
// delete_deployment, update_deploy_env, wake_deployment).
export const deployIdSchema = z
  .string()
  .regex(
    APP_ID_REGEX,
    "must be an 8-character lowercase-hex deployment id (e.g. a3f91c0e), as returned by create_deploy"
  );

// Vault env / key shapes — mirror the api's validateEnv / validateKey
// (api/internal/handlers/vault.go): env is 1-64 chars [A-Za-z0-9_-], key is
// 1-256 chars [A-Za-z0-9_.-]. These are DISTINCT from the resource `env`
// regex above (^[a-z0-9-]{1,32}$): the vault namespace permits uppercase +
// underscores so a `production` env can hold a `DATABASE_URL` key. Enforcing
// here surfaces a precise zod error instead of an api 400 round-trip, and
// keeps the regex in one constant so the api/CLI/MCP stay in lockstep.
const VAULT_ENV_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const VAULT_KEY_REGEX = /^[A-Za-z0-9_.-]{1,256}$/;
const vaultEnvSchema = z
  .string()
  .regex(
    VAULT_ENV_REGEX,
    "vault env must match ^[A-Za-z0-9_-]{1,64}$ (e.g. production, staging)"
  );
const vaultKeySchema = z
  .string()
  .regex(
    VAULT_KEY_REGEX,
    "vault key must match ^[A-Za-z0-9_.-]{1,256}$ (e.g. DATABASE_URL, STRIPE_KEY)"
  );

// Vault value cap mirrors vaultMaxValueBytes in api/internal/handlers/vault.go
// (1 MiB). Catch an oversized payload at the zod boundary rather than after a
// 413 round-trip.
const VAULT_MAX_VALUE_BYTES = 1024 * 1024;
const vaultValueSchema = z
  .string()
  .min(1, "value must not be empty")
  .max(
    VAULT_MAX_VALUE_BYTES,
    "value exceeds the 1 MiB vault cap — store large blobs in object storage and vault only a reference"
  );

const ipOrCidrSchema = z
  .string()
  .min(1)
  .refine(isIPOrCIDR, {
    message:
      "must be an IPv4/IPv6 address or CIDR (e.g. '203.0.113.42', '10.0.0.0/8', '2001:db8::/32')",
  });

const envArg = {
  env: envSchema,
};

// Convenience: every create_* tool that only needs name + optional env. Spread
// in place of `nameArg` to add the env passthrough.
const nameAndEnvArg = { ...nameArg, ...envArg };

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

Cleanup: anonymous tier auto-expires after 24h — there is no on-demand
delete_resource for anonymous tokens, by design. On a paid tier, call
delete_resource to tear down on demand.

Store the connection_url in an env var (DATABASE_URL); do not hardcode it.`,
  nameAndEnvArg,
  async ({ name, env }) => {
    try {
      const result = await client.createPostgres(name, env);
      const lines = [
        `Postgres database provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      appendIgnoredFields(lines, result);
      lines.push(
        ``,
        `Use directly as DATABASE_URL (add .env to .gitignore):`,
        `  DATABASE_URL=${result.connection_url}`,
        ``,
        `pgvector is ready — no CREATE EXTENSION needed.`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: create_vector ───────────────────────────────────────────────────────

server.tool(
  "create_vector",
  `Provision a pgvector-enabled Postgres database on instanode.dev (POST /vector/new).

Underlying storage IS Postgres (tier limits mirror Postgres exactly), with the
pgvector extension already loaded via CREATE EXTENSION vector at provisioning
time. Use for embedding stores (OpenAI text-embedding-ada-002 / 3-small = 1536
dims; text-embedding-3-large = 3072). Returns a standard postgres:// connection
URL — drop in as DATABASE_URL with any pg driver.

Note: create_postgres ALSO ships with pgvector pre-installed today, so this
tool is functionally equivalent for embedding workloads. Use create_vector when
the agent wants to make the intent (pgvector / embeddings) explicit, or when
the API contract evolves and pgvector-only routing diverges from generic
Postgres provisioning.

The optional 'dimensions' field is a documentation hint only — pgvector lets
you pick per-column dimensions at table-create time, so the server stores the
declared default but does not enforce it.

Without INSTANODE_TOKEN: anonymous tier — 10 MB, 2 connections, expires in 24h,
capped at 5 provisions/day per /24 subnet. The response carries 'note' +
'upgrade' (claim URL) — surface both verbatim.
With INSTANODE_TOKEN (paid): hobby/pro/team Postgres limits, permanent.

The 'name' field is required.`,
  {
    ...nameArg,
    ...envArg,
    dimensions: z
      .number()
      .int()
      .min(1)
      .max(16000)
      .optional()
      .describe(
        "Optional embedding dimension hint (defaults to 1536 — OpenAI text-embedding-3-small / ada-002). Use 3072 for text-embedding-3-large. Informational only; pgvector enforces dimensions per column at table-create time."
      ),
  },
  async ({ name, env, dimensions }) => {
    try {
      const result = await client.createVector(name, dimensions, env);
      const lines = [
        `pgvector Postgres database provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        `Extension:      ${result.extension ?? "pgvector"}`,
        `Dimensions:     ${result.dimensions ?? dimensions ?? 1536}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      appendIgnoredFields(lines, result);
      lines.push(
        ``,
        `Use directly as DATABASE_URL (add .env to .gitignore):`,
        `  DATABASE_URL=${result.connection_url}`,
        ``,
        `pgvector is ready — no CREATE EXTENSION needed. Pick column dimensions`,
        `at CREATE TABLE time, e.g. embedding vector(1536).`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
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
With INSTANODE_TOKEN (paid): hobby 50 MB / hobby_plus 50 MB / pro 512 MB /
growth 1024 MB / team 1536 MB (per api/plans.yaml), permanent.

Cleanup: anonymous resources auto-expire after 24h — there is no on-demand
delete for anonymous tokens, by design. On a paid tier, call
delete_resource to tear down on demand.

The 'name' field is required.`,
  nameAndEnvArg,
  async ({ name, env }) => {
    try {
      const result = await client.createCache(name, env);
      const lines = [
        `Redis cache provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      appendIgnoredFields(lines, result);
      lines.push(
        ``,
        `Use directly as REDIS_URL:`,
        `  REDIS_URL=${result.connection_url}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
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
With INSTANODE_TOKEN (paid): hobby 100 MB / hobby_plus 1 GB / pro 5 GB /
growth 20 GB / team 40 GB (per api/plans.yaml), permanent.

Cleanup: anonymous resources auto-expire after 24h — there is no on-demand
delete for anonymous tokens, by design. On a paid tier, call
delete_resource to tear down on demand.

The 'name' field is required.`,
  nameAndEnvArg,
  async ({ name, env }) => {
    try {
      const result = await client.createNoSQL(name, env);
      const lines = [
        `MongoDB database provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      appendIgnoredFields(lines, result);
      lines.push(
        ``,
        `Use directly as MONGODB_URI:`,
        `  MONGODB_URI=${result.connection_url}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
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

Cleanup: anonymous resources auto-expire after 24h — there is no on-demand
delete for anonymous tokens, by design. On a paid tier, call
delete_resource to tear down on demand.

The 'name' field is required.`,
  nameAndEnvArg,
  async ({ name, env }) => {
    try {
      const result = await client.createQueue(name, env);
      const lines = [
        `NATS JetStream queue provisioned.`,
        `Token:          ${result.token}`,
        `Name:           ${result.name ?? name}`,
        `Tier:           ${result.tier}`,
        `Connection URL: ${result.connection_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      appendIgnoredFields(lines, result);
      lines.push(
        ``,
        `Use directly as NATS_URL:`,
        `  NATS_URL=${result.connection_url}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
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

Cleanup: anonymous storage prefixes auto-expire after 24h — there is no
on-demand delete for anonymous tokens, by design. Objects under the
prefix are removed by the bucket lifecycle policy. On a paid tier, call
delete_resource to tear down on demand.

The 'name' field is required.`,
  nameAndEnvArg,
  async ({ name, env }) => {
    try {
      const result = await client.createStorage(name, env);
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
      appendIgnoredFields(lines, result);
      lines.push(
        ``,
        `S3-compatible — use with the AWS SDK in any language:`,
        `  AWS_ACCESS_KEY_ID=${result.access_key_id}`,
        `  AWS_SECRET_ACCESS_KEY=${result.secret_access_key}`,
        `  AWS_ENDPOINT_URL=${result.endpoint}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
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
With INSTANODE_TOKEN (paid): 1000+ stored per tier, permanent.

Cleanup: anonymous webhook receivers auto-expire after 24h — there is no
on-demand delete for anonymous tokens, by design. On a paid tier, call
delete_resource to tear down on demand.`,
  nameAndEnvArg,
  async ({ name, env }) => {
    try {
      const result = await client.createWebhook(name, env);
      const lines = [
        `Webhook receiver provisioned.`,
        `Token:       ${result.token}`,
        `Name:        ${result.name ?? name}`,
        `Tier:        ${result.tier}`,
        `Receive URL: ${result.receive_url}`,
        ...formatLimits(result.limits),
      ];
      appendUpgradeBlock(lines, result);
      appendIgnoredFields(lines, result);
      lines.push(
        ``,
        `Point any provider at the receive_url; GET it to pull stored requests:`,
        `  curl -X POST ${result.receive_url} -d '{"event":"test"}'`,
        `  curl ${result.receive_url}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: claim_resource ──────────────────────────────────────────────────────

server.tool(
  "claim_resource",
  `Turn an anonymous resource's upgrade JWT into the API claim URL the agent
should direct the user to. NO API call — pure helper: builds
https://api.instanode.dev/start?t=<jwt> from the JWT the create_* tools return
in the 'upgrade_jwt' field. /start issues a 302 redirect to the dashboard's
/claim page, which drives the email login.

Use this when:
  1. You just provisioned an anonymous resource via create_postgres /
     create_cache / etc.
  2. The user wants to keep it past 24h (upgrade to a paid plan, or just claim
     it on a free authenticated account so it's visible on their dashboard).
  3. You want to give them a single clickable URL rather than a long JWT string.

The MCP server cannot complete the claim for the user — it requires a browser
session for OAuth login. Show the URL and tell the user to click it.

If you (the agent) already have the user's email and the upgrade JWT, use
'claim_token' instead to claim programmatically (POST /claim).`,
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
    // /start lives on the API host (api.instanode.dev), NOT the dashboard
    // host (instanode.dev). The API issues a 302 to the dashboard's /claim
    // page — that's the indirection so the dashboard host can move without
    // breaking JWTs already-issued and pasted into chats. FIX-E #C6.
    const apiBase = client.apiBaseURL();
    const claimURL = `${apiBase}/start?t=${encodeURIComponent(jwt)}`;
    const lines = [
      `Claim URL ready. Direct the user here to keep the resource past 24h:`,
      ``,
      `  ${claimURL}`,
      ``,
      `What happens when they click it:`,
      `  1. GET /start?t=<jwt> on the API issues a 302 to the dashboard's /claim page.`,
      `  2. They sign in with GitHub or Google (or magic link).`,
      `  3. The resource is attached to their account. Free tier keeps it visible;`,
      `     paid tier (hobby/pro/team) makes it permanent and lifts anonymous limits.`,
      ``,
      `If you have the user's email handy, call 'claim_token' instead to attach`,
      `the resource programmatically without a browser round-trip.`,
    ];
    return textResult(lines.join("\n"));
  }
);

// ── Tool: claim_token ─────────────────────────────────────────────────────────

server.tool(
  "claim_token",
  `Convert an anonymous upgrade JWT into a claimed team programmatically
(POST /claim). Same flow the dashboard's /claim page drives — but lets an
agent that already knows the user's email skip the browser round-trip.

The 'upgrade_jwt' is the JWT returned in the upgrade_jwt field of any
create_* tool response (NOT the per-resource UUID token). It can also be
extracted from the 't=' query param of the upgrade URL.

On success the API creates (or attaches to) the user's team, links every
anonymous resource issued under that JWT, and returns a 24h session token.
The session token isn't returned to the agent here — use 'get_api_token'
or have the user mint one in the dashboard to authenticate future MCP calls.

If you don't have the user's email yet, use 'claim_resource' instead to get
a URL the user can click in their browser.`,
  {
    upgrade_jwt: z
      .string()
      .min(1)
      .describe(
        "The 'upgrade_jwt' field returned by any create_* tool (or the raw JWT from the 'upgrade' URL). Required."
      ),
    email: z
      .string()
      .email()
      .describe(
        "User's email address. The team will be created or matched against this email."
      ),
  },
  async ({ upgrade_jwt, email }) => {
    try {
      // Accept either a raw JWT or a full https://...start?t=<jwt> URL.
      let jwt = upgrade_jwt.trim();
      try {
        const u = new URL(jwt);
        const t = u.searchParams.get("t");
        if (t) jwt = t;
      } catch {
        // Not a URL — common case, leave jwt as-is.
      }
      const result = await client.claimToken(jwt, email);
      // Live API contract (api/openapi.snapshot.json ClaimResponse, 2026-05-20):
      // a successful claim returns {ok, team_id, user_id, session_token?,
      // message?}. The previous renderer expected the retired direct-claim
      // shape ({resource_type, token, tier, status, name}) and so showed
      // "(see list_resources)" placeholders on every line of every successful
      // claim — the agent learned NOTHING about what just happened and never
      // surfaced the session_token the api hands back for immediate use.
      const lines = [`Claim accepted for ${email}.`];
      if (result.message) lines.push(`Message: ${result.message}`);
      if (result.team_id) lines.push(`Team ID: ${result.team_id}`);
      if (result.user_id) lines.push(`User ID: ${result.user_id}`);
      if (result.session_token) {
        lines.push(
          ``,
          `Session token (24h, ready to use):`,
          `  ${result.session_token}`,
          ``,
          `Pass this as INSTANODE_TOKEN in your MCP env to call authenticated tools`,
          `(list_resources, delete_resource, get_api_token, etc.) immediately. To rotate`,
          `to a long-lived API key, sign in at https://instanode.dev/dashboard and call`,
          `get_api_token (PATs cannot mint other PATs — see get_api_token docs).`
        );
      } else {
        lines.push(
          ``,
          `Magic link sent to ${email}. The user must click the link in their inbox to`,
          `finish signing in. After that, mint an API key in the dashboard (Settings → API`,
          `Keys) and set it as INSTANODE_TOKEN to use authenticated MCP tools.`,
          ``,
          `Use list_resources (once authenticated) to confirm the resources transferred.`
        );
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: list_resources ──────────────────────────────────────────────────────

server.tool(
  "list_resources",
  `List resources on the caller's instanode.dev account, newest first
(GET /api/v1/resources).

Requires INSTANODE_TOKEN to be set. Mint one at https://instanode.dev/dashboard.

Returns each resource's type (postgres/cache/nosql/queue/storage/webhook/vector),
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
      return errorResult(err);
    }
  }
);

// ── Tool: delete_resource ─────────────────────────────────────────────────────

server.tool(
  "delete_resource",
  `Permanently delete one of the caller's resources
(DELETE /api/v1/resources/{id}, where the {id} path param is the resource
token). Drops the underlying Postgres/Mongo database, Redis ACL user, NATS
user, storage prefix, or clears the webhook's request log, then marks the
row status='deleted'.

Paid tier only (hobby/pro/team). Anonymous and free tiers cannot be
deleted manually BY DESIGN — they auto-expire 24h after creation. This is
the documented platform contract (see CLAUDE.md "anonymous = 24h TTL"):
the free surface is throwaway-by-construction, which is why there's no
auth required to provision and why deletion is a paid-tier feature. If
your agent needs on-demand teardown, claim the resources first (move
them to a paid tier), then call delete_resource.

For anonymous-tier cleanup: do nothing — the resource self-destructs at
the 24h mark. The api's worker reaper handles the underlying DB / Redis
ACL / storage prefix cleanup automatically.

Requires INSTANODE_TOKEN.`,
  {
    // BUG-MCP-024: validate the UUID shape client-side so a typo'd token
    // surfaces as a zod error rather than an API 400 round-trip.
    token: uuidSchema.describe("Resource token (UUID) to delete."),
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
      return errorResult(err);
    }
  }
);

// ── Tool: get_api_token ───────────────────────────────────────────────────────

server.tool(
  "get_api_token",
  `Mint a fresh API key for the authenticated caller and return it as plain
text (POST /api/v1/auth/api-keys). The user should paste the returned key
into their MCP server config as INSTANODE_TOKEN (or export it as an env var
for CLI use).

API keys are revocation-based (not time-bound) — they live until revoked
in the dashboard.

IMPORTANT — PATs cannot mint other PATs (BugBash B16 F5 / task #171):
The api enforces a one-step trust chain. A PAT (Personal Access Token, the
standard INSTANODE_TOKEN format) can only be created by a logged-in user
session, NOT by another PAT. So this tool will return HTTP 403 "PAT creation
requires a user session" whenever INSTANODE_TOKEN itself is a PAT (which is
the common case once the user has minted at least one).

The supported flow is therefore:
  1. Claim once via the dashboard's browser sign-in.
  2. From the dashboard's Settings → API Keys page, mint the FIRST key.
  3. Paste it into the MCP server's INSTANODE_TOKEN.
  4. Rotate by minting a NEW key in the dashboard (not via this tool) and
     revoking the old one.

This tool remains useful for the (rare) caller running with a dashboard
session token (not a PAT), and as a clear surface for the 403 above so the
agent can route the user to the dashboard instead of guessing.`,
  {
    // BugBash B16 F2 (regression of task #173): mirror the api's name regex
    // here too — the api applies the same /^[A-Za-z0-9][A-Za-z0-9 _-]*$/ on
    // POST /api/v1/auth/api-keys. Optional because this tool defaults the
    // label to "instanode-mcp" when omitted.
    name: nameSchema.optional(),
  },
  async ({ name }) => {
    try {
      const result = await client.getApiToken(name);
      const lines = [
        `New API key minted.`,
        `(Keys are revocation-based — they live until you revoke them in the dashboard.)`,
        ``,
        `Key:`,
        result.token,
        ``,
        `Set it in your MCP server config:`,
        `  "env": { "INSTANODE_TOKEN": "<key above>" }`,
        ``,
        `Or export it in your shell:`,
        `  export INSTANODE_TOKEN=<key above>`,
        ``,
        `The plaintext key is shown ONCE — save it now. To rotate later, mint a new`,
        `key here and revoke the old one at https://instanode.dev/dashboard/settings.`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: create_deploy ───────────────────────────────────────────────────────

server.tool(
  "create_deploy",
  `Create a new deploy — OR set \`redeploy: true\` to update an existing deployment with the same name (preserves app_id + URL). Optionally set \`private: true\` + \`allowed_ips: ['1.2.3.4', '10.0.0.0/8']\` to restrict access to specific IPs. Deploying requires a paid plan: Hobby tier or higher (Hobby = 1 app, Hobby Plus = 2, Pro = 10, Growth = 50, Team = 100 — per api/plans.yaml deployments_apps); anonymous and free tiers cannot deploy and get HTTP 402. The PRIVATE-deploy option (private: true + allowed_ips) additionally requires Pro tier or higher. Useful when an agent is asked to deploy a CRM, internal dashboard, or staging app that should only be reachable by the user.

Deploys a containerized application on instanode.dev (POST /deploy/new).

The agent base64-encodes a gzip tarball of the user's project (must contain a
Dockerfile at the root), passes it as 'tarball_base64', and the API builds +
deploys + returns a public URL in ~30s. Build is asynchronous: the initial
response carries status="building"; poll 'get_deployment' with the returned
'deploy_id' until status becomes "running" or "failed".

In-place update (redeploy:true): when you ship v2 of an existing app, pass
the SAME 'name' plus 'redeploy: true'. The api updates that deployment in
place — same app_id, same *.deployment.instanode.dev URL — instead of
minting a fresh one. Default behaviour (redeploy omitted or false) always
creates a new deployment and a new URL. This closes the AGENT-UX trap where
shipping v2 with the same name left two live deployments + two URLs.

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

The 'name' field is required (the human-readable label shown on the dashboard).

Private deploys: set 'private: true' AND pass 'allowed_ips' (IPs or CIDR
blocks) to restrict access at the Ingress. Pro tier or higher is required —
hobby tier returns 402 with an agent_action prompting the user to upgrade.
The two fields are coupled (T17 P2): allowed_ips without private:true is
silently dropped by the api (the deploy stays publicly reachable), and
private:true with an empty allowed_ips is a 400. The MCP client rejects
both shapes locally with a clear error before the upload.

Tarball cap: 50 MiB after base64 decode. The MCP client enforces this
client-side (T17 P2) — an oversized payload fails fast with a "shrink the
tarball" hint instead of being uploaded and rejected server-side.

Requires INSTANODE_TOKEN (anonymous tier cannot deploy).`,
  {
    // BUG-MCP-020: cap the tarball at the API's documented 50 MiB limit
    // BEFORE we POST. base64 inflates raw bytes by ~4/3 → a 50 MiB decoded
    // tarball is ~66.7 MiB encoded. Reject anything over 70 MiB encoded so
    // we surface a precise zod error instead of multiparting a payload that
    // the API will only reject after upload. minLength:1 stays for the
    // empty-string case.
    tarball_base64: z
      .string()
      .min(1)
      .max(
        70 * 1024 * 1024,
        "tarball_base64: encoded payload exceeds 70 MiB (≈50 MiB decoded). Shrink the tarball — strip .git, node_modules, build artifacts."
      )
      .describe(
        "Base64-encoded gzip tarball of the project directory (must include a Dockerfile at the root). <50 MB after decode (≈70 MiB encoded)."
      ),
    // BugBash B16 F2 (regression of task #173): same name regex as every other
    // create_* tool — mirrors the api's contract via nameSchema.
    name: nameSchema,
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("Container HTTP port. Default 8080."),
    // BUG-MCP-003/010: enforce the api regex client-side so a bad env
    // surfaces as a zod error rather than a confusing API 400 round-trip.
    env: z
      .string()
      .regex(
        ENV_REGEX,
        "env must match ^[a-z0-9-]{1,32}$ (lowercase letters, digits, dashes; 1-32 chars)"
      )
      .optional()
      .describe(
        "Deploy environment scope: 'development' (default — see CLAUDE.md convention #11 / migration 026), 'staging', or 'production'. Format: ^[a-z0-9-]{1,32}$. Omitting `env` lands the deploy in 'development' (lowest stakes), so accidental no-env deploys can't merge with prod state. Each scope has its own vault and env_vars."
      ),
    // Security hardening (audit 2026-05-29):
    //   Bound the number of env entries and the per-value byte length so a
    //   hostile agent host can't blow the 50 MiB multipart cap with a
    //   pathological env_vars / resource_bindings map. 256 keys + 8 KiB per
    //   value matches a typical k8s env-var budget; the api will still
    //   reject anything that exceeds its own envelope, but rejecting here
    //   wastes no bandwidth and surfaces a precise error to the agent.
    env_vars: z
      .record(z.string().min(1).max(256), z.string().max(8 * 1024))
      .optional()
      .refine((d) => !d || Object.keys(d).length <= 256, {
        message: "env_vars: at most 256 entries",
      })
      .describe(
        "Env vars to inject into the container. Values may be plaintext or 'vault://env/KEY' refs (the API decrypts them at deploy time). Max 256 entries, 8 KiB per value."
      ),
    resource_bindings: z
      .record(z.string().min(1).max(256), z.string().max(8 * 1024))
      .optional()
      .refine((d) => !d || Object.keys(d).length <= 256, {
        message: "resource_bindings: at most 256 entries",
      })
      .describe(
        "Map of env var name → resource token UUID (e.g. { DATABASE_URL: '<postgres token>' }). The API resolves each token to its connection URL server-side. DO NOT pass raw connection URLs here — use create_postgres/create_cache/etc. to get tokens, then bind them. Max 256 entries, 8 KiB per value."
      ),
    private: z
      .boolean()
      .optional()
      .describe(
        "When true, the deploy is only reachable from IPs in 'allowed_ips'. Requires Pro tier or higher — anonymous and hobby callers get HTTP 402 with an agent_action prompting the user to upgrade. Use for CRMs, internal dashboards, staging apps."
      ),
    // BUG-MCP-022: validate each entry is an IP or CIDR. Bound the array at
    // 256 entries — Ingress allowlist of this size is already exotic; cap is
    // here to prevent a hostile-host runaway. Authoritative check stays
    // server-side; this catches obvious typos before the round-trip.
    allowed_ips: z
      .array(ipOrCidrSchema)
      .max(256, "allowed_ips: at most 256 entries")
      .optional()
      .describe(
        "IP / CIDR allowlist enforced at the Ingress when 'private' is true. Examples: ['1.2.3.4', '10.0.0.0/8', '203.0.113.42/32']. Required when private=true; ignored otherwise. Max 256 entries; each must parse as IPv4/IPv6 address or CIDR."
      ),
    // In-place redeploy opt-in (api PR feat/deploy-new-redeploy-in-place).
    // Sent to the api as a multipart form field — when true, the api looks
    // up an existing deployment by (team_id, name) and updates it in place
    // (same app_id, same URL) instead of minting a fresh one. Default false
    // preserves the existing "always create a new deployment" behaviour.
    // Note: the api PR must be in prod before this flag does anything; on
    // an older api the field is silently ignored by Fiber's form parser
    // (caller sees legacy behaviour, no error).
    redeploy: z
      .boolean()
      .optional()
      .describe(
        "Set true to update an existing deployment with the same name (preserves app_id + URL). Default false → creates a new deployment with a fresh app_id and URL. Use redeploy:true when shipping a new version of an app you've already deployed."
      ),
  },
  // BUG-MCP-021: enforce the documented private+allowed_ips coupling
  // client-side. The API rejects (private=true, allowed_ips=[]) with a 400,
  // but doing it here makes the failure mode crisp and stops the agent from
  // shipping a payload that's structurally guaranteed to fail.
  async (params) => {
    if (params.private === true) {
      if (!params.allowed_ips || params.allowed_ips.length === 0) {
        return textResult(
          [
            `create_deploy: private=true requires a non-empty allowed_ips list.`,
            ``,
            `Pass an array of IPs/CIDRs (e.g. ['203.0.113.42/32', '10.0.0.0/8'])`,
            `or set private=false to make the deploy publicly reachable.`,
          ].join("\n")
        );
      }
    } else if (params.allowed_ips && params.allowed_ips.length > 0) {
      // The API silently drops allowed_ips when private=false; tell the
      // agent so the misconfiguration is visible.
      return textResult(
        [
          `create_deploy: allowed_ips set but private=false (or omitted).`,
          ``,
          `Set private=true to enforce the allowlist, or remove allowed_ips`,
          `to make the field's absence intentional.`,
        ].join("\n")
      );
    }
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
      return errorResult(err);
    }
  }
);

// ── Tool: create_stack ────────────────────────────────────────────────────────

server.tool(
  "create_stack",
  `Deploy a multi-service bundle from a single MCP call (POST /stacks/new).

The wedge: one tool call → a live URL on *.deployment.instanode.dev for an
\`instant.yaml\`-shaped manifest declaring 1..N services. Each service has its
own build context (tarball), Dockerfile, port, optional Ingress (\`expose: true\`),
and resource deps (\`needs: [postgres, redis]\` to auto-provision and bind, or
\`kind: postgres\` blocks inline). Cross-service references use
\`service://<name>\` in env values — these resolve to cluster-internal
\`http://<name>:<port>\` URLs at deploy time.

ANONYMOUS-FRIENDLY: no INSTANODE_TOKEN required. Anonymous stacks land at the
anonymous tier with a 6h TTL (a stack is live compute, so its window is tighter
than the 24h anonymous RESOURCE TTL), rate-limited by /24-subnet fingerprint. The
response carries the same 'note' + 'upgrade' (claim) URL as create_postgres so
the agent can prompt the user to keep the stack past 6h. With INSTANODE_TOKEN
the stack inherits the user's plan tier and is permanent.

Multipart shape (the client builds this for you):
  - \`name\` (text, required)
  - \`manifest\` (text, the YAML body)
  - One binary file part PER service declared in the manifest, named after the
    service. The MCP receives them as a \`{ <service-name>: <base64-gzip> }\`
    object — pass the same base64-encoded gzip tarball you'd pass to
    create_deploy, one per service.

Example manifest:
  services:
    app:
      build: .
      port: 8080
      expose: true
      env:
        DATABASE_URL: service://postgres
        REDIS_URL: service://redis
    postgres:
      kind: postgres
    redis:
      kind: cache

Build is asynchronous: the initial response carries status="building"; poll
'get_stack' with the returned 'stack_id' until status="healthy" (~30s typical).
Overall status is "healthy" only when every service is healthy.

Each tarball: gzip(tar(<service-build-dir>)) → base64, cap 50 MiB per service
(client-enforced). Total request body cap is 200 MB across all services (api).

Returns: stack_id, status, tier, env, per-service { name, port, expose, url,
status } (only exposed services get a public URL), expires_in (6h on anon),
plus the anonymous-tier upgrade fields.`,
  {
    name: nameSchema,
    // Security hardening (audit 2026-05-29):
    //   Bound the manifest body and the number of services in the multipart
    //   payload. A hostile agent host could otherwise stream an unbounded
    //   YAML body to the api (which then has to parse it) or declare
    //   thousands of services (each spawning a multipart part). Both lead to
    //   server-side resource burn that wastes the 200 MB total-body budget
    //   long before any tarball arrives. Cap the manifest at 256 KiB (the
    //   server's own openapi bound) and cap service_tarballs at 32 services
    //   — same ceiling the api documents for a stack. Service keys are also
    //   constrained to the resource-name contract so the multipart wire
    //   format and the manifest's `service://<name>` cross-refs cannot
    //   diverge (control-byte / CRLF in keys is already percent-encoded by
    //   undici, but a clean key contract avoids server-side surprises).
    manifest: z
      .string()
      .min(1)
      .max(256 * 1024, {
        message: "manifest must be at most 256 KiB",
      })
      .describe(
        "instant.yaml text. MUST declare a top-level `services:` map; each service entry takes build/port/expose/env/needs/kind fields. Cross-service refs use service://<name>. See the example in this tool's description. Max 256 KiB."
      ),
    service_tarballs: z
      .record(
        z
          .string()
          .min(1)
          .max(64)
          .regex(NAME_PATTERN, {
            message:
              "service name must start with a letter or digit, then letters/digits/spaces/underscores/hyphens (matches /^[A-Za-z0-9][A-Za-z0-9 _-]*$/)",
          }),
        z.string().min(1)
      )
      .refine((d) => Object.keys(d).length <= 32, {
        message: "at most 32 services per stack",
      })
      .describe(
        "Map of service-name → base64-encoded gzip tarball of that service's build context (Dockerfile + source). One entry per service declared in the manifest that has a `build:` field. Service names match ^[A-Za-z0-9][A-Za-z0-9 _-]*$ (1..64). Cap: 50 MiB per service after base64 decode; max 32 services per stack."
      ),
    // BUG-MCP-003/010: enforce the api regex client-side; same regex as
    // envSchema above. Kept inline rather than referencing envSchema so
    // the create_stack input contract is grep-visible in one block.
    env: z
      .string()
      .regex(
        ENV_REGEX,
        "env must match ^[a-z0-9-]{1,32}$ (lowercase letters, digits, dashes; 1-32 chars)"
      )
      .optional()
      .describe(
        "Resource environment scope: 'development' (server default — see CLAUDE.md convention #11 / migration 026), 'staging', or 'production'. Format: ^[a-z0-9-]{1,32}$. Omitting `env` lands the stack in 'development' (lowest stakes). The response echoes the resolved `env`."
      ),
  },
  async ({ name, manifest, service_tarballs, env }) => {
    try {
      const result = await client.createStack({
        name,
        manifest,
        service_tarballs,
        env,
      });
      const lines = [
        `Stack accepted (build is asynchronous).`,
        `Stack ID:   ${result.stack_id}`,
        `Status:     ${result.status}`,
        `Tier:       ${result.tier}`,
      ];
      if (result.env) lines.push(`Environment: ${result.env}`);
      if (result.name) lines.push(`Name:       ${result.name}`);
      if (result.expires_in) lines.push(`Expires in: ${result.expires_in}`);
      if (Array.isArray(result.services) && result.services.length > 0) {
        lines.push(``, `Services (${result.services.length}):`);
        for (const svc of result.services) {
          const urlPart = svc.url
            ? ` → ${svc.url}`
            : svc.expose
              ? ` → (URL pending — poll get_stack)`
              : ` (cluster-internal http://${svc.name}:${svc.port})`;
          lines.push(`  [${svc.status}] ${svc.name} :${svc.port}${urlPart}`);
        }
      }
      appendUpgradeBlock(lines, result);
      lines.push(
        ``,
        `Poll for terminal status:`,
        `  get_stack({ stack_id: "${result.stack_id}" })`,
        ``,
        `Stack is "healthy" only when every service is healthy. Typical ~30s.`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: get_stack ───────────────────────────────────────────────────────────

server.tool(
  "get_stack",
  `Fetch a stack by id (GET /stacks/{stack_id}). Use this after create_stack to
poll until every service is "healthy" (~30s typical).

Anonymous-friendly: the public /stacks/{slug} route mirrors the StackResponse
shape returned by POST /stacks/new (services array, expires_in, etc.) and
does not require INSTANODE_TOKEN — anonymous callers can poll their own
stacks. The dashboard-only GET /api/v1/stacks/{slug} returns a flatter
summary and requires auth; this tool uses the public route.

Returns the same shape as create_stack: stack_id, status, tier, env,
per-service { name, port, expose, url, status }, expires_in.`,
  {
    stack_id: z
      .string()
      .min(1)
      .describe("Stack id (returned as 'stack_id' by create_stack). Format: stk-<8-char-hex>."),
  },
  async ({ stack_id }) => {
    try {
      const result = await client.getStack(stack_id);
      const lines = [
        `Stack ${result.stack_id ?? stack_id}`,
        `Status:     ${result.status ?? "(unknown)"}`,
        `Tier:       ${result.tier ?? "(unknown)"}`,
      ];
      if (result.env) lines.push(`Environment: ${result.env}`);
      if (result.name) lines.push(`Name:       ${result.name}`);
      if (result.expires_in) lines.push(`Expires in: ${result.expires_in}`);
      if (Array.isArray(result.services) && result.services.length > 0) {
        lines.push(``, `Services (${result.services.length}):`);
        for (const svc of result.services) {
          const urlPart = svc.url
            ? ` → ${svc.url}`
            : svc.expose
              ? ` → (URL pending)`
              : ` (cluster-internal http://${svc.name}:${svc.port})`;
          lines.push(`  [${svc.status}] ${svc.name} :${svc.port}${urlPart}`);
        }
      }
      appendUpgradeBlock(lines, result);
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
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
      // BugBash B16 F1 (regression of task #170): defensive — if the api ever
      // hands back an empty 2xx body, the empty-body sentinel coerces it to
      // {ok: true} with no `items` field. Treat that the same as no
      // deployments rather than dereferencing undefined.
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
      return errorResult(err);
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
    // BUG-MCP-043: app_id is 8-char hex, not a UUID. Validate client-side.
    id: deployIdSchema.describe("Deployment app id (returned as 'deploy_id' by create_deploy)."),
  },
  async ({ id }) => {
    try {
      const result = await client.getDeployment(id);
      // BugBash B16 F1 (regression of task #170): if the api ever returns an
      // empty 2xx, the sentinel coerces to {ok: true} with no `item` field.
      // Surface that explicitly rather than crashing on `result.item.app_id`.
      const d = result.item;
      if (!d) {
        return textResult(
          `Deployment ${id}: server returned 2xx with no body. Re-poll get_deployment to fetch the current state.`
        );
      }
      const lines = [
        `Deployment ${d.app_id ?? id}`,
        `Status:      ${d.status ?? "(unknown)"}`,
        `URL:         ${d.url || "(pending)"}`,
        `Tier:        ${d.tier ?? "(unknown)"}`,
        `Port:        ${d.port ?? "(unknown)"}`,
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
      return errorResult(err);
    }
  }
);

// ── Tool: get_deployment_events ───────────────────────────────────────────────

server.tool(
  "get_deployment_events",
  `Read the failure-timeline autopsy for a deployment (GET /api/v1/deployments/:id/events).

This is the rule-27 self-correction surface: when a deploy is stuck in
"building" or flips to "failed", get_deployment only shows the LATEST error
string — this tool returns the full chronological autopsy the platform's
worker captured (Kaniko build failures, k8s pod events, OOM kills, image-pull
errors). Each event carries:
  - kind       (e.g. "failure_autopsy")
  - reason     (e.g. "BackoffLimitExceeded", "OOMKilled", "ImagePullBackOff")
  - exit_code  (process exit code, or null when not an exit)
  - event      (k8s event type, when captured)
  - last_lines (the tail of the build/pod log — usually the actual error)
  - hint       (a remediation suggestion you can act on)
  - created_at (RFC3339 UTC)

Events are newest-first, so events[0] is the most recent failure. Use this to
fix a broken Dockerfile or misconfigured port without guessing: read the hint
and last_lines, patch the project, then redeploy.

If the deploy succeeded there may be no events (empty list) — that's normal.

Requires INSTANODE_TOKEN. A deployment id that isn't on your team returns a
clean "not found" (the api never confirms other teams' deployments).`,
  {
    // BUG-MCP-043: app_id is 8-char hex, not a UUID. Mirrors get_deployment.
    id: deployIdSchema.describe(
      "Deployment app id (returned as 'deploy_id' by create_deploy / 'app_id' by get_deployment)."
    ),
    // Optional cap on rows returned. api default is 50, clamped server-side.
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max number of events to return (newest first). Optional — the api defaults to 50 and clamps to its own maximum. Omit to use the default."
      ),
  },
  async ({ id, limit }) => {
    try {
      const result = await client.getDeploymentEvents(id, limit);
      if (!result.events || result.events.length === 0) {
        return textResult(
          `No events recorded for deployment ${id}.\n\n` +
            `This is normal for a deployment that built and is running cleanly — ` +
            `the failure-timeline only records build/runtime failures. If the ` +
            `deploy is stuck in "building", re-poll get_deployment and try ` +
            `get_deployment_events again in a few seconds; the worker writes the ` +
            `autopsy asynchronously once the failure is detected.`
        );
      }
      const lines: string[] = [
        `${result.count} event(s) for deployment ${id} (newest first):`,
        "",
      ];
      result.events.forEach((ev: DeploymentEvent, i: number) => {
        lines.push(`[${i + 1}] ${ev.kind}${ev.reason ? ` — ${ev.reason}` : ""}`);
        if (ev.created_at) lines.push(`    when:       ${ev.created_at}`);
        if (ev.event) lines.push(`    k8s event:  ${ev.event}`);
        if (typeof ev.exit_code === "number") {
          lines.push(`    exit code:  ${ev.exit_code}`);
        }
        if (ev.hint) lines.push(`    hint:       ${ev.hint}`);
        if (ev.last_lines) {
          // Render the log tail under its own indented heading so a multi-line
          // blob stays visually grouped with its event.
          lines.push(`    last lines:`);
          for (const ll of ev.last_lines.split("\n")) {
            lines.push(`      ${ll}`);
          }
        }
        lines.push("");
      });
      lines.push(
        `Act on the most recent event's hint + last_lines: patch your project, ` +
          `then redeploy (create_deploy({ name, redeploy: true }) or redeploy({ id })).`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: redeploy ────────────────────────────────────────────────────────────

server.tool(
  "redeploy",
  `Push updated code to an existing deployment by app id. Same URL, new build
(POST /deploy/:id/redeploy).

Use this when you already know the deploy_id and want to ship a code change
without touching the URL or app_id. For the more common "I have the name, I
want to update the app I just shipped" path, prefer
create_deploy({ name, tarball_base64, redeploy: true }) — that resolves the
deployment by name and is the AGENT-UX-recommended path.

The api REQUIRES a fresh tarball — there is no server-side tarball reuse
(the earlier tool description claiming reuse was wrong and caused every
real call to fail with 400 missing_tarball). Pass a base64-encoded gzip
tar of the project (Dockerfile + source), same shape as create_deploy.

Status flips back to "building"; poll get_deployment until it returns
to "running" (~30s typical).

Requires INSTANODE_TOKEN.`,
  {
    // BUG-MCP-043: app_id is 8-char hex, not a UUID. Validate client-side.
    id: deployIdSchema.describe("Deployment app id (returned as 'deploy_id' by create_deploy)."),
    // T-redeploy-fix: tarball is required. The api handler at
    // deploy.go:1245 returns 400 missing_tarball without it; the previous
    // tool schema omitted this field and the description lied about
    // tarball reuse, making every real call 400.
    tarball_base64: z
      .string()
      .min(1)
      .max(
        70 * 1024 * 1024,
        "tarball_base64: encoded payload exceeds 70 MiB (≈50 MiB decoded). Shrink the tarball — strip .git, node_modules, build artifacts."
      )
      .describe(
        "Base64-encoded gzip tarball of the project directory (must include a Dockerfile at the root). <50 MB after decode (≈70 MiB encoded). Same shape as create_deploy.tarball_base64."
      ),
  },
  async ({ id, tarball_base64 }) => {
    try {
      // BugBash B16 F1 (regression of task #170): /deploy/:id/redeploy returns
      // a bare 202 with no body — the previous handler dereferenced
      // result.item.app_id and crashed with "Cannot read properties of
      // undefined (reading 'app_id')". client.redeploy() now resolves to
      // {ok, id, status, message} with safe fallbacks so the handler stays
      // alive even when the body is empty.
      const result = await client.redeploy(id, tarball_base64);
      const appId = result.id ?? id;
      const lines = [
        `Redeploy accepted for ${appId}.`,
        `Status: ${result.status ?? "building"}`,
      ];
      if (result.message) lines.push(`Message: ${result.message}`);
      lines.push(``, `Poll get_deployment({ id: "${appId}" }) until status="running".`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
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
    // BUG-MCP-043: app_id is 8-char hex, not a UUID. Validate client-side.
    id: deployIdSchema.describe("Deployment app id (returned as 'deploy_id' by create_deploy)."),
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
      return errorResult(err);
    }
  }
);

// ── Tool: get_capabilities ────────────────────────────────────────────────────

server.tool(
  "get_capabilities",
  `Read the live per-tier capability matrix (GET /api/v1/capabilities).

Use this BEFORE a provision/deploy call to plan around tier limits instead of
provisioning-to-discover them and eating a 402 mid-flow. The api iterates its
live plans registry, so the response is always current — tiers today are
anonymous and free (both no-cost, 24h-TTL), then the paid tiers hobby ($9/mo),
hobby_plus ($19/mo), pro ($49/mo), growth ($99/mo) and team ($199/mo). The
exact numbers come from the api, not this description, so they never drift.

Per tier you get:
  - storage_limit_mb     — per-service storage cap (postgres/redis/mongodb/
                           queue/storage/webhook/vector); -1 = unlimited
  - connections_limit    — per-service max connections; -1 = unlimited
  - resource_count_limit — per-service max number of active resources; -1 = unlimited
  - deployments_apps     — max concurrent deployed apps; -1 = unlimited
  - price_usd_monthly, paid_from_day_one, annual_discount_percent
  - backup_retention_days / backup_restore_enabled / manual_backups_per_day
  - rpo_minutes / rto_minutes (durability promise; 0 = not promised)
  - upgrade_url (null on the terminal Team tier) + is_terminal_tier

Tiers are returned in upgrade order (cheapest first). NO INSTANODE_TOKEN
required — this is a public discovery surface so a cold-start agent can plan
its first call. The response is the same for every caller.`,
  {},
  async () => {
    try {
      const result = await client.getCapabilities();
      if (!result.tiers || result.tiers.length === 0) {
        return textResult(
          "The capability matrix is currently empty (the api returned no tiers). " +
            "Retry shortly; if it persists the api's plans registry may be unloaded."
        );
      }
      const lines: string[] = [
        `${result.tiers.length} tier(s) (cheapest first):`,
        "",
      ];
      const fmt = (n: number): string => (n < 0 ? "unlimited" : String(n));
      for (const t of result.tiers as TierCapability[]) {
        const price =
          t.price_usd_monthly > 0 ? `$${t.price_usd_monthly}/mo` : "free";
        const terminal = t.is_terminal_tier ? " (top tier)" : "";
        lines.push(`${t.display_name ?? t.tier} [${t.tier}] — ${price}${terminal}`);
        // Render the per-service storage + connection caps compactly.
        const storage = t.storage_limit_mb ?? {};
        const conns = t.connections_limit ?? {};
        const services = Object.keys(storage);
        if (services.length > 0) {
          for (const svc of services) {
            const s = fmt(storage[svc]);
            const c = conns[svc] !== undefined ? `, ${fmt(conns[svc])} conn` : "";
            lines.push(`    ${svc}: ${s === "unlimited" ? "unlimited" : `${s} MB`}${c}`);
          }
        }
        lines.push(`    deployments: ${fmt(t.deployments_apps)}`);
        // resource_count_limit — per-service cap on the NUMBER of active
        // resources (distinct from storage/connection caps). The tool
        // description promises this; render the per-service counts compactly
        // (e.g. "postgres 5, redis 3"). -1 = unlimited.
        const counts = t.resource_count_limit ?? {};
        const countSvcs = Object.keys(counts);
        if (countSvcs.length > 0) {
          const pairs = countSvcs.map((svc) => `${svc} ${fmt(counts[svc])}`);
          lines.push(`    resource count: ${pairs.join(", ")}`);
        }
        // backup + RPO/RTO durability promise — the description advertises
        // "backup + RPO/RTO promises". Show backup retention + manual-backup
        // quota when restore is enabled, then RPO/RTO when promised (0 = not
        // promised, e.g. the anonymous/free tiers).
        if (t.backup_restore_enabled) {
          lines.push(
            `    backups: ${t.backup_retention_days}d retention, ` +
              `${t.manual_backups_per_day}/day manual`
          );
        }
        if (t.rpo_minutes > 0 || t.rto_minutes > 0) {
          lines.push(
            `    durability: RPO ${t.rpo_minutes}m, RTO ${t.rto_minutes}m`
          );
        }
        if (t.annual_discount_percent > 0) {
          lines.push(`    annual: save ${t.annual_discount_percent}%`);
        }
        if (t.upgrade_url) lines.push(`    upgrade: ${t.upgrade_url}`);
        lines.push("");
      }
      if (result.docs) lines.push(`Full docs: ${result.docs}`);
      if (result.contact) lines.push(`Enterprise: ${result.contact}`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: set_vault_key ───────────────────────────────────────────────────────

server.tool(
  "set_vault_key",
  `Write a secret to the team vault (PUT /api/v1/vault/:env/:key).

This is the WRITE side of the vault:// references create_deploy advertises.
Store a secret here, then reference it from a deploy as vault://<env>/<key> in
env_vars (or resource_bindings) — the api decrypts it at deploy time so the
plaintext never sits in your tool params or the deploy record. Closes the gap
where create_deploy could point at vault://env/KEY but there was no MCP tool to
populate it.

Every write creates a NEW version (v1 on first create, v2+ on updates), so the
returned 'version' tells you which generation this call minted. The plaintext
value is never echoed back.

Vault is a paid feature: Hobby+ (20 entries) through Pro/Team (unlimited). On
anonymous/free you get 403 vault_not_available; at the entry cap you get 402.
Hobby/Pro tiers restrict the env to 'production' only — pass env="production"
there (the api returns 403 vault_env_not_allowed otherwise).

Requires INSTANODE_TOKEN.`,
  {
    env: vaultEnvSchema.describe(
      "Vault environment namespace (e.g. 'production', 'staging'). Hobby/Pro tiers allow 'production' only. Format: ^[A-Za-z0-9_-]{1,64}$."
    ),
    key: vaultKeySchema.describe(
      "Secret key name (e.g. 'DATABASE_URL', 'STRIPE_SECRET_KEY'). Format: ^[A-Za-z0-9_.-]{1,256}$. Reference it later as vault://<env>/<key>."
    ),
    value: vaultValueSchema.describe(
      "The secret value (≤1 MiB). Stored encrypted at rest; never echoed back."
    ),
  },
  async ({ env, key, value }) => {
    try {
      const result = await client.setVaultKey(env, key, value);
      const lines = [
        `Secret written to the vault.`,
        `Env:     ${result.env ?? env}`,
        `Key:     ${result.key ?? key}`,
        `Version: ${result.version}`,
        ``,
        `Reference it from a deploy as: vault://${result.env ?? env}/${result.key ?? key}`,
        `(pass it in create_deploy env_vars; the api decrypts it at deploy time).`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: rotate_vault_key ────────────────────────────────────────────────────

server.tool(
  "rotate_vault_key",
  `Rotate a vault secret's value (POST /api/v1/vault/:env/:key/rotate).

Functionally a vault write that mints a new version, but recorded under a
distinct audit action so the vault audit log distinguishes an intentional
rotation (e.g. a leaked credential, scheduled key rotation) from a routine
update. Use this when you're replacing a compromised or expiring secret;
use set_vault_key for a first write or a normal value change.

After rotating, redeploy any app that references vault://<env>/<key> so the
new value is injected (the running container keeps the old value until its
next deploy).

Requires INSTANODE_TOKEN.`,
  {
    env: vaultEnvSchema.describe(
      "Vault environment namespace of the existing secret (e.g. 'production')."
    ),
    key: vaultKeySchema.describe(
      "Secret key name to rotate (e.g. 'DATABASE_URL')."
    ),
    value: vaultValueSchema.describe(
      "The NEW secret value (≤1 MiB). Stored encrypted; never echoed back."
    ),
  },
  async ({ env, key, value }) => {
    try {
      const result = await client.rotateVaultKey(env, key, value);
      const lines = [
        `Vault secret rotated.`,
        `Env:     ${result.env ?? env}`,
        `Key:     ${result.key ?? key}`,
        `Version: ${result.version}  (a new version was minted)`,
        ``,
        `Redeploy any app referencing vault://${result.env ?? env}/${result.key ?? key}`,
        `so the rotated value takes effect (running pods keep the old value until redeploy).`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: update_deploy_env ───────────────────────────────────────────────────

server.tool(
  "update_deploy_env",
  `Merge environment variables into an existing deployment
(PATCH /deploy/:id/env).

The supplied keys are MERGED into the deployment's current env (incoming wins
on collision) — you don't have to resend the full set. The response echoes the
full merged map with secret values redacted. A redeploy is required to apply
the change: the running container keeps its current env until its next build,
so finish with create_deploy({ name, redeploy: true }) or redeploy({ id }).

Values can be plaintext or vault://env/KEY references (write the secret first
with set_vault_key). Requires INSTANODE_TOKEN. A deployment id not on your
team returns a clean 404 (the api never confirms other teams' deployments).`,
  {
    // BUG-MCP-043: app_id is 8-char hex, not a UUID. Validate client-side.
    id: deployIdSchema.describe(
      "Deployment app id (returned as 'deploy_id' by create_deploy / 'app_id' by get_deployment)."
    ),
    env: z
      .record(z.string(), z.string())
      .describe(
        "Map of env var name → value to merge in. Values may be plaintext or vault://env/KEY references. Merged with the deployment's existing env (incoming wins)."
      ),
  },
  async ({ id, env }) => {
    try {
      if (Object.keys(env).length === 0) {
        return textResult(
          "No env vars supplied. Pass a non-empty 'env' map of KEY → value to merge."
        );
      }
      const result = await client.updateDeployEnv(id, env);
      const lines = [`Env vars merged into deployment ${id}.`];
      if (result.note) lines.push(`Note: ${result.note}`);
      const keys = Object.keys(result.env ?? {});
      if (keys.length > 0) {
        lines.push(``, `Current env (secret values redacted):`);
        for (const k of keys.sort()) lines.push(`  ${k}=${result.env[k]}`);
      }
      lines.push(
        ``,
        `Redeploy to apply: create_deploy({ name, redeploy: true, tarball_base64 }) or redeploy({ id: "${id}", tarball_base64 }).`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: update_stack_env ────────────────────────────────────────────────────

server.tool(
  "update_stack_env",
  `Merge environment variables into an existing stack
(PATCH /stacks/:slug/env).

Same merge semantics as update_deploy_env but for a multi-service stack, and
transactionally row-locked server-side so concurrent updates don't clobber each
other. An EMPTY-STRING value deletes that key. The response echoes the merged
map with secret values redacted. Redeploy the stack
(POST /stacks/:slug/redeploy) to apply the change.

Auth required — anonymous stacks cannot be mutated (claim the stack first). A
slug not on your team returns a clean 404. Requires INSTANODE_TOKEN.`,
  {
    stack_id: z
      .string()
      .min(1)
      .describe(
        "Stack id / slug (format stk-<8hex>, returned by create_stack as 'stack_id')."
      ),
    env: z
      .record(z.string(), z.string())
      .describe(
        "Map of env var name → value to merge in. An empty-string value DELETES that key. Values may be plaintext or vault://env/KEY references."
      ),
  },
  async ({ stack_id, env }) => {
    try {
      if (Object.keys(env).length === 0) {
        return textResult(
          "No env vars supplied. Pass a non-empty 'env' map of KEY → value to merge (use an empty-string value to delete a key)."
        );
      }
      const result = await client.updateStackEnv(stack_id, env);
      const lines = [`Env vars merged into stack ${stack_id}.`];
      if (result.message) lines.push(`Note: ${result.message}`);
      const keys = Object.keys(result.env ?? {});
      if (keys.length > 0) {
        lines.push(``, `Current env (secret values redacted):`);
        for (const k of keys.sort()) lines.push(`  ${k}=${result.env[k]}`);
      }
      lines.push(
        ``,
        `Redeploy to apply (re-POST /stacks/${stack_id}/redeploy with the updated manifest + tarballs).`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: presign_storage ─────────────────────────────────────────────────────

server.tool(
  "presign_storage",
  `Mint a short-lived presigned S3 URL for an object in a storage bucket prefix
(POST /storage/:token/presign).

Use this to upload (PUT) or download/inspect (GET/HEAD) an object without
handing out long-lived credentials. The signed URL is scoped to the storage
resource's tenant prefix and expires in ≤1h (default 10 min). Auth is the
storage TOKEN in the path (the value create_storage returned) — so this works
for anonymous-tier storage you just provisioned, no INSTANODE_TOKEN needed.

Then use the returned 'url' with any plain HTTP client:
  - PUT  → upload the object body to that URL
  - GET  → download the object
  - HEAD → fetch metadata only

DELETE is intentionally NOT offered — a leaked presigned URL must not be able
to wipe a prefix. The key must be relative to the prefix (no leading slash,
no '..' path traversal — the api rejects those).`,
  {
    token: uuidSchema.describe(
      "Storage resource token (UUID) returned by create_storage."
    ),
    operation: z
      .enum(["GET", "PUT", "HEAD"])
      .describe(
        "S3 verb the signed URL authorises: GET (download), PUT (upload), or HEAD (metadata). DELETE is not permitted."
      ),
    key: z
      .string()
      .min(1)
      .describe(
        "Object key RELATIVE to the tenant prefix (e.g. 'uploads/avatar.png'). No leading slash, no '..' segments."
      ),
    expires_in: z
      .number()
      .int()
      .positive()
      .max(3600)
      .optional()
      .describe(
        "TTL in seconds. Default 600 (10 min); capped server-side at 3600 (1h). Omit for the default."
      ),
  },
  async ({ token, operation, key, expires_in }) => {
    try {
      const result = await client.presignStorage({
        token,
        operation,
        key,
        expires_in,
      });
      const lines = [
        `Presigned ${result.method ?? operation} URL minted (expires ${result.expires_at}).`,
        `Key:        ${result.key ?? key}`,
        `Object key: ${result.object_key ?? key}`,
        ``,
        `URL (use with a plain HTTP client; treat as a secret until it expires):`,
        result.url,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: pause_resource ──────────────────────────────────────────────────────

server.tool(
  "pause_resource",
  `Suspend a resource WITHOUT deleting it
(POST /api/v1/resources/:id/pause).

Storage is preserved and the connection URL is unchanged — the resource just
stops accepting new connections (the provider-side credential is revoked) until
you resume it. Use this to park a staging database overnight, freeze a resource
during an incident, or temporarily cut access without losing data.

Pro tier or higher only (anonymous/free/hobby get 402 with an upgrade prompt).
Pausing an already-paused resource returns 409. Resume with resume_resource;
the same connection URL works again immediately after resume.

Requires INSTANODE_TOKEN. A token not on your team returns a clean 404.`,
  {
    id: uuidSchema.describe(
      "Resource token (UUID) to pause — the value create_* returned as 'token'."
    ),
  },
  async ({ id }) => {
    try {
      const result = await client.pauseResource(id);
      const lines = [
        `Resource paused.`,
        `Token:  ${result.token ?? id}`,
        `Status: ${result.status ?? "paused"}`,
      ];
      if (result.message) lines.push(`Message: ${result.message}`);
      lines.push(``, `Resume with: resume_resource({ id: "${id}" }).`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: resume_resource ─────────────────────────────────────────────────────

server.tool(
  "resume_resource",
  `Un-pause a previously-paused resource
(POST /api/v1/resources/:id/resume).

Flips the resource back to 'active' and re-grants the provider credential. The
connection URL is preserved unchanged (same password, host, database name) so
your existing config keeps working — no reconnection-string change needed.

Pro tier or higher only (symmetric with pause_resource). Resuming a resource
that isn't paused returns 409. Requires INSTANODE_TOKEN. A token not on your
team returns a clean 404.`,
  {
    id: uuidSchema.describe(
      "Resource token (UUID) to resume — the value create_* returned as 'token'."
    ),
  },
  async ({ id }) => {
    try {
      const result = await client.resumeResource(id);
      const lines = [
        `Resource resumed.`,
        `Token:  ${result.token ?? id}`,
        `Status: ${result.status ?? "active"}`,
      ];
      if (result.message) lines.push(`Message: ${result.message}`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: rotate_credentials ──────────────────────────────────────────────────

server.tool(
  "rotate_credentials",
  `Rotate a resource's password and get the NEW connection URL
(POST /api/v1/resources/:id/rotate-credentials).

The host and database name are unchanged; only the credential rotates. An
attacker holding a leaked OLD connection URL is locked out, while the freshly-
returned URL keeps working. Use this after a suspected leak, on a key-rotation
schedule, or before handing a resource off.

The response includes the new connection_url IN PLAINTEXT (the one place
besides create_* that exposes it) — treat it as a secret, store it (e.g. with
set_vault_key), and update any app/deploy that references the old URL.

Requires INSTANODE_TOKEN. A token not on your team returns a clean 404.`,
  {
    id: uuidSchema.describe(
      "Resource token (UUID) whose credentials to rotate — the value create_* returned as 'token'."
    ),
  },
  async ({ id }) => {
    try {
      const result = await client.rotateCredentials(id);
      const lines = [
        `Credentials rotated for resource ${id}.`,
        `The old connection URL no longer works. New connection URL (treat as a secret):`,
        ``,
        result.connection_url,
        ``,
        `Update any app/deploy that referenced the old URL. Consider storing this`,
        `with set_vault_key and referencing it as vault://<env>/<key> in your deploys.`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: wake_deployment ─────────────────────────────────────────────────────

server.tool(
  "wake_deployment",
  `Explicitly wake a scaled-to-zero deployment
(POST /deploy/:id/wake).

When scale-to-zero is enabled, an idle app is descheduled to 0 replicas to save
compute; its URL then returns 502/503 (no pod) until woken. This tool scales it
back to 1 replica and refreshes its activity stamp. The pod still needs its
normal cold-start time before it serves traffic, so retry the app URL a few
seconds after waking.

This endpoint is FLAG-GATED on the platform: when scale-to-zero is disabled the
api returns 501 'scale_to_zero_disabled' and nothing is scaled. That's expected
on a deploy where the feature isn't turned on — the deployment is already
always-on, so there's nothing to wake.

Requires INSTANODE_TOKEN. A deployment id not on your team returns a clean 404.`,
  {
    // BUG-MCP-043: app_id is 8-char hex, not a UUID. Validate client-side.
    id: deployIdSchema.describe(
      "Deployment app id (returned as 'deploy_id' by create_deploy / 'app_id' by get_deployment)."
    ),
  },
  async ({ id }) => {
    try {
      const result = await client.wakeDeployment(id);
      const lines = [`Deployment ${id} woken.`];
      if (result.message) lines.push(result.message);
      lines.push(
        ``,
        `Retry the app URL in a few seconds — the pod cold-starts before it serves traffic.`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── Tool: create_lead ─────────────────────────────────────────────────────────

server.tool(
  "create_lead",
  `Submit an enterprise contact / interest form to instanode.dev
(POST /api/v1/leads).

Use this when the user needs capacity or features beyond the Pro tier —
dedicated infrastructure, SAML/SSO, SOC 2 compliance, a custom SLA, or any
other Enterprise-tier requirement. It directly reaches the instanode.dev team
and is faster than a cold email.

Only 'email' is required. Providing 'company' and 'use_case' gives the team
context to respond with an accurate quote without a back-and-forth.

No INSTANODE_TOKEN needed — anonymous callers are accepted. When called with
a valid bearer token the lead is automatically linked to the caller's team
so the sales team can see the account's current usage.

Returns the UUID of the created lead record on success.`,
  {
    email: z
      .string()
      .email()
      .max(254)
      .describe("Contact email address. Required. Must be a valid RFC 5322 address (max 254 chars)."),
    name: z
      .string()
      .max(128)
      .optional()
      .describe("Contact full name. Optional — max 128 chars."),
    company: z
      .string()
      .max(128)
      .optional()
      .describe("Company or organisation name. Optional — max 128 chars."),
    use_case: z
      .string()
      .max(1024)
      .optional()
      .describe(
        "Plain-text description of scale requirements or the use case driving the Enterprise inquiry. Optional — max 1024 chars."
      ),
  },
  async ({ email, name, company, use_case }) => {
    try {
      const result = await client.createLead({ email, name, company, use_case });
      const lines = [
        `Enterprise inquiry submitted.`,
        `Lead ID: ${result.id ?? "(pending)"}`,
        ``,
        `The instanode.dev team will follow up at ${email}.`,
        `Typical response time: 1–2 business days.`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ── CLI flags (BUG-MCP-017) ────────────────────────────────────────────────────

// `instanode-mcp --version` and `instanode-mcp --help` short-circuit before
// the stdio transport binds, so operators / package managers can probe the
// binary without it sitting forever waiting on stdin. Stdout-friendly, exit
// 0. Unknown flags fall through to the normal stdio loop so a hostile MCP
// host can't force the process to exit by sending a stray "--whatever".
export function handleCLIFlags(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === "-h" || a === "--help") {
      process.stdout.write(
        [
          `instanode-mcp ${pkgVersion}`,
          `MCP server for instanode.dev — exposes provisioning + deploy tools to AI agents.`,
          ``,
          `Usage: instanode-mcp [--version] [--help]`,
          ``,
          `By default the binary speaks MCP over stdio. Configure it as the`,
          `command in your Claude Code / Cursor / Windsurf MCP settings.`,
          ``,
          `Env vars:`,
          `  INSTANODE_TOKEN         Bearer token from the dashboard (paid-tier tools).`,
          `  INSTANODE_API_URL       Override the API base URL (default https://api.instanode.dev).`,
          `  INSTANODE_DASHBOARD_URL Override the dashboard URL (default https://instanode.dev).`,
          ``,
        ].join("\n")
      );
      return true;
    }
    if (a === "-v" || a === "--version") {
      process.stdout.write(`${pkgVersion}\n`);
      return true;
    }
  }
  return false;
}

// ── Start server ──────────────────────────────────────────────────────────────

// maybeShortCircuit invokes handleCLIFlags(argv); if a CLI flag was handled,
// calls exit() to terminate the process. Returns true when it short-circuited,
// false otherwise. Extracted so unit tests can drive both branches without
// touching process.argv or actually exiting the test runner.
export function maybeShortCircuit(
  argv: readonly string[],
  exit: (code: number) => void = process.exit
): boolean {
  if (handleCLIFlags(argv)) {
    exit(0);
    return true;
  }
  return false;
}

// BUG-MCP-017: CLI flag short-circuit runs OUTSIDE the no-listen guard so the
// real binary (which never sets INSTANODE_MCP_NO_LISTEN) can be probed for
// --version / --help without sitting on stdin. The exported helper makes
// both the short-circuit-true and fall-through-false branches reachable
// from unit tests via an injected exit fn — see input-hardening-unit.test.ts.
maybeShortCircuit(process.argv.slice(2));

// Unit tests import this module purely to reach the exported helpers
// (formatError / formatLimits / appendUpgradeBlock) without binding to a real
// stdio transport — set INSTANODE_MCP_NO_LISTEN=1 in that case. The CLI binary
// path (and integration tests that spawn `node dist/index.js`) never set this
// var, so the production behavior is unchanged.
if (!process.env["INSTANODE_MCP_NO_LISTEN"]) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Re-export the MCP server so unit tests can introspect the tool registry
// without spawning a subprocess. Production callers ignore this — the binary
// entrypoint only depends on the `await server.connect(...)` above.
export { server };
