/**
 * Thin HTTP client for the instanode.dev REST API.
 *
 * Base URL defaults to https://api.instanode.dev and can be overridden via the
 * INSTANODE_API_URL env var (kept mostly for local development against a k3s
 * cluster).
 *
 * Bearer auth is read from INSTANODE_TOKEN on every call so the user can
 * rotate the token without restarting the MCP process. Anonymous callers
 * simply leave the env var unset.
 *
 * Today's API surface (all live):
 *   POST /db/new       — Postgres
 *   POST /cache/new    — Redis
 *   POST /nosql/new    — MongoDB
 *   POST /queue/new    — NATS JetStream
 *   POST /storage/new  — S3-compatible bucket
 *   POST /webhook/new  — Webhook receiver
 *   POST /deploy/new   — Container deployment (multipart/form-data)
 *   GET  /api/v1/deployments, GET /api/v1/deployments/:id
 *   POST /deploy/:id/redeploy, DELETE /deploy/:id
 *   GET  /api/v1/resources             — list resources for the authenticated team
 *   DELETE /api/v1/resources/{token}   — soft-delete (Pro+; free-tier rows auto-expire)
 *   POST /claim                        — convert anonymous JWT → authenticated team
 *   POST /api/v1/auth/api-keys         — mint a fresh bearer JWT
 *
 * Historical note: an earlier MCP build called /api/me/resources, /api/me/claim,
 * /api/me/token — these were never live (a typo'd /api/me prefix that the
 * router never registered). Every such call returned 404 and the agent saw
 * "instanode.dev error (404)" with no path forward. FIX-E #C5 rewired the
 * client to the canonical routes above.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://api.instanode.dev";
const DEFAULT_DASHBOARD_URL = "https://instanode.dev";

/**
 * Module-init User-Agent — resolved once from package.json so every release
 * naturally rolls forward without anyone remembering to bump a hardcoded
 * string. BugBash B16 F4 (regression of task #176): the previous version
 * carried `instanode-mcp/0.11.0` as a literal in two places, which drifted
 * out of sync with the published package version. Falling back to "dev" on
 * any failure (file missing, malformed JSON) so the client never explodes
 * at import time just to read a UA.
 */
function resolveUserAgent(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/client.js → repo root; src/client.ts → repo root in dev. Same path.
    const pkgPath = resolve(here, "..", "package.json");
    const pkgRaw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(pkgRaw) as { name?: string; version?: string };
    const name = pkg.name && pkg.name.length > 0 ? pkg.name : "instanode-mcp";
    const version = pkg.version && pkg.version.length > 0 ? pkg.version : "dev";
    return `${name}/${version}`;
  } catch {
    return "instanode-mcp/dev";
  }
}

const USER_AGENT = resolveUserAgent();

/**
 * Maximum decoded tarball size accepted by POST /deploy/new (50 MiB,
 * mirroring the api's documented contract). T17 P2: enforced client-side
 * BEFORE the multipart upload so an oversized payload fails immediately
 * with a clear error — instead of round-tripping a multi-MB base64 string
 * up to the api just to get a 413 / 400 back, with the wasted bandwidth
 * and (potentially) the multi-MB string logged by the agent host.
 *
 * Counted in bytes against `Buffer.byteLength(decodedTarball)`, NOT
 * against `tarball_base64.length` (the base64 representation is ~33%
 * larger than the decoded bytes).
 */
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;

export interface ClientOptions {
  baseURL?: string;
}

export interface Resource {
  id: string;
  token: string;
  resource_type: string;
  tier: string;
  status: string;
  name?: string;
  created_at?: string;
  expires_at?: string | null;
}

export interface ProvisionLimits {
  storage_mb?: number;
  connections?: number;
  requests_stored?: number;
  expires_in?: string;
  [key: string]: unknown;
}

/**
 * Shared fields every /<resource>/new response carries. Some resources have
 * type-specific extras (receive_url for webhook, endpoint/access_key_id/etc
 * for storage).
 */
export interface ProvisionResultBase {
  ok: boolean;
  id: string;
  token: string;
  name?: string;
  tier: string;
  limits?: ProvisionLimits;
  /** Human-readable CTA the agent should surface verbatim. */
  note?: string;
  /** https://instanode.dev/start?t=<jwt> — the dashboard claim URL. */
  upgrade?: string;
  /** Raw upgrade JWT (for callers that want to build their own claim URL). */
  upgrade_jwt?: string;
  expires_at?: string | null;
  env?: string;
  /**
   * Unknown request-body fields the api silently dropped (api D7 / #283). When
   * an agent sends a hallucinated param (e.g. `region`, `size`) the api ignores
   * it and echoes the dropped key(s) here so the caller learns the param had no
   * effect. Empty/absent on a clean request. Surfaced verbatim by the provision
   * tools so the agent stops sending the dead field.
   */
  ignored_fields?: string[];
}

export interface DatabaseProvisionResult extends ProvisionResultBase {
  /** postgres://... connection string, drop-in DATABASE_URL. */
  connection_url: string;
}

export interface VectorProvisionResult extends ProvisionResultBase {
  /**
   * postgres:// connection string with the pgvector extension pre-installed
   * (CREATE EXTENSION vector already ran). Drop-in DATABASE_URL.
   */
  connection_url: string;
  /** Always 'pgvector'. */
  extension?: string;
  /** Echo of the requested default embedding dimensions hint (defaults to 1536). */
  dimensions?: number;
}

export interface CacheProvisionResult extends ProvisionResultBase {
  /** redis://user:pass@host:port — drop-in REDIS_URL. */
  connection_url: string;
}

export interface NoSQLProvisionResult extends ProvisionResultBase {
  /** mongodb://user:pass@host:port/db — drop-in MONGODB_URI. */
  connection_url: string;
}

export interface QueueProvisionResult extends ProvisionResultBase {
  /** nats://user:pass@host:port — drop-in NATS_URL. JetStream enabled. */
  connection_url: string;
}

export interface StorageProvisionResult extends ProvisionResultBase {
  /** Public bucket URL prefix, e.g. https://nyc3.digitaloceanspaces.com/instant-shared/<prefix>/ */
  connection_url: string;
  endpoint: string;
  access_key_id: string;
  secret_access_key: string;
  prefix: string;
}

export interface WebhookProvisionResult extends ProvisionResultBase {
  /** Public URL: POST anything to it, GET it to retrieve the captured log. */
  receive_url: string;
}

/**
 * Single deployment record as returned by the api's deploymentToMap helper.
 * Fields that may be absent on a freshly-accepted (status="building") deploy
 * are typed optional.
 */
export interface Deployment {
  id: string;
  /** Public-facing app id (also exposed as `token` alias). */
  app_id: string;
  token: string;
  port: number;
  tier: string;
  status: string;
  /** Live URL once the build finishes; empty string while building. */
  url?: string;
  /** Map of env var name → value (or vault://env/KEY ref). */
  env?: Record<string, string>;
  /** Deploy environment scope: production / staging / development / ... */
  environment?: string;
  provider_id?: string;
  resource_id?: string;
  error?: string;
  created_at?: string;
  updated_at?: string;
  team_id?: string;
  /**
   * Private deploy flag — when true, the deploy's Ingress only accepts traffic
   * from `allowed_ips`. Pro tier or higher required (anonymous + hobby are 402).
   */
  private?: boolean;
  /**
   * IP / CIDR allowlist enforced at the Ingress when `private` is true.
   * Strings like "1.2.3.4" or "10.0.0.0/8". Empty / undefined when
   * `private` is false.
   *
   * Track A's backend contract uses `allowed_ips`. If Track A ends up renaming
   * to `allowed_cidrs`, reconcile post-merge with a one-line schema rename
   * (see PR body).
   */
  allowed_ips?: string[];
}

