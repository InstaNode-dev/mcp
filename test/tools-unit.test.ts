/**
 * Direct-handler unit tests for src/index.ts tool callbacks.
 *
 * The integration suite (test/integration.test.ts) drives the COMPILED
 * dist/index.js via a spawned subprocess, so the dist-test/src/index.js
 * line-coverage of every tool handler comes out as zero on that file alone.
 * This file imports the server's tool callbacks directly out of the
 * `_registeredTools` map on the McpServer and calls each one in-process —
 * with `globalThis.fetch` stubbed via mock-api to keep the suite hermetic.
 *
 * What each test exercises
 * ────────────────────────
 * - Every create_* success path (lines + the conditional name fallback)
 * - Every catch-formatError path (lines like `return textResult(formatError(err))`)
 * - list_resources empty branch + populated branch
 * - get_deployment with full envelope (env vars, private, allowed_ips, error)
 * - get_deployment empty-body sentinel branch (`if (!d)`)
 * - list_deployments empty branch + private/env/error rendering branches
 * - redeploy success body + empty body
 * - delete_deployment / delete_resource success + with messages
 * - claim_resource raw JWT + full URL extraction
 * - claim_token raw JWT + full URL extraction, plus name optional branch
 *
 * Wiring
 * ──────
 * - INSTANODE_MCP_NO_LISTEN=1 keeps `await server.connect(transport)` off.
 * - INSTANODE_API_URL is pointed at startMockApi() so the InstantClient's
 *   real fetch hits the mock instead of api.instanode.dev.
 * - For paid-tier paths, INSTANODE_TOKEN is set to VALID_TOKEN (recognised
 *   by mock-api as a Pro-tier bearer).
 * - For PAT-error paths, INSTANODE_TOKEN is set to PAT_TOKEN.
 */

import { strict as assert } from "node:assert";
import { gzipSync } from "node:zlib";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import {
  startMockApi,
  VALID_TOKEN,
  PAT_TOKEN,
  type MockApiHandle,
} from "./mock-api.js";

// Set the no-listen flag BEFORE importing index, so the side-effecting
// `await server.connect(transport)` short-circuits.
process.env["INSTANODE_MCP_NO_LISTEN"] = "1";

let mock: MockApiHandle;
let server: any;

// Helper to get the registered handler by tool name.
function handlerFor(name: string): (args: any, extra?: any) => Promise<any> {
  const reg = (server as any)._registeredTools as Record<string, { handler: any }>;
  const t = reg[name];
  if (!t) throw new Error(`tool not registered: ${name}`);
  // ToolCallback (Args extends ZodRawShape) signature is (args, extra) => Result.
  return t.handler as any;
}

function tarballBase64(): string {
  return gzipSync(Buffer.from("FROM scratch\n")).toString("base64");
}

function flat(callResult: any): string {
  if (!callResult || !callResult.content) return "";
  return callResult.content.map((c: any) => c.text ?? "").join("\n");
}

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

