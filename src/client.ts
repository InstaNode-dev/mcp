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
}

export interface DatabaseProvisionResult extends ProvisionResultBase {
  /** postgres://... connection string, drop-in DATABASE_URL. */
  connection_url: string;
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

/** Caller-supplied params for create_deploy. */
export interface CreateDeployParams {
  /** Base64-encoded gzip tarball (with Dockerfile + source). <50 MB after decode. */
  tarball_base64: string;
  /** Human-readable name shown on the dashboard. Required (1-64 chars). */
  name: string;
  /** Container HTTP port. Default 8080. */
  port?: number;
  /** Deploy env scope: production / staging / development. Default "production". */
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
}

export interface ClaimResult {
  ok: boolean;
  id: string;
  token: string;
  resource_type: string;
  name?: string;
  tier: string;
  status: string;
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

  constructor(
    status: number,
    message: string,
    code?: string,
    upgradeURL?: string,
    agentAction?: string,
    claimURL?: string
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.upgradeURL = upgradeURL;
    this.agentAction = agentAction;
    this.claimURL = claimURL;
  }
}

export class InstantClient {
  private readonly baseURL: string;

  constructor(opts: ClientOptions = {}) {
    this.baseURL = (
      opts.baseURL ??
      process.env["INSTANODE_API_URL"] ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, "");
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
      const err = (data ?? {}) as {
        error?: string;
        message?: string;
        upgrade_url?: string;
        agent_action?: string;
        claim_url?: string;
      };
      const message = err.message ?? "upstream error";
      throw new ApiError(
        resp.status,
        message,
        err.error,
        err.upgrade_url,
        err.agent_action,
        err.claim_url
      );
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
      const err = (data ?? {}) as {
        error?: string;
        message?: string;
        upgrade_url?: string;
        agent_action?: string;
        claim_url?: string;
      };
      const message = err.message ?? "upstream error";
      throw new ApiError(
        resp.status,
        message,
        err.error,
        err.upgrade_url,
        err.agent_action,
        err.claim_url
      );
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

  /** POST /db/new — provision a Postgres database. `name` is required. */
  async createPostgres(name: string): Promise<DatabaseProvisionResult> {
    return this.request<DatabaseProvisionResult>("POST", "/db/new", { name });
  }

  /** POST /cache/new — provision a Redis cache. `name` is required. */
  async createCache(name: string): Promise<CacheProvisionResult> {
    return this.request<CacheProvisionResult>("POST", "/cache/new", { name });
  }

  /** POST /nosql/new — provision a MongoDB database. `name` is required. */
  async createNoSQL(name: string): Promise<NoSQLProvisionResult> {
    return this.request<NoSQLProvisionResult>("POST", "/nosql/new", { name });
  }

  /** POST /queue/new — provision a NATS JetStream queue. `name` is required. */
  async createQueue(name: string): Promise<QueueProvisionResult> {
    return this.request<QueueProvisionResult>("POST", "/queue/new", { name });
  }

  /** POST /storage/new — provision an S3-compatible object storage bucket prefix. `name` is required. */
  async createStorage(name: string): Promise<StorageProvisionResult> {
    return this.request<StorageProvisionResult>("POST", "/storage/new", { name });
  }

  /** POST /webhook/new — provision a webhook receiver. `name` is required. */
  async createWebhook(name: string): Promise<WebhookProvisionResult> {
    return this.request<WebhookProvisionResult>("POST", "/webhook/new", { name });
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
   * Note: `/claim` requires {jwt, email} — it's the same flow the dashboard
   * uses. There is no programmatic "claim a token to an existing team" route;
   * the canonical claim primitive is identity-bound. Pass the upgrade_jwt
   * returned by any anonymous provisioning response.
   */
  async claimToken(jwt: string, email: string): Promise<ClaimResult> {
    return this.request<ClaimResult>(
      "POST",
      "/claim",
      { jwt, email },
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
   * The live API returns a bare 202 with no body (see openapi.json). Earlier
   * versions of this client typed the response as DeployGetResult and the
   * tool handler dereferenced `result.item.app_id`, throwing
   * "Cannot read properties of undefined (reading 'app_id')" on every real
   * call. BugBash B16 F1 (regression of task #170): the empty-body now
   * resolves to `{ok: true}` via the request<T>() empty-2xx sentinel; this
   * helper layers the caller-supplied id on top so the tool handler has a
   * stable surface to read.
   */
  async redeploy(id: string): Promise<RedeployResult> {
    const raw = await this.request<RedeployResult>(
      "POST",
      `/deploy/${encodeURIComponent(id)}/redeploy`,
      undefined,
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
}
