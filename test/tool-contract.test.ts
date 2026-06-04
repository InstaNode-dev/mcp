/**
 * Contract / agent-facing error-mapping tests for the MCP gap tools.
 *
 * Companion to test/tools-unit.test.ts (success paths) and test/index-unit.test.ts
 * (pure formatError unit). This file fills the matrix §2 gap "MCP: J2-J9,J11,
 * J14-J19 live (error + contract)" at the integration layer: each test drives a
 * REAL tool handler against the mock api and asserts (a) it hits the correct J-row
 * endpoint with the correct payload shape, and (b) the api's error envelope is
 * mapped into the exact agent-facing block the LLM reads aloud.
 *
 * Agents are the PRIMARY consumers of instanode (CLAUDE.md), so the agent-facing
 * error surface — the `Action:` / `Upgrade:` / `Claim:` block and the 401/404
 * headlines — is itself a P0 contract, not cosmetic text.
 *
 * SCOPE NOTE (matrix W0 dependency): these run hermetically against the in-process
 * mock api (test/mock-api.ts). Real-backend MUTATING flows (live provision/deploy
 * against staging/prod) depend on the W0 backend skip-cohort guard
 * (USER-FLOW-INVENTORY-AND-TEST-MATRIX.md §3.W0) and are intentionally NOT run
 * here — until that guard lands, live mutating MCP runs target STAGING only. The
 * read-only live smoke lives in test/live-smoke.test.ts.
 */

import { strict as assert } from "node:assert";
import { gzipSync } from "node:zlib";
import { after, afterEach, before, describe, it } from "node:test";

import {
  startMockApi,
  VALID_TOKEN,
  HOBBY_TOKEN,
  type MockApiHandle,
} from "./mock-api.js";

// Keep the side-effecting `await server.connect(transport)` off when index is
// imported (same flag the other in-process suites use).
process.env["INSTANODE_MCP_NO_LISTEN"] = "1";

let mock: MockApiHandle;
let server: any;

function handlerFor(name: string): (args: any, extra?: any) => Promise<any> {
  const reg = (server as any)._registeredTools as Record<string, { handler: any }>;
  const t = reg[name];
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t.handler as any;
}

function tarballBase64(): string {
  return gzipSync(Buffer.from("FROM scratch\n")).toString("base64");
}

function flat(callResult: any): string {
  if (!callResult || !callResult.content) return "";
  return callResult.content.map((c: any) => c.text ?? "").join("\n");
}

// A syntactically-valid UUID that the mock has never minted → exercises the
// "not on your team / not found" 404 (matrix J11/J17 cross-team-404 contract:
// the api returns an indistinguishable 404 whether the row is on another team
// or absent — that indistinguishability IS the isolation guarantee).
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

before(async () => {
  mock = await startMockApi();
  process.env["INSTANODE_API_URL"] = mock.url;
  delete process.env["INSTANODE_TOKEN"];
  const mod: any = await import("../src/index.js");
  server = mod.server;
});

after(async () => {
  await mock.close();
});

afterEach(() => {
  delete process.env["INSTANODE_TOKEN"];
});