/**
 * Response shape from POST /deploy/new (HTTP 202 Accepted).
 *
 * The api returns `{ ok, item: <deployment>, note }`. We flatten the item
 * onto the result so callers can read `deploy_id`, `status`, `url`, etc.
 * directly while still exposing the raw item for completeness.
 */
export interface DeployResult {
  ok: boolean;
  /** Public-facing app id — use this for GET /deploy/:id, redeploy, delete. */
  deploy_id: string;
  /** "building" on the initial 202; poll get_deployment for terminal status. */
  status: string;
  /** Live URL — empty string until the build finishes. */
  url: string;
  /** Where to fetch build logs (constructed client-side from base + id). */
  build_logs_url: string;
  /** Surfaced verbatim to the user. */
  note?: string;
  /** Anonymous-tier claim URL — same semantics as create_*. */
  upgrade?: string;
  upgrade_jwt?: string;
  /** Raw deployment record from the api. */
  item: Deployment;
}

export interface DeployListResult {
  ok: boolean;
  items: Deployment[];
  total: number;
}

export interface DeployGetResult {
  ok: boolean;
  item: Deployment;
}

export interface DeployDeleteResult {
  ok: boolean;
  id?: string;
  token?: string;
  status?: string;
  message?: string;
}

/**
 * One tier row from GET /api/v1/capabilities.
 *
 * Mirrors `tierCapabilities` in api/internal/handlers/capabilities.go. The
 * handler iterates the live plans registry, so this shape is contract-stable
 * but the SET of tiers is whatever api/plans.yaml ships. Today (2026-06):
 * anonymous, free, hobby, hobby_plus, pro, growth, team.
 *
 * `storage_limit_mb` / `connections_limit` / `resource_count_limit` are keyed
 * by service string ("postgres", "redis", "mongodb", "queue", "storage",
 * "webhook", "vector"). A value of -1 means "unlimited"; a positive value is
 * the hard cap (in MB for storage, count for connections / resource_count).
 */
export interface TierCapability {
  tier: string;
  display_name: string;
  price_usd_monthly: number;
  paid_from_day_one: boolean;
  storage_limit_mb: Record<string, number>;
  connections_limit: Record<string, number>;
  resource_count_limit: Record<string, number>;
  /** Max number of concurrent deployed apps. -1 = unlimited. */
  deployments_apps: number;
  backup_retention_days: number;
  backup_restore_enabled: boolean;
  manual_backups_per_day: number;
  rpo_minutes: number;
  rto_minutes: number;
  annual_discount_percent: number;
  /**
   * Pricing-page URL for upgrading INTO a higher tier, or null on the terminal
   * tier (Team today — nothing to upgrade to). Pairs with is_terminal_tier.
   */
  upgrade_url: string | null;
  is_terminal_tier: boolean;
}

/**
 * Response shape from GET /api/v1/capabilities (auth-optional, public).
 *
 * The api returns `{ ok, tiers, docs, contact }`. `tiers` is sorted ascending
 * by upgrade rank (anonymous → team) so consumers see them in upgrade order.
 */
export interface CapabilitiesResult {
  ok: boolean;
  tiers: TierCapability[];
  /** LLM-targeted full-docs URL (https://instanode.dev/llms-full.txt). */
  docs?: string;
  /** Enterprise contact mailto: link. */
  contact?: string;
}

/**
 * One row from GET /api/v1/deployments/:id/events — the failure-timeline
 * autopsy surface (rule 27). Written by the worker's deploy_failure_autopsy
 * job, read-only on the api. Mirrors the per-row shape emitted by
 * DeployHandler.Events in api/internal/handlers/deploy.go.
 *
 * Most rows are kind="failure_autopsy" carrying a Kaniko/k8s failure reason
 * plus the last lines of the build/pod log and a remediation hint. `exit_code`
 * is null when the failure wasn't a process exit (e.g. ProgressDeadlineExceeded).
 */
export interface DeploymentEvent {
  /** e.g. "failure_autopsy". */
  kind: string;
  /** e.g. "BackoffLimitExceeded", "OOMKilled", "ImagePullBackOff". */
  reason: string;
  /** k8s event type, when one was captured (e.g. "Warning"). */
  event?: string;
  /** Tail of the build/pod logs — the lines most likely to explain the failure. */
  last_lines?: string;
  /** Human-readable remediation suggestion the agent can act on. */
  hint?: string;
  /** Process exit code, or null when the failure wasn't an exit. */
  exit_code: number | null;
  /** RFC3339 UTC timestamp. */
  created_at: string;
}

/**
 * Response shape from GET /api/v1/deployments/:id/events.
 *
 * The api returns `{ ok, deployment_id, events, count }` with `events` ordered
 * DESC by created_at (newest first). RBAC mirrors GET /deployments/:id exactly:
 * a cross-team or absent id returns an indistinguishable 404 (never confirming
 * existence of another team's deployment).
 */
export interface DeploymentEventsResult {
  ok: boolean;
  /** Internal deployment UUID (distinct from the public app_id in the path). */
  deployment_id?: string;
  events: DeploymentEvent[];
  count: number;
}

/**
 * Response shape from POST /deploy/:id/redeploy.
 *
 * The live API documents this as a bare 202 with NO body (see openapi.json),
 * not a deployment record. The previous client mis-typed it as DeployGetResult
 * and the index.ts handler dereferenced `result.item.app_id`, blowing up
 * with "Cannot read properties of undefined (reading 'app_id')" on every
 * real call. BugBash B16 F1 (regression of task #170): use a body-less type
 * and let callers fall back to the caller-supplied id when needed.
 */
export interface RedeployResult {
  ok: boolean;
  id?: string;
  status?: string;
  message?: string;
}

/**
 * Response shape from PUT /api/v1/vault/:env/:key and
 * POST /api/v1/vault/:env/:key/rotate.
 *
 * Both return 201 `{ok, key, env, version}` (see VaultHandler.upsertSecret in
 * api/internal/handlers/vault.go). Every write creates a NEW version (v1 on
 * first create, v2+ on subsequent writes / rotates), so `version` is the
 * authoritative "which generation did this call mint" signal. The plaintext
 * secret value is NEVER echoed back — only its coordinates. This is the write
 * side of the `vault://env/KEY` refs that create_deploy advertises: an agent
 * can now write a secret here, then reference it as `vault://<env>/<key>` in a
 * deploy's env_vars and the api decrypts it at deploy time (closes D4).
 */
export interface VaultWriteResult {
  ok: boolean;
  key: string;
  env: string;
  /** Version minted by this write. v1 = fresh create, v2+ = update/rotate. */
  version: number;
}

/**
 * Response shape from PATCH /deploy/:id/env (DeployHandler.UpdateEnv).
 *
 * The api MERGES the supplied keys into the deployment's existing env vars
 * (incoming wins on collision) and returns the full merged map with secret
 * values redacted (`env`), plus a `note` reminding the caller a redeploy is
 * needed to apply the change. NOTE the route is `/deploy/:id/env`, NOT
 * `/api/v1/deployments/:id/env` — the deployment env-mutation lives on the
 * deploy group alongside /deploy/new.
 */
export interface UpdateDeployEnvResult {
  ok: boolean;
  /** Merged env map, values redacted. */
  env: Record<string, string>;
  note?: string;
}

/**
 * Response shape from PATCH /stacks/:slug/env (StackHandler.UpdateEnv).
 *
 * Same load-merge-save semantics as the deploy variant but transactionally
 * row-locked (MergeStackEnvVars) so concurrent PATCHes don't lose updates. An
 * empty-string value DELETES that key. Returns the merged map (redacted) +
 * a `message` reminding the caller to redeploy.
 */
export interface UpdateStackEnvResult {
  ok: boolean;
  env: Record<string, string>;
  message?: string;
}

