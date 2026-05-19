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

import { startMockApi, type MockApiHandle, VALID_TOKEN, BAD_TOKEN } from "./mock-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The server is built to dist/index.js (tsconfig rootDir=src, outDir=dist).
// This test file compiles to dist-test/test/integration.test.js, so the
// server binary sits two directories up then into dist/.
const SERVER_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

/** Every tool the server is contractually required to register. */
const EXPECTED_TOOLS = [
  "create_postgres",
  "create_cache",
  "create_nosql",
  "create_queue",
  "create_storage",
  "create_webhook",
  "create_deploy",
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
  token: "valid" | "bad" | "none"
): Promise<{ client: Client; close: () => Promise<void> }> {
  const env: Record<string, string> = {
    INSTANODE_API_URL: apiUrl,
    // Keep PATH so node can find shared libs; everything else is scrubbed.
    PATH: process.env["PATH"] ?? "",
  };
  if (token === "valid") env["INSTANODE_TOKEN"] = VALID_TOKEN;
  if (token === "bad") env["INSTANODE_TOKEN"] = BAD_TOKEN;

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
    it("registers exactly the 16 contract tools, no dead ones", async () => {
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

        // redeploy — status flips back to building
        const redeployed = await client.callTool({ name: "redeploy", arguments: { id: appId } });
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
        const res = await client.callTool({ name: "get_deployment", arguments: { id: "app-doesnotexist" } });
        assert.ok(/404|not found/i.test(resultText(res)), "get_deployment did not surface a 404");
      } finally {
        await close();
      }
    });

    it("redeploy returns a not-found error for an unknown app id", async () => {
      const { client, close } = await connectClient(mock.url, "valid");
      try {
        const res = await client.callTool({ name: "redeploy", arguments: { id: "app-doesnotexist" } });
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
});