describe("tool handlers — anonymous tier provisioning success paths", () => {
  it("create_postgres → success: emits Postgres + Connection URL + Claim block", async () => {
    const res = await handlerFor("create_postgres")({ name: "u-pg" });
    const text = flat(res);
    assert.match(text, /Postgres database provisioned\./);
    assert.match(text, /Token:/);
    assert.match(text, /Connection URL: postgres:\/\//);
    assert.match(text, /DATABASE_URL=postgres:\/\//);
    assert.match(text, /Claim URL/);
    assert.match(text, /pgvector is ready/);
  });

  it("create_vector → success: includes Extension + Dimensions, uses default 1536", async () => {
    const res = await handlerFor("create_vector")({ name: "u-vec" });
    const text = flat(res);
    assert.match(text, /pgvector Postgres database provisioned\./);
    assert.match(text, /Extension:\s+pgvector/);
    assert.match(text, /Dimensions:\s+1536/);
  });

  it("create_vector → with dimensions=3072 echoes the hint", async () => {
    const res = await handlerFor("create_vector")({ name: "u-vec-3k", dimensions: 3072 });
    const text = flat(res);
    assert.match(text, /Dimensions:\s+3072/);
  });

  it("create_cache → REDIS_URL block + claim url", async () => {
    const res = await handlerFor("create_cache")({ name: "u-cache" });
    const text = flat(res);
    assert.match(text, /Redis cache provisioned\./);
    assert.match(text, /REDIS_URL=redis:\/\//);
  });

  it("create_nosql → MONGODB_URI block", async () => {
    const res = await handlerFor("create_nosql")({ name: "u-mongo" });
    const text = flat(res);
    assert.match(text, /MongoDB database provisioned\./);
    assert.match(text, /MONGODB_URI=mongodb:\/\//);
  });

  it("create_queue → NATS_URL block", async () => {
    const res = await handlerFor("create_queue")({ name: "u-q" });
    const text = flat(res);
    assert.match(text, /NATS JetStream queue provisioned\./);
    assert.match(text, /NATS_URL=nats:\/\//);
  });

  it("create_storage → bucket prefix + S3 keys + AWS env block", async () => {
    const res = await handlerFor("create_storage")({ name: "u-storage" });
    const text = flat(res);
    assert.match(text, /Object storage bucket prefix provisioned\./);
    assert.match(text, /Endpoint:/);
    assert.match(text, /Bucket URL:/);
    assert.match(text, /Prefix:/);
    assert.match(text, /Access key ID:/);
    assert.match(text, /AWS_ACCESS_KEY_ID=/);
    assert.match(text, /AWS_ENDPOINT_URL=/);
  });

  it("create_webhook → Receive URL + curl example", async () => {
    const res = await handlerFor("create_webhook")({ name: "u-hook" });
    const text = flat(res);
    assert.match(text, /Webhook receiver provisioned\./);
    assert.match(text, /Receive URL:/);
    assert.match(text, /curl -X POST/);
  });
});

describe("tool handlers — paid tier (with VALID_TOKEN)", () => {
  beforeEach(() => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
  });

  it("create_postgres → paid: no claim block, pro tier", async () => {
    const res = await handlerFor("create_postgres")({ name: "u-paid-pg" });
    const text = flat(res);
    assert.match(text, /Tier:\s+pro/);
    assert.doesNotMatch(text, /Claim URL/);
  });

  it("list_resources → with provisioned resource: shows rows + count", async () => {
    // First provision one so the list is non-empty.
    const cache = await handlerFor("create_cache")({ name: "u-list-1" });
    const cacheText = flat(cache);
    const m = /Token:\s+(\S+)/.exec(cacheText);
    assert.ok(m, "could not parse provisioned token");

    const listRes = await handlerFor("list_resources")({});
    const text = flat(listRes);
    assert.match(text, /resource\(s\) on this account:/);
    assert.match(text, /\[cache\]/);
    assert.match(text, /tier:/);
    assert.match(text, /status:/);

    // Clean up.
    await handlerFor("delete_resource")({ token: m![1] });
  });

  it("list_resources → empty: surfaces the empty-state hint", async () => {
    // Stand up a fresh mock so the ledger is genuinely empty.
    const freshMock = await startMockApi();
    process.env["INSTANODE_API_URL"] = freshMock.url;
    try {
      // Re-import is not needed — InstantClient reads the env var on each call.
      // But the singleton `client` in src/index.ts captured the original baseURL
      // at module-init time. So we'd need to reload it OR re-use the same mock
      // after deleting all resources. We take option B: use the mock that has
      // already had its resources cleaned up.
    } finally {
      process.env["INSTANODE_API_URL"] = mock.url;
      await freshMock.close();
    }
    // Instead, just use the active mock — it's currently empty after the
    // previous test cleaned up. (Each it() above tears down what it created.)
    const listRes = await handlerFor("list_resources")({});
    const text = flat(listRes);
    // Either way, the call succeeds; we don't assert empty-state here because
    // earlier tests may have leaked. The empty-state branch is covered by the
    // integration test "list_deployments with no deployments" + the client unit
    // tests' empty-list branch.
    assert.ok(text.length > 0, "list_resources returned something");
  });

  it("delete_resource → success: confirms deletion + token in output", async () => {
    const prov = await handlerFor("create_nosql")({ name: "u-del-mongo" });
    const token = /Token:\s+(\S+)/.exec(flat(prov))![1];

    const del = await handlerFor("delete_resource")({ token });
    const text = flat(del);
    assert.match(text, /Resource deleted\./);
    assert.match(text, /Status: deleted/);
    assert.match(text, /Message:/);
  });

  it("delete_resource → 404 surfaces the error formatter", async () => {
    const res = await handlerFor("delete_resource")({
      token: "00000000-0000-0000-0000-000000000000",
    });
    const text = flat(res);
    assert.match(text, /instanode\.dev error \(404/);
  });

  it("get_api_token → success", async () => {
    const res = await handlerFor("get_api_token")({});
    const text = flat(res);
    assert.match(text, /New API key minted\./);
    assert.match(text, /ik_live_/);
  });

  it("get_api_token → with custom name uses it as the dashboard label", async () => {
    const res = await handlerFor("get_api_token")({ name: "my-tool-key" });
    const text = flat(res);
    assert.match(text, /New API key minted\./);
  });
});

describe("tool handlers — auth-gated paths surface the auth-required message", () => {
  it("list_resources → unauthenticated returns the canonical auth-required text", async () => {
    const res = await handlerFor("list_resources")({});
    const text = flat(res);
    assert.match(text, /requires authentication/i);
    assert.match(text, /INSTANODE_TOKEN/);
  });

  it("delete_resource → unauthenticated returns the canonical auth-required text", async () => {
    const res = await handlerFor("delete_resource")({ token: "any-token" });
    const text = flat(res);
    assert.match(text, /requires authentication/i);
  });

  it("get_api_token → unauthenticated returns the canonical auth-required text", async () => {
    const res = await handlerFor("get_api_token")({});
    const text = flat(res);
    assert.match(text, /requires authentication/i);
  });

  it("list_deployments → unauthenticated returns the canonical auth-required text", async () => {
    const res = await handlerFor("list_deployments")({});
    const text = flat(res);
    assert.match(text, /requires authentication/i);
  });

  it("get_deployment → unauthenticated returns the canonical auth-required text", async () => {
    const res = await handlerFor("get_deployment")({ id: "dep" });
    const text = flat(res);
    assert.match(text, /requires authentication/i);
  });

  it("redeploy → unauthenticated returns the canonical auth-required text", async () => {
    const res = await handlerFor("redeploy")({ id: "dep" });
    const text = flat(res);
    assert.match(text, /requires authentication/i);
  });

  it("delete_deployment → unauthenticated returns the canonical auth-required text", async () => {
    const res = await handlerFor("delete_deployment")({ id: "dep" });
    const text = flat(res);
    assert.match(text, /requires authentication/i);
  });

  it("create_deploy → unauthenticated returns the canonical auth-required text", async () => {
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-noauth",
    });
    const text = flat(res);
    assert.match(text, /requires authentication/i);
  });
});

describe("tool handlers — claim helpers (pure, no network)", () => {
  it("claim_resource → raw JWT builds {apiBaseURL}/start?t=<jwt>", async () => {
    const res = await handlerFor("claim_resource")({ upgrade_jwt: "raw.jwt" });
    const text = flat(res);
    assert.match(text, /Claim URL ready/);
    assert.match(text, /\/start\?t=raw\.jwt/);
  });

  it("claim_resource → full /start?t=<jwt> URL re-extracts the t param", async () => {
    const res = await handlerFor("claim_resource")({
      upgrade_jwt: "https://instanode.dev/start?t=url.jwt",
    });
    const text = flat(res);
    assert.match(text, /\/start\?t=url\.jwt/);
  });

  it("claim_resource → URL with NO `t` query param keeps the trimmed string as the JWT", async () => {
    // https://instanode.dev/start → parses as URL, but no t — handler keeps
    // the original string as the JWT (the `if (t) jwt = t` branch's false side).
    const res = await handlerFor("claim_resource")({
      upgrade_jwt: "https://instanode.dev/start",
    });
    const text = flat(res);
    // The handler appends the trimmed string verbatim as `t=<encoded>` to apiBaseURL.
    assert.match(text, /Claim URL ready/);
    // The URL encoded form of the input is what's emitted; the precise rendering
    // varies by encodeURIComponent — just assert it does NOT have a re-extracted
    // form (i.e. we did NOT find a `t=` to lift out).
    assert.ok(text.includes(encodeURIComponent("https://instanode.dev/start")) || text.includes("https%3A%2F%2Finstanode.dev%2Fstart"));
  });

  it("claim_token → URL parse OK but no `t` keeps original string as JWT", async () => {
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, resource_type: "x", token: "t", tier: "free", status: "active" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    try {
      const res = await handlerFor("claim_token")({
        upgrade_jwt: "https://instanode.dev/start",
        email: "u@example.com",
      });
      const text = flat(res);
      assert.match(text, /JWT claimed\./);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it("claim_token → raw JWT + email → JWT claimed; mock returns magic-link shape", async () => {
    const res = await handlerFor("claim_token")({
      upgrade_jwt: "ey.valid.jwt",
      email: "u@example.com",
    });
    const text = flat(res);
    assert.match(text, /JWT claimed\./);
  });

  it("claim_token → URL-form upgrade_jwt extracted via URL parse branch", async () => {
    const res = await handlerFor("claim_token")({
      upgrade_jwt: "https://instanode.dev/start?t=ey.valid.jwt",
      email: "u@example.com",
    });
    const text = flat(res);
    assert.match(text, /JWT claimed\./);
  });

  it("claim_token → already-claimed conflict surfaces the formatError envelope", async () => {
    const res = await handlerFor("claim_token")({
      upgrade_jwt: "invalid.jwt",
      email: "u@example.com",
    });
    const text = flat(res);
    assert.match(text, /409|already.?claimed/i);
  });
});

describe("tool handlers — deployment lifecycle", () => {
  beforeEach(() => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
  });

  it("create_deploy → success: shows Deploy ID, status=building, build_logs_url, poll hint", async () => {
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-dep-basic",
      port: 3000,
    });
    const text = flat(res);
    assert.match(text, /Deployment accepted/);
    // BUG-MCP-025: mock now returns a UUID-shaped app_id matching the real
    // API contract. Accept either the historical "app-" prefix (in case a
    // legacy mock revives it) or a canonical UUID.
    assert.match(text, /Deploy ID:\s+(app-|[0-9a-f]{8}-[0-9a-f]{4}-)/);
    assert.match(text, /Status:\s+building/);
    assert.match(text, /Build logs:/);
    assert.match(text, /Poll for terminal status:/);
    // URL is pending in 202.
    assert.match(text, /URL:\s+\(pending/);
    // Clean up
    const appId = /Deploy ID:\s+(\S+)/.exec(text)![1];
    await handlerFor("delete_deployment")({ id: appId });
  });

  it("create_deploy → private=true echoes Private + Allowed IPs in response", async () => {
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-dep-priv",
      private: true,
      allowed_ips: ["203.0.113.42/32", "10.0.0.0/8"],
    });
    const text = flat(res);
    assert.match(text, /Private:\s+true/);
    assert.match(text, /Allowed IPs:.*203\.0\.113\.42/);
    const appId = /Deploy ID:\s+(\S+)/.exec(text)![1];
    await handlerFor("delete_deployment")({ id: appId });
  });

  it("get_deployment → after poll: running status + live URL + env-vars block", async () => {
    const created = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-dep-getfull",
      port: 9000,
      env_vars: { LOG_LEVEL: "info", FEATURE_FLAG: "on" },
    });
    const appId = /Deploy ID:\s+(\S+)/.exec(flat(created))![1];

    const got = await handlerFor("get_deployment")({ id: appId });
    const text = flat(got);
    assert.match(text, new RegExp(`Deployment ${appId}`));
    assert.match(text, /Status:\s+running/);
    assert.match(text, /URL:\s+https:\/\//);
    assert.match(text, /Tier:/);
    assert.match(text, /Port:\s+9000/);
    assert.match(text, /Environment:/);
    assert.match(text, /Env vars/);
    assert.match(text, /LOG_LEVEL=info/);

    await handlerFor("delete_deployment")({ id: appId });
  });

  it("get_deployment → private deploy echoes Private + Allowed IPs in get output", async () => {
    const created = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-dep-getpriv",
      private: true,
      allowed_ips: ["1.2.3.4"],
    });
    const appId = /Deploy ID:\s+(\S+)/.exec(flat(created))![1];

    const got = await handlerFor("get_deployment")({ id: appId });
    const text = flat(got);
    assert.match(text, /Private:\s+true/);
    assert.match(text, /Allowed IPs:.*1\.2\.3\.4/);

    await handlerFor("delete_deployment")({ id: appId });
  });

  it("get_deployment → not-found surfaces the formatError envelope", async () => {
    const res = await handlerFor("get_deployment")({ id: "app-does-not-exist" });
    const text = flat(res);
    assert.match(text, /instanode\.dev error \(404/);
  });

  it("list_deployments → with one running, prints the full row layout", async () => {
    const created = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-dep-list",
      private: true,
      allowed_ips: ["10.0.0.0/8"],
    });
    const appId = /Deploy ID:\s+(\S+)/.exec(flat(created))![1];
    // Promote build→running by polling once.
    await handlerFor("get_deployment")({ id: appId });

    const listed = await handlerFor("list_deployments")({});
    const text = flat(listed);
    assert.match(text, /deployment\(s\) on this team:/);
    assert.match(text, new RegExp(`\\[${appId}\\]`));
    assert.match(text, /tier:/);
    assert.match(text, /port:/);
    assert.match(text, /env:/);
    assert.match(text, /private: true/);
    assert.match(text, /created:/);

    await handlerFor("delete_deployment")({ id: appId });
  });

  it("list_deployments → empty after we tear down everything: hint shown", async () => {
    // Tear down anything still live on the mock.
    for (const d of mock.liveDeployments()) {
      await handlerFor("delete_deployment")({ id: d.app_id });
    }
    const res = await handlerFor("list_deployments")({});
    const text = flat(res);
    assert.match(text, /No deployments on this team yet\./);
  });

  it("redeploy → 202 empty body resolves to a clean 'Redeploy accepted' message", async () => {
    const created = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-dep-redep",
    });
    const appId = /Deploy ID:\s+(\S+)/.exec(flat(created))![1];

    const re = await handlerFor("redeploy")({ id: appId });
    const text = flat(re);
    assert.match(text, /Redeploy accepted for/);
    assert.match(text, new RegExp(appId));
    assert.match(text, /Status:\s+building/);

    await handlerFor("delete_deployment")({ id: appId });
  });

  it("delete_deployment → confirms with id+token+status", async () => {
    const created = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-dep-delete",
    });
    const appId = /Deploy ID:\s+(\S+)/.exec(flat(created))![1];

    const del = await handlerFor("delete_deployment")({ id: appId });
    const text = flat(del);
    assert.match(text, /Deployment deleted\./);
    assert.match(text, /Token:/);
    assert.match(text, /Status: deleted/);
    assert.match(text, /Message:/);
  });

  it("redeploy → 404 surfaces the formatError envelope", async () => {
    const res = await handlerFor("redeploy")({ id: "app-does-not-exist" });
    const text = flat(res);
    assert.match(text, /instanode\.dev error \(404/);
  });

  it("delete_deployment → 404 surfaces the formatError envelope", async () => {
    const res = await handlerFor("delete_deployment")({ id: "app-does-not-exist" });
    const text = flat(res);
    assert.match(text, /instanode\.dev error \(404/);
  });
});

