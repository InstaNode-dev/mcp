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
 */

const DEFAULT_BASE_URL = "https://api.instanode.dev";

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

export interface DatabaseProvisionResult {
  ok: boolean;
  id: string;
  token: string;
  name?: string;
  connection_url: string;
  tier: string;
  limits: ProvisionLimits;
  note?: string;
}

export interface WebhookProvisionResult {
  ok: boolean;
  id: string;
  token: string;
  name?: string;
  receive_url: string;
  tier: string;
  limits: ProvisionLimits;
  note?: string;
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

  constructor(status: number, message: string, code?: string, upgradeURL?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.upgradeURL = upgradeURL;
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

  /** Read the bearer token fresh from the environment on every call. */
  private bearerToken(): string | undefined {
    const tok = process.env["INSTANODE_TOKEN"];
    return tok && tok.length > 0 ? tok : undefined;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "instanode-mcp/0.7.0",
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
      };
      const message = err.message ?? "upstream error";
      throw new ApiError(resp.status, message, err.error, err.upgrade_url);
    }

    return data as T;
  }

  /** POST /db/new — provision a Postgres database. `name` is required. */
  async createPostgres(name: string): Promise<DatabaseProvisionResult> {
    return this.request<DatabaseProvisionResult>("POST", "/db/new", { name });
  }

  /** POST /webhook/new — provision a webhook receiver. `name` is required. */
  async createWebhook(name: string): Promise<WebhookProvisionResult> {
    return this.request<WebhookProvisionResult>("POST", "/webhook/new", { name });
  }

  /** GET /api/me/resources — list resources claimed by the authenticated caller. Requires bearer. */
  async listResources(): Promise<Resource[]> {
    return this.request<Resource[]>("GET", "/api/me/resources", undefined, {
      requireAuth: true,
    });
  }

  /** POST /api/me/claim — attach an anonymous token to the authenticated account. */
  async claimToken(token: string): Promise<ClaimResult> {
    return this.request<ClaimResult>(
      "POST",
      "/api/me/claim",
      { token },
      { requireAuth: true }
    );
  }

  /** DELETE /api/me/resources/{token} — paid-only hard-delete. */
  async deleteResource(token: string): Promise<DeleteResult> {
    return this.request<DeleteResult>(
      "DELETE",
      `/api/me/resources/${encodeURIComponent(token)}`,
      undefined,
      { requireAuth: true }
    );
  }

  /** GET /api/me/token — mint a fresh bearer JWT. Requires an existing bearer or session cookie. */
  async getApiToken(): Promise<ApiTokenResult> {
    return this.request<ApiTokenResult>("GET", "/api/me/token", undefined, {
      requireAuth: true,
    });
  }
}
