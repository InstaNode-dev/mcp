/**
 * Hermetic in-process mock of the instanode.dev agent API.
 *
 * The MCP server's only dependency on the outside world is the HTTP REST API
 * documented at https://api.instanode.dev/openapi.json. This module stands up
 * a real `http.Server` on an ephemeral port that implements that contract
 * faithfully enough to exercise every MCP tool end-to-end — success paths,
 * error envelopes (401 / 402 / 403 / 429 / 400), the multipart /deploy/new
 * upload, and malformed-input handling — with NO external network access.
 *
 * The integration suite points the spawned MCP server at this mock via the
 * INSTANODE_API_URL env var, so `npm test` runs identically in CI and locally.
 *
 * The mock also keeps an in-memory ledger of every resource / deployment it
 * "created" so the test suite's cleanup sweep can assert that nothing leaked.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/** A resource the mock has "provisioned". */
export interface MockResource {
  id: string;
  token: string;
  resource_type: string;
  tier: string;
  status: string;
  name: string;
  created_at: string;
  expires_at: string | null;
}

/** A deployment the mock has "accepted". */
export interface MockDeployment {
  id: string;
  app_id: string;
  token: string;
  port: number;
  tier: string;
  status: string;
  url: string;
  env: Record<string, string>;
  environment: string;
  private: boolean;
  allowed_ips: string[];
  created_at: string;
  updated_at: string;
}

/** A stack the mock has "accepted" via POST /stacks/new. */
export interface MockStackService {
  name: string;
  status: string;
  port: number;
  expose: boolean;
  url: string;
}

export interface MockStack {
  stack_id: string;
  name: string;
  tier: string;
  env: string;
  status: string;
  services: MockStackService[];
  created_at: string;
  expires_at: string | null;
  upgrade_jwt?: string;
}

/**
 * The bearer token the mock recognises as a valid paid-tier credential.
 * Any other Authorization value is treated as a bad token (401). Requests
 * with no Authorization header are treated as anonymous.
 */
export const VALID_TOKEN = "test-bearer-pro-tier";

/** A token the mock rejects with 401 — used to exercise bad-auth handling. */
export const BAD_TOKEN = "test-bearer-revoked";

/**
 * A valid bearer token whose AuthMode is "pat" (Personal Access Token).
 *
 * The live API enforces "PATs cannot mint other PATs" — `POST /api/v1/auth/api-keys`
 * returns 403 when the caller is themselves a PAT. The mock mirrors that contract
 * via this fixture: any request authenticated with `PAT_TOKEN` is treated as a PAT,
 * and `/api/v1/auth/api-keys` will return 403 with the documented error.
 *
 * Real-world note: the dashboard's "API token" UI mints PATs, and the MCP's
 * `get_api_token` tool itself mints PATs. So the typical `INSTANODE_TOKEN`
 * value IS a PAT — meaning `get_api_token` would 403 in its documented
 * "rotate as needed" use case. The MCP's `get_api_token` tool surfaces a
 * clear "use a session token, not a PAT" message on this 403; this fixture
 * lets the integration test pin that behavior.
 */
export const PAT_TOKEN = "test-bearer-pat-pro-tier";

/**
 * A valid bearer token whose plan tier is "hobby".
 *
 * Used to exercise the agent-facing tier-gate (402) error mapping END-TO-END
 * through a real MCP tool call. The hobby plan cannot create private deploys
 * (private deploys require Pro+), so a `create_deploy` with `private: true`
 * authenticated as HOBBY_TOKEN returns 402 `tier_upgrade_required` carrying an
 * `agent_action` + `upgrade_url`. Before this fixture the only way the mock
 * produced that 402 was an `x-mock-tier: hobby` request header the real
 * InstantClient never sends — so the agent_action surfacing path was unreachable
 * through an actual tool invocation. Keying it off the bearer makes the 402 path
 * reachable the same way prod reaches it (the api derives tier from the team
 * behind the token).
 */
export const HOBBY_TOKEN = "test-bearer-hobby-tier";

export interface MockApiHandle {
  /** Base URL the MCP server should be pointed at (INSTANODE_API_URL). */
  url: string;
  /** Underlying server, for shutdown. */
  server: Server;
  /** Every resource the mock currently believes is live (not deleted). */
  liveResources(): MockResource[];
  /** Every deployment the mock currently believes is live (not deleted). */
  liveDeployments(): MockDeployment[];
  /** Every stack the mock currently believes is live (not deleted). */
  liveStacks(): MockStack[];
  /** Total count of create_* calls received, for sanity assertions. */
  provisionCount(): number;
  /** Total count of /deploy/new calls received. */
  deployCount(): number;
  /** Total count of /stacks/new calls received. */
  stackCount(): number;
  /** Shut the server down. */
  close(): Promise<void>;
}

