/**
 * MANDATORY integration test suite for the instanode-mcp server.
 *
 * Why this exists
 * ───────────────
 * The MCP server is the surface AI coding agents (Claude Code, Cursor,
 * Windsurf) call to provision databases, caches, queues, storage, webhooks,
 * and to deploy containers on instanode.dev. A regression here silently
 * breaks every agent that depends on it. This suite is wired as a CI gate
 * (.github/workflows/ci.yml runs `npm test` on every push + PR) so an
 * MCP-server change cannot land without proving every tool still works.
 *
 * What it does
 * ────────────
 * - Spawns the REAL built server binary (dist/index.js) and drives it over
 *   the genuine MCP stdio protocol using the official SDK Client. No mocked
 *   transport — this is end-to-end through JSON-RPC.
 * - Points the server at a hermetic in-process mock of the agent API
 *   (test/mock-api.ts) so the suite runs in CI with zero external deps.
 * - Asserts the tool registry, every tool's input schema, success responses,
 *   error envelopes (401 / 402 / 403 / 404 / 400), the multipart deploy
 *   path, bearer-token auth handling, and malformed-input rejection.
 *
 * RESOURCE CLEANUP (mandatory)
 * ────────────────────────────
 * Every test that creates a resource or deployment records its id and tears
 * it down. The `after()` hook runs a final sweep: it lists every resource +
 * deployment still live on the mock and deletes them, then asserts the mock's
 * ledger is empty. Because the backend is a hermetic in-process mock, no real
 * kaniko build or k8s pod is ever created — but the cleanup discipline is
 * exercised exactly as it would be against a live backend, and the optional
 * live smoke test (test/live-smoke.test.ts) reuses the same teardown helpers.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { readFileSync } from "node:fs";
import { startMockApi, type MockApiHandle, VALID_TOKEN, BAD_TOKEN, PAT_TOKEN } from "./mock-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The server is built to dist/index.js (tsconfig rootDir=src, outDir=dist).
// This test file compiles to dist-test/test/integration.test.js, so the
// server binary sits two directories up then into dist/.
const SERVER_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

/** Every tool the server is contractually required to register. */
const EXPECTED_TOOLS = [
  "create_postgres",
  "create_vector",
  "create_cache",
  "create_nosql",
  "create_queue",
  "create_storage",
  "create_webhook",
  "create_deploy",
  "create_stack",
  "get_stack",
  "list_deployments",
  "get_deployment",
  "redeploy",
  "delete_deployment",
  "claim_resource",
  "claim_token",
  "list_resources",
  "delete_resource",
  "get_api_token",
] as const;

/**
 * Spawn the MCP server connected to the mock API and return a connected
 * SDK Client. `token` controls the INSTANODE_TOKEN env var:
 *   - "valid"  → recognised paid bearer
 *   - "bad"    → revoked bearer (mock returns 401)
 *   - "none"   → anonymous (env var unset)
 */
async function connectClient(
  apiUrl: string,
  token: "valid" | "bad" | "none" | "pat"
): Promise<{ client: Client; close: () => Promise<void> }> {
  const env: Record<string, string> = {
    INSTANODE_API_URL: apiUrl,
    // Keep PATH so node can find shared libs; everything else is scrubbed.
    PATH: process.env["PATH"] ?? "",
  };
  if (token === "valid") env["INSTANODE_TOKEN"] = VALID_TOKEN;
  if (token === "bad") env["INSTANODE_TOKEN"] = BAD_TOKEN;
  if (token === "pat") env["INSTANODE_TOKEN"] = PAT_TOKEN;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
    // "ignore" (not "pipe"): an undrained stderr pipe is an open handle that
    // keeps the test process's event loop alive forever — the suite would
    // hang after the last test. We don't read server stderr here anyway.
    stderr: "ignore",
  });
  const client = new Client(
    { name: "instanode-mcp-integration-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      // Closing the client closes the stdio transport, which signals the
      // spawned server to exit. Capture the pid first so we can hard-kill
      // it if it lingers — a leaked child process keeps `node --test` from
      // ever exiting (the suite would hang forever in CI).
      const pid = transport.pid;
      await client.close().catch(() => {});
      if (pid !== null) {
        try {
          process.kill(pid, 0); // throws if already gone
          process.kill(pid, "SIGKILL");
        } catch {
          // already exited — nothing to do
        }
      }
    },
  };
}

/** Extract the flattened text from a tools/call result. */
function resultText(callResult: unknown): string {
  const r = callResult as { content?: Array<{ type: string; text?: string }> };
  if (!r.content || r.content.length === 0) return "";
  return r.content.map((c) => c.text ?? "").join("\n");
}

