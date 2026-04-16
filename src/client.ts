/**
 * Thin HTTP client for the instant.dev REST API.
 *
 * Reads INSTANT_API_KEY and INSTANT_API_URL from the environment.
 * Falls back to anonymous mode (no key) and https://instant.dev.
 */

import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DEFAULT_BASE_URL = "https://instant.dev";

export interface ClientOptions {
  apiKey?: string;
  baseURL?: string;
}

export interface Resource {
  id: string;
  token: string;
  resource_type: string;
  tier: string;
  status: string;
  name?: string;
  cloud_vendor?: string;
  country_code?: string;
  expires_at?: string;
  team_id?: string;
  created_at: string;
}

export interface ResourceListResult {
  ok: boolean;
  items: Resource[];
  total: number;
}

export interface CacheProvisionResult {
  ok: boolean;
  id: string;
  token: string;
  connection_url: string;
  tier: string;
  name?: string;
  limits: Record<string, unknown>;
  note?: string;
  upgrade?: string;
}

export interface DocumentDBProvisionResult {
  ok: boolean;
  id: string;
  token: string;
  connection_url: string;
  tier: string;
  name?: string;
  limits: Record<string, unknown>;
  note?: string;
  upgrade?: string;
}

export interface DatabaseProvisionResult {
  ok: boolean;
  id: string;
  token: string;
  connection_url: string;
  tier: string;
  name?: string;
  limits: Record<string, unknown>;
  note?: string;
  upgrade?: string;
  expires_in?: string;
}

export interface QueueProvisionResult {
  ok: boolean;
  id: string;
  token: string;
  connection_url: string;
  tier: string;
  name?: string;
  limits: Record<string, unknown>;
  note?: string;
  upgrade?: string;
  expires_in?: string;
}

export interface StorageProvisionResult {
  ok: boolean;
  id: string;
  token: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  secret_access_key: string;
  tier: string;
  name?: string;
  limits: Record<string, unknown>;
  note?: string;
  upgrade?: string;
  expires_in?: string;
}

export interface WebhookProvisionResult {
  ok: boolean;
  id: string;
  token: string;
  receive_url: string;
  tier: string;
  name?: string;
  limits: Record<string, unknown>;
  note?: string;
  upgrade?: string;
  expires_in?: string;
}

export interface DeployResult {
  ok: boolean;
  id: string;
  token: string;
  app_id: string;
  app_url: string;
  status: string;
  tier: string;
  note?: string;
}

export interface StackDeployResult {
  ok: boolean;
  stack_id: string;
  slug: string;
  status: string;
  services: Array<{
    name: string;
    status: string;
    app_url?: string;
  }>;
  error?: string;
}

/**
 * Minimal YAML pre-parser: extracts service names and their build: paths
 * from an instant.yaml manifest. Only handles the `services:` block.
 * The server performs full YAML validation — this is just enough to know
 * which directories to tar up before posting.
 */
function parseManifestForServices(yaml: string): Record<string, string> {
  const services: Record<string, string> = {};
  const lines = yaml.split("\n");
  let inServices = false;
  let currentService = "";

  for (const line of lines) {
    if (line.trim() === "services:") {
      inServices = true;
      continue;
    }
    if (inServices) {
      // Top-level key change — exit services block
      if (/^[a-zA-Z]/.test(line) && !line.match(/^  /)) {
        inServices = false;
        continue;
      }
      const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
      if (serviceMatch) {
        currentService = serviceMatch[1];
        continue;
      }
      if (currentService) {
        const buildMatch = line.match(/^\s+build:\s+(.+)$/);
        if (buildMatch) {
          services[currentService] = buildMatch[1].trim();
        }
      }
    }
  }
  return services;
}

export class InstantClient {
  private readonly baseURL: string;
  private readonly apiKey: string | undefined;