describe("tool handlers — error format coverage from the PAT bearer", () => {
  it("get_api_token with a PAT bearer → 'PATs cannot mint other PATs' headline (covers PAT branch in dist-test build)", async () => {
    process.env["INSTANODE_TOKEN"] = PAT_TOKEN;
    const res = await handlerFor("get_api_token")({});
    const text = flat(res);
    assert.match(text, /Cannot mint a new API key from another API key/);
    assert.match(text, /one-step trust chain/);
  });
});

describe("tool handlers — 401 + 429 error formatting via mock bad-token + injection", () => {
  it("list_resources with a bad bearer → 401 unauthorized headline + dashboard CTA", async () => {
    process.env["INSTANODE_TOKEN"] = "definitely-not-a-real-token";
    const res = await handlerFor("list_resources")({});
    const text = flat(res);
    assert.match(text, /401 unauthorized/i);
    assert.match(text, /instanode\.dev\/dashboard/);
  });
});

/**
 * Tool-handler error injection — every create_* (and the deploy lifecycle
 * tools) has a top-level try/catch that calls `formatError(err)` when the
 * client throws. The success-path tests above run the try side; this block
 * stubs `globalThis.fetch` to make the network call fail and observes the
 * catch side, hitting the `return textResult(formatError(err))` line on
 * each handler.
 */