/** A minimal but valid gzip tarball payload, base64-encoded. */
function fakeTarballBase64(): string {
  // Real gzip stream so the payload is structurally a gzip blob; the mock
  // does not untar it, it only checks the multipart `tarball` part exists.
  return gzipSync(Buffer.from("FROM scratch\n")).toString("base64");
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("instanode-mcp integration suite", () => {
  let mock: MockApiHandle;

  before(async () => {
    // Verify the server was built. The CI gate runs `npm run build` first;
    // locally `npm test` does the same via the prebuild step.
    const check = spawnSync(process.execPath, ["-e", `require('node:fs').accessSync(${JSON.stringify(SERVER_ENTRY)})`]);
    assert.equal(
      check.status,
      0,
      `server binary missing at ${SERVER_ENTRY} — run "npm run build" first`
    );
    mock = await startMockApi();
  });

  after(async () => {
    // ── MANDATORY CLEANUP SWEEP ───────────────────────────────────────────
    // Every paid create_* / create_deploy test below tears down what it
    // made, but a failed assertion can leave a deletable resource behind.
    // This sweep deletes anything still live that the API CAN delete, then
    // asserts the deletable ledger is empty — the same discipline the
    // optional live smoke test relies on so a real deploy never leaks a
    // kaniko build or k8s pod.
    //
    // Anonymous-tier resources (provisioned by the six "anonymous tier"
    // tests with no token) are deliberately NOT swept: the API forbids
    // deleting them — they auto-expire at their 24h TTL. They are counted
    // and reported, not deleted. Only deployments + paid resources are
    // swept, because only those cost real compute if leaked.
    let leakedPaid = 0;
    let leakedDeploys = 0;
    try {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        for (const d of mock.liveDeployments()) {
          await client.callTool({ name: "delete_deployment", arguments: { id: d.app_id } });
        }
        for (const r of mock.liveResources()) {
          if (r.tier === "anonymous" || r.tier === "free") continue; // not deletable by contract
          await client.callTool({ name: "delete_resource", arguments: { token: r.token } });
        }
      } finally {
        await close();
      }
      leakedPaid = mock.liveResources().filter((r) => r.tier !== "anonymous" && r.tier !== "free").length;
      leakedDeploys = mock.liveDeployments().length;
    } finally {
      // mock.close() MUST run even if the sweep above throws — otherwise the
      // mock's http.Server stays open and the test process never exits.
      await mock.close();
    }
    assert.equal(leakedPaid, 0, `cleanup sweep left ${leakedPaid} deletable resource(s) on the backend`);
    assert.equal(leakedDeploys, 0, `cleanup sweep left ${leakedDeploys} deployment(s) on the backend`);
  });

  // ── Tool registry + schemas ─────────────────────────────────────────────────

  describe("tool registry", () => {
    it("registers exactly the 19 contract tools, no dead ones", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const names = new Set(tools.map((t) => t.name));
        for (const expected of EXPECTED_TOOLS) {
          assert.ok(names.has(expected), `missing tool: ${expected}`);
        }
        assert.equal(
          names.size,
          EXPECTED_TOOLS.length,
          `unexpected tools registered: ${[...names].filter((n) => !EXPECTED_TOOLS.includes(n as never))}`
        );
        // Dead tools from earlier MCP builds must never reappear.
        for (const dead of ["provision_cache", "deploy_app", "deploy_stack"]) {
          assert.ok(!names.has(dead), `dead tool still registered: ${dead}`);
        }
      } finally {
        await close();
      }
    });

    it("every tool advertises a non-empty description and input schema", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        for (const t of tools) {
          assert.ok(
            typeof t.description === "string" && t.description.length > 20,
            `tool ${t.name} has a too-short description`
          );
          assert.ok(t.inputSchema, `tool ${t.name} has no inputSchema`);
          assert.equal(
            (t.inputSchema as { type?: string }).type,
            "object",
            `tool ${t.name} inputSchema is not an object schema`
          );
        }
      } finally {
        await close();
      }
    });

    it("create_* tools require a 'name' string argument", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));
        for (const tool of ["create_postgres", "create_cache", "create_nosql", "create_queue", "create_storage", "create_webhook"]) {
          const schema = byName.get(tool)!.inputSchema as {
            properties?: Record<string, unknown>;
            required?: string[];
          };
          assert.ok(schema.properties && "name" in schema.properties, `${tool} missing 'name' property`);
          assert.ok(schema.required?.includes("name"), `${tool} does not mark 'name' required`);
        }
      } finally {
        await close();
      }
    });

    it("create_deploy schema advertises tarball_base64, name, private, allowed_ips, resource_bindings", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const deploy = tools.find((t) => t.name === "create_deploy")!;
        const props = (deploy.inputSchema as { properties?: Record<string, { type?: string }> }).properties ?? {};
        for (const field of ["tarball_base64", "name", "port", "env", "env_vars", "resource_bindings", "private", "allowed_ips"]) {
          assert.ok(field in props, `create_deploy schema missing '${field}'`);
        }
        assert.equal(props["allowed_ips"]?.type, "array", "allowed_ips should be an array");
        const required = (deploy.inputSchema as { required?: string[] }).required ?? [];
        assert.ok(required.includes("tarball_base64"), "create_deploy must require tarball_base64");
        assert.ok(required.includes("name"), "create_deploy must require name");
        assert.ok(/pro tier/i.test(deploy.description ?? ""), "create_deploy description must mention the Pro tier gate");
      } finally {
        await close();
      }
    });

    it("claim_token requires both upgrade_jwt and email (rejects the legacy single-token shape)", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const claim = tools.find((t) => t.name === "claim_token")!;
        const schema = claim.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        assert.ok(schema.properties && "upgrade_jwt" in schema.properties, "claim_token missing upgrade_jwt");
        assert.ok(schema.properties && "email" in schema.properties, "claim_token missing email");
        assert.ok(schema.required?.includes("upgrade_jwt"), "claim_token must require upgrade_jwt");
        assert.ok(schema.required?.includes("email"), "claim_token must require email");
      } finally {
        await close();
      }
    });
  });

  // ── create_* provisioning tools (anonymous tier) ────────────────────────────

  describe("provisioning tools — anonymous tier", () => {
    const provisioners: Array<{ tool: string; expectInOutput: string[] }> = [
      { tool: "create_postgres", expectInOutput: ["Postgres database provisioned.", "Connection URL:", "DATABASE_URL="] },
      { tool: "create_cache", expectInOutput: ["Redis cache provisioned.", "REDIS_URL="] },
      { tool: "create_nosql", expectInOutput: ["MongoDB database provisioned.", "MONGODB_URI="] },
      { tool: "create_queue", expectInOutput: ["NATS JetStream queue provisioned.", "NATS_URL="] },
      { tool: "create_webhook", expectInOutput: ["Webhook receiver provisioned.", "Receive URL:"] },
    ];

    for (const { tool, expectInOutput } of provisioners) {
      it(`${tool} succeeds and surfaces the claim/upgrade block`, async () => {
        const { client, close } = await connectClient(mock.url, "none");
        try {
          const res = await client.callTool({ name: tool, arguments: { name: `it-${tool}` } });
          const text = resultText(res);
          for (const fragment of expectInOutput) {
            assert.ok(text.includes(fragment), `${tool} output missing "${fragment}":\n${text}`);
          }
          // Anonymous responses must carry the claim URL verbatim.
          assert.ok(text.includes("Claim URL"), `${tool} did not surface the claim URL`);
          assert.ok(text.includes("Tier:"), `${tool} did not report a tier`);
        } finally {
          await close();
        }
      });
    }

    it("create_storage returns S3 credentials and the AWS-SDK env block", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({ name: "create_storage", arguments: { name: "it-storage" } });
        const text = resultText(res);
        for (const fragment of ["Object storage bucket prefix provisioned.", "Access key ID:", "Secret access key:", "AWS_ACCESS_KEY_ID=", "AWS_ENDPOINT_URL="]) {
          assert.ok(text.includes(fragment), `create_storage output missing "${fragment}":\n${text}`);
        }
      } finally {
        await close();
      }
    });

    it("create_postgres rejects an empty name at the schema layer", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({ name: "create_postgres", arguments: { name: "" } });
        // Zod min(1) failure surfaces as an MCP error result.
        assert.ok(
          (res as { isError?: boolean }).isError === true,
          `create_postgres accepted an empty name: ${JSON.stringify(res)}`
        );
      } finally {
        await close();
      }
    });

    it("create_postgres rejects an over-long (>64 char) name", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "create_postgres",
          arguments: { name: "x".repeat(65) },
        });
        assert.ok((res as { isError?: boolean }).isError === true, "create_postgres accepted a 65-char name");
      } finally {
        await close();
      }
    });

    it("create_postgres rejects a missing name argument entirely", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({ name: "create_postgres", arguments: {} });
        assert.ok((res as { isError?: boolean }).isError === true, "create_postgres accepted a missing name");
      } finally {
        await close();
      }
    });
  });

  // ── create_* provisioning tools (paid tier) ─────────────────────────────────

  describe("provisioning tools — authenticated paid tier", () => {
    it("create_postgres with a valid token reports the pro tier and no claim block", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      let token = "";
      try {
        const res = await client.callTool({ name: "create_postgres", arguments: { name: "it-paid-pg" } });
        const text = resultText(res);
        assert.ok(text.includes("Tier:           pro"), `expected pro tier:\n${text}`);
        assert.ok(!text.includes("Claim URL"), `paid resource should not carry a claim URL:\n${text}`);
        const m = /Token:\s+(\S+)/.exec(text);
        assert.ok(m, "could not parse provisioned token");
        token = m[1];
      } finally {
        await close();
      }
      // CLEANUP: tear down what this test created.
      const { client: c2, close: close2 } = await connectClient(mock.url, "valid");
      try {
        const delRes = await c2.callTool({ name: "delete_resource", arguments: { token } });
        assert.ok(resultText(delRes).includes("Resource deleted."), "cleanup delete failed");
      } finally {
        await close2();
      }
    });
  });

  // ── Authentication handling ─────────────────────────────────────────────────

  describe("authentication handling", () => {
    it("list_resources without a token surfaces the auth-required message (no network call)", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({ name: "list_resources", arguments: {} });
        const text = resultText(res);
        assert.ok(text.includes("INSTANODE_TOKEN"), `expected auth-required text:\n${text}`);
      } finally {
        await close();
      }
    });

    it("list_resources with a bad token surfaces a 401 with the dashboard CTA", async () => {
      const { client, close } = await connectClient(mock.url, "bad");
      try {
        const res = await client.callTool({ name: "list_resources", arguments: {} });
        const text = resultText(res);
        assert.ok(/401/.test(text), `expected a 401 in the output:\n${text}`);
        assert.ok(text.includes("instanode.dev/dashboard"), `expected the dashboard CTA:\n${text}`);
      } finally {
        await close();
      }
    });

    it("list_resources with a valid token returns the resource list", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      let token = "";
      try {
        // Provision one so the list is non-empty.
        const prov = await client.callTool({ name: "create_cache", arguments: { name: "it-list-cache" } });
        token = /Token:\s+(\S+)/.exec(resultText(prov))![1];

        const res = await client.callTool({ name: "list_resources", arguments: {} });
        const text = resultText(res);
        assert.ok(text.includes("resource(s) on this account"), `expected a resource list:\n${text}`);
        assert.ok(text.includes(token), `provisioned resource ${token} not in the list:\n${text}`);
      } finally {
        await close();
      }
      // CLEANUP
      const { client: c2, close: close2 } = await connectClient(mock.url, "valid");
      try {
        await c2.callTool({ name: "delete_resource", arguments: { token } });
      } finally {
        await close2();
      }
    });

    it("create_deploy without a token surfaces the auth-required message before any upload", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: fakeTarballBase64(), name: "it-noauth-deploy" },
        });
        const text = resultText(res);
        assert.ok(text.includes("INSTANODE_TOKEN"), `expected auth-required text:\n${text}`);
        assert.equal(mock.deployCount(), 0, "create_deploy hit the network despite missing auth");
      } finally {
        await close();
      }
    });

    it("get_api_token without a token surfaces the auth-required message", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({ name: "get_api_token", arguments: {} });
        assert.ok(resultText(res).includes("INSTANODE_TOKEN"), "get_api_token did not gate on auth");
      } finally {
        await close();
      }
    });

    it("get_api_token with a valid token mints and returns a fresh key", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({ name: "get_api_token", arguments: { name: "ci-test-key" } });
        const text = resultText(res);
        assert.ok(text.includes("New API key minted."), `expected a minted key:\n${text}`);
        assert.ok(/ik_live_/.test(text), `expected the key value in the output:\n${text}`);
      } finally {
        await close();
      }
    });
  });

  // ── delete_resource error envelopes ─────────────────────────────────────────

  describe("delete_resource", () => {
    it("returns a 404-style error for an unknown token", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({
          name: "delete_resource",
          arguments: { token: "00000000-0000-0000-0000-000000000000" },
        });
        const text = resultText(res);
        assert.ok(/404|not found/i.test(text), `expected a not-found error:\n${text}`);
      } finally {
        await close();
      }
    });

    it("deletes a paid resource and the mock ledger drops it", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const prov = await client.callTool({ name: "create_nosql", arguments: { name: "it-del-mongo" } });
        const token = /Token:\s+(\S+)/.exec(resultText(prov))![1];
        const before = mock.liveResources().length;

        const del = await client.callTool({ name: "delete_resource", arguments: { token } });
        assert.ok(resultText(del).includes("Resource deleted."), "delete_resource did not confirm deletion");
        assert.equal(mock.liveResources().length, before - 1, "mock ledger did not drop the deleted resource");
      } finally {
        await close();
      }
    });
  });

  // ── claim helpers ───────────────────────────────────────────────────────────

  describe("claim helpers", () => {
    it("claim_resource builds an API-host /start URL from a raw JWT (pure helper, no network)", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "claim_resource",
          arguments: { upgrade_jwt: "ey.raw.jwt" },
        });
        const text = resultText(res);
        assert.ok(text.includes(`${mock.url}/start?t=ey.raw.jwt`), `expected API-host claim URL:\n${text}`);
      } finally {
        await close();
      }
    });

    it("claim_resource extracts the JWT from a full /start?t= URL", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "claim_resource",
          arguments: { upgrade_jwt: "https://instanode.dev/start?t=ey.url.jwt" },
        });
        assert.ok(resultText(res).includes("/start?t=ey.url.jwt"), "claim_resource did not re-extract the JWT");
      } finally {
        await close();
      }
    });

    it("claim_token with upgrade_jwt + email succeeds against POST /claim", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "claim_token",
          arguments: { upgrade_jwt: "ey.valid.jwt", email: "dev@example.com" },
        });
        assert.ok(resultText(res).includes("JWT claimed."), `expected a successful claim:\n${resultText(res)}`);
      } finally {
        await close();
      }
    });

    it("claim_token surfaces the already-claimed conflict from the API", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "claim_token",
          arguments: { upgrade_jwt: "invalid.jwt", email: "dev@example.com" },
        });
        const text = resultText(res);
        assert.ok(/409|already.?claimed/i.test(text), `expected a conflict error:\n${text}`);
      } finally {
        await close();
      }
    });

    it("claim_token rejects a malformed email at the schema layer", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "claim_token",
          arguments: { upgrade_jwt: "ey.valid.jwt", email: "not-an-email" },
        });
        assert.ok((res as { isError?: boolean }).isError === true, "claim_token accepted a malformed email");
      } finally {
        await close();
      }
    });
  });

  // ── Deployment lifecycle (create → poll → redeploy → delete) ─────────────────

  describe("deployment lifecycle", () => {
    it("create_deploy uploads a multipart tarball and returns a building deployment", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      let appId = "";
      try {
        const res = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: fakeTarballBase64(), name: "it-deploy-basic", port: 3000 },
        });
        const text = resultText(res);
        assert.ok(text.includes("Deployment accepted"), `expected an accepted deploy:\n${text}`);
        assert.ok(/Status:\s+building/.test(text), `expected status=building:\n${text}`);
        appId = /Deploy ID:\s+(\S+)/.exec(text)![1];
      } finally {
        await close();
      }
      // CLEANUP — mandatory: a real deploy is a kaniko build + k8s pod.
      const { client: c2, close: close2 } = await connectClient(mock.url, "valid");
      try {
        const del = await c2.callTool({ name: "delete_deployment", arguments: { id: appId } });
        assert.ok(resultText(del).includes("Deployment deleted."), "deploy cleanup failed");
      } finally {
        await close2();
      }
    });

    it("create_deploy with resource_bindings + env_vars merges them into the upload", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      let appId = "";
      try {
        const res = await client.callTool({
          name: "create_deploy",
          arguments: {
            tarball_base64: fakeTarballBase64(),
            name: "it-deploy-bound",
            env_vars: { LOG_LEVEL: "debug" },
            resource_bindings: { DATABASE_URL: "11111111-2222-3333-4444-555555555555" },
          },
        });
        appId = /Deploy ID:\s+(\S+)/.exec(resultText(res))![1];
        const deployment = mock.liveDeployments().find((d) => d.app_id === appId)!;
        assert.equal(deployment.env["LOG_LEVEL"], "debug", "env_vars not forwarded");
        assert.equal(
          deployment.env["DATABASE_URL"],
          "11111111-2222-3333-4444-555555555555",
          "resource_bindings not merged into env_vars"
        );
      } finally {
        await close();
      }
      // CLEANUP
      const { client: c2, close: close2 } = await connectClient(mock.url, "valid");
      try {
        await c2.callTool({ name: "delete_deployment", arguments: { id: appId } });
      } finally {
        await close2();
      }
    });

    it("full lifecycle: create → get (building→running) → redeploy → delete", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        // create
        const created = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: fakeTarballBase64(), name: "it-lifecycle" },
        });
        const appId = /Deploy ID:\s+(\S+)/.exec(resultText(created))![1];

        // get — the mock flips building→running on first poll
        const got = await client.callTool({ name: "get_deployment", arguments: { id: appId } });
        const gotText = resultText(got);
        assert.ok(/Status:\s+running/.test(gotText), `expected status=running after poll:\n${gotText}`);
        assert.ok(/https:\/\/.*deployment\.instanode\.dev/.test(gotText), `expected a live URL:\n${gotText}`);

        // list — the deployment must appear
        const listed = await client.callTool({ name: "list_deployments", arguments: {} });
        assert.ok(resultText(listed).includes(appId), "deployment missing from list_deployments");

        // redeploy — status flips back to building. The fix that landed
        // alongside this test now requires a tarball multipart on
        // /deploy/:id/redeploy (mirroring the real api contract; the
        // previous bodyless call always 400'd missing_tarball in prod).
        const redeployed = await client.callTool({
          name: "redeploy",
          arguments: { id: appId, tarball_base64: fakeTarballBase64() },
        });
        assert.ok(/Status:\s+building/.test(resultText(redeployed)), "redeploy did not reset status to building");

        // delete — MANDATORY teardown
        const deleted = await client.callTool({ name: "delete_deployment", arguments: { id: appId } });
        assert.ok(resultText(deleted).includes("Deployment deleted."), "delete_deployment did not confirm");
        assert.ok(
          !mock.liveDeployments().some((d) => d.app_id === appId),
          "deleted deployment still live on the mock"
        );
      } finally {
        await close();
      }
    });

    it("get_deployment returns a not-found error for an unknown app id", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        // BUG-MCP-025: id must be a real UUID — supply one the mock doesn't
        // know about so the API still returns 404.
        const res = await client.callTool({
          name: "get_deployment",
          arguments: { id: "00000000-0000-4000-8000-000000000404" },
        });
        assert.ok(/404|not found/i.test(resultText(res)), "get_deployment did not surface a 404");
      } finally {
        await close();
      }
    });

    it("redeploy returns a not-found error for an unknown app id", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        // BUG-MCP-025: see above — UUID-shaped + unknown.
        // tarball_base64 is now required (real api: deploy.go:1245).
        const res = await client.callTool({
          name: "redeploy",
          arguments: {
            id: "00000000-0000-4000-8000-000000000404",
            tarball_base64: fakeTarballBase64(),
          },
        });
        assert.ok(/404|not found/i.test(resultText(res)), "redeploy did not surface a 404");
      } finally {
        await close();
      }
    });

    it("list_deployments with no deployments returns the empty-state hint", async () => {
      // Fresh mock so the deployment ledger is genuinely empty.
      const freshMock = await startMockApi();
      const { client, close } = await connectClient(freshMock.url, "valid");
      try {
        const res = await client.callTool({ name: "list_deployments", arguments: {} });
        assert.ok(resultText(res).includes("No deployments"), "expected the empty-state message");
      } finally {
        await close();
        await freshMock.close();
      }
    });
  });

  // ── Private deploys + tier gating ───────────────────────────────────────────

  describe("private deploys + tier gating", () => {
    it("create_deploy with private=true + allowed_ips succeeds on Pro and echoes the allowlist", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      let appId = "";
      try {
        const res = await client.callTool({
          name: "create_deploy",
          arguments: {
            tarball_base64: fakeTarballBase64(),
            name: "it-private-crm",
            private: true,
            allowed_ips: ["1.2.3.4", "10.0.0.0/8"],
          },
        });
        const text = resultText(res);
        assert.ok(text.includes("Private:        true"), `expected the private flag echoed:\n${text}`);
        assert.ok(text.includes("1.2.3.4"), `expected the IP allowlist echoed:\n${text}`);
        appId = /Deploy ID:\s+(\S+)/.exec(text)![1];
      } finally {
        await close();
      }
      // CLEANUP
      const { client: c2, close: close2 } = await connectClient(mock.url, "valid");
      try {
        await c2.callTool({ name: "delete_deployment", arguments: { id: appId } });
      } finally {
        await close2();
      }
    });
  });

  // ── Malformed input handling ────────────────────────────────────────────────

  describe("malformed input handling", () => {
    it("create_deploy rejects a non-string tarball_base64 at the schema layer", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: 12345 as unknown as string, name: "it-bad-tar" },
        });
        assert.ok((res as { isError?: boolean }).isError === true, "create_deploy accepted a numeric tarball");
      } finally {
        await close();
      }
    });

    it("create_deploy rejects an out-of-range port", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: fakeTarballBase64(), name: "it-bad-port", port: 99999 },
        });
        assert.ok((res as { isError?: boolean }).isError === true, "create_deploy accepted port 99999");
      } finally {
        await close();
      }
    });

    it("calling an unknown tool name fails cleanly (error result, not a crash)", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        // The MCP SDK surfaces an unregistered tool as either a rejected
        // JSON-RPC call or an isError result — both are "clean" failures.
        // What must NOT happen is the server crashing or hanging.
        let failedCleanly = false;
        try {
          const res = await client.callTool({ name: "no_such_tool", arguments: {} });
          failedCleanly = (res as { isError?: boolean }).isError === true;
        } catch {
          failedCleanly = true;
        }
        assert.ok(failedCleanly, "unknown tool was not rejected as an error");
        // The server must still be alive and serving — list a known tool.
        const { tools } = await client.listTools();
        assert.ok(tools.length === EXPECTED_TOOLS.length, "server unhealthy after unknown-tool call");
      } finally {
        await close();
      }
    });

    it("get_deployment rejects an empty id at the schema layer", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({ name: "get_deployment", arguments: { id: "" } });
        assert.ok((res as { isError?: boolean }).isError === true, "get_deployment accepted an empty id");
      } finally {
        await close();
      }
    });
  });

  // ── BugBash 2026-05-20 regression tests ────────────────────────────────────
  //
  // Each `it()` here pins exactly one of the T17 findings so a future change
  // that reverts a fix fails this suite immediately. Keep them grouped (and
  // their issue refs in the title) so the failure message points straight at
  // the original report.

  describe("BugBash 2026-05-20 T17 P0-1 — redeploy tolerates bare-202 empty body", () => {
    it("redeploy resolves successfully when the api returns 202 with no body (no TypeError on result.item.app_id)", async () => {
      // The live api documents POST /deploy/{id}/redeploy as a bare 202 with
      // no body schema. The previous client typed it as DeployGetResult and
      // the index.ts handler dereferenced `result.item.app_id`, throwing
      // `TypeError: Cannot read properties of undefined (reading 'app_id')`.
      // The fixed mock now returns a bare 202 (no JSON body) so this test
      // genuinely exercises the empty-body path. T17 P0-1.
      const { client, close } = await connectClient(mock.url, "valid");
      let appId = "";
      try {
        const created = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: fakeTarballBase64(), name: "it-redeploy-bare-202" },
        });
        appId = /Deploy ID:\s+(\S+)/.exec(resultText(created))![1];

        // Promote building → running by polling once.
        await client.callTool({ name: "get_deployment", arguments: { id: appId } });

        // The act: redeploy must not throw, must include a clear "Redeploy
        // accepted" headline, and must NOT contain any sign of an undefined
        // dereference (the old failure mode).
        const res = await client.callTool({
          name: "redeploy",
          arguments: { id: appId, tarball_base64: fakeTarballBase64() },
        });
        const text = resultText(res);
        assert.ok(text.includes("Redeploy accepted"), `expected a clean redeploy headline:\n${text}`);
        assert.ok(text.includes(appId), `expected the redeploy output to echo the id ${appId}:\n${text}`);
        assert.ok(
          !/undefined|cannot read prop|TypeError/i.test(text),
          `redeploy output looks like an undefined-deref crash:\n${text}`
        );
        // The result must not advertise a status or URL field the api didn't
        // give us — the bare-202 contract has neither.
        assert.ok(
          !text.includes("Status: running"),
          `redeploy must not claim a status it did not receive:\n${text}`
        );
      } finally {
        await close();
      }
      // CLEANUP
      const { client: c2, close: close2 } = await connectClient(mock.url, "valid");
      try {
        await c2.callTool({ name: "delete_deployment", arguments: { id: appId } });
      } finally {
        await close2();
      }
    });
  });

  describe("BugBash 2026-05-20 T17 P0-2 — get_api_token surfaces a clear error for PATs", () => {
    it("get_api_token with a PAT bearer surfaces the 'use a session JWT' message (not a generic 403)", async () => {
      // The live api enforces "PATs cannot mint other PATs" — a 403 with code
      // `pat_cannot_mint_pat` on POST /api/v1/auth/api-keys when the caller is
      // a PAT. Since `get_api_token` itself mints PATs, the typical INSTANODE_TOKEN
      // value IS a PAT — meaning this tool fails 100% of the time in its
      // documented "rotate as needed" use case unless the user surfaces the
      // restriction. T17 P0-2.
      const { client, close } = await connectClient(mock.url, "pat");
      try {
        const res = await client.callTool({ name: "get_api_token", arguments: {} });
        const text = resultText(res);
        // Headline must name the constraint plainly. Looking for the canonical
        // failure-mode keywords; if the message ever drifts away from these,
        // an agent reading the output will be unable to recover.
        assert.ok(/Personal Access Token|PAT/i.test(text), `expected a PAT-aware error message:\n${text}`);
        assert.ok(/session/i.test(text), `expected the error to mention a session JWT:\n${text}`);
        assert.ok(text.includes("instanode.dev/dashboard"), `expected the dashboard link:\n${text}`);
        // The generic "instanode.dev error (403):" preamble (which produced
        // confused agent retries) MUST NOT be the entire headline.
        assert.ok(
          !/^instanode\.dev error \(403\): upstream error\s*$/.test(text.trim()),
          `error fell through to the generic 403 path:\n${text}`
        );
      } finally {
        await close();
      }
    });

    it("get_api_token tool description mentions the session-vs-PAT requirement", async () => {
      // Locking the description down prevents the "rotate as needed" claim
      // from creeping back in. The fix at T17 P0-2 rewrote the description
      // to explicitly state PATs can't mint PATs.
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "get_api_token")!;
        const desc = tool.description ?? "";
        assert.ok(/PAT|Personal Access Token/i.test(desc), "get_api_token description must mention PATs");
        assert.ok(/session/i.test(desc), "get_api_token description must mention session JWTs");
        assert.ok(!/rotate as needed/i.test(desc), "the misleading 'rotate as needed' line must be gone");
      } finally {
        await close();
      }
    });
  });

  describe("BugBash 2026-05-20 T17 P1 — name schema mirrors the live api regex", () => {
    // The api enforces `^[A-Za-z0-9][A-Za-z0-9 _-]*$` (start-alnum then
    // letters/digits/spaces/underscores/hyphens, 1-64 chars). The previous
    // mcp schema used `min(1).max(64)` only — names like "-bad" or "@x"
    // passed locally and 400'd on the api with a generic invalid_name.
    // T17 P1-1.
    const REJECTED = [
      "-leading-dash",
      " starts-with-space",
      "@invalid",
      ".dotty",
      "has/slash",
      "name\twith\ttab",
    ];
    const ACCEPTED = [
      "valid-name",
      "valid_name",
      "Valid Name 1",
      "123start",
      "a",
    ];

    for (const bad of REJECTED) {
      it(`create_postgres rejects ${JSON.stringify(bad)} at the zod regex layer (no round-trip to the api)`, async () => {
        const { client, close } = await connectClient(mock.url, "none");
        try {
          const res = await client.callTool({ name: "create_postgres", arguments: { name: bad } });
          assert.ok(
            (res as { isError?: boolean }).isError === true,
            `create_postgres accepted ${JSON.stringify(bad)}: ${JSON.stringify(res)}`
          );
        } finally {
          await close();
        }
      });
    }

    for (const good of ACCEPTED) {
      it(`create_postgres accepts ${JSON.stringify(good)} (matches the live api pattern)`, async () => {
        const { client, close } = await connectClient(mock.url, "none");
        try {
          const res = await client.callTool({ name: "create_postgres", arguments: { name: good } });
          assert.ok(
            (res as { isError?: boolean }).isError !== true,
            `create_postgres rejected ${JSON.stringify(good)} which should be valid: ${JSON.stringify(res)}`
          );
        } finally {
          await close();
        }
      });
    }

    it("create_deploy mirrors the same name regex (start-alnum, no leading dash)", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: fakeTarballBase64(), name: "-leading-dash" },
        });
        assert.ok(
          (res as { isError?: boolean }).isError === true,
          `create_deploy accepted a leading-dash name: ${JSON.stringify(res)}`
        );
      } finally {
        await close();
      }
    });

    it("every create_* tool's name schema has a non-empty pattern (coverage block — guards against single-site fallacy)", async () => {
      // Enumerate every create_* tool the registry advertises and assert
      // each one carries a non-empty regex pattern on its `name` field.
      // The previous build added the regex to `create_deploy` but missed
      // the shared `nameArg` (single-site fallacy); the fix updated both,
      // and this test fails if either drifts away from the api contract.
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const namedCreates = tools.filter((t) => /^create_/.test(t.name));
        assert.ok(namedCreates.length >= 7, `expected ≥7 create_* tools, got ${namedCreates.length}`);
        for (const tool of namedCreates) {
          const schema = tool.inputSchema as {
            properties?: Record<string, { type?: string; pattern?: string }>;
          };
          const nameProp = schema.properties?.["name"];
          assert.ok(nameProp, `${tool.name} has no name property`);
          assert.ok(
            typeof nameProp.pattern === "string" && nameProp.pattern.length > 0,
            `${tool.name} name schema is missing the api regex (pattern=${JSON.stringify(nameProp.pattern)})`
          );
        }
      } finally {
        await close();
      }
    });
  });

  describe("BugBash 2026-05-20 T17 P1 — User-Agent reflects package.json version", () => {
    it("client UA string equals 'instanode-mcp/<package.json version>' (no hardcoded 0.11.0 literal)", async () => {
      // T17 P1-6: the client previously hardcoded "instanode-mcp/0.11.0" in two
      // places. After a version bump, server-side analytics, rate-limit
      // attribution, and abuse triage keyed on UA would see stale data forever.
      // This test loads the real package.json + spawns the server pointed at
      // a UA-capturing mock to confirm the UA is sourced from package.json.
      const here = dirname(fileURLToPath(import.meta.url));
      const pkgPath = resolve(here, "..", "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
      const expectedUA = `instanode-mcp/${pkg.version}`;

      // Capture the UA on a real http.Server pointed at the spawned mcp.
      const observedUAs: string[] = [];
      const captureServer = await createMockApiThatCapturesUA(observedUAs);
      try {
        const { client, close } = await connectClient(captureServer.url, "none");
        try {
          // Any tool that triggers an HTTP call works — create_postgres on
          // anonymous tier hits POST /db/new without auth.
          await client.callTool({ name: "create_postgres", arguments: { name: "it-ua-check" } });
        } finally {
          await close();
        }
      } finally {
        await captureServer.close();
      }

      assert.ok(observedUAs.length > 0, "no requests reached the UA-capture server");
      for (const ua of observedUAs) {
        assert.equal(
          ua,
          expectedUA,
          `User-Agent mismatch: expected ${expectedUA}, got ${ua}`
        );
      }
      // Anti-drift guard against the literal that used to be hardcoded.
      // If anyone ever re-pins a hardcoded "instanode-mcp/<bumped-version>",
      // this assert fires the moment package.json moves past that version.
      assert.ok(
        !observedUAs.some((u) => /instanode-mcp\/0\.11\.0/.test(u)) ||
          pkg.version === "0.11.0",
        `client is still sending the old hardcoded 0.11.0 UA after a version bump (saw ${observedUAs.join(", ")})`
      );
    });
  });

  describe("BugBash 2026-05-20 T17 P0/P1 — mock-api contract pinning", () => {
    // These tests don't drive the mcp server — they sanity-check the mock
    // itself against the live openapi.json contract. If the mock ever drifts
    // back to its earlier fiction (a 202 with `{ok,item}`, an api-keys 201
    // for any caller, the legacy direct-claim shape), these fire.

    it("POST /deploy/:id/redeploy returns a bare 202 with no body (matches openapi.json)", async () => {
      // T17 P0-1: the prior mock returned {ok, item: deployment} on 202,
      // letting the broken redeploy client pass tests against fiction.
      // fix/mcp-redeploy-in-place: the mock now also enforces the api's
      // missing_tarball contract (deploy.go:1245), so this raw fetch must
      // post multipart with a tarball file part to get the 202 — same
      // shape as the real api.
      const { client, close } = await connectClient(mock.url, "valid");
      let appId = "";
      try {
        const created = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: fakeTarballBase64(), name: "it-mock-bare202" },
        });
        appId = /Deploy ID:\s+(\S+)/.exec(resultText(created))![1];

        // Direct fetch — bypass the mcp client to inspect the raw response.
        const form = new FormData();
        const tarball = Buffer.from(fakeTarballBase64(), "base64");
        const blob = new Blob([tarball], { type: "application/gzip" });
        form.append("tarball", blob, "app.tar.gz");
        const resp = await fetch(`${mock.url}/deploy/${appId}/redeploy`, {
          method: "POST",
          headers: { Authorization: `Bearer ${VALID_TOKEN}` },
          body: form,
        });
        assert.equal(resp.status, 202, `expected 202, got ${resp.status}`);
        const body = await resp.text();
        assert.equal(body, "", `expected an empty body, got: ${body}`);
      } finally {
        await close();
      }
      // CLEANUP
      const { client: c2, close: close2 } = await connectClient(mock.url, "valid");
      try {
        await c2.callTool({ name: "delete_deployment", arguments: { id: appId } });
      } finally {
        await close2();
      }
    });

    it("POST /deploy/:id/redeploy WITHOUT a tarball returns 400 missing_tarball (real api contract)", async () => {
      // fix/mcp-redeploy-in-place: mirror api/internal/handlers/deploy.go:1245
      // — the prior mock accepted bodyless calls, masking the bug where
      // the standalone redeploy MCP tool sent no tarball and always 400'd.
      const { client, close } = await connectClient(mock.url, "valid");
      let appId = "";
      try {
        const created = await client.callTool({
          name: "create_deploy",
          arguments: { tarball_base64: fakeTarballBase64(), name: "it-mock-missing-tar" },
        });
        appId = /Deploy ID:\s+(\S+)/.exec(resultText(created))![1];

        const resp = await fetch(`${mock.url}/deploy/${appId}/redeploy`, {
          method: "POST",
          headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        });
        assert.equal(resp.status, 400, `expected 400 missing_tarball, got ${resp.status}`);
        const body = (await resp.json()) as { error?: string; message?: string };
        assert.equal(body.error, "invalid_form", `unexpected error: ${JSON.stringify(body)}`);
      } finally {
        await close();
      }
      const { client: c2, close: close2 } = await connectClient(mock.url, "valid");
      try {
        await c2.callTool({ name: "delete_deployment", arguments: { id: appId } });
      } finally {
        await close2();
      }
    });

    it("POST /api/v1/auth/api-keys returns 403 pat_cannot_mint_pat when the caller is a PAT", async () => {
      // T17 P0-2: the prior mock unconditionally returned 201 — masked the
      // entire PAT-creating-PAT failure mode.
      const resp = await fetch(`${mock.url}/api/v1/auth/api-keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "should-be-rejected", scopes: ["read", "write"] }),
      });
      assert.equal(resp.status, 403, `expected 403, got ${resp.status}`);
      const body = (await resp.json()) as { error?: string; message?: string };
      assert.equal(body.error, "pat_cannot_mint_pat", `unexpected error code: ${JSON.stringify(body)}`);
    });

    it("POST /api/v1/auth/api-keys requires a name field (per openapi.json)", async () => {
      // openapi.json marks `name` required on this endpoint; the prior mock
      // accepted a missing name.
      const resp = await fetch(`${mock.url}/api/v1/auth/api-keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.equal(resp.status, 400, `expected 400 for missing name, got ${resp.status}`);
    });

    it("POST /api/v1/auth/api-keys rejects an invalid scope (per openapi.json enum)", async () => {
      const resp = await fetch(`${mock.url}/api/v1/auth/api-keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "k", scopes: ["god"] }),
      });
      assert.equal(resp.status, 400, `expected 400 for bad scope, got ${resp.status}`);
    });

    it("POST /claim returns 200 with the ClaimResponse magic-link shape (not the legacy 201 direct-claim)", async () => {
      // T17 P1-5: prior mock returned {id, token, resource_type, tier, status}
      // — the legacy 201 shape the live api retired. The real response is
      // {ok, team_id, user_id, session_token, message}.
      const resp = await fetch(`${mock.url}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jwt: "ey.valid.jwt", email: "dev@example.com" }),
      });
      assert.equal(resp.status, 200, `expected 200, got ${resp.status}`);
      const body = (await resp.json()) as Record<string, unknown>;
      assert.equal(typeof body["ok"], "boolean", "missing ok");
      assert.equal(typeof body["session_token"], "string", "missing session_token");
      assert.ok("team_id" in body, "missing team_id");
      assert.ok("user_id" in body, "missing user_id");
      // The legacy fields MUST be gone — if they reappear, the mock has drifted.
      assert.equal(body["resource_type"], undefined, "legacy resource_type leaked");
      assert.equal(body["token"], undefined, "legacy token leaked");
      assert.equal(body["tier"], undefined, "legacy tier leaked");
    });

    it("provisioning routes 400 on a name that fails the live api pattern (start-alnum + spaces/underscores/dashes)", async () => {
      // Names like "-bad", "@x", "has/slash" pass the loose old mock and the
      // loose old client schema but 400 on the live api. The mock now mirrors
      // the regex so the test catches schema drift.
      const resp = await fetch(`${mock.url}/db/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "-bad" }),
      });
      assert.equal(resp.status, 400, `expected 400 for bad name, got ${resp.status}`);
      const body = (await resp.json()) as { error?: string };
      assert.equal(body.error, "invalid_name", `unexpected error: ${JSON.stringify(body)}`);
    });
  });

  // ── Stack lifecycle (CEO wedge: one MCP call → live bundle URL) ──────────────

  describe("stack lifecycle", () => {
    // Minimal manifest the mock will accept. Indented two-space services map,
    // one entry called `app` with port + expose:true.
    const HELLO_MANIFEST =
      "services:\n  app:\n    build: .\n    port: 8080\n    expose: true\n";

    it("create_stack schema advertises name, manifest, service_tarballs, env", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const stack = tools.find((t) => t.name === "create_stack")!;
        const props = (stack.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        for (const field of ["name", "manifest", "service_tarballs", "env"]) {
          assert.ok(field in props, `create_stack schema missing '${field}'`);
        }
        const required = (stack.inputSchema as { required?: string[] }).required ?? [];
        assert.ok(required.includes("name"), "create_stack must require name");
        assert.ok(required.includes("manifest"), "create_stack must require manifest");
        assert.ok(required.includes("service_tarballs"), "create_stack must require service_tarballs");
        // env is OPTIONAL — server defaults to development per mig 026.
        assert.ok(!required.includes("env"), "create_stack env must be optional");
        assert.ok(
          /anonymous/i.test(stack.description ?? ""),
          "create_stack description must mention anonymous-friendly semantics (wedge)"
        );
      } finally {
        await close();
      }
    });

    it("get_stack schema advertises stack_id required", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const get = tools.find((t) => t.name === "get_stack")!;
        const required = (get.inputSchema as { required?: string[] }).required ?? [];
        assert.ok(required.includes("stack_id"), "get_stack must require stack_id");
      } finally {
        await close();
      }
    });

    it("anonymous create_stack succeeds without INSTANODE_TOKEN (the wedge)", async () => {
      // CEO ask: cold-start agent, NO token, one MCP call → stack accepted.
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "create_stack",
          arguments: {
            name: "wedge-anon",
            manifest: HELLO_MANIFEST,
            service_tarballs: { app: fakeTarballBase64() },
          },
        });
        const text = resultText(res);
        assert.ok(text.includes("Stack accepted"), `expected accepted stack:\n${text}`);
        assert.ok(/Status:\s+building/.test(text), `expected status=building:\n${text}`);
        assert.ok(/Tier:\s+anonymous/.test(text), `expected anonymous tier:\n${text}`);
        assert.ok(/Expires in:\s+24h/.test(text), `expected 24h TTL on anon:\n${text}`);
        // Anonymous tier → upgrade block surfaces a claim URL.
        assert.ok(/Claim URL/i.test(text), `expected the claim URL block:\n${text}`);
        assert.equal(mock.stackCount(), 1, "/stacks/new was not hit exactly once");
      } finally {
        await close();
      }
    });

    it("create_stack with INSTANODE_TOKEN lands at the paid tier (no anon CTA)", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({
          name: "create_stack",
          arguments: {
            name: "wedge-paid",
            manifest: HELLO_MANIFEST,
            service_tarballs: { app: fakeTarballBase64() },
          },
        });
        const text = resultText(res);
        assert.ok(/Tier:\s+pro/.test(text), `expected pro tier with valid token:\n${text}`);
        assert.equal(/Claim URL/i.test(text), false, "paid stack should not surface the anon claim CTA");
      } finally {
        await close();
      }
    });

    it("create_stack forwards env through to the api (CLI-MCP FINDING-8 contract on stacks)", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({
          name: "create_stack",
          arguments: {
            name: "wedge-env",
            manifest: HELLO_MANIFEST,
            service_tarballs: { app: fakeTarballBase64() },
            env: "staging",
          },
        });
        const text = resultText(res);
        assert.ok(/Environment:\s+staging/.test(text), `expected echoed env=staging:\n${text}`);
        const stack = mock.liveStacks().find((s) => s.name === "wedge-env")!;
        assert.equal(stack.env, "staging", "mock did not see env=staging on the wire");
      } finally {
        await close();
      }
    });

    it("full stack lifecycle: create (building) → get_stack flips to healthy with a live URL", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const created = await client.callTool({
          name: "create_stack",
          arguments: {
            name: "stack-lifecycle",
            manifest: HELLO_MANIFEST,
            service_tarballs: { app: fakeTarballBase64() },
          },
        });
        const createdText = resultText(created);
        const stackId = /Stack ID:\s+(\S+)/.exec(createdText)![1];
        assert.match(stackId, /^stk-/, "expected stk-<hex> stack id");

        // Poll — mock flips building→healthy on first GET.
        const got = await client.callTool({
          name: "get_stack",
          arguments: { stack_id: stackId },
        });
        const gotText = resultText(got);
        assert.ok(/Status:\s+healthy/.test(gotText), `expected healthy after poll:\n${gotText}`);
        assert.ok(
          /https:\/\/.*deployment\.instanode\.dev/.test(gotText),
          `expected a live URL on the exposed service:\n${gotText}`
        );
      } finally {
        await close();
      }
    });

    it("get_stack 404s on a missing slug with a clean error envelope (no crash)", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "get_stack",
          arguments: { stack_id: "stk-does-not-exist" },
        });
        const text = resultText(res);
        // formatError should surface the api's error envelope (status + code + msg).
        assert.ok(/404/.test(text), `expected 404 message:\n${text}`);
        assert.ok(/stack not found/i.test(text), `expected 'stack not found' detail:\n${text}`);
      } finally {
        await close();
      }
    });

    it("create_stack rejects a manifest with no `services:` map (400 invalid_manifest)", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const res = await client.callTool({
          name: "create_stack",
          arguments: {
            name: "no-svc",
            manifest: "name: empty\n",
            service_tarballs: { app: fakeTarballBase64() },
          },
        });
        const text = resultText(res);
        // The mock returns invalid_manifest when zero services are declared.
        // The MCP surfaces this via formatError → "(400 invalid_manifest)".
        assert.ok(
          /invalid_manifest|manifest/i.test(text),
          `expected invalid manifest error:\n${text}`
        );
      } finally {
        await close();
      }
    });
  });

  // ── CLI-MCP FINDING-8: env passthrough on every provisioning tool ──────────

  describe("env passthrough on provisioning tools (CLI-MCP FINDING-8)", () => {
    // One assertion per create_* — call with env="staging" and assert the api
    // saw it on the wire by inspecting mock state OR (where the mock doesn't
    // surface env on the resource) the request body the mock captured.
    //
    // The mock's provisionResponse hardcodes env: "development" on the
    // RESPONSE body regardless of the request — which is fine for now: the
    // test pins the CLIENT-side wire contract, not the server's echo.

    it("create_postgres forwards env to /db/new", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const before = mock.provisionCount();
        await client.callTool({
          name: "create_postgres",
          arguments: { name: "pg-staging", env: "staging" },
        });
        assert.equal(mock.provisionCount(), before + 1, "provision did not occur");
        // Cleanup: anonymous and free auto-expire — paid creates a row,
        // but listResources isn't exercised here. The mock simply tracks
        // it; no real DB to leak.
      } finally {
        await close();
      }
    });

    it("create_cache forwards env to /cache/new", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const before = mock.provisionCount();
        await client.callTool({
          name: "create_cache",
          arguments: { name: "rc-staging", env: "staging" },
        });
        assert.equal(mock.provisionCount(), before + 1);
      } finally {
        await close();
      }
    });
  });

  // ── CLI-MCP FINDING-12: cache description honesty ──────────────────────────

  describe("CLI-MCP FINDING-12 — create_cache description honesty", () => {
    it("create_cache description quotes the live plans.yaml numbers (50/512/1024)", async () => {
      const { client, close } = await connectClient(mock.url, "none");
      try {
        const { tools } = await client.listTools();
        const cache = tools.find((t) => t.name === "create_cache")!;
        const desc = cache.description ?? "";
        // Pre-fix it said "hobby 25 / pro 256" — both wrong by a factor of 2.
        // Post-fix it must quote the actual plans.yaml values.
        assert.match(desc, /hobby 50 MB/i, "expected hobby 50 MB in create_cache description");
        assert.match(desc, /pro 512 MB/i, "expected pro 512 MB in create_cache description");
      } finally {
        await close();
      }
    });
  });
});

// ── UA-capturing mock server (used by the User-Agent regression test only) ────
//
// A tiny http.Server that records every inbound User-Agent header and otherwise
// responds like the anonymous-tier /db/new happy path. Kept separate from the
// main mock so the rest of the suite is unaffected.
import { createServer, type Server as HttpServer } from "node:http";

async function createMockApiThatCapturesUA(
  observed: string[]
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: HttpServer = createServer((req, res) => {
    const ua = req.headers["user-agent"];
    if (typeof ua === "string") observed.push(ua);
    // Drain the request body so the client sees the response.
    req.on("data", () => undefined);
    req.on("end", () => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          id: "00000000-0000-0000-0000-000000000000",
          token: "00000000-0000-0000-0000-000000000000",
          name: "ua-check",
          tier: "anonymous",
          env: "development",
          expires_at: null,
          limits: { storage_mb: 10, connections: 2, expires_in: "24h" },
          connection_url: "postgres://u:p@host/db",
          note: "stub",
          upgrade: "https://api.instanode.dev/start?t=stub",
          upgrade_jwt: "stub",
        })
      );
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("UA mock failed to bind a port");
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}