  constructor(opts: ClientOptions = {}) {
    this.baseURL = (
      opts.baseURL ??
      process.env["INSTANT_API_URL"] ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, "");

    this.apiKey = opts.apiKey ?? process.env["INSTANT_API_KEY"];
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "instant-mcp/0.1",
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const resp = await fetch(url, init);
    const text = await resp.text();

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`instant.dev: non-JSON response (${resp.status}): ${text.slice(0, 200)}`);
    }

    if (!resp.ok) {
      const err = data as { error?: string; message?: string };
      throw new Error(
        `instant.dev API error ${resp.status}: ${err.error ?? err.message ?? text.slice(0, 200)}`
      );
    }

    return data as T;
  }

  /** GET /api/v1/resources — list all resources for the authenticated team. Requires INSTANT_API_KEY. */
  async listResources(): Promise<ResourceListResult> {
    return this.request<ResourceListResult>("GET", "/api/v1/resources");
  }

  /** POST /cache/new — provision a Redis cache instance. */
  async provisionCache(opts: { name?: string } = {}): Promise<CacheProvisionResult> {
    const body = opts.name ? { name: opts.name } : undefined;
    return this.request<CacheProvisionResult>("POST", "/cache/new", body);
  }

  /** POST /nosql/new — provision a MongoDB document database. */
  async provisionDocumentDB(opts: { name?: string } = {}): Promise<DocumentDBProvisionResult> {
    const body = opts.name ? { name: opts.name } : undefined;
    return this.request<DocumentDBProvisionResult>("POST", "/nosql/new", body);
  }

  /** POST /db/new — provision a PostgreSQL database. */
  async provisionDatabase(opts: { name?: string } = {}): Promise<DatabaseProvisionResult> {
    const body = opts.name ? { name: opts.name } : undefined;
    return this.request<DatabaseProvisionResult>("POST", "/db/new", body);
  }

  /** POST /queue/new — provision a NATS JetStream queue. */
  async provisionQueue(opts: { name?: string } = {}): Promise<QueueProvisionResult> {
    const body = opts.name ? { name: opts.name } : undefined;
    return this.request<QueueProvisionResult>("POST", "/queue/new", body);
  }

  /** POST /storage/new — provision an S3-compatible object storage prefix. */
  async provisionStorage(opts: { name?: string } = {}): Promise<StorageProvisionResult> {
    const body = opts.name ? { name: opts.name } : undefined;
    return this.request<StorageProvisionResult>("POST", "/storage/new", body);
  }

  /** POST /webhook/new — provision a webhook receiver URL. */
  async provisionWebhook(opts: { name?: string } = {}): Promise<WebhookProvisionResult> {
    const body = opts.name ? { name: opts.name } : undefined;
    return this.request<WebhookProvisionResult>("POST", "/webhook/new", body);
  }

  /**
   * Deploy a multi-service stack from an instant.yaml manifest.
   * Reads the manifest, creates tarballs for each service's build context,
   * and POSTs multipart to /stacks/new.
   *
   * @param manifestPath - Path to instant.yaml (default: ./instant.yaml)
   * @param baseDir - Base directory for resolving service build paths (default: dir containing manifestPath)
   * @param token - Bearer token for authenticated request
   */
  async deployStack(
    manifestPath: string = "./instant.yaml",
    baseDir?: string,
    token?: string
  ): Promise<StackDeployResult> {
    const resolvedManifest = path.resolve(manifestPath);

    if (!fs.existsSync(resolvedManifest)) {
      throw new Error(`instant.yaml not found at ${resolvedManifest}`);
    }

    const manifestBytes = fs.readFileSync(resolvedManifest);
    const manifestText = manifestBytes.toString("utf8");
    const resolvedBase = baseDir ?? path.dirname(resolvedManifest);

    // Parse the manifest to discover service names and build: paths
    const serviceBuilds = parseManifestForServices(manifestText);

    // Build multipart form data
    const form = new FormData();
    form.append(
      "manifest",
      new Blob([manifestBytes], { type: "text/yaml" }),
      "instant.yaml"
    );

    for (const [serviceName, buildPath] of Object.entries(serviceBuilds)) {
      const buildDir = path.resolve(resolvedBase, buildPath);
      if (!fs.existsSync(buildDir)) {
        throw new Error(
          `build directory not found: ${buildDir} for service ${serviceName}`
        );
      }

      // Shell out to system tar to create a gzipped tarball of the build context
      const tarballBuf = child_process.execSync(
        `tar -czf - -C ${JSON.stringify(buildDir)} .`,
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      // Convert to Uint8Array so it is a valid BlobPart regardless of TS target
      const tarball = new Uint8Array(tarballBuf.buffer, tarballBuf.byteOffset, tarballBuf.byteLength);

      form.append(
        serviceName,
        new Blob([tarball], { type: "application/gzip" }),
        `${serviceName}.tar.gz`
      );
    }

    // Build headers — let fetch set the multipart boundary automatically
    const headers: Record<string, string> = {
      "User-Agent": "instant-mcp/0.1",
    };
    // Prefer the explicit token arg, then fall back to apiKey/env
    const authToken = token ?? this.apiKey;
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const url = `${this.baseURL}/stacks/new`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: form,
    });

    const text = await resp.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON error response — return as structured error
      return {
        ok: false,
        stack_id: "",
        slug: "",
        status: "error",
        services: [],
        error: `non-JSON response (${resp.status}): ${text.slice(0, 200)}`,
      };
    }

    if (!resp.ok) {
      const err = data as { error?: string; message?: string };
      return {
        ok: false,
        stack_id: "",
        slug: "",
        status: "error",
        services: [],
        error: err.error ?? err.message ?? text.slice(0, 200),
      };
    }

    return data as StackDeployResult;
  }

  /** POST /deploy/new — deploy a containerized app from a local source directory. */
  async deployApp(opts: { sourceDir?: string; name?: string; port?: number } = {}): Promise<DeployResult> {
    const sourceDir = path.resolve(opts.sourceDir ?? ".");

    // Create a temp file path for the tarball
    const tmpFile = path.join(os.tmpdir(), `instant-deploy-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`);

    try {
      // Create a gzipped tarball of the source directory
      child_process.execSync(`tar czf ${tmpFile} -C ${sourceDir} .`, {
        stdio: "pipe",
      });

      // Read the tarball into a buffer
      const tarball = fs.readFileSync(tmpFile);

      // Build multipart form data
      const form = new FormData();
      form.append("tarball", new Blob([tarball], { type: "application/gzip" }), "source.tar.gz");
      if (opts.name) {
        form.append("name", opts.name);
      }
      if (opts.port !== undefined) {
        form.append("port", String(opts.port));
      }

      // Build headers without Content-Type so fetch sets the multipart boundary automatically
      const headers: Record<string, string> = {
        "User-Agent": "instant-mcp/0.1",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const url = `${this.baseURL}/deploy/new`;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: form,
      });

      const text = await resp.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`instant.dev: non-JSON response (${resp.status}): ${text.slice(0, 200)}`);
      }

      if (!resp.ok) {
        const err = data as { error?: string; message?: string };
        throw new Error(
          `instant.dev API error ${resp.status}: ${err.error ?? err.message ?? text.slice(0, 200)}`
        );
      }

      return data as DeployResult;
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
