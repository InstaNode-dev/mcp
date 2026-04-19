#!/usr/bin/env node
/**
 * @instanode/mcp — MCP server for instanode.dev
 *
 * Exposes tools to AI coding agents (Claude Code, Cursor, Windsurf, etc.):
 *
 *   create_postgres    — provision an ephemeral Postgres database (with pgvector)
 *   create_webhook     — provision an inbound webhook receiver URL
 *   list_resources     — list resources on the caller's account (requires INSTANODE_TOKEN)
 *   claim_token        — attach an anonymous token to the caller's account
 *   delete_resource    — permanently delete a resource (paid tier only)
 *   get_api_token      — mint a fresh bearer token for CLI / agent usage
 *
 * Environment:
 *   INSTANODE_TOKEN     Optional. Bearer JWT from https://instanode.dev/dashboard.
 *                       Required for list_resources, claim_token, delete_resource,
 *                       get_api_token. Unlocks paid-tier semantics on create_*.
 *   INSTANODE_API_URL   Optional. Defaults to https://api.instanode.dev. Override
 *                       only when pointing at a local dev cluster.
 */

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

const server = new McpServer({
  name: "instanode.dev",
  version: "0.7.0",
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

// ── Tool: create_postgres ─────────────────────────────────────────────────────

server.tool(
  "create_postgres",
  `Provision a fresh Postgres database on instanode.dev. pgvector is pre-installed.

Returns a standard postgres:// connection URL that any driver can use directly
as DATABASE_URL — no wrapper SDK, no setup. The 'name' field is required (the
human label surfaced on the dashboard).

Without INSTANODE_TOKEN: free tier — 10 MB, 2 connections, expires in 24h,
capped at 5 provisions/day per /24 subnet.
With INSTANODE_TOKEN (paid): 500 MB, 5 connections, permanent, no subnet cap.

Store the connection_url in an env var (DATABASE_URL); do not hardcode it.`,
  {
    name: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Human-readable label for this database (1–64 chars). Example: 'prospector-agent' or 'test-pgpid-123'."
      ),
  },
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
      if (result.note) lines.push(`Note: ${result.note}`);
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

// ── Tool: create_webhook ──────────────────────────────────────────────────────

server.tool(
  "create_webhook",
  `Provision an inbound webhook receiver URL on instanode.dev.

Returns a receive_url that accepts any HTTP method from any sender and stores
each request (method, headers, body, received_at). GET the same URL to pull
back the stored log. The 'name' field is required.

Useful for: testing Stripe/GitHub/Slack webhooks locally, inspecting payloads
during development, building integrations without exposing a local port.

Without INSTANODE_TOKEN: free tier — up to 100 requests stored, 24h TTL.
With INSTANODE_TOKEN (paid): 1000 stored, permanent.`,
  {
    name: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Human-readable label for this receiver (1–64 chars). Example: 'stripe-sandbox'."
      ),
  },
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
      if (result.note) lines.push(`Note: ${result.note}`);
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

// ── Tool: list_resources ──────────────────────────────────────────────────────

server.tool(
  "list_resources",
  `List resources on the caller's instanode.dev account, newest first.

Requires INSTANODE_TOKEN to be set. Mint one at https://instanode.dev/dashboard.

Returns each resource's type, token, tier, status, name, and expiry.`,
  {},
  async () => {
    try {
      const items: Resource[] = await client.listResources();
      if (items.length === 0) {
        return textResult(
          "No resources on this account yet.\n\nUse create_postgres or create_webhook to provision one."
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

// ── Tool: claim_token ─────────────────────────────────────────────────────────

server.tool(
  "claim_token",
  `Attach an anonymous token (returned by create_postgres / create_webhook) to
the authenticated caller's account. Idempotent — re-claiming a token you
already own returns the same payload.

For paid callers, the resource's tier is upgraded to 'paid' and its expiry is
cleared. For free callers, the resource stays anonymous-tier but is now
visible on the dashboard.

Requires INSTANODE_TOKEN.`,
  {
    token: z
      .string()
      .min(1)
      .describe("Resource token (UUID) returned by create_postgres or create_webhook."),
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

// ── Tool: delete_resource ─────────────────────────────────────────────────────

server.tool(
  "delete_resource",
  `Permanently delete one of the caller's resources. Drops the underlying
Postgres database (or clears the webhook's request log), then marks the row
status='deleted'.

Paid tier only. Free-tier resources auto-expire in 24h and cannot be deleted
manually — the tool will surface the upgrade URL.

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
as plain text. The user should paste the returned token into their MCP
server config as INSTANODE_TOKEN (or export it as an env var for CLI use).

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

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
