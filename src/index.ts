#!/usr/bin/env node
/**
 * @instant/mcp — MCP server for instant.dev
 *
 * Exposes tools to AI agents (Claude Code, etc.):
 *
 *   list_my_resources      — list all provisioned resources
 *   provision_database     — provision a Postgres + pgvector database
 *   provision_cache        — provision a Redis cache instance
 *   provision_document_db  — provision a MongoDB document database
 *   provision_queue        — provision a NATS JetStream queue
 *   provision_storage      — provision an S3-compatible object storage prefix
 *   provision_webhook      — provision a webhook receiver URL
 *   deploy_app             — deploy a containerized app to instant.dev hosting
 *   deploy_stack           — deploy a multi-service stack from an instant.yaml manifest
 *
 * Install globally for Claude Code:
 *   npx @instant/mcp
 *
 * ~/.claude/settings.json:
 *   {
 *     "mcpServers": {
 *       "instant": {
 *         "command": "npx",
 *         "args": ["@instant/mcp"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { InstantClient } from "./client.js";

const client = new InstantClient();

const server = new McpServer({
  name: "instant.dev",
  version: "0.6.0",
});

// ── Tool: list_my_resources ───────────────────────────────────────────────────

server.tool(
  "list_my_resources",
  `List all instant.dev resources provisioned for the authenticated team.

Requires INSTANT_API_KEY to be set in the environment. Without a key, returns an
error explaining how to authenticate.

Returns a table of resources with their type, token, status, name, tier, and
expiry time. Useful for auditing what infrastructure is currently provisioned.`,
  {},
  async () => {
    if (!process.env["INSTANT_API_KEY"]) {
      return {
        content: [
          {
            type: "text",
            text: [
              "INSTANT_API_KEY is not set — cannot list authenticated resources.",
              "",
              "To authenticate:",
              "  1. Sign up at https://instant.dev/start",
              "  2. Get your API key from the dashboard",
              "  3. Set INSTANT_API_KEY in your environment or pass it to the MCP server config",
              "",
              "Anonymous resources (provisioned without a key) expire after 24h and cannot",
              "be listed here — they are tracked by the token embedded in your code.",
            ].join("\n"),
          },
        ],
      };
    }

    const result = await client.listResources();

    if (result.total === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No resources provisioned for this team yet.\n\nUse a provision_* tool (e.g. provision_database) to create resources.",
          },
        ],
      };
    }

    const rows = result.items.map((r) => {
      const parts = [
        `[${r.resource_type}] ${r.token}`,
        `  status:  ${r.status}`,
        `  tier:    ${r.tier}`,
      ];
      if (r.name) parts.push(`  name:    ${r.name}`);
      if (r.expires_at) parts.push(`  expires: ${r.expires_at}`);
      if (r.cloud_vendor) parts.push(`  cloud:   ${r.cloud_vendor}`);
      return parts.join("\n");
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `${result.total} resource(s) provisioned:`,
            "",
            ...rows,
          ].join("\n"),
        },
      ],
    };
  }
);

// ── Tool: provision_cache ─────────────────────────────────────────────────────

server.tool(
  "provision_cache",
  `Provision a Redis cache instance on instant.dev.

Returns a connection_url the caller can use immediately with any Redis client.
Anonymous (no API key): free tier, expires in 24h, limited memory.
Authenticated (INSTANT_API_KEY set): tied to your team's plan.

The connection_url is only returned once — store it securely (e.g. as an env var
or in your secrets manager). Use list_my_resources to see provisioned caches.`,
  {
    name: z
      .string()
      .optional()
      .describe(
        "Optional human-readable label for this cache instance. E.g. 'session-cache'."
      ),
  },
  async ({ name }) => {
    let result;
    try {
      result = await client.provisionCache({ name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("service_disabled")) {
        return {
          content: [
            {
              type: "text",
              text: [
                "Redis provisioning is not yet available on this server.",
                "Visit https://instant.dev to use the hosted service.",
              ].join("\n"),
            },
          ],
        };
      }
      throw err;
    }

    const lines = [
      `Redis cache provisioned.`,
      `Token: ${result.token}`,
      `Connection URL: ${result.connection_url}`,
      `Tier: ${result.tier}`,
    ];
    if (result.name) lines.push(`Name: ${result.name}`);
    if (result.note) lines.push(`Note: ${result.note}`);
    if (result.upgrade) lines.push(`Upgrade: ${result.upgrade}`);
    lines.push(
      ``,
      `Store the connection_url securely — it won't be shown again.`,
      `Connect with any Redis client:`,
      `  redis-cli -u "${result.connection_url}"`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: provision_document_db ───────────────────────────────────────────────

server.tool(
  "provision_document_db",
  `Provision a MongoDB document database on instant.dev.

Returns a connection_url the caller can use immediately with any MongoDB driver.
Anonymous (no API key): free tier, expires in 24h, limited storage.
Authenticated (INSTANT_API_KEY set): tied to your team's plan.

The connection_url is only returned once — store it securely.`,
  {
    name: z
      .string()
      .optional()
      .describe(
        "Optional human-readable label for this database. E.g. 'app-db'."
      ),
  },
  async ({ name }) => {
    let result;
    try {
      result = await client.provisionDocumentDB({ name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("service_disabled")) {
        return {
          content: [
            {
              type: "text",
              text: [
                "MongoDB provisioning is not yet available on this server.",
                "Visit https://instant.dev to use the hosted service.",
              ].join("\n"),
            },
          ],
        };
      }
      throw err;
    }

    const lines = [
      `MongoDB database provisioned.`,
      `Token: ${result.token}`,
      `Connection URL: ${result.connection_url}`,
      `Tier: ${result.tier}`,
    ];
    if (result.name) lines.push(`Name: ${result.name}`);
    if (result.note) lines.push(`Note: ${result.note}`);
    if (result.upgrade) lines.push(`Upgrade: ${result.upgrade}`);
    lines.push(
      ``,
      `Store the connection_url securely — it won't be shown again.`,
      `Connect with mongosh:`,
      `  mongosh "${result.connection_url}"`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: provision_database ──────────────────────────────────────────────────

server.tool(
  "provision_database",
  `Provision a PostgreSQL database (with pgvector) using instant.dev. Returns a ready-to-use connection string. No account required — anonymous resources work immediately, expire after 24h unless claimed.`,
  {
    name: z
      .string()
      .optional()
      .describe(
        "Human-readable label for this database instance, e.g. 'my-app-dev'"
      ),
  },
  async ({ name }) => {
    let result;
    try {
      result = await client.provisionDatabase({ name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("service_disabled")) {
        return {
          content: [
            {
              type: "text",
              text: [
                "PostgreSQL provisioning is not yet available on this server.",
                "Visit https://instant.dev to use the hosted service.",
              ].join("\n"),
            },
          ],
        };
      }
      throw err;
    }

    const lines = [
      `Database provisioned.`,
      `Token: ${result.token}`,
      `Connection URL: ${result.connection_url}`,
      `Tier: ${result.tier}`,
    ];
    const limits = result.limits as { storage_mb?: number; connections?: number };
    if (limits.storage_mb !== undefined) lines.push(`Storage: ${limits.storage_mb} MB`);
    if (limits.connections !== undefined) lines.push(`Max connections: ${limits.connections}`);
    if (result.expires_in) lines.push(`Expires in: ${result.expires_in}`);
    if (result.note) lines.push(`Note: ${result.note}`);
    if (result.upgrade) lines.push(`Upgrade: ${result.upgrade}`);
    lines.push(
      ``,
      `Add to your .env:`,
      `  DATABASE_URL=${result.connection_url}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: provision_queue ─────────────────────────────────────────────────────

server.tool(
  "provision_queue",
  `Provision a NATS JetStream message queue using instant.dev. Returns a ready-to-use nats:// connection string. No account required — anonymous resources work immediately, expire after 24h unless claimed.`,
  {
    name: z
      .string()
      .optional()
      .describe(
        "Human-readable label for this queue instance, e.g. 'my-app-events'"
      ),
  },
  async ({ name }) => {
    let result;
    try {
      result = await client.provisionQueue({ name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("service_disabled")) {
        return {
          content: [
            {
              type: "text",
              text: [
                "NATS JetStream provisioning is not yet available on this server.",
                "Visit https://instant.dev to use the hosted service.",
              ].join("\n"),
            },
          ],
        };
      }
      throw err;
    }

    const lines = [
      `Queue provisioned.`,
      `Token: ${result.token}`,
      `Connection URL: ${result.connection_url}`,
      `Tier: ${result.tier}`,
    ];
    const limits = result.limits as { storage_mb?: number };
    if (limits.storage_mb !== undefined) lines.push(`Storage: ${limits.storage_mb} MB`);
    if (result.expires_in) lines.push(`Expires in: ${result.expires_in}`);
    if (result.note) lines.push(`Note: ${result.note}`);
    if (result.upgrade) lines.push(`Upgrade: ${result.upgrade}`);
    lines.push(
      ``,
      `Add to your .env:`,
      `  NATS_URL=${result.connection_url}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: provision_storage ───────────────────────────────────────────────────

server.tool(
  "provision_storage",
  `Provision an S3-compatible object storage prefix on instant.dev.

Returns S3 credentials (endpoint, bucket, prefix, access_key_id, secret_access_key)
scoped to a per-token prefix within a shared bucket. Works with any S3-compatible
client (AWS SDK, boto3, rclone, etc.).

Anonymous (no API key): free tier, 10 MB, expires in 24h.
Authenticated (INSTANT_API_KEY set): tied to your team's plan.

Store the secret_access_key securely — it is only returned once.`,
  {
    name: z
      .string()
      .optional()
      .describe(
        "Optional human-readable label for this storage prefix. E.g. 'user-uploads'."
      ),
  },
  async ({ name }) => {
    let result;
    try {
      result = await client.provisionStorage({ name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("service_disabled")) {
        return {
          content: [
            {
              type: "text",
              text: [
                "Object storage provisioning is not yet available on this server.",
                "Visit https://instant.dev to use the hosted service.",
              ].join("\n"),
            },
          ],
        };
      }
      throw err;
    }

    const lines = [
      `Object storage provisioned.`,
      `Token:             ${result.token}`,
      `Endpoint:          ${result.endpoint}`,
      `Bucket:            ${result.bucket}`,
      `Prefix:            ${result.prefix}`,
      `Access Key ID:     ${result.access_key_id}`,
      `Secret Access Key: ${result.secret_access_key}`,
      `Tier:              ${result.tier}`,
    ];
    const limits = result.limits as { storage_mb?: number };
    if (limits.storage_mb !== undefined) lines.push(`Storage: ${limits.storage_mb} MB`);
    if (result.expires_in) lines.push(`Expires in: ${result.expires_in}`);
    if (result.note) lines.push(`Note: ${result.note}`);
    if (result.upgrade) lines.push(`Upgrade: ${result.upgrade}`);
    lines.push(
      ``,
      `Add to your .env:`,
      `  S3_ENDPOINT=${result.endpoint}`,
      `  S3_BUCKET=${result.bucket}`,
      `  S3_PREFIX=${result.prefix}`,
      `  AWS_ACCESS_KEY_ID=${result.access_key_id}`,
      `  AWS_SECRET_ACCESS_KEY=${result.secret_access_key}`,
      ``,
      `Store the secret — it won't be shown again.`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: provision_webhook ───────────────────────────────────────────────────

server.tool(
  "provision_webhook",
  `Provision a webhook receiver URL on instant.dev.

Returns a receive_url that accepts any HTTP method from any sender. Payloads are
stored and retrievable via the instant.dev dashboard or API.

Useful for: testing webhooks locally, inspecting Stripe/GitHub/Slack payloads
during development, building integrations without exposing a local port.

Anonymous (no API key): stores up to 100 requests, expires in 24h.
Authenticated (INSTANT_API_KEY set): tied to your team's plan with higher limits.`,
  {
    name: z
      .string()
      .optional()
      .describe(
        "Optional human-readable label for this receiver. E.g. 'stripe-events'."
      ),
  },
  async ({ name }) => {
    let result;
    try {
      result = await client.provisionWebhook({ name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("service_disabled")) {
        return {
          content: [
            {
              type: "text",
              text: [
                "Webhook receiver provisioning is not yet available on this server.",
                "Visit https://instant.dev to use the hosted service.",
              ].join("\n"),
            },
          ],
        };
      }
      throw err;
    }

    const lines = [
      `Webhook receiver provisioned.`,
      `Token:       ${result.token}`,
      `Receive URL: ${result.receive_url}`,
      `Tier:        ${result.tier}`,
    ];
    if (result.name) lines.push(`Name: ${result.name}`);
    const limits = result.limits as { requests_stored?: number };
    if (limits.requests_stored !== undefined) lines.push(`Requests stored: ${limits.requests_stored}`);
    if (result.expires_in) lines.push(`Expires in: ${result.expires_in}`);
    if (result.note) lines.push(`Note: ${result.note}`);
    if (result.upgrade) lines.push(`Upgrade: ${result.upgrade}`);
    lines.push(
      ``,
      `Point any service at the receive_url:`,
      `  curl -X POST ${result.receive_url} -d '{"event":"test"}'`,
      ``,
      `View captured requests in the dashboard or via:`,
      `  GET /api/v1/webhooks/${result.token}/requests  (requires INSTANT_API_KEY)`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: deploy_app ──────────────────────────────────────────────────────────

server.tool(
  "deploy_app",
  "Deploy a containerized app to instant.dev hosting. The source directory must contain a Dockerfile. Returns the deployment ID and app URL once healthy.",
  {
    source_dir: z.string().optional().describe("Path to source directory containing Dockerfile (default: current directory '.')"),
    name: z.string().optional().describe("Human-readable name for the deployment"),
    port: z.number().int().min(1).max(65535).optional().describe("Port the app listens on (default: 8080)"),
  },
  async ({ source_dir = ".", name, port }) => {
    let result;
    try {
      result = await client.deployApp({ sourceDir: source_dir, name, port });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("service_disabled")) {
        return {
          content: [
            {
              type: "text",
              text: [
                "App deployment is not yet available on this server.",
                "Visit https://instant.dev to use the hosted service.",
              ].join("\n"),
            },
          ],
        };
      }
      throw err;
    }

    const lines = [
      `App deployment submitted.`,
      `Deployment ID: ${result.id}`,
      `App ID:        ${result.app_id}`,
      `Token:         ${result.token}`,
      `Status:        ${result.status}`,
      `Tier:          ${result.tier}`,
    ];
    if (result.app_url) lines.push(`App URL:       ${result.app_url}`);
    if (result.note) lines.push(`Note: ${result.note}`);
    lines.push(
      ``,
      `Poll status at https://instant.dev/dashboard or use GET /deploy/${result.id}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: deploy_stack ────────────────────────────────────────────────────────

server.tool(
  "deploy_stack",
  `Deploy a multi-service stack from an instant.yaml manifest. Reads the manifest from the current directory, creates Docker images for each service, and deploys them to instant.dev infrastructure. All services share an isolated namespace and can communicate via service:// DNS.`,
  {
    manifest_path: z
      .string()
      .optional()
      .describe(
        "Path to instant.yaml manifest file (default: ./instant.yaml)"
      ),
    token: z
      .string()
      .optional()
      .describe(
        "Authentication token from instant.dev (required for authenticated deployments)"
      ),
  },
  async ({ manifest_path, token }) => {
    const manifestPath = manifest_path ?? "./instant.yaml";
    let result;
    try {
      result = await client.deployStack(manifestPath, undefined, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("service_disabled")) {
        return {
          content: [
            {
              type: "text",
              text: [
                "Stack deployment is not yet available on this server.",
                "Visit https://instant.dev to use the hosted service.",
              ].join("\n"),
            },
          ],
        };
      }
      throw err;
    }

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: [
              `Stack deployment failed.`,
              result.error ? `Error: ${result.error}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    }

    const lines = [
      `Stack deployed successfully.`,
      `Stack ID: ${result.stack_id}`,
      `Slug:     ${result.slug}`,
      `Status:   ${result.status}`,
      ``,
      `Services:`,
    ];
    for (const svc of result.services) {
      lines.push(`  ${svc.name}: ${svc.status}${svc.app_url ? ` → ${svc.app_url}` : ""}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