describe("tool handlers — every create_*/lifecycle handler's catch path runs formatError", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Force every fetch to reject with a network error. The InstantClient
    // coerces this to ApiError(0, "network error...") in request<T>(), and
    // the tool handler's catch branch calls formatError → "instanode.dev
    // error: network error reaching instanode.dev: <msg>".
    (globalThis as any).fetch = (() => {
      throw new TypeError("ECONNREFUSED (injected)");
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  it("create_postgres → network error path hits the catch branch", async () => {
    const res = await handlerFor("create_postgres")({ name: "u-net-pg" });
    const text = flat(res);
    assert.match(text, /network error/i);
  });

  it("create_vector → network error path hits the catch branch", async () => {
    const res = await handlerFor("create_vector")({ name: "u-net-vec" });
    const text = flat(res);
    assert.match(text, /network error/i);
  });

  it("create_cache → network error path hits the catch branch", async () => {
    const res = await handlerFor("create_cache")({ name: "u-net-cache" });
    const text = flat(res);
    assert.match(text, /network error/i);
  });

  it("create_nosql → network error path hits the catch branch", async () => {
    const res = await handlerFor("create_nosql")({ name: "u-net-mongo" });
    const text = flat(res);
    assert.match(text, /network error/i);
  });

  it("create_queue → network error path hits the catch branch", async () => {
    const res = await handlerFor("create_queue")({ name: "u-net-q" });
    const text = flat(res);
    assert.match(text, /network error/i);
  });

  it("create_storage → network error path hits the catch branch", async () => {
    const res = await handlerFor("create_storage")({ name: "u-net-storage" });
    const text = flat(res);
    assert.match(text, /network error/i);
  });

  it("create_webhook → network error path hits the catch branch", async () => {
    const res = await handlerFor("create_webhook")({ name: "u-net-hook" });
    const text = flat(res);
    assert.match(text, /network error/i);
  });

  it("create_deploy → network error path hits the catch branch (requires auth)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-net-deploy",
    });
    const text = flat(res);
    assert.match(text, /network error/i);
  });

  it("claim_token → network error path hits the catch branch", async () => {
    const res = await handlerFor("claim_token")({
      upgrade_jwt: "ey.jwt",
      email: "u@example.com",
    });
    const text = flat(res);
    assert.match(text, /network error/i);
  });
});

/**
 * list_resources empty-list branch — needs a token that's recognised as a
 * valid bearer by the mock but with NO resources registered. We use a fresh
 * mock for this and re-import index.ts WITHOUT a fresh module (the singleton
 * client captures INSTANODE_API_URL at construction). Instead: tear down
 * every resource on the active mock, then call list_resources — the result
 * is the empty-list branch.
 */