/**
 * Response shape from POST /storage/:token/presign (StorageHandler.PresignStorage).
 *
 * Returns a short-lived (≤1h) presigned S3 URL scoped to the resource's tenant
 * prefix. The `:token` is the storage token from create_storage; auth is the
 * token in the URL (broker mode) so an anonymous caller can presign against a
 * storage prefix it just provisioned. DELETE is intentionally NOT a permitted
 * operation server-side (a leaked URL must not be able to wipe a prefix).
 */
export interface PresignStorageResult {
  ok: boolean;
  /** The signed S3 URL — usable with a plain HTTP client for the given method. */
  url: string;
  /** Echo of the resolved operation (GET / PUT / HEAD). */
  method: string;
  /** The object key relative to the tenant prefix. */
  key: string;
  /** The fully-qualified object key (prefix + key) the URL signs. */
  object_key: string;
  /** RFC3339 UTC expiry — the URL is invalid after this. */
  expires_at: string;
}

/** Caller-supplied params for presign_storage. */
export interface PresignStorageParams {
  /** Storage resource token (UUID) from create_storage. */
  token: string;
  /** GET | PUT | HEAD — the S3 verb the signed URL authorises. */
  operation: string;
  /** Object key relative to the tenant prefix (no leading slash, no '..'). */
  key: string;
  /** TTL in seconds. Default 600, capped server-side at 3600 (1h). */
  expires_in?: number;
}

/**
 * Response shape from POST /api/v1/resources/:id/pause and
 * POST /api/v1/resources/:id/resume (ResourceHandler.Pause/Resume).
 *
 * Pause suspends the resource WITHOUT deleting it: storage is preserved, the
 * connection URL is unchanged, and the provider-side credential is revoked so
 * new connections are refused until resume. Pro+ tier only (402 otherwise);
 * already-paused → 409, already-active resume → 409. The `:id` is the resource
 * TOKEN (the same value create_* emits as `token`).
 */
export interface ResourcePauseResumeResult {
  ok: boolean;
  id?: string;
  token?: string;
  status?: string;
  message?: string;
}

/**
 * Response shape from POST /api/v1/resources/:id/rotate-credentials
 * (ResourceHandler.RotateCredentials).
 *
 * Rotates the resource's password and returns the NEW connection_url in
 * plaintext — the one place (besides GetCredentials) the api exposes a
 * connection string in cleartext. The host / database name are unchanged; only
 * the credential rotates, so an attacker holding a leaked old URL is locked
 * out while the new URL keeps working. Pro+ semantics mirror the live api.
 */
export interface RotateCredentialsResult {
  ok: boolean;
  /** The freshly-rotated connection string. Treat as a secret. */
  connection_url: string;
}

/**
 * Response shape from POST /deploy/:id/wake (DeployHandler.Wake).
 *
 * Scale-to-zero explicit wake: scales a (possibly scaled-to-zero) deployment
 * back to 1 replica and refreshes its activity stamp. FLAG-GATED server-side by
 * DEPLOY_SCALE_TO_ZERO_ENABLED — when the flag is OFF the api returns 501
 * `scale_to_zero_disabled` and performs NO scaling / NO DB write. The pod still
 * needs its normal cold-start before serving traffic, so a request racing the
 * wake gets the app's cold-start latency (brief 502/503 from the ingress).
 */
export interface WakeDeploymentResult {
  ok: boolean;
  message?: string;
  /** The refreshed deployment record (scaled_to_zero cleared). */
  deployment?: Deployment;
}

/** Caller-supplied params for create_deploy. */
export interface CreateDeployParams {
  /** Base64-encoded gzip tarball (with Dockerfile + source). <50 MB after decode. */
  tarball_base64: string;
  /** Human-readable name shown on the dashboard. Required (1-64 chars). */
  name: string;
  /** Container HTTP port. Default 8080. */
  port?: number;
  /**
   * Deploy env scope: development / staging / production. Default
   * "development" server-side — see CLAUDE.md convention #11 / migration 026.
   * Omitting `env` lands the deploy in 'development' (lowest stakes) so
   * accidental no-env deploys can't merge with prod state.
   */
  env?: string;
  /**
   * env vars dict; values can be plaintext or vault://env/KEY refs. The api
   * decrypts vault refs at deploy time.
   */
  env_vars?: Record<string, string>;
  /**
   * Resource token bindings, e.g. `{ "DATABASE_URL": "<postgres token>" }`.
   * The MCP client does NOT pre-resolve tokens to connection URLs — it
   * merges this map into env_vars as-is and lets the api resolve token
   * strings server-side. Pre-resolving would leak credentials into the
   * tool params, which the agent host may log.
   */
  resource_bindings?: Record<string, string>;
  /**
   * Private deploy flag. When true, the Ingress only accepts traffic from
   * `allowed_ips`. Requires Pro tier or higher (api returns 402 on hobby
   * with an `agent_action` upgrade prompt).
   */
  private?: boolean;
  /**
   * IP / CIDR allowlist (required when `private=true`). Strings like
   * "1.2.3.4" or "10.0.0.0/8". The MCP client forwards this as-is to
   * Track A's backend contract; if Track A ships with a slightly different
   * shape (e.g. `allowed_cidrs`), reconcile post-merge.
   */
  allowed_ips?: string[];
  /**
   * In-place redeploy flag (api PR feat/deploy-new-redeploy-in-place).
   * When true AND `name` matches an existing deployment on the caller's team,
   * the api updates that deployment IN PLACE (same app_id, same URL) instead
   * of minting a fresh one. Default false → preserves the legacy "always mint
   * a new app_id" behaviour. This closes the AGENT-UX gap where an agent
   * shipping v2 of an existing app ended up with two live URLs.
   *
   * Forward compatibility: when sent against an api that doesn't yet
   * understand the field, the multipart form value is silently ignored by
   * Fiber's MultipartForm parser → behaves like the legacy path. Safe to
   * ship from MCP before the api PR lands; the user only sees in-place
   * redeploy behaviour once the api side is in prod.
   */
  redeploy?: boolean;
}

/**
 * A single service entry in a StackResponse. The api returns one of these per
 * service declared in the manifest. Only services with `expose: true` get a
 * public `url`; the rest are reachable in-cluster only via
 * `http://<service-name>:<port>`.
 */
export interface StackService {
  name: string;
  status: string;
  port: number;
  expose?: boolean;
  /** Empty string while building or for non-exposed services. */
  url?: string;
}

/**
 * Response shape from POST /stacks/new (HTTP 202 Accepted) and GET /stacks/{slug}.
 *
 * Mirrors the `StackResponse` schema in api/internal/handlers/openapi.go. Like
 * /deploy/new, the build is asynchronous: the initial response carries
 * status="building"; poll `getStack(stack_id)` until status="healthy" (or
 * "failed"). Overall status is "healthy" only when every service is healthy.
 */
export interface StackResult {
  ok: boolean;
  /** Format: stk-<8-char-hex>. Use this for getStack / GET /stacks/{slug}. */
  stack_id: string;
  status: string;
  tier: string;
  /** Resolved env bucket (defaults to 'development' — see CLAUDE.md #11). */
  env?: string;
  name?: string;
  services: StackService[];
  /** Anonymous stacks have a 6h TTL; authenticated stacks return empty. */
  expires_in?: string;
  /** Anonymous-tier CTA fields, same semantics as create_*. */
  note?: string;
  upgrade?: string;
  upgrade_jwt?: string;
}

/**
 * Caller-supplied params for create_stack — wraps POST /stacks/new.
 *
 * `manifest` is the raw YAML text of an `instant.yaml`. `service_tarballs`
 * maps each service-name declared in the manifest to a base64-encoded gzip
 * tarball of that service's build context (Dockerfile + sources). The client
 * decodes each tarball and attaches it as a multipart file part NAMED AFTER
 * THE SERVICE — this is the api's documented contract (see openapi.json
 * StackRequest: "One field per service declared in the manifest, named after
 * the service. Value is a gzipped tar archive."). Total request body cap is
 * 200 MB across all services (api side); each service's decoded tarball is
 * still capped at 50 MiB client-side.
 */