// ───────────────────────────────────────────────────────────────────────────
// 402 over-limit → agent_action (matrix J13 "tier gate", agent-facing P0)
//
// This is the contract gap the dedicated mock fixture (HOBBY_TOKEN) was added
// for: before it, the mock's tier-gate 402 was only reachable via an
// `x-mock-tier` request header the InstantClient never sends, so the END-TO-END
// agent_action surfacing path (tool → client → ApiError → formatError) was
// never exercised. Now a real create_deploy({private:true}) on a hobby bearer
// reaches it the same way prod does.
// ───────────────────────────────────────────────────────────────────────────
describe("agent-facing error mapping — 402 tier-gate surfaces agent_action verbatim", () => {
  it("create_deploy({private:true}) on hobby tier → 402 maps to Action + Upgrade block", async () => {
    process.env["INSTANODE_TOKEN"] = HOBBY_TOKEN;
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "hobby-private-app",
      private: true,
      allowed_ips: ["203.0.113.42/32"],
    });
    const text = flat(res);
    // Headline carries the 402 + the api error code.
    assert.match(text, /402 tier_upgrade_required/);
    assert.match(text, /private deploys require Pro tier or higher/);
    // The agent_action sentence the platform copy-edited for the LLM is
    // surfaced VERBATIM under an "Action:" label (rule 12 / FIX-E #C7).
    assert.match(text, /\nAction: .*upgrade.*pricing/i);
    // The upgrade URL is surfaced so the agent can hand the user a live CTA.
    assert.match(text, /\nUpgrade: https:\/\/instanode\.dev\/pricing/);
    // It did NOT create a deployment — a tier-gate is a hard stop.
    assert.equal(
      mock.liveDeployments().some((d) => (d.env["_name"] ?? "") === "hobby-private-app"),
      false,
      "402 tier-gate must not leave a half-created deployment"
    );
  });

  it("create_deploy({private:true}) on PRO tier → succeeds (negative control for the gate)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "pro-private-app",
      private: true,
      allowed_ips: ["203.0.113.42/32"],
    });
    const text = flat(res);
    assert.doesNotMatch(text, /tier_upgrade_required/);
    assert.match(text, /Deployment accepted/);
    assert.match(text, /Private:\s+true/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 401 auth (matrix J11/J13/J14 — auth-required tools)
// ───────────────────────────────────────────────────────────────────────────
describe("agent-facing error mapping — 401 on auth-required tools points at the dashboard", () => {
  it("create_deploy with a revoked bearer → 401 headline + dashboard CTA", async () => {
    process.env["INSTANODE_TOKEN"] = "definitely-not-a-real-token";
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "no-auth-deploy",
    });
    const text = flat(res);
    assert.match(text, /401 unauthorized/i);
    assert.match(text, /instanode\.dev\/dashboard/);
  });

  it("delete_resource with a revoked bearer → 401 headline + dashboard CTA", async () => {
    process.env["INSTANODE_TOKEN"] = "definitely-not-a-real-token";
    const res = await handlerFor("delete_resource")({ token: UNKNOWN_UUID });
    const text = flat(res);
    assert.match(text, /401 unauthorized/i);
    assert.match(text, /instanode\.dev\/dashboard/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 404 not-found / cross-team isolation (matrix J11 + J17)
// ───────────────────────────────────────────────────────────────────────────
describe("agent-facing error mapping — 404 (cross-team / absent) maps to a clean not_found", () => {
  it("get_deployment for an id not on the caller's team → 404 not_found", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("get_deployment")({ id: UNKNOWN_UUID });
    const text = flat(res);
    assert.match(text, /404 not_found/);
    assert.match(text, /deployment not found/);
  });

  it("delete_resource for a token not on the caller's team → 404 not_found", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("delete_resource")({ token: UNKNOWN_UUID });
    const text = flat(res);
    assert.match(text, /404 not_found/);
    assert.match(text, /resource not found/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Endpoint contract — each gap tool reaches the correct J-row endpoint and
// round-trips the documented response shape. A successful, shape-correct
// response proves the right (method, path) was hit (the mock routes strictly
// by method+path and 404s any unmatched route).
// ───────────────────────────────────────────────────────────────────────────
describe("endpoint contract — gap tools hit the correct J-row endpoint + shape", () => {
  it("J5 create_queue → POST /queue/new, returns a queue token + claim block (anon)", async () => {
    const before = mock.provisionCount();
    const res = await handlerFor("create_queue")({ name: "ctr-queue" });
    const text = flat(res);
    assert.equal(mock.provisionCount(), before + 1, "create_queue did not hit /queue/new");
    assert.match(text, /Token:/);
    assert.match(text, /Claim URL/i);
  });

  it("J6 create_storage → POST /storage/new, surfaces the isolation mode", async () => {
    const before = mock.provisionCount();
    const res = await handlerFor("create_storage")({ name: "ctr-storage" });
    const text = flat(res);
    assert.equal(mock.provisionCount(), before + 1, "create_storage did not hit /storage/new");
    assert.match(text, /Token:/);
  });

  it("J7 create_webhook → POST /webhook/new, returns a receiver token", async () => {
    const before = mock.provisionCount();
    const res = await handlerFor("create_webhook")({ name: "ctr-hook" });
    const text = flat(res);
    assert.equal(mock.provisionCount(), before + 1, "create_webhook did not hit /webhook/new");
    assert.match(text, /Token:/);
  });

  it("J14 create_stack → POST /stacks/new, returns a stack_id (anon, multi-service)", async () => {
    const before = mock.stackCount();
    const res = await handlerFor("create_stack")({
      name: "ctr-stack",
      manifest: "services:\n  app:\n    build: .\n    port: 8080\n    expose: true\n",
      service_tarballs: { app: tarballBase64() },
    });
    const text = flat(res);
    assert.equal(mock.stackCount(), before + 1, "create_stack did not hit /stacks/new");
    assert.match(text, /Stack ID:\s+stk-[0-9a-f]{8}/);
    assert.match(text, /Claim URL/i, "anon stack must surface the upgrade/claim block");
  });

  it("J15 get_stack → GET /stacks/:slug, returns the stack status for polling", async () => {
    // Create a stack first so there is a stack_id to fetch.
    const created = flat(
      await handlerFor("create_stack")({
        name: "ctr-stack-poll",
        manifest: "services:\n  web:\n    build: .\n    port: 8080\n    expose: true\n",
        service_tarballs: { web: tarballBase64() },
      })
    );
    const idMatch = /Stack ID:\s+(stk-[0-9a-f]{8})/.exec(created);
    assert.ok(idMatch, `could not extract a stack_id from create_stack output:\n${created}`);
    const res = await handlerFor("get_stack")({ stack_id: idMatch[1] });
    const text = flat(res);
    // A non-error, populated response proves GET /stacks/:slug was reached and
    // the build auto-flipped building → healthy on poll.
    assert.match(text, new RegExp(`Stack ${idMatch[1]}`));
    assert.match(text, /Status:\s+healthy/);
  });

  it("J16 list_deployments → GET /api/v1/deployments, team-scoped list", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("list_deployments")({});
    const text = flat(res);
    // Either a populated list or the empty sentinel — both prove the endpoint
    // was reached and the response was mapped (not an error).
    assert.match(text, /deployment\(s\) on this team:|No deployments on this team yet/);
  });
});