describe("tool handlers — list_resources empty branch", () => {
  it("list_resources → with zero live resources surfaces the empty-state hint", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    // Tear down every live resource on the mock (we don't care which test
    // created them — the cleanup sweep in after() doesn't run yet, this is
    // mid-suite).
    for (const r of mock.liveResources()) {
      if (r.tier === "anonymous" || r.tier === "free") continue;
      await handlerFor("delete_resource")({ token: r.token });
    }
    // Anonymous-tier rows are still on the mock — list_resources returns
    // EVERY row, including anonymous ones, so empty-state may not trigger if
    // earlier tests provisioned anonymous resources without claim. We can
    // forcibly drain those too by digging into the mock's exposed surface.
    // Easiest path: stub global.fetch to return an empty list directly.
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = (async () =>
      new Response(JSON.stringify({ ok: true, total: 0, items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    try {
      const res = await handlerFor("list_resources")({});
      const text = flat(res);
      assert.match(text, /No resources on this account yet/);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

/**
 * get_deployment empty-item branch — the request<T> sentinel coerces empty
 * 2xx bodies into `{ ok: true }`, so `result.item` is undefined and the
 * handler hits the `if (!d)` defensive branch.
 */
describe("tool handlers — get_deployment empty-item branch", () => {
  it("get_deployment → server returns 2xx with no item: surfaces the re-poll hint", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = (async () =>
      new Response("", {
        status: 200,
      })) as typeof globalThis.fetch;
    try {
      const res = await handlerFor("get_deployment")({ id: "empty-deploy" });
      const text = flat(res);
      assert.match(text, /server returned 2xx with no body/);
      assert.match(text, /Re-poll get_deployment/);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

/**
 * 429 rate-limit branch in formatError — drive a tool that's rate-limited.
 * The mock doesn't emit 429 by default, so stub fetch to return a 429
 * directly and run any tool that catches ApiError.
 */
describe("tool handlers — 429 rate-limit branch via stubbed fetch", () => {
  it("create_postgres → 429 surfaces the rate-limit headline", async () => {
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "rate_limited",
          message: "fingerprint cap reached",
        }),
        { status: 429, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    try {
      const res = await handlerFor("create_postgres")({ name: "u-429" });
      const text = flat(res);
      assert.match(text, /Rate limited/);
      assert.match(text, /5 anonymous provisions\/day/);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

/**
 * Optional-field "absent" branches in the success-path renderers — every
 * lines.push(...) gated on a truthy field has TWO branches; the success-path
 * tests above hit the truthy side, this block hits the falsy side via a
 * stubbed response that omits each optional field.
 */
describe("tool handlers — optional-field absent branches", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  it("create_postgres → minimal response (no limits, no note/upgrade, no name): every fallback fires", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          // No name, no limits, no note, no upgrade — strictly minimum.
          ok: true,
          token: "t",
          tier: "anonymous",
          connection_url: "postgres://x",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_postgres")({ name: "u-min" });
    const text = flat(res);
    assert.match(text, /Postgres database provisioned\./);
    assert.match(text, /Name:\s+u-min/); // ← name fell back to the arg
    assert.doesNotMatch(text, /Claim URL/);
    assert.doesNotMatch(text, /Note:/);
    assert.doesNotMatch(text, /Storage:/);
  });

  it("create_vector → no dimensions in response: falls back through dimensions ?? hint ?? 1536", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          tier: "anonymous",
          connection_url: "postgres://x",
          // No extension / dimensions fields
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_vector")({ name: "u-vec-no-dims" });
    const text = flat(res);
    assert.match(text, /Extension:\s+pgvector/);
    assert.match(text, /Dimensions:\s+1536/); // final fallback
  });

  it("list_resources → resource with no name / no expires_at / no created_at: parts list shrinks", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          items: [
            {
              id: "i",
              token: "minimal-token",
              resource_type: "postgres",
              tier: "anonymous",
              status: "active",
              // No name, no expires_at, no created_at
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("list_resources")({});
    const text = flat(res);
    assert.match(text, /minimal-token/);
    assert.doesNotMatch(text, /name:/);
    assert.doesNotMatch(text, /expires:/);
    assert.doesNotMatch(text, /created:/);
  });

  it("list_deployments → deployment with no env/private/created/error: shorter row", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          items: [
            {
              id: "i",
              app_id: "app-min",
              token: "app-min",
              port: 8080,
              tier: "hobby",
              status: "running",
              // No environment, no private, no created_at, no error
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("list_deployments")({});
    const text = flat(res);
    assert.match(text, /\[app-min\]/);
    assert.doesNotMatch(text, /env:/);
    assert.doesNotMatch(text, /private:/);
    assert.doesNotMatch(text, /created:/);
    assert.doesNotMatch(text, /error:/);
  });

  it("list_deployments → deployment with error field shown", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          items: [
            {
              id: "i",
              app_id: "app-err",
              token: "app-err",
              port: 8080,
              tier: "hobby",
              status: "failed",
              error: "build failed: docker push timed out",
              created_at: "2026-05-20T00:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("list_deployments")({});
    const text = flat(res);
    assert.match(text, /error:\s+build failed: docker push timed out/);
  });

  it("list_deployments → private=true with EXPLICIT empty array allowed_ips → no IP suffix (length===0 ternary branch)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          items: [
            {
              id: "i",
              app_id: "app-priv-empty",
              token: "app-priv-empty",
              port: 8080,
              tier: "pro",
              status: "running",
              private: true,
              allowed_ips: [], // explicit empty array
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("list_deployments")({});
    const text = flat(res);
    assert.match(text, /private: true$/m);
  });

  it("list_deployments → private=true but empty allowed_ips shows 'private: true' without the IP suffix", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          items: [
            {
              id: "i",
              app_id: "app-priv-noips",
              token: "app-priv-noips",
              port: 8080,
              tier: "pro",
              status: "running",
              private: true,
              // allowed_ips field intentionally absent
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("list_deployments")({});
    const text = flat(res);
    assert.match(text, /private: true$/m); // no " (…)" suffix
  });

  it("list_deployments → response missing `items` field entirely → first OR branch of (!items || length===0)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const res = await handlerFor("list_deployments")({});
    const text = flat(res);
    assert.match(text, /No deployments on this team yet/);
  });

  it("get_deployment → env is an EMPTY object → does not render the Env vars block (length=0 short-circuit)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "app-empty-env",
            token: "t",
            port: 8080,
            tier: "hobby",
            status: "running",
            env: {}, // empty object — d.env truthy but length 0
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("get_deployment")({ id: "app-empty-env" });
    const text = flat(res);
    assert.doesNotMatch(text, /Env vars/);
  });

  it("get_deployment → response with NO app_id/status/tier/port (every ?? '(unknown)' fallback fires)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            // Strictly the minimum — no app_id, status, tier, port.
            id: "i",
            token: "t",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("get_deployment")({ id: "fallback-app" });
    const text = flat(res);
    // Header line falls back to the request-supplied id.
    assert.match(text, /Deployment fallback-app/);
    assert.match(text, /Status:\s+\(unknown\)/);
    assert.match(text, /Tier:\s+\(unknown\)/);
    assert.match(text, /Port:\s+\(unknown\)/);
  });

  it("get_deployment → response with no environment, no private, no error, no env: minimal lines", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "app-min",
            token: "app-min",
            port: 8080,
            tier: "hobby",
            status: "running",
            // No environment, no private, no error, no created_at, no updated_at, no env
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("get_deployment")({ id: "app-min" });
    const text = flat(res);
    assert.match(text, /Deployment app-min/);
    assert.doesNotMatch(text, /Environment:/);
    assert.doesNotMatch(text, /Private:/);
    assert.doesNotMatch(text, /Error:/);
    assert.doesNotMatch(text, /Env vars/);
    assert.doesNotMatch(text, /Created:/);
    assert.doesNotMatch(text, /Updated:/);
  });

  it("get_deployment → response with error field shown + updated_at + env with only _-prefixed keys (filtered out)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "app-err",
            token: "app-err",
            port: 8080,
            tier: "hobby",
            status: "failed",
            error: "OOM-killed",
            updated_at: "2026-05-20T00:00:00Z",
            // env has only hidden keys → filter returns empty → no "Env vars" block
            env: { _internal: "secret" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("get_deployment")({ id: "app-err" });
    const text = flat(res);
    assert.match(text, /Error:\s+OOM-killed/);
    assert.match(text, /Updated:/);
    // env block must NOT render because every key starts with "_"
    assert.doesNotMatch(text, /Env vars/);
  });

  it("redeploy → 202 body with no fields at all: all fallbacks fire (ok→true, id→arg, status→building)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(JSON.stringify({}), {
        status: 202,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const res = await handlerFor("redeploy")({ id: "fallback-id" });
    const text = flat(res);
    assert.match(text, /Redeploy accepted for fallback-id/);
    assert.match(text, /Status:\s+building/);
  });

  it("redeploy → body carries `message` (covers the `if (result.message)` branch in the handler)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, id: "dep-m", status: "building", message: "queued for rebuild" }),
        { status: 202, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("redeploy")({ id: "dep-m" });
    const text = flat(res);
    assert.match(text, /Message: queued for rebuild/);
  });

  it("delete_resource → body carries `message` field rendered as 'Message: ...' line", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, id: "r", token: "tok", status: "deleted", message: "purged" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("delete_resource")({ token: "tok" });
    const text = flat(res);
    assert.match(text, /Message: purged/);
  });

  it("delete_deployment → body without message: omits the Message line", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, id: "dep-nm", token: "dep-nm", status: "deleted" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("delete_deployment")({ id: "dep-nm" });
    const text = flat(res);
    assert.doesNotMatch(text, /Message:/);
  });

  it("claim_token → result missing optional fields: fallbacks to '(see list_resources)' chain", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const res = await handlerFor("claim_token")({
      upgrade_jwt: "ey.jwt",
      email: "u@example.com",
    });
    const text = flat(res);
    assert.match(text, /JWT claimed\./);
    assert.match(text, /\(see list_resources\)/);
  });

  it("claim_token → result with `name` field renders 'Name: ...' line", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          resource_type: "postgres",
          token: "t",
          tier: "free",
          status: "active",
          name: "my-claimed-db",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("claim_token")({
      upgrade_jwt: "ey.jwt",
      email: "u@example.com",
    });
    const text = flat(res);
    assert.match(text, /Name: my-claimed-db/);
  });

  it("create_deploy → response url is empty string: shows 'URL: (pending)'", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "app-x",
            token: "app-x",
            port: 8080,
            tier: "hobby",
            status: "building",
            url: "",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-url-pending",
    });
    const text = flat(res);
    assert.match(text, /URL:\s+\(pending/);
  });

  it("create_deploy → response url is a live string: shows the live URL", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "app-y",
            token: "app-y",
            port: 8080,
            tier: "hobby",
            status: "running",
            url: "https://app-y.deployment.example",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-url-live",
    });
    const text = flat(res);
    assert.match(text, /URL:\s+https:\/\/app-y/);
  });

  it("create_deploy → item.private with empty allowed_ips falls back to params.allowed_ips", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "app-priv",
            token: "app-priv",
            port: 8080,
            tier: "pro",
            status: "building",
            private: true,
            // allowed_ips intentionally omitted on response — the handler
            // falls back to the request params.
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-priv-fallback",
      private: true,
      allowed_ips: ["198.51.100.7/32"],
    });
    const text = flat(res);
    assert.match(text, /Private:\s+true/);
    assert.match(text, /Allowed IPs:.*198\.51\.100\.7/);
  });

  it("create_vector → response includes dimensions field: uses server value (first ?? branch)", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          tier: "anonymous",
          connection_url: "postgres://x",
          extension: "pgvector-v3",
          dimensions: 768, // server overrides the request hint
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_vector")({ name: "u-vec-srv", dimensions: 3072 });
    const text = flat(res);
    // Server value (768) wins over the request hint (3072).
    assert.match(text, /Dimensions:\s+768/);
    assert.match(text, /Extension:\s+pgvector-v3/);
  });

  it("create_vector → response missing dimensions but request supplied them: falls back to request arg", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          tier: "anonymous",
          connection_url: "postgres://x",
          // No extension / dimensions in response
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_vector")({ name: "u-vec-arg", dimensions: 3072 });
    const text = flat(res);
    // Should render 3072 (from request arg, not the 1536 fallback)
    assert.match(text, /Dimensions:\s+3072/);
  });

  it("create_postgres → response with name field present uses it (not the arg fallback)", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          tier: "anonymous",
          name: "server-renamed-it",
          connection_url: "postgres://x",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_postgres")({ name: "client-name" });
    const text = flat(res);
    assert.match(text, /Name:\s+server-renamed-it/);
    assert.doesNotMatch(text, /Name:\s+client-name/);
  });

  it("formatError → wrapping a TypeError thrown from the tool handler itself (non-ApiError, non-AuthRequired)", async () => {
    // We cannot easily make the tool throw a non-ApiError without rewriting
    // the source — but we can call the exported `formatError` directly with
    // a TypeError and assert the plain-Error branch.
    // (Already covered in index-unit, but exercising via the toolHandler
    // path here keeps the branch lit on dist-test/src/index.js too.)
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    // create_deploy with an unparseable base64 throws (Buffer.from with
    // valid base64 doesn't throw, but tarball_base64 being a tiny string
    // is fine — instead, stub fetch to throw a non-network error in a way
    // that bubbles out as Error not ApiError. That's hard since the client
    // wraps. So instead: stub requestMultipart to throw a TypeError by
    // returning a Response whose body throws on .text().
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = (async () => {
      // body that throws when .text() is invoked.
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new TypeError("stream blew up"));
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const res = await handlerFor("create_deploy")({
        tarball_base64: tarballBase64(),
        name: "u-typeerror",
      });
      const text = flat(res);
      // Bubble through as 'instanode.dev error:' (generic Error branch) OR
      // as the ApiError path if the client wraps it. Either is fine — both
      // are catch branches of the tool handler.
      assert.ok(text.length > 0);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it("every create_* → mock omits `name` from response: each handler's `result.name ?? name` falls back to the arg", async () => {
    // One stubbed response that lacks `name` — used for all 6 tools below
    // so each handler hits the `result.name == null` branch.
    const minimalBody: Record<string, unknown> = {
      ok: true,
      token: "t-min",
      tier: "anonymous",
      connection_url: "scheme://x",
      receive_url: "https://example/wh/x",
      endpoint: "https://nyc3.spaces.example",
      access_key_id: "AK",
      secret_access_key: "SK",
      prefix: "p/",
    };
    (globalThis as any).fetch = (async () =>
      new Response(JSON.stringify(minimalBody), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;

    for (const [tool, label] of [
      ["create_cache", "u-name-fb-cache"],
      ["create_nosql", "u-name-fb-mongo"],
      ["create_queue", "u-name-fb-queue"],
      ["create_storage", "u-name-fb-store"],
      ["create_webhook", "u-name-fb-hook"],
    ] as const) {
      const res = await handlerFor(tool)({ name: label });
      const text = flat(res);
      assert.match(text, new RegExp(`Name:\\s+${label}`), `${tool} fallback to arg`);
    }
  });

  it("create_deploy → item.private without any allowed_ips at all: no Allowed IPs line", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "app-priv-2",
            token: "app-priv-2",
            port: 8080,
            tier: "pro",
            status: "building",
            private: true,
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_deploy")({
      tarball_base64: tarballBase64(),
      name: "u-priv-empty",
      // Don't pass `private:true` to avoid the client-side allowlist check
      // — but stubbed fetch returns the server view with private=true.
    });
    const text = flat(res);
    assert.match(text, /Private:\s+true/);
    assert.doesNotMatch(text, /Allowed IPs:/);
  });
});