export interface CreateStackParams {
  /** Stack name. Required (1-64 chars, ^[A-Za-z0-9][A-Za-z0-9 _-]*$). */
  name: string;
  /** instant.yaml text — declares services + their build/port/expose/needs. */
  manifest: string;
  /**
   * One entry per service declared in the manifest. Keys are service names;
   * values are base64-encoded gzip tarballs of that service's build context.
   */
  service_tarballs: Record<string, string>;
  /**
   * Optional resource env scope (development / staging / production). Default
   * "development" server-side (see CLAUDE.md convention #11 / mig 026).
   */
  env?: string;
}

/**
 * Response shape from POST /claim.
 *
 * Mirrors the live api's `ClaimResponse` schema (see
 * api/openapi.snapshot.json ClaimResponse): `{ok, team_id, user_id,
 * session_token?, message?}`. The legacy 201 direct-claim shape
 * (`{id, token, resource_type, tier, status}`) was retired 2026-05-20 — every
 * successful claim now goes through the magic-link flow and returns the
 * magic-link envelope (see mcp/test/mock-api.ts:427-429). The previous MCP
 * `ClaimResult` carried the retired fields verbatim, so `claim_token` rendered
 * `(see list_resources)` placeholders for every line instead of telling the
 * agent which team/user the claim landed against and (when present) handing
 * back the 24h `session_token` the agent can use to call other tools
 * immediately without a dashboard round-trip.
 */
export interface ClaimResult {
  ok: boolean;
  team_id?: string;
  user_id?: string;
  /** 24h session JWT — returned by the legacy direct-claim path only. */
  session_token?: string;
  message?: string;
}

export interface ApiTokenResult {
  ok: boolean;
  token: string;
  expires_in: number;
}

export interface DeleteResult {
  ok: boolean;
  id?: string;
  token?: string;
  status?: string;
  message?: string;
  // Free-tier 403 response
  error?: string;
  upgrade_url?: string;
}

/** Thrown when the caller needs a bearer token but INSTANODE_TOKEN is unset. */
export class AuthRequiredError extends Error {
  constructor() {
    super(
      "This action requires authentication. Mint a token at https://instanode.dev/dashboard and set INSTANODE_TOKEN in your MCP server env."
    );
    this.name = "AuthRequiredError";
  }
}

/** Thrown when the server returns a non-2xx response. Carries a cleaned message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly upgradeURL?: string;
  /**
   * The `agent_action` field from the API's error envelope, when present.
   *
   * The API copies a verbatim sentence the agent should surface to the human
   * user (e.g. "Tell the user they've hit the hobby tier storage limit — have
   * them upgrade at https://instanode.dev/pricing"). FIX-E #C7 plumbs this
   * through to the formatError handler so the MCP user actually sees it.
   * Previously the MCP discarded `agent_action` entirely and the LLM had to
   * guess at the action from a generic "API error 402" string.
   */
  readonly agentAction?: string;
  /**
   * The `claim_url` field from the API's error envelope on
   * `free_tier_recycle_requires_claim` (the anonymous-fingerprint recycle gate).
   * Distinct from `upgradeURL` — `claimURL` is the identity step (anon → claimed),
   * `upgradeURL` is the tier step (claimed → paid).
   */
  readonly claimURL?: string;
  /**
   * The `request_id` field every API error envelope carries — a support /
   * log-correlation id. An agent or user can quote it when reporting a failure
   * so the operator can grep it in the api logs. Previously the MCP discarded
   * it entirely, so a failure was unattributable. Surfaced verbatim by
   * formatError.
   */
  readonly requestId?: string;
  /**
   * The `retry_after_seconds` field present on rate-limit (429) and some
   * transient-backpressure envelopes — the number of seconds the api asks the
   * caller to wait before retrying. Surfaced so an agent backs off for the
   * right duration instead of hammering or guessing.
   */
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    message: string,
    code?: string,
    upgradeURL?: string,
    agentAction?: string,
    claimURL?: string,
    requestId?: string,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.upgradeURL = upgradeURL;
    this.agentAction = agentAction;
    this.claimURL = claimURL;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Build an ApiError from a parsed non-2xx response body.
 *
 * Single construction site for both `request<T>` and `requestMultipart<T>` so
 * the set of fields lifted off the api's error envelope can never drift between
 * the JSON and multipart code paths. The api's error envelope shape is
 * `{ ok:false, error, message, agent_action?, upgrade_url?, claim_url?,
 *    request_id, retry_after_seconds? }` (api/internal/handlers ErrorResponse).
 *
 * `request_id` is always present on a real api error; `retry_after_seconds` is
 * present on 429 and transient-backpressure envelopes. Both are coerced
 * defensively (a hostile/garbled body must not throw here) and only forwarded
 * when they are the right shape.
 */
function apiErrorFromEnvelope(status: number, data: unknown): ApiError {
  const err = (data ?? {}) as {
    error?: string;
    message?: string;
    upgrade_url?: string;
    agent_action?: string;
    claim_url?: string;
    request_id?: string;
    retry_after_seconds?: number;
  };
  const message = err.message ?? "upstream error";
  const requestId =
    typeof err.request_id === "string" && err.request_id.length > 0
      ? err.request_id
      : undefined;
  const retryAfterSeconds =
    typeof err.retry_after_seconds === "number" &&
    Number.isFinite(err.retry_after_seconds) &&
    err.retry_after_seconds >= 0
      ? err.retry_after_seconds
      : undefined;
  return new ApiError(
    status,
    message,
    err.error,
    err.upgrade_url,
    err.agent_action,
    err.claim_url,
    requestId,
    retryAfterSeconds
  );
}

/**
 * Validate that a base URL is well-formed and uses http(s). BUG-MCP-040:
 * `INSTANODE_API_URL=javascript:alert(1)` would otherwise produce mysterious
 * failures deep in fetch — refuse it up-front with a clear stderr message and
 * fall back to the default. Same intent as the CLI's safeBrowserURL.
 */
export function validateBaseURL(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") return null;
  if (!u.host) return null;
  return raw.trim();
}

export class InstantClient {
  private readonly baseURL: string;