interface State {
  resources: Map<string, MockResource>;
  deployments: Map<string, MockDeployment>;
  stacks: Map<string, MockStack>;
  provisionCalls: number;
  deployCalls: number;
  stackCalls: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiry24h(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

/** Classify the inbound Authorization header. */
type AuthState = "anonymous" | "valid" | "pat" | "hobby" | "bad";
function classifyAuth(req: IncomingMessage): AuthState {
  const h = req.headers["authorization"];
  if (!h) return "anonymous";
  const m = /^Bearer\s+(.+)$/.exec(Array.isArray(h) ? h[0] : h);
  if (!m) return "bad";
  if (m[1] === VALID_TOKEN) return "valid";
  if (m[1] === PAT_TOKEN) return "pat";
  if (m[1] === HOBBY_TOKEN) return "hobby";
  return "bad";
}

/**
 * Live API name pattern: 1-64 chars, must start with a letter or digit, then
 * letters/digits/spaces/underscores/hyphens. Sourced verbatim from
 * `ProvisionRequest.name.pattern` in api/internal/handlers/openapi.go (and the
 * runtime validator in provision_helper.go:558-662). The previous mock only
 * checked `name.length===0` which masked the MCP's name-pattern gap — adding
 * the regex here means the mock now rejects bad names with `invalid_name`
 * the same way prod does.
 */
const API_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

/** Returns the validation error code (or null if name is valid). */
function validateName(name: unknown): { error: string; message: string } | null {
  if (typeof name !== "string" || name.length === 0) {
    return { error: "name_required", message: "name is required" };
  }
  if (name.length > 64) {
    return { error: "invalid_name", message: "name must be 1-64 characters" };
  }
  if (!API_NAME_PATTERN.test(name)) {
    return {
      error: "invalid_name",
      message:
        "name must start with a letter or digit, then letters/digits/spaces/underscores/hyphens",
    };
  }
  return null;
}

/** Standard error envelope, matching the real API's shape. */
function errorEnvelope(opts: {
  error?: string;
  message: string;
  upgrade_url?: string;
  agent_action?: string;
  claim_url?: string;
}): Record<string, unknown> {
  const e: Record<string, unknown> = { ok: false, message: opts.message };
  if (opts.error) e["error"] = opts.error;
  if (opts.upgrade_url) e["upgrade_url"] = opts.upgrade_url;
  if (opts.agent_action) e["agent_action"] = opts.agent_action;
  if (opts.claim_url) e["claim_url"] = opts.claim_url;
  return e;
}

/**
 * Build a provisioning response for a create_* endpoint. `auth` controls the
 * tier and whether an upgrade/claim block is attached.
 */
function provisionResponse(
  state: State,
  resourceType: string,
  name: string,
  auth: AuthState,
  extra: Record<string, unknown>
): Record<string, unknown> {
  const id = randomUUID();
  const token = randomUUID();
  const paid = auth === "valid" || auth === "pat" || auth === "hobby";
  const tier = paid ? (auth === "hobby" ? "hobby" : "pro") : "anonymous";
  const resource: MockResource = {
    id,
    token,
    resource_type: resourceType,
    tier,
    status: "active",
    name,
    created_at: nowIso(),
    expires_at: paid ? null : expiry24h(),
  };
  state.resources.set(token, resource);
  state.provisionCalls += 1;

  const body: Record<string, unknown> = {
    ok: true,
    id,
    token,
    name,
    tier,
    env: "development",
    expires_at: resource.expires_at,
    limits: paid
      ? { storage_mb: 10240, connections: 20 }
      : { storage_mb: 10, connections: 2, expires_in: "24h" },
    ...extra,
  };
  if (!paid) {
    body["note"] =
      "Anonymous resource — expires in 24h. Claim it to keep it permanently.";
    body["upgrade"] = "https://api.instanode.dev/start?t=mock.upgrade.jwt";
    body["upgrade_jwt"] = "mock.upgrade.jwt";
  }
  return body;
}

/**
 * Parse a multipart/form-data body just enough to confirm the deploy upload
 * carries the `tarball` file part + `name` field. We do not need a full RFC
 * parser — we only assert structure.
 */
function parseMultipart(
  buf: Buffer,
  contentType: string
): { hasTarball: boolean; fields: Record<string, string>; fileParts: string[] } {
  // CodeQL js/polynomial-redos: cap the capture group length so the regex
  // can't backtrack on a giant adversarial Content-Type header. RFC 7578
  // multipart boundaries are a 1-70 character token; 200 here is generous
  // but bounded so the engine runs in O(n) rather than O(n^2).
  const m = /boundary=([^;\s]{1,200})/.exec(contentType);
  const fields: Record<string, string> = {};
  const fileParts: string[] = [];
  if (!m) return { hasTarball: false, fields, fileParts };
  const boundary = `--${m[1]}`;
  const text = buf.toString("latin1");
  const parts = text.split(boundary).slice(1, -1);
  let hasTarball = false;
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const value = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const isFile = fieldName === "tarball" || headers.includes("filename=");
    if (isFile) {
      hasTarball = true;
      fileParts.push(fieldName);
    } else {
      fields[fieldName] = value;
    }
  }
  return { hasTarball, fields, fileParts };
}

/**
 * Start the mock API. Resolves once it is listening on an ephemeral port.
 */
export function startMockApi(): Promise<MockApiHandle> {
  const state: State = {
    resources: new Map(),
    deployments: new Map(),
    stacks: new Map(),
    provisionCalls: 0,
    deployCalls: 0,
    stackCalls: 0,
  };

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, state);
    } catch (err) {
      sendJSON(res, 500, errorEnvelope({ message: `mock internal error: ${String(err)}` }));
    }
  });

  return new Promise((resolveHandle) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("mock api failed to bind a port");
      }
      const url = `http://127.0.0.1:${addr.port}`;
      resolveHandle({
        url,
        server,
        liveResources: () =>
          [...state.resources.values()].filter((r) => r.status !== "deleted"),
        liveDeployments: () =>
          [...state.deployments.values()].filter((d) => d.status !== "deleted"),
        liveStacks: () =>
          [...state.stacks.values()].filter((s) => s.status !== "deleted"),
        provisionCount: () => state.provisionCalls,
        deployCount: () => state.deployCalls,
        stackCount: () => state.stackCalls,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            // Drop any keep-alive sockets so close() resolves promptly even
            // if a spawned MCP server's HTTP agent left a socket pooled.
            server.closeAllConnections();
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, state: State): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const fullUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = fullUrl.pathname;
  const auth = classifyAuth(req);

  // A bad bearer token is rejected up-front on every route, mirroring the
  // real API's auth middleware.
  if (auth === "bad") {
    sendJSON(
      res,
      401,
      errorEnvelope({
        error: "unauthorized",
        message: "invalid or revoked bearer token",
      })
    );
    return;
  }

  // ── create_* provisioning routes ──────────────────────────────────────────
  const provisionRoutes: Record<string, string> = {
    "/db/new": "postgres",
    "/vector/new": "postgres",
    "/cache/new": "cache",
    "/nosql/new": "nosql",
    "/queue/new": "queue",
    "/storage/new": "storage",
    "/webhook/new": "webhook",
  };
  if (method === "POST" && path in provisionRoutes) {
    const resourceType = provisionRoutes[path];
    const raw = await readBody(req);
    let parsed: { name?: unknown };
    try {
      parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      sendJSON(res, 400, errorEnvelope({ error: "bad_request", message: "malformed JSON body" }));
      return;
    }
    const nameErr = validateName(parsed.name);
    if (nameErr) {
      sendJSON(res, 400, errorEnvelope(nameErr));
      return;
    }
    const name = parsed.name as string;
    const extra: Record<string, unknown> = {};
    if (resourceType === "postgres" || resourceType === "cache" || resourceType === "nosql" || resourceType === "queue") {
      const scheme =
        resourceType === "postgres"
          ? "postgres"
          : resourceType === "cache"
            ? "redis"
            : resourceType === "nosql"
              ? "mongodb"
              : "nats";
      extra["connection_url"] = `${scheme}://user:pass@mock-host:5432/db_${randomUUID().slice(0, 8)}`;
    } else if (resourceType === "storage") {
      const prefix = `prefix-${randomUUID().slice(0, 8)}`;
      extra["connection_url"] = `https://nyc3.mock-spaces.com/instant-shared/${prefix}/`;
      extra["endpoint"] = "https://nyc3.mock-spaces.com";
      extra["access_key_id"] = `AK${randomUUID().slice(0, 12)}`;
      extra["secret_access_key"] = `SK${randomUUID()}`;
      extra["prefix"] = prefix;
    } else if (resourceType === "webhook") {
      extra["receive_url"] = `http://127.0.0.1/webhook/${randomUUID()}`;
    }
    sendJSON(res, 201, provisionResponse(state, resourceType, name, auth, extra));
    return;
  }

  // Any authenticated session — covers session JWTs *and* PATs (any plan tier,
  // including the hobby fixture). The /api/v1/auth/api-keys route is the one
  // exception (it requires a session, not a PAT) and handles that distinction in
  // its own branch below.
  const authed = auth === "valid" || auth === "pat" || auth === "hobby";

  // ── POST /claim ────────────────────────────────────────────────────────────
  // Per openapi.json: returns 200 ClaimResponse {ok, team_id, user_id, session_token,
  // message} — the magic-link flow. The legacy 201 direct-claim shape (the old
  // {id, token, resource_type, tier, status} body) has been retired in the live API.
  // Canonical request field is `token` (B5-P1, 2026-05-20); the legacy `jwt` alias
  // is still accepted server-side for backward compatibility — `token` wins on
  // collision. Mirror that here so we can verify MCP sends the canonical name.
  if (method === "POST" && path === "/claim") {
    const raw = await readBody(req);
    let parsed: { token?: unknown; jwt?: unknown; email?: unknown };
    try {
      parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      sendJSON(res, 400, errorEnvelope({ error: "bad_request", message: "malformed JSON body" }));
      return;
    }
    const tokField =
      typeof parsed.token === "string" && parsed.token.length > 0
        ? parsed.token
        : typeof parsed.jwt === "string" && parsed.jwt.length > 0
          ? parsed.jwt
          : "";
    if (tokField.length === 0) {
      sendJSON(res, 400, errorEnvelope({ error: "missing_token", message: "token is required" }));
      return;
    }
    if (typeof parsed.email !== "string" || parsed.email.length === 0) {
      sendJSON(res, 400, errorEnvelope({ error: "bad_request", message: "email is required" }));
      return;
    }
    if (tokField === "invalid.jwt") {
      sendJSON(
        res,
        409,
        errorEnvelope({ error: "already_claimed", message: "this JWT has already been claimed" })
      );
      return;
    }
    sendJSON(res, 200, {
      ok: true,
      team_id: randomUUID(),
      user_id: randomUUID(),
      session_token: `session.${randomUUID()}.jwt`,
      message: "Magic link sent to email",
    });
    return;
  }

  // ── GET /api/v1/resources ──────────────────────────────────────────────────
  if (method === "GET" && path === "/api/v1/resources") {
    if (!authed) {
      sendJSON(res, 401, errorEnvelope({ error: "unauthorized", message: "bearer token required" }));
      return;
    }
    const items = [...state.resources.values()].filter((r) => r.status !== "deleted");
    sendJSON(res, 200, { ok: true, items, total: items.length });
    return;
  }

  // ── DELETE /api/v1/resources/:token ────────────────────────────────────────
  if (method === "DELETE" && path.startsWith("/api/v1/resources/")) {
    if (!authed) {
      sendJSON(res, 401, errorEnvelope({ error: "unauthorized", message: "bearer token required" }));
      return;
    }
    const token = decodeURIComponent(path.slice("/api/v1/resources/".length));
    const resource = state.resources.get(token);
    if (!resource) {
      sendJSON(res, 404, errorEnvelope({ error: "not_found", message: "resource not found" }));
      return;
    }
    if (resource.tier === "anonymous" || resource.tier === "free") {
      sendJSON(
        res,
        403,
        errorEnvelope({
          error: "paid_tier_only",
          message: "free-tier resources auto-expire and cannot be deleted",
          upgrade_url: "https://instanode.dev/pricing",
        })
      );
      return;
    }
    resource.status = "deleted";
    sendJSON(res, 200, { ok: true, token, status: "deleted", message: "resource deleted" });
    return;
  }

  // ── POST /api/v1/auth/api-keys ─────────────────────────────────────────────
  // Per openapi.json: "PATs cannot mint other PATs (the request fails with 403 when
  // the caller is themselves a PAT, not a user session)." Mirrors api/internal/
  // handlers/openapi.go and the live api's auth middleware AuthMode==pat gate.
  // `name` is required (not optional) and scopes are restricted to read/write/admin.
  if (method === "POST" && path === "/api/v1/auth/api-keys") {
    if (!authed) {
      sendJSON(res, 401, errorEnvelope({ error: "unauthorized", message: "bearer token required" }));
      return;
    }
    if (auth === "pat") {
      sendJSON(
        res,
        403,
        errorEnvelope({
          error: "pat_cannot_mint_pat",
          message:
            "Personal Access Tokens cannot mint other PATs — use a browser session JWT (sign in at https://instanode.dev/dashboard).",
        })
      );
      return;
    }
    const raw = await readBody(req);
    let parsed: { name?: unknown; scopes?: unknown } = {};
    try {
      parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      sendJSON(res, 400, errorEnvelope({ error: "bad_request", message: "malformed JSON body" }));
      return;
    }
    if (typeof parsed.name !== "string" || parsed.name.length === 0) {
      sendJSON(res, 400, errorEnvelope({ error: "name_required", message: "name is required" }));
      return;
    }
    if (parsed.name.length > 120) {
      sendJSON(
        res,
        400,
        errorEnvelope({ error: "invalid_name", message: "name must be 1-120 characters" })
      );
      return;
    }
    if (parsed.scopes !== undefined) {
      if (!Array.isArray(parsed.scopes)) {
        sendJSON(
          res,
          400,
          errorEnvelope({ error: "invalid_scopes", message: "scopes must be an array of strings" })
        );
        return;
      }
      for (const s of parsed.scopes) {
        if (s !== "read" && s !== "write" && s !== "admin") {
          sendJSON(
            res,
            400,
            errorEnvelope({ error: "invalid_scopes", message: `invalid scope: ${String(s)}` })
          );
          return;
        }
      }
    }
    sendJSON(res, 201, {
      ok: true,
      id: randomUUID(),
      name: parsed.name,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes : ["read", "write", "admin"],
      key: `ik_live_${randomUUID().replace(/-/g, "")}`,
      created_at: nowIso(),
    });
    return;
  }

  // ── POST /deploy/new (multipart) ───────────────────────────────────────────
  if (method === "POST" && path === "/deploy/new") {
    if (!authed) {
      sendJSON(res, 401, errorEnvelope({ error: "unauthorized", message: "deploy requires authentication" }));
      return;
    }
    const ct = req.headers["content-type"] ?? "";
    const ctStr = Array.isArray(ct) ? ct[0] : ct;
    if (!ctStr.startsWith("multipart/form-data")) {
      sendJSON(
        res,
        400,
        errorEnvelope({ error: "bad_request", message: "deploy expects multipart/form-data" })
      );
      return;
    }
    const raw = await readBody(req);
    const { hasTarball, fields } = parseMultipart(raw, ctStr);
    if (!hasTarball) {
      sendJSON(
        res,
        400,
        errorEnvelope({ error: "bad_request", message: "tarball file part is required" })
      );
      return;
    }
    const nameErr = validateName(fields["name"]);
    if (nameErr) {
      sendJSON(res, 400, errorEnvelope(nameErr));
      return;
    }

    const isPrivate = fields["private"] === "true";
    // Tier resolution order:
    //   1. explicit `x-mock-tier` request header (legacy test override), else
    //   2. the tier behind the bearer — HOBBY_TOKEN → "hobby", any other valid
    //      paid token → "pro". This makes the private-deploy 402 reachable via a
    //      real `create_deploy({private:true})` call authenticated as HOBBY_TOKEN
    //      (the InstantClient never sends `x-mock-tier`), mirroring how prod
    //      derives the tier from the team behind the token.
    const tierOverride = req.headers["x-mock-tier"];
    const headerTier = Array.isArray(tierOverride) ? tierOverride[0] : tierOverride;
    const effectiveTier = headerTier ?? (auth === "hobby" ? "hobby" : "pro");
    if (isPrivate && effectiveTier === "hobby") {
      sendJSON(
        res,
        402,
        errorEnvelope({
          error: "tier_upgrade_required",
          message: "private deploys require Pro tier or higher",
          upgrade_url: "https://instanode.dev/pricing",
          agent_action:
            "Tell the user private deploys need the Pro plan — have them upgrade at https://instanode.dev/pricing",
        })
      );
      return;
    }

    let allowedIps: string[] = [];
    if (fields["allowed_ips"]) {
      try {
        const parsedIps = JSON.parse(fields["allowed_ips"]);
        if (Array.isArray(parsedIps)) allowedIps = parsedIps.map(String);
      } catch {
        sendJSON(
          res,
          400,
          errorEnvelope({ error: "bad_request", message: "allowed_ips must be a JSON array" })
        );
        return;
      }
    }
    let envVars: Record<string, string> = {};
    if (fields["env_vars"]) {
      try {
        const parsedEnv = JSON.parse(fields["env_vars"]);
        if (parsedEnv && typeof parsedEnv === "object") {
          envVars = parsedEnv as Record<string, string>;
        }
      } catch {
        sendJSON(
          res,
          400,
          errorEnvelope({ error: "bad_request", message: "env_vars must be a JSON object" })
        );
        return;
      }
    }

    // In-place redeploy support (api PR feat/deploy-new-redeploy-in-place):
    // when the multipart form carries `redeploy=true` AND there is an
    // existing deployment with the same `name` on the caller's team, the
    // api updates that deployment IN PLACE — same app_id, same URL — and
    // returns 202 with the existing item (status flipped back to building).
    // The mock matches by name across all live deployments since it has
    // no real team model.
    const wantInPlace = fields["redeploy"] === "true";
    const reqName = fields["name"] ?? "";
    if (wantInPlace && reqName !== "") {
      for (const existing of state.deployments.values()) {
        if (existing.status === "deleted") continue;
        // The mock stamps the user-supplied name into env["_name"] on
        // create-new (see below) so subsequent redeploy-by-name lookups
        // resolve without a separate team/name index. Real api uses the
        // (team_id, name) primary key — the mock doesn't model teams.
        if ((existing.env["_name"] ?? "") !== reqName) continue;
        // Update in place — status flips to building, URL cleared until
        // the next get_deployment poll flips it back to running.
        existing.status = "building";
        existing.url = "";
        existing.env = { ...envVars, _name: reqName };
        existing.updated_at = nowIso();
        state.deployCalls += 1;
        sendJSON(res, 202, {
          ok: true,
          item: existing,
          note: "In-place redeploy started — poll get_deployment until status=running.",
        });
        return;
      }
      // Fall through to create-new when no existing deployment matches.
    }

    // BUG-MCP-025: app_id is now validated as a UUID on the get/redeploy/
    // delete paths, matching the real API contract. The previous
    // `app-{shortid}` mock id silently passed because the schema was a
    // bare string; now the mock returns a UUID-shaped app_id like prod so
    // the test fixtures don't trip the schema.
    const id = randomUUID();
    const appId = id;
    const deployment: MockDeployment = {
      id,
      app_id: appId,
      token: appId,
      port: fields["port"] ? Number(fields["port"]) : 8080,
      tier: effectiveTier,
      status: "building",
      url: "",
      env: { ...envVars, _name: reqName },
      environment: fields["env"] ?? "production",
      private: isPrivate,
      allowed_ips: allowedIps,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.deployments.set(appId, deployment);
    state.deployCalls += 1;
    sendJSON(res, 202, {
      ok: true,
      item: deployment,
      note: "Build started — poll get_deployment until status=running.",
    });
    return;
  }

  // ── GET /api/v1/deployments ────────────────────────────────────────────────
  if (method === "GET" && path === "/api/v1/deployments") {
    if (!authed) {
      sendJSON(res, 401, errorEnvelope({ error: "unauthorized", message: "bearer token required" }));
      return;
    }
    const items = [...state.deployments.values()].filter((d) => d.status !== "deleted");
    sendJSON(res, 200, { ok: true, items, total: items.length });
    return;
  }

  // ── GET /api/v1/deployments/:id ────────────────────────────────────────────
  if (method === "GET" && path.startsWith("/api/v1/deployments/")) {
    if (!authed) {
      sendJSON(res, 401, errorEnvelope({ error: "unauthorized", message: "bearer token required" }));
      return;
    }
    const id = decodeURIComponent(path.slice("/api/v1/deployments/".length));
    const deployment = state.deployments.get(id);
    if (!deployment || deployment.status === "deleted") {
      sendJSON(res, 404, errorEnvelope({ error: "not_found", message: "deployment not found" }));
      return;
    }
    // Simulate the build completing: once polled, flip building → running.
    if (deployment.status === "building") {
      deployment.status = "running";
      deployment.url = `https://${deployment.app_id}.deployment.instanode.dev`;
      deployment.updated_at = nowIso();
    }
    sendJSON(res, 200, { ok: true, item: deployment });
    return;
  }

  // ── POST /deploy/:id/redeploy ──────────────────────────────────────────────
  // Per the real api (deploy.go:1245 missing_tarball): /deploy/:id/redeploy
  // REQUIRES a multipart `tarball` file part. The previous bodyless contract
  // was a bug — the api always rejected with 400 missing_tarball in prod.
  // The mock now enforces the real contract so the MCP client wiring
  // (multipart upload from the standalone redeploy tool) is exercised end-
  // to-end. Per openapi.json the response is a bare 202 with no body.
  if (method === "POST" && /^\/deploy\/[^/]+\/redeploy$/.test(path)) {
    if (!authed) {
      sendJSON(res, 401, errorEnvelope({ error: "unauthorized", message: "bearer token required" }));
      return;
    }
    const id = decodeURIComponent(path.slice("/deploy/".length, path.length - "/redeploy".length));
    const deployment = state.deployments.get(id);
    if (!deployment || deployment.status === "deleted") {
      sendJSON(res, 404, errorEnvelope({ error: "not_found", message: "deployment not found" }));
      return;
    }
    const ct = req.headers["content-type"] ?? "";
    const ctStr = Array.isArray(ct) ? ct[0] : ct;
    if (!ctStr.startsWith("multipart/form-data")) {
      sendJSON(
        res,
        400,
        errorEnvelope({ error: "invalid_form", message: "Request must be multipart/form-data with a 'tarball' field" })
      );
      return;
    }
    const raw = await readBody(req);
    const { hasTarball } = parseMultipart(raw, ctStr);
    if (!hasTarball) {
      sendJSON(
        res,
        400,
        errorEnvelope({ error: "missing_tarball", message: "Multipart field 'tarball' is required" })
      );
      return;
    }
    deployment.status = "building";
    deployment.url = "";
    deployment.updated_at = nowIso();
    // Bare 202 — Content-Length 0, no body. Matches the live API contract verbatim.
    res.writeHead(202);
    res.end();
    return;
  }

  // ── DELETE /deploy/:id ─────────────────────────────────────────────────────
  if (method === "DELETE" && /^\/deploy\/[^/]+$/.test(path)) {
    if (!authed) {
      sendJSON(res, 401, errorEnvelope({ error: "unauthorized", message: "bearer token required" }));
      return;
    }
    const id = decodeURIComponent(path.slice("/deploy/".length));
    const deployment = state.deployments.get(id);
    if (!deployment || deployment.status === "deleted") {
      sendJSON(res, 404, errorEnvelope({ error: "not_found", message: "deployment not found" }));
      return;
    }
    deployment.status = "deleted";
    sendJSON(res, 200, {
      ok: true,
      id: deployment.id,
      token: deployment.app_id,
      status: "deleted",
      message: "deployment torn down",
    });
    return;
  }

  // ── POST /stacks/new (multipart, OptionalAuth) ─────────────────────────────
  // Mirrors api/internal/handlers/stack.go:Create. The route is OptionalAuth
  // (openapi.json:157) — anonymous callers land at the anonymous tier with
  // a 24h TTL, authenticated callers inherit their team tier. The mock pins
  // the live contract: every service declared under `services:` in the YAML
  // manifest MUST have a matching multipart file part named after the
  // service.
  if (method === "POST" && path === "/stacks/new") {
    const ct = req.headers["content-type"] ?? "";
    const ctStr = Array.isArray(ct) ? ct[0] : ct;
    if (!ctStr.startsWith("multipart/form-data")) {
      sendJSON(
        res,
        400,
        errorEnvelope({ error: "bad_request", message: "stacks/new expects multipart/form-data" })
      );
      return;
    }
    const raw = await readBody(req);
    const { fields, fileParts } = parseMultipart(raw, ctStr);
    const nameErr = validateName(fields["name"]);
    if (nameErr) {
      sendJSON(res, 400, errorEnvelope(nameErr));
      return;
    }
    const manifest = fields["manifest"];
    if (typeof manifest !== "string" || manifest.length === 0) {
      sendJSON(
        res,
        400,
        errorEnvelope({ error: "manifest_required", message: "manifest is required" })
      );
      return;
    }

    // Discover service names from the manifest. The mock only needs to know
    // which services were declared so it can (a) assert that each has a
    // matching file part and (b) emit per-service entries in the response.
    // The api does a full YAML parse + dependency-graph build; the mock
    // matches simple `  <service-name>:` indented lines under `services:`.
    const declaredServices: { name: string; port: number; expose: boolean }[] = [];
    const lines = manifest.split(/\r?\n/);
    let inServices = false;
    let current: { name: string; port: number; expose: boolean } | null = null;
    for (const line of lines) {
      if (/^services:\s*$/.test(line)) {
        inServices = true;
        continue;
      }
      if (inServices && /^[A-Za-z]/.test(line)) {
        // Hit a new top-level key — services section ended.
        inServices = false;
        if (current) declaredServices.push(current);
        current = null;
        continue;
      }
      if (!inServices) continue;
      const svcMatch = /^ {2}([A-Za-z0-9_-]+):/.exec(line);
      if (svcMatch) {
        if (current) declaredServices.push(current);
        current = { name: svcMatch[1], port: 8080, expose: false };
        continue;
      }
      if (current) {
        const portMatch = /port:\s*(\d+)/.exec(line);
        if (portMatch) current.port = Number(portMatch[1]);
        if (/expose:\s*true/.test(line)) current.expose = true;
      }
    }
    if (current) declaredServices.push(current);

    if (declaredServices.length === 0) {
      sendJSON(
        res,
        400,
        errorEnvelope({
          error: "invalid_manifest",
          message: "manifest declares no services",
        })
      );
      return;
    }

    // Every declared `build:`-style service must have a matching file part.
    // The mock keeps this lenient — declaredServices includes inline-resource
    // services like `postgres: { kind: postgres }` which the api would
    // recognise as resources rather than build contexts. To keep the mock
    // small, we accept any subset of file parts that covers the services
    // whose name matches a fileParts entry, and require at least one match.
    const matchedServices = declaredServices.filter((s) => fileParts.includes(s.name));
    if (matchedServices.length === 0) {
      sendJSON(
        res,
        400,
        errorEnvelope({
          error: "missing_service_tarball",
          message: `no file part matched a declared service (declared: ${declaredServices.map((s) => s.name).join(",")}; file parts: ${fileParts.join(",") || "(none)"})`,
        })
      );
      return;
    }

    const paid = auth === "valid" || auth === "pat" || auth === "hobby";
    const tier = paid ? (auth === "hobby" ? "hobby" : "pro") : "anonymous";
    const stackId = `stk-${randomUUID().slice(0, 8)}`;
    const env = fields["env"] && fields["env"].length > 0 ? fields["env"] : "development";

    const services: MockStackService[] = declaredServices.map((s) => ({
      name: s.name,
      status: "building",
      port: s.port,
      expose: s.expose,
      url: "",
    }));
    const stack: MockStack = {
      stack_id: stackId,
      name: fields["name"] ?? "",
      tier,
      env,
      status: "building",
      services,
      created_at: nowIso(),
      expires_at: paid ? null : expiry24h(),
      upgrade_jwt: paid ? undefined : "mock.upgrade.jwt",
    };
    state.stacks.set(stackId, stack);
    state.stackCalls += 1;
    const body: Record<string, unknown> = {
      ok: true,
      stack_id: stackId,
      status: "building",
      tier,
      env,
      name: stack.name,
      services,
      expires_in: paid ? "" : "24h",
    };
    if (!paid) {
      body["note"] =
        "Anonymous stack — expires in 24h. Claim it to keep it permanently.";
      body["upgrade"] = "https://api.instanode.dev/start?t=mock.upgrade.jwt";
      body["upgrade_jwt"] = "mock.upgrade.jwt";
    }
    sendJSON(res, 202, body);
    return;
  }

  // ── GET /stacks/{slug} (public — no auth required) ─────────────────────────
  // Mirrors the public StackResponse-returning route. Distinct from the
  // dashboard-only GET /api/v1/stacks/{slug} (flatter summary, requires
  // auth). Anonymous callers can poll their own stacks.
  if (method === "GET" && /^\/stacks\/[^/]+$/.test(path)) {
    const slug = decodeURIComponent(path.slice("/stacks/".length));
    const stack = state.stacks.get(slug);
    if (!stack || stack.status === "deleted") {
      sendJSON(res, 404, errorEnvelope({ error: "not_found", message: "stack not found" }));
      return;
    }
    // Simulate the build completing: once polled, flip building → healthy and
    // hand out URLs for exposed services. The mock mirrors get_deployment's
    // building→running auto-flip so the test harness can exercise the poll
    // loop without sleeping.
    if (stack.status === "building") {
      stack.status = "healthy";
      for (const svc of stack.services) {
        svc.status = "healthy";
        if (svc.expose) {
          svc.url = `https://${stack.stack_id}-${svc.name}.deployment.instanode.dev`;
        }
      }
    }
    const paid = stack.tier !== "anonymous";
    const body: Record<string, unknown> = {
      ok: true,
      stack_id: stack.stack_id,
      status: stack.status,
      tier: stack.tier,
      env: stack.env,
      name: stack.name,
      services: stack.services,
      expires_in: paid ? "" : "24h",
    };
    if (!paid && stack.upgrade_jwt) {
      body["upgrade"] = `https://api.instanode.dev/start?t=${stack.upgrade_jwt}`;
      body["upgrade_jwt"] = stack.upgrade_jwt;
      body["note"] = "Anonymous stack — expires in 24h.";
    }
    sendJSON(res, 200, body);
    return;
  }

  // ── Unknown route ──────────────────────────────────────────────────────────
  sendJSON(res, 404, errorEnvelope({ error: "not_found", message: `no route for ${method} ${path}` }));
}