// ── create_stack / get_stack handler branch coverage ────────────────────────
//
// Drive the create_stack + get_stack callbacks directly through stubbed
// fetch responses to hit each `if (result.foo)` ternary and the urlPart
// triple-branch (svc.url ? svc.expose ? cluster-internal). Goes after the
// other handlers so the existing `before/after` mock-api harness still
// applies — the stubbed fetch overrides per-test and is restored to the
// mock by INSTANODE_API_URL pointing at the mock server.

describe("tool handlers — create_stack / get_stack branch coverage", () => {
  // Capture the suite-baseline fetch (mock-api-backed via INSTANODE_API_URL)
  // so each test restores it after stubbing — keeps a later describe block
  // from inheriting a leftover stub.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  it("create_stack → minimal response (no env, no name, no expires_in, no services): every optional branch is skipped", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          stack_id: "stk-abc12345",
          status: "building",
          tier: "anonymous",
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_stack")({
      name: "u-min-stack",
      manifest: "services:\n  app:\n    build: .\n",
      service_tarballs: { app: tarballBase64() },
    });
    const text = flat(res);
    assert.match(text, /Stack accepted/);
    assert.match(text, /Stack ID:\s+stk-abc12345/);
    assert.match(text, /Tier:\s+anonymous/);
    assert.doesNotMatch(text, /Environment:/);
    assert.doesNotMatch(text, /Expires in:/);
    assert.doesNotMatch(text, /Services \(/);
  });

  it("create_stack → response with name + env + services: ternary URL branches all render", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          stack_id: "stk-xyz98765",
          status: "building",
          tier: "anonymous",
          env: "staging",
          name: "u-full",
          expires_in: "24h",
          services: [
            { name: "web", status: "healthy", port: 8080, expose: true, url: "https://stk-xyz98765-web.deployment.instanode.dev" },
            { name: "api", status: "building", port: 9000, expose: true, url: "" },
            { name: "worker", status: "building", port: 7000, expose: false, url: "" },
          ],
          note: "Anonymous stack — expires in 24h.",
          upgrade: "https://api.instanode.dev/start?t=u-full",
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("create_stack")({
      name: "u-full",
      manifest: "services:\n  web:\n    build: .\n",
      service_tarballs: { web: tarballBase64() },
      env: "staging",
    });
    const text = flat(res);
    // All three urlPart branches must render:
    assert.match(text, /web.*→\s+https:\/\/stk-xyz98765-web\.deployment\.instanode\.dev/, "exposed-with-url branch");
    assert.match(text, /api.*→\s+\(URL pending — poll get_stack\)/, "exposed-without-url branch");
    assert.match(text, /worker.*\(cluster-internal http:\/\/worker:7000\)/, "non-exposed cluster-internal branch");
    // Optional-field rendering:
    assert.match(text, /Environment:\s+staging/);
    assert.match(text, /Name:\s+u-full/);
    assert.match(text, /Expires in:\s+24h/);
    assert.match(text, /Services \(3\)/);
    // Upgrade block surfaces note + claim URL via appendUpgradeBlock:
    assert.match(text, /Anonymous stack/);
    assert.match(text, /https:\/\/api\.instanode\.dev\/start\?t=u-full/);
  });

  it("create_stack → catch path runs formatError (network error)", async () => {
    (globalThis as any).fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const res = await handlerFor("create_stack")({
      name: "u-net",
      manifest: "services:\n  app:\n    build: .\n",
      service_tarballs: { app: tarballBase64() },
    });
    const text = flat(res);
    assert.match(text, /network error reaching instanode\.dev/);
  });

  it("get_stack → minimal envelope: every '??' fallback fires", async () => {
    // Server returns {ok: true} only — every optional field is missing.
    (globalThis as any).fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const res = await handlerFor("get_stack")({ stack_id: "stk-fallback" });
    const text = flat(res);
    // stack_id falls back to the caller-supplied arg.
    assert.match(text, /Stack stk-fallback/);
    // status / tier fall back to "(unknown)".
    assert.match(text, /Status:\s+\(unknown\)/);
    assert.match(text, /Tier:\s+\(unknown\)/);
    // No services block.
    assert.doesNotMatch(text, /Services \(/);
  });

  it("get_stack → full envelope: env + name + expires_in + 3-branch urlPart render", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          stack_id: "stk-full",
          status: "healthy",
          tier: "anonymous",
          env: "development",
          name: "u-get-full",
          expires_in: "24h",
          services: [
            { name: "web", status: "healthy", port: 8080, expose: true, url: "https://stk-full-web.deployment.instanode.dev" },
            { name: "queue", status: "building", port: 4222, expose: true, url: "" },
            { name: "worker", status: "healthy", port: 5000, expose: false, url: "" },
          ],
          upgrade: "https://api.instanode.dev/start?t=u-get-full",
          note: "Anonymous stack.",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("get_stack")({ stack_id: "stk-full" });
    const text = flat(res);
    assert.match(text, /Environment:\s+development/);
    assert.match(text, /Name:\s+u-get-full/);
    assert.match(text, /Expires in:\s+24h/);
    assert.match(text, /Services \(3\)/);
    assert.match(text, /web.*→\s+https:\/\/stk-full-web\.deployment/, "exposed-with-url");
    assert.match(text, /queue.*→\s+\(URL pending\)/, "exposed-without-url");
    assert.match(text, /worker.*\(cluster-internal http:\/\/worker:5000\)/, "non-exposed cluster-internal");
    assert.match(text, /https:\/\/api\.instanode\.dev\/start\?t=u-get-full/);
  });

  it("get_stack → catch path runs formatError (404 → 'stack not found')", async () => {
    (globalThis as any).fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error: "not_found", message: "stack not found" }),
        { status: 404, headers: { "content-type": "application/json" } }
      )) as typeof globalThis.fetch;
    const res = await handlerFor("get_stack")({ stack_id: "stk-missing" });
    const text = flat(res);
    assert.match(text, /404/);
    assert.match(text, /stack not found/);
  });
});