  constructor(opts: ClientOptions = {}) {
    const requested =
      opts.baseURL ?? process.env["INSTANODE_API_URL"] ?? DEFAULT_BASE_URL;
    const validated = validateBaseURL(requested);
    if (validated === null && requested !== DEFAULT_BASE_URL) {
      // Operator passed a bad URL via env / opts. Warn on stderr and fall
      // back to the default rather than failing every subsequent call with
      // an opaque fetch error.
      process.stderr.write(
        `instanode-mcp: refusing INSTANODE_API_URL=${JSON.stringify(requested)} ` +
          `(must be http(s)://host). Falling back to ${DEFAULT_BASE_URL}.\n`
      );
    }
    this.baseURL = (validated ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /**
   * Public dashboard URL — where the agent should direct the user to claim an
   * anonymous resource. Reads INSTANODE_DASHBOARD_URL on every call so the user
   * can override for staging without restarting the MCP process.
   */
  dashboardURL(): string {
    return (process.env["INSTANODE_DASHBOARD_URL"] ?? DEFAULT_DASHBOARD_URL).replace(
      /\/$/,
      ""
    );
  }

  /**
   * API base URL (where /db/new, /claim, /start etc. live). Distinct from
   * `dashboardURL` — the dashboard host is for the human signin flow, the API
   * host is what /start redirects FROM. The `claim_resource` MCP tool builds
   * `{apiBaseURL}/start?t=<jwt>` because /start is a route on the API, not the
   * dashboard.
   */
  apiBaseURL(): string {
    return this.baseURL;
  }

  /** Read the bearer token fresh from the environment on every call. */
  private bearerToken(): string | undefined {
    const tok = process.env["INSTANODE_TOKEN"];
    return tok && tok.length > 0 ? tok : undefined;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    const tok = this.bearerToken();
    if (tok) {
      h["Authorization"] = `Bearer ${tok}`;
    }
    return h;
  }

  /**
   * Bare auth headers for multipart/form-data requests — we intentionally
   * omit Content-Type here so fetch() can set its own multipart boundary.
   */
  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": USER_AGENT,
    };
    const tok = this.bearerToken();
    if (tok) {
      h["Authorization"] = `Bearer ${tok}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { requireAuth?: boolean } = {}
  ): Promise<T> {
    if (opts.requireAuth && !this.bearerToken()) {
      throw new AuthRequiredError();
    }

    const url = `${this.baseURL}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(0, `network error reaching instanode.dev: ${msg}`);
    }

    const text = await resp.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON body. Never return raw HTML to the caller.
        if (!resp.ok) {
          throw new ApiError(resp.status, `upstream error (HTTP ${resp.status})`);
        }
        throw new ApiError(resp.status, "upstream returned non-JSON response");
      }
    }

    if (!resp.ok) {
      throw apiErrorFromEnvelope(resp.status, data);
    }

    // BugBash B16 F1 (regression of task #170 P0-1): empty 2xx bodies used to
    // leave `data` as undefined, and any caller that did `result.foo` blew up
    // with "Cannot read properties of undefined (reading 'foo')". Eight tools
    // hit this: redeploy, delete_resource, delete_deployment, get_deployment,
    // list_deployments, list_resources, get_api_token, claim_token — most
    // commonly redeploy + delete_*, which the API documents as bare 2xx (no
    // body). The previous fix only patched redeploy. Now: any 2xx with an
    // empty body returns a safe sentinel `{ok: true}` so the dereferencing
    // path stays alive. Callers that need richer fields handle the empty
    // case explicitly (see redeploy / deleteResource / deleteDeployment).
    if (data === undefined) {
      return { ok: true } as T;
    }
    return data as T;
  }

  /**
   * Send a multipart/form-data POST. Used for endpoints that upload binary
   * blobs (today: POST /deploy/new). The api accepts a `tarball` file part
   * plus arbitrary string fields (name, port, env, env_vars JSON).
   *
   * Mirrors `request<T>` for error handling — non-2xx bodies are coerced into
   * an ApiError carrying the api's `error` code and `upgrade_url` (if present).
   */
  async requestMultipart<T>(
    path: string,
    form: FormData,
    opts: { requireAuth?: boolean } = {}
  ): Promise<T> {
    if (opts.requireAuth && !this.bearerToken()) {
      throw new AuthRequiredError();
    }

    const url = `${this.baseURL}${path}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        // Do NOT set Content-Type — fetch fills in the boundary itself.
        headers: this.authHeaders(),
        body: form,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(0, `network error reaching instanode.dev: ${msg}`);
    }

    const text = await resp.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        if (!resp.ok) {
          throw new ApiError(resp.status, `upstream error (HTTP ${resp.status})`);
        }
        throw new ApiError(resp.status, "upstream returned non-JSON response");
      }
    }

    if (!resp.ok) {
      throw apiErrorFromEnvelope(resp.status, data);
    }

    // Same empty-2xx safe sentinel as request<T>(). See the long comment up
    // there for the why. requestMultipart() is only used for create_deploy
    // today, which always returns a JSON body, but mirroring the safety
    // makes the two paths drift-free.
    if (data === undefined) {
      return { ok: true } as T;
    }
    return data as T;
  }

  /**
   * Build a `{ name [, env] }` body for the /<resource>/new endpoints.
   *
   * CLI-MCP FINDING-8: `env` is the resource environment scope (development /
   * staging / production). The MCP previously dropped it entirely, so every
   * call landed in the server-side default (`development` per mig 026 /
   * CLAUDE.md convention #11) with no way for the agent to override. The
   * helper only sets the field when the caller actually passed a non-empty
   * string — undefined/empty preserves the server default and matches the
   * pre-fix request shape exactly (so the wire diff is opt-in).
   */
  private provisionBody(name: string, env?: string): { name: string; env?: string } {
    const body: { name: string; env?: string } = { name };
    if (typeof env === "string" && env.length > 0) body.env = env;
    return body;
  }

  /** POST /db/new — provision a Postgres database. `name` is required. */
  async createPostgres(name: string, env?: string): Promise<DatabaseProvisionResult> {
    return this.request<DatabaseProvisionResult>(
      "POST",
      "/db/new",
      this.provisionBody(name, env)
    );
  }

  /**
   * POST /vector/new — provision a pgvector-enabled Postgres database. `name`
   * is required client-side for parity with the other create_* tools (the
   * server allows it to be omitted, but every other endpoint requires it).
   * Optional `dimensions` is a documentation hint only — pgvector picks
   * dimensions per column at table-create time. Optional `env` lands the
   * resource in a specific env bucket (server default `development`).
   */
  async createVector(
    name: string,
    dimensions?: number,
    env?: string
  ): Promise<VectorProvisionResult> {
    const body: { name: string; dimensions?: number; env?: string } =
      this.provisionBody(name, env);
    if (typeof dimensions === "number") body.dimensions = dimensions;
    return this.request<VectorProvisionResult>("POST", "/vector/new", body);
  }

  /** POST /cache/new — provision a Redis cache. `name` is required. */
  async createCache(name: string, env?: string): Promise<CacheProvisionResult> {
    return this.request<CacheProvisionResult>(
      "POST",
      "/cache/new",
      this.provisionBody(name, env)
    );
  }

  /** POST /nosql/new — provision a MongoDB database. `name` is required. */
  async createNoSQL(name: string, env?: string): Promise<NoSQLProvisionResult> {
    return this.request<NoSQLProvisionResult>(
      "POST",
      "/nosql/new",
      this.provisionBody(name, env)
    );
  }

  /** POST /queue/new — provision a NATS JetStream queue. `name` is required. */
  async createQueue(name: string, env?: string): Promise<QueueProvisionResult> {
    return this.request<QueueProvisionResult>(
      "POST",
      "/queue/new",
      this.provisionBody(name, env)
    );
  }

  /** POST /storage/new — provision an S3-compatible object storage bucket prefix. `name` is required. */
  async createStorage(name: string, env?: string): Promise<StorageProvisionResult> {
    return this.request<StorageProvisionResult>(
      "POST",
      "/storage/new",
      this.provisionBody(name, env)
    );
  }

  /** POST /webhook/new — provision a webhook receiver. `name` is required. */
  async createWebhook(name: string, env?: string): Promise<WebhookProvisionResult> {
    return this.request<WebhookProvisionResult>(
      "POST",
      "/webhook/new",
      this.provisionBody(name, env)
    );
  }

  /**
   * GET /api/v1/resources — list resources for the authenticated team.
   *
   * The canonical route is `/api/v1/resources` (the previous `/api/me/resources`
   * path was never registered — every call 404'd). The live API returns
   * `{ ok, items, total }`; this helper unwraps to the raw items array so the
   * tool can iterate naturally.
   */
  async listResources(): Promise<Resource[]> {
    const wrapped = await this.request<{ ok: boolean; items: Resource[]; total: number }>(
      "GET",
      "/api/v1/resources",
      undefined,
      { requireAuth: true }
    );
    return wrapped.items ?? [];
  }

  /**
   * POST /claim — convert an anonymous onboarding JWT into a claimed team.
   *
   * Wire field name (B5-P1, 2026-05-20): the canonical request field is
   * `token`. The api still accepts the legacy `jwt` alias for backward
   * compatibility (dashboard, sdk-go, curl recipes) and prefers `token` when
   * both are present — but the openapi ClaimRequest schema marks `jwt` as
   * `deprecated: true`. New callers send `token`. We were previously the only
   * surface still sending `jwt`-as-canonical, contributing to the three-name
   * drift (jwt / token / INSTANODE_TOKEN) the api ClaimRequest doc calls out.
   *
   * Response: `{ok, team_id, user_id, session_token?, message?}` —
   * NOT the retired 201 direct-claim shape. See the ClaimResult interface.
   */
  async claimToken(jwt: string, email: string): Promise<ClaimResult> {
    return this.request<ClaimResult>(
      "POST",
      "/claim",
      { token: jwt, email },
      { requireAuth: false }
    );
  }

  /**
   * DELETE /api/v1/resources/{token} — soft-delete a resource (paid tier only).
   *
   * The path parameter is the resource's UUID token (the same value emitted
   * as `token` by every create_* response). Free-tier and anonymous resources
   * auto-expire and cannot be deleted manually — the API surfaces the upgrade
   * URL in the 403 envelope.
   */
  async deleteResource(token: string): Promise<DeleteResult> {
    return this.request<DeleteResult>(
      "DELETE",
      `/api/v1/resources/${encodeURIComponent(token)}`,
      undefined,
      { requireAuth: true }
    );
  }

  /**
   * POST /api/v1/auth/api-keys — mint a fresh bearer key for the authenticated team.
   *
   * Requires an existing bearer (you have to be signed in to mint another key).
   * The API returns the plaintext key exactly once in the `key` field — it is
   * never recoverable after this response. Default name "instanode-mcp" so the
   * dashboard's key list shows where the key came from.
   */
  async getApiToken(name?: string): Promise<ApiTokenResult> {
    const raw = await this.request<{
      ok: boolean;
      id: string;
      name: string;
      key: string;
      note?: string;
      created_at: string;
    }>(
      "POST",
      "/api/v1/auth/api-keys",
      { name: name && name.length > 0 ? name : "instanode-mcp", scopes: ["read", "write"] },
      { requireAuth: true }
    );
    return {
      ok: raw.ok,
      token: raw.key,
      // Mint returns no explicit expiry — keys are revocation-based, not
      // time-bound. Surface a sentinel (0) so the tool description can adapt.
      expires_in: 0,
    };
  }

  /**
   * POST /deploy/new — upload a tarball + Dockerfile and deploy. Multipart.
   *
   * `tarball_base64` is a base64-encoded gzip tar; we decode it to a Buffer
   * and attach it as the `tarball` form file. `resource_bindings` is merged
   * into `env_vars` as-is — the agent passes raw resource tokens (UUIDs) and
   * the api resolves them server-side at deploy time. We do not pre-resolve
   * here: that would round-trip every binding to GET /credentials and embed
   * the raw connection URLs in tool params, which the agent host may log.
   *
   * Returns the api's 202 response flattened so callers can read `deploy_id`,
   * `status`, `url`, and `build_logs_url` directly.
   */
  async createDeploy(params: CreateDeployParams): Promise<DeployResult> {
    const form = new FormData();

    // Decode the base64 tarball and attach as a binary file part.
    const tarball = Buffer.from(params.tarball_base64, "base64");

    // T17 P2 — enforce the 50 MiB cap CLIENT-SIDE so an oversized payload
    // fails BEFORE we open a multipart connection and stream the bytes
    // up to the api. Pre-fix the agent would base64-encode a giant
    // node_modules tree, the MCP would happily POST the whole thing, and
    // the api would 400 — wasting bandwidth and (depending on the host)
    // logging multi-MB strings.
    if (tarball.byteLength > MAX_TARBALL_BYTES) {
      throw new Error(
        `Tarball is too large: ${tarball.byteLength.toLocaleString()} bytes ` +
          `(decoded). The api accepts at most ${MAX_TARBALL_BYTES.toLocaleString()} ` +
          `bytes (50 MiB). Shrink the tarball: include only what \`docker build\` ` +
          `needs — exclude node_modules, .git, build artifacts, large media files. ` +
          `Add a .dockerignore to your project root.`
      );
    }

    const blob = new Blob([tarball], { type: "application/gzip" });
    form.append("tarball", blob, "app.tar.gz");

    // `name` is a required field on POST /deploy/new — always sent.
    form.append("name", params.name);
    if (typeof params.port === "number") form.append("port", String(params.port));
    if (params.env) form.append("env", params.env);

    // Private deploy + IP allowlist (Track A backend contract). Booleans and
    // arrays go through multipart as strings — the api parses them back. We
    // intentionally forward `private` even when false so the server can
    // distinguish "explicitly public" from "field omitted".
    //
    // T17 P2 — also enforce the api's allowed_ips ↔ private invariant
    // client-side. The api only consults allowed_ips when private===true;
    // passing allowed_ips without private silently drops the allowlist
    // (the agent thinks it restricted access, but the deploy was public).
    if (params.allowed_ips && params.allowed_ips.length > 0 && params.private !== true) {
      throw new Error(
        `allowed_ips was provided but \`private\` is not true. The api only ` +
          `consults allowed_ips when private=true; passing it without private ` +
          `would silently leave the deploy publicly reachable. Set \`private: true\` ` +
          `to use the allowlist, OR remove allowed_ips for a public deploy.`
      );
    }
    if (params.private === true && (!params.allowed_ips || params.allowed_ips.length === 0)) {
      throw new Error(
        `private=true requires a non-empty \`allowed_ips\` allowlist (otherwise ` +
          `the api returns 400 private_deploy_requires_allowed_ips). Pass at ` +
          `least one IP or CIDR, e.g. allowed_ips: ["203.0.113.42/32"].`
      );
    }
    if (typeof params.private === "boolean") {
      form.append("private", params.private ? "true" : "false");
    }
    if (params.allowed_ips && params.allowed_ips.length > 0) {
      form.append("allowed_ips", JSON.stringify(params.allowed_ips));
    }
    // Redeploy-in-place opt-in (api PR feat/deploy-new-redeploy-in-place).
    // Only forward when explicitly true — omitting the field keeps the api
    // on the legacy "mint a new app_id" path, preserving existing behaviour
    // for every caller that hasn't asked for in-place. Sending "false"
    // would also work server-side, but omitting it makes the wire trace
    // identical to pre-fix MCP versions for unaffected callers.
    if (params.redeploy === true) {
      form.append("redeploy", "true");
    }

    // Merge resource_bindings into env_vars. The api treats every value
    // either as plaintext, a vault://env/KEY ref, or — for deploy bindings —
    // a raw resource token that the server resolves to a connection URL
    // before injecting it into the running container.
    const merged: Record<string, string> = { ...(params.env_vars ?? {}) };
    if (params.resource_bindings) {
      for (const [k, v] of Object.entries(params.resource_bindings)) {
        merged[k] = v;
      }
    }
    if (Object.keys(merged).length > 0) {
      form.append("env_vars", JSON.stringify(merged));
    }

    const raw = await this.requestMultipart<{
      ok: boolean;
      item: Deployment;
      note?: string;
      upgrade?: string;
      upgrade_jwt?: string;
    }>("/deploy/new", form, { requireAuth: true });

    return {
      ok: raw.ok,
      deploy_id: raw.item.app_id,
      status: raw.item.status,
      url: raw.item.url ?? "",
      build_logs_url: `${this.baseURL}/deploy/${encodeURIComponent(raw.item.app_id)}/logs`,
      note: raw.note,
      upgrade: raw.upgrade,
      upgrade_jwt: raw.upgrade_jwt,
      item: raw.item,
    };
  }

  /**
   * POST /stacks/new — upload an instant.yaml manifest + one gzipped tarball
   * per declared service and deploy a multi-service bundle. Multipart.
   *
   * Anonymous-friendly: like /deploy/new the api accepts anonymous callers
   * (OptionalAuth — openapi.json:157), issuing the stack at the anonymous tier
   * with a 6h TTL (anonymousStackTTL — a stack is live compute, so the window
   * is tighter than the 24h anonymous RESOURCE TTL; api PR #214). This is the
   * CEO wedge: a single MCP call from a cold-start
   * agent → live bundle URL on *.deployment.instanode.dev, no card, no
   * dashboard round-trip.
   *
   * Multipart shape (per StackRequest in openapi.json):
   *   - `name`  — text field, required.
   *   - `manifest` — text field carrying the YAML body.
   *   - `<service-name>` — one binary file part PER service declared in the
   *     manifest, named after the service (e.g. `api`, `web`, `worker`).
   *   - `env` — optional text field (resource env scope).
   *
   * Returns the api's 202 StackResponse with stack_id, per-service status +
   * URL (exposed services only), and anonymous-tier CTA fields.
   */
  async createStack(params: CreateStackParams): Promise<StackResult> {
    const form = new FormData();

    form.append("name", params.name);
    form.append("manifest", params.manifest);
    if (typeof params.env === "string" && params.env.length > 0) {
      form.append("env", params.env);
    }

    // One file part per service. Enforce the per-tarball 50 MiB cap
    // client-side, mirroring the create_deploy guard — an oversized tarball
    // would otherwise stream multiple MB of base64 to the api just to be
    // rejected, with the agent host potentially logging the body.
    for (const [serviceName, b64] of Object.entries(params.service_tarballs)) {
      const tarball = Buffer.from(b64, "base64");
      if (tarball.byteLength > MAX_TARBALL_BYTES) {
        throw new Error(
          `Tarball for service "${serviceName}" is too large: ` +
            `${tarball.byteLength.toLocaleString()} bytes (decoded). ` +
            `The api accepts at most ${MAX_TARBALL_BYTES.toLocaleString()} ` +
            `bytes (50 MiB) per service. Shrink the tarball: include only ` +
            `what \`docker build\` needs — exclude node_modules, .git, build ` +
            `artifacts, large media. Add a .dockerignore.`
        );
      }
      const blob = new Blob([tarball], { type: "application/gzip" });
      form.append(serviceName, blob, `${serviceName}.tar.gz`);
    }

    // /stacks/new is OptionalAuth — anonymous callers are accepted with a 6h
    // TTL (anonymousStackTTL, api PR #214). Do NOT pass requireAuth here.
    return this.requestMultipart<StackResult>("/stacks/new", form);
  }

  /**
   * GET /stacks/{slug} — poll a stack's per-service status + URLs.
   *
   * The public `/stacks/{slug}` route mirrors the StackResponse shape returned
   * by POST /stacks/new (services array, expires_in, etc.) — distinct from
   * the dashboard-only `GET /api/v1/stacks/{slug}` which requires auth and
   * returns a flatter summary. Anonymous callers polling a stack they just
   * created use the public route, so this method is intentionally NOT
   * requireAuth.
   */
  async getStack(stackId: string): Promise<StackResult> {
    return this.request<StackResult>(
      "GET",
      `/stacks/${encodeURIComponent(stackId)}`
    );
  }

  /** GET /api/v1/deployments — list deployments for the authenticated team. */
  async listDeployments(): Promise<DeployListResult> {
    return this.request<DeployListResult>("GET", "/api/v1/deployments", undefined, {
      requireAuth: true,
    });
  }

  /** GET /api/v1/deployments/:id — fetch one deployment by app id. */
  async getDeployment(id: string): Promise<DeployGetResult> {
    return this.request<DeployGetResult>(
      "GET",
      `/api/v1/deployments/${encodeURIComponent(id)}`,
      undefined,
      { requireAuth: true }
    );
  }

  /**
   * POST /deploy/:id/redeploy — rebuild + rolling update an existing app.
   *
   * The api handler REQUIRES a fresh tarball multipart file part
   * (deploy.go:1245 `missing_tarball`); there is no tarball reuse anywhere
   * server-side. The previous bodyless version of this method always 400'd
   * with "Multipart field 'tarball' is required" — see AGENT-UX.md Path B.
   *
   * `tarball_base64` is the same shape `createDeploy()` accepts: base64-
   * encoded gzip tar (Dockerfile + source), capped at 50 MiB after decode.
   * The 50 MiB ceiling is enforced client-side BEFORE the upload so an
   * oversized payload fails fast with a clear error instead of round-
   * tripping multiple MB of base64 to the api.
   *
   * The live api returns a bare 202 with no body (see openapi.json). The
   * request<T>() empty-2xx sentinel resolves it to `{ok: true}`; this
   * helper layers the caller-supplied id on top so the tool handler has a
   * stable surface to read.
   */
  async redeploy(id: string, tarballBase64: string): Promise<RedeployResult> {
    const form = new FormData();

    const tarball = Buffer.from(tarballBase64, "base64");

    // Mirror the createDeploy guard — fail BEFORE opening a multipart
    // connection on an oversized payload. The api enforces 50 MiB
    // (deploy.go:1249 tarball_too_large); pre-empting it here surfaces a
    // precise error and avoids bandwidth burn.
    if (tarball.byteLength > MAX_TARBALL_BYTES) {
      throw new Error(
        `Tarball is too large: ${tarball.byteLength.toLocaleString()} bytes ` +
          `(decoded). The api accepts at most ${MAX_TARBALL_BYTES.toLocaleString()} ` +
          `bytes (50 MiB). Shrink the tarball: include only what \`docker build\` ` +
          `needs — exclude node_modules, .git, build artifacts, large media files. ` +
          `Add a .dockerignore to your project root.`
      );
    }

    const blob = new Blob([tarball], { type: "application/gzip" });
    form.append("tarball", blob, "app.tar.gz");

    const raw = await this.requestMultipart<RedeployResult>(
      `/deploy/${encodeURIComponent(id)}/redeploy`,
      form,
      { requireAuth: true }
    );
    return {
      ok: raw.ok ?? true,
      id: raw.id ?? id,
      status: raw.status ?? "building",
      message: raw.message,
    };
  }

  /** DELETE /deploy/:id — tear down the running pod + remove the record. */
  async deleteDeployment(id: string): Promise<DeployDeleteResult> {
    return this.request<DeployDeleteResult>(
      "DELETE",
      `/deploy/${encodeURIComponent(id)}`,
      undefined,
      { requireAuth: true }
    );
  }

  /**
   * GET /api/v1/capabilities — the live per-tier capability matrix.
   *
   * Auth-OPTIONAL (the api route is registered directly on the app, NOT under
   * the RequireAuth group). An anonymous agent can read this to plan a call
   * BEFORE provisioning-to-discover-limits — e.g. "is a 1 GB Mongo within the
   * hobby cap, or do I need pro?" — instead of hitting a 402 mid-flow. With a
   * bearer set the call still works identically (the response is the same for
   * every caller; the tier matrix is not per-user). We therefore do NOT pass
   * requireAuth — forcing a token here would defeat the whole point of a
   * pre-flight discovery surface for cold-start agents.
   *
   * The response is cached `max-age=60` by the api (the matrix is immutable for
   * the life of the running pod); callers that poll tighter than that get the
   * edge-cached copy.
   */
  async getCapabilities(): Promise<CapabilitiesResult> {
    const raw = await this.request<CapabilitiesResult>(
      "GET",
      "/api/v1/capabilities"
    );
    return { ...raw, tiers: raw.tiers ?? [] };
  }

  /**
   * GET /api/v1/deployments/:id/events — the failure-timeline autopsy rows.
   *
   * Auth-REQUIRED (the route lives under the /api/v1 RequireAuth group). The
   * `:id` is the public app_id (the same value emitted as `deploy_id` by
   * create_deploy / `app_id` by get_deployment), NOT the internal UUID returned
   * in the body's `deployment_id`. RBAC mirrors GET /deployments/:id: a
   * cross-team or unknown id returns an indistinguishable 404 (the api never
   * confirms the existence of another team's deployment).
   *
   * Optional `limit` is forwarded as a query param (api default 50, clamped to
   * a max server-side). The api orders events DESC by created_at (newest first)
   * so the most recent failure is `events[0]`.
   */
  async getDeploymentEvents(
    id: string,
    limit?: number
  ): Promise<DeploymentEventsResult> {
    let path = `/api/v1/deployments/${encodeURIComponent(id)}/events`;
    if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
      path += `?limit=${limit}`;
    }
    const raw = await this.request<DeploymentEventsResult>(
      "GET",
      path,
      undefined,
      { requireAuth: true }
    );
    return {
      ok: raw.ok ?? true,
      deployment_id: raw.deployment_id,
      events: raw.events ?? [],
      count: typeof raw.count === "number" ? raw.count : (raw.events ?? []).length,
    };
  }

  /**
   * PUT /api/v1/vault/:env/:key — write (always-new-version) a secret.
   *
   * The body is `{value}`; the api creates a fresh version on every call. Auth
   * REQUIRED (vault is a paid-tier feature — hobby+ has 20 entries, pro/team
   * unlimited; anonymous/free 403 `vault_not_available`). `env` and `key` are
   * path params; we encode each segment so a key like `DATABASE_URL` (or a key
   * containing a dot) round-trips cleanly. Returns `{ok, key, env, version}` —
   * the plaintext value is never echoed back.
   */
  async setVaultKey(
    env: string,
    key: string,
    value: string
  ): Promise<VaultWriteResult> {
    return this.request<VaultWriteResult>(
      "PUT",
      `/api/v1/vault/${encodeURIComponent(env)}/${encodeURIComponent(key)}`,
      { value },
      { requireAuth: true }
    );
  }

  /**
   * POST /api/v1/vault/:env/:key/rotate — rotate a secret's value.
   *
   * Functionally identical to setVaultKey (mints a new version) but exposed
   * under a distinct audit action so the vault audit log distinguishes an
   * intentional rotation from an ordinary write. Body `{value}` is the NEW
   * secret value. Auth REQUIRED. Returns `{ok, key, env, version}`.
   */
  async rotateVaultKey(
    env: string,
    key: string,
    value: string
  ): Promise<VaultWriteResult> {
    return this.request<VaultWriteResult>(
      "POST",
      `/api/v1/vault/${encodeURIComponent(env)}/${encodeURIComponent(key)}/rotate`,
      { value },
      { requireAuth: true }
    );
  }

  /**
   * PATCH /deploy/:id/env — merge env vars into an existing deployment.
   *
   * The `:id` is the public app_id. The api merges the supplied keys into the
   * deployment's existing env (incoming wins) and returns the merged map with
   * secret values redacted. Auth REQUIRED. A redeploy is needed to apply the
   * change — the api's `note` says so and the tool surfaces it.
   */
  async updateDeployEnv(
    id: string,
    env: Record<string, string>
  ): Promise<UpdateDeployEnvResult> {
    const raw = await this.request<UpdateDeployEnvResult>(
      "PATCH",
      `/deploy/${encodeURIComponent(id)}/env`,
      { env },
      { requireAuth: true }
    );
    return { ok: raw.ok ?? true, env: raw.env ?? {}, note: raw.note };
  }

  /**
   * PATCH /stacks/:slug/env — merge env vars into an existing stack.
   *
   * Transactionally row-locked server-side (no lost updates across concurrent
   * PATCHes). An empty-string value DELETES that key. The `:slug` is the
   * stack_id from create_stack. Auth REQUIRED (anonymous stacks cannot be
   * mutated). Returns the merged map (redacted) + a redeploy reminder.
   */
  async updateStackEnv(
    slug: string,
    env: Record<string, string>
  ): Promise<UpdateStackEnvResult> {
    const raw = await this.request<UpdateStackEnvResult>(
      "PATCH",
      `/stacks/${encodeURIComponent(slug)}/env`,
      { env },
      { requireAuth: true }
    );
    return { ok: raw.ok ?? true, env: raw.env ?? {}, message: raw.message };
  }

  /**
   * POST /storage/:token/presign — mint a short-lived presigned S3 URL.
   *
   * Auth is the storage token in the URL (broker mode), so this is NOT
   * requireAuth: an anonymous caller can presign against a prefix it just
   * provisioned. A session bearer, when set, is cross-checked server-side
   * against the resource's team. Body carries `{operation, key, expires_in}`.
   * Returns `{ok, url, method, key, object_key, expires_at}`.
   */
  async presignStorage(params: PresignStorageParams): Promise<PresignStorageResult> {
    const body: { operation: string; key: string; expires_in?: number } = {
      operation: params.operation,
      key: params.key,
    };
    if (typeof params.expires_in === "number") body.expires_in = params.expires_in;
    return this.request<PresignStorageResult>(
      "POST",
      `/storage/${encodeURIComponent(params.token)}/presign`,
      body
    );
  }

  /**
   * POST /api/v1/resources/:id/pause — suspend a resource without deleting it.
   *
   * The `:id` is the resource token. Storage is preserved; the connection URL
   * is unchanged; new connections are refused until resume. Pro+ only (402),
   * already-paused → 409. Auth REQUIRED. The api returns a body carrying the
   * flat fields plus a `resource` object; we surface the flat fields.
   */
  async pauseResource(token: string): Promise<ResourcePauseResumeResult> {
    return this.request<ResourcePauseResumeResult>(
      "POST",
      `/api/v1/resources/${encodeURIComponent(token)}/pause`,
      undefined,
      { requireAuth: true }
    );
  }

  /**
   * POST /api/v1/resources/:id/resume — un-pause a previously-paused resource.
   *
   * Flips status back to 'active' and re-grants the provider credential. The
   * connection URL is preserved unchanged so the customer's config still works.
   * Pro+ only (402), not-paused → 409. Auth REQUIRED.
   */
  async resumeResource(token: string): Promise<ResourcePauseResumeResult> {
    return this.request<ResourcePauseResumeResult>(
      "POST",
      `/api/v1/resources/${encodeURIComponent(token)}/resume`,
      undefined,
      { requireAuth: true }
    );
  }

  /**
   * POST /api/v1/resources/:id/rotate-credentials — rotate a resource password.
   *
   * Returns the NEW connection_url in plaintext (host + database name unchanged;
   * only the credential rotates). An attacker holding the old leaked URL is
   * locked out; the new URL keeps working. Auth REQUIRED. Treat the returned
   * connection_url as a secret.
   */
  async rotateCredentials(token: string): Promise<RotateCredentialsResult> {
    return this.request<RotateCredentialsResult>(
      "POST",
      `/api/v1/resources/${encodeURIComponent(token)}/rotate-credentials`,
      undefined,
      { requireAuth: true }
    );
  }

  /**
   * POST /deploy/:id/wake — explicitly wake a scaled-to-zero deployment.
   *
   * FLAG-GATED server-side (DEPLOY_SCALE_TO_ZERO_ENABLED): when the flag is OFF
   * the api returns 501 `scale_to_zero_disabled` and the tool surfaces that
   * verbatim. When ON, scales the app back to 1 replica + refreshes the
   * activity stamp. Auth REQUIRED. The pod still cold-starts before serving.
   */
  async wakeDeployment(id: string): Promise<WakeDeploymentResult> {
    return this.request<WakeDeploymentResult>(
      "POST",
      `/deploy/${encodeURIComponent(id)}/wake`,
      undefined,
      { requireAuth: true }
    );
  }
}