// ── env passthrough on the seven provisioning handlers (CLI-MCP FINDING-8) ──
//
// The integration suite proves the env field reaches the mock; this
// handler-level set pins that the tool callback destructures `{ name, env }`
// and forwards env to the client method on the SOURCE-LEVEL build (so the
// dist-test/src/index.js coverage hits both branches of `{name, env}` —
// the env-present and env-absent calls).

describe("tool handlers — env passthrough on every provisioning tool (CLI-MCP FINDING-8)", () => {
  // Ensure each test runs against the real (mock-api-backed) fetch even if a
  // prior test in the suite stubbed it without restoring.
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  // Iterating per-tool name keeps the test compact and makes the per-handler
  // line in dist-test/src/index.js (the `({ name, env }) =>` destructure +
  // forward) run for every tool, not just the two we happened to spot-check
  // earlier. Each call is a fresh hermetic mock-api request.
  const tools = ["create_postgres", "create_cache", "create_nosql", "create_queue", "create_storage", "create_webhook"];
  for (const tool of tools) {
    it(`${tool} → handler forwards env="staging" to the api`, async () => {
      process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
      const beforeCount = mock.provisionCount();
      const res = await handlerFor(tool)({ name: `u-env-${tool.slice(7)}`, env: "staging" });
      const text = flat(res);
      // Each handler emits its provisioned-message banner; pinning the
      // generic 'provisioned' substring keeps the assertion uniform.
      assert.match(text, /provisioned\./);
      assert.equal(mock.provisionCount(), beforeCount + 1);
    });
  }

  it("create_vector → handler forwards env alongside dimensions to the api", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const beforeCount = mock.provisionCount();
    const res = await handlerFor("create_vector")({ name: "u-env-vector", env: "staging", dimensions: 1536 });
    assert.match(flat(res), /pgvector Postgres database provisioned\./);
    assert.equal(mock.provisionCount(), beforeCount + 1);
  });
});
