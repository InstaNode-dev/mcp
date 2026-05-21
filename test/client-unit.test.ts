/**
 * Unit tests for src/client.ts that hit branches the in-process integration
 * suite (test/integration.test.ts) does not exercise:
 *
 *   - request<T>() network-error path (fetch rejects)
 *   - request<T>() non-JSON response body (parse throws), both ok + non-ok
 *   - request<T>() empty-2xx safe sentinel (data === undefined)
 *   - request<T>() requireAuth gating when INSTANODE_TOKEN is unset
 *   - requestMultipart<T>() same four paths (mirror coverage)
 *   - dashboardURL() + apiBaseURL() helpers
 *   - createDeploy(): tarball-too-large client-side reject
 *   - createDeploy(): allowed_ips + private invariant rejects
 *
 * These tests stub global.fetch (Node 26 has it built-in) so they run with
 * zero external infrastructure — no mock-api, no server spawn.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ApiError,
  AuthRequiredError,
  InstantClient,
} from "../src/client.js";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

function stubFetch(fn: (input: any, init?: any) => Promise<Response> | Response): void {
  (globalThis as any).fetch = ((input: any, init?: any) => Promise.resolve(fn(input, init))) as FetchFn;
}

function restoreFetch(): void {
  (globalThis as any).fetch = realFetch;
}

describe("InstantClient — unit-level branch coverage", () => {
  beforeEach(() => {
    delete process.env["INSTANODE_TOKEN"];
    delete process.env["INSTANODE_API_URL"];
    delete process.env["INSTANODE_DASHBOARD_URL"];
  });

  afterEach(() => {
    restoreFetch();
    delete process.env["INSTANODE_TOKEN"];
    delete process.env["INSTANODE_API_URL"];
    delete process.env["INSTANODE_DASHBOARD_URL"];
  });

  it("apiBaseURL returns the constructor baseURL with trailing slash stripped", () => {
    const c = new InstantClient({ baseURL: "https://example.test/" });
    assert.equal(c.apiBaseURL(), "https://example.test");
  });

  it("apiBaseURL reads INSTANODE_API_URL when no baseURL is passed", () => {
    process.env["INSTANODE_API_URL"] = "https://env-host.example/";
    const c = new InstantClient();
    assert.equal(c.apiBaseURL(), "https://env-host.example");
  });

  it("dashboardURL reads INSTANODE_DASHBOARD_URL fresh each call and strips trailing slash", () => {
    const c = new InstantClient();
    process.env["INSTANODE_DASHBOARD_URL"] = "https://staging.dash/";
    assert.equal(c.dashboardURL(), "https://staging.dash");
    process.env["INSTANODE_DASHBOARD_URL"] = "https://other.dash";
    assert.equal(c.dashboardURL(), "https://other.dash");
  });

  it("createPostgres → throws ApiError(0) when fetch itself throws (network error)", async () => {
    stubFetch(() => { throw new TypeError("fetch failed"); });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.createPostgres("db"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 0);
        assert.match((err as ApiError).message, /network error reaching instanode.dev/);
        return true;
      }
    );
  });

  it("createPostgres → throws ApiError on non-JSON 2xx body", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.createPostgres("db"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 200);
        assert.match((err as ApiError).message, /non-JSON response/);
        return true;
      }
    );
  });

  it("createPostgres → throws ApiError on non-JSON non-2xx body", async () => {
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.createPostgres("db"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 502);
        assert.match((err as ApiError).message, /upstream error \(HTTP 502\)/);
        return true;
      }
    );
  });

  it("redeploy → empty-2xx body resolves to safe sentinel with caller-supplied id", async () => {
    stubFetch(() => new Response("", { status: 202 }));
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const res = await c.redeploy("dep-123");
    assert.equal(res.ok, true);
    assert.equal(res.id, "dep-123");
    assert.equal(res.status, "building");
  });

  it("listResources → throws AuthRequiredError when INSTANODE_TOKEN is unset", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.listResources(),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("deleteResource → bubbles ApiError envelope fields (agent_action, upgrade_url, claim_url)", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          error: "paid_tier_only",
          message: "Free-tier resources auto-expire",
          upgrade_url: "https://instanode.dev/pricing",
          agent_action: "Tell the user free-tier resources cannot be deleted manually.",
          claim_url: "https://instanode.dev/claim?t=jwt",
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
    );
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.deleteResource("res_123"),
      (err: unknown) => {
        const e = err as ApiError;
        assert.equal(e.status, 403);
        assert.equal(e.code, "paid_tier_only");
        assert.equal(e.upgradeURL, "https://instanode.dev/pricing");
        assert.match(e.agentAction ?? "", /free-tier resources cannot be deleted manually/);
        assert.equal(e.claimURL, "https://instanode.dev/claim?t=jwt");
        return true;
      }
    );
  });

  it("deleteResource → defaults message to 'upstream error' on empty error body", async () => {
    stubFetch(() => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }));
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.deleteResource("res_123"),
      (err: unknown) => {
        const e = err as ApiError;
        assert.equal(e.status, 500);
        assert.equal(e.message, "upstream error");
        return true;
      }
    );
  });

  it("createDeploy → rejects oversized tarballs CLIENT-SIDE before any fetch", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });

    // Create a 60 MiB base64 string (50 MiB cap on the decoded side; one
    // base64 char ≈ 0.75 bytes decoded, so 60 MiB of base64 → ~45 MiB
    // decoded — under the cap. Bump to 80 MiB to clear the cap.)
    const big = Buffer.alloc(60 * 1024 * 1024, 0xff).toString("base64");

    let fetched = false;
    stubFetch(() => { fetched = true; return new Response("ok", { status: 200 }); });

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: big, name: "huge" }),
      (err: unknown) => /too large/i.test((err as Error).message)
    );
    assert.equal(fetched, false, "fetch should never be reached for oversized tarballs");
  });

  it("createDeploy → rejects allowed_ips without private=true", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    let fetched = false;
    stubFetch(() => { fetched = true; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); });

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x", allowed_ips: ["1.2.3.4/32"] }),
      (err: unknown) => /allowed_ips was provided but `private` is not true/.test((err as Error).message)
    );
    assert.equal(fetched, false);
  });

  it("createDeploy → rejects private=true with empty allowed_ips", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    let fetched = false;
    stubFetch(() => { fetched = true; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); });

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x", private: true }),
      (err: unknown) => /requires a non-empty `allowed_ips`/.test((err as Error).message)
    );
    assert.equal(fetched, false);
  });

  it("createDeploy → multipart network error surfaces as ApiError(0)", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    stubFetch(() => { throw new TypeError("ECONNREFUSED"); });

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x", port: 8080 }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 0);
        assert.match((err as ApiError).message, /network error reaching instanode.dev/);
        return true;
      }
    );
  });

  it("createDeploy → multipart non-JSON 2xx body surfaces as ApiError", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    stubFetch(() => new Response("html-not-json", { status: 200, headers: { "content-type": "text/html" } }));

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.match((err as ApiError).message, /non-JSON response/);
        return true;
      }
    );
  });

  it("createDeploy → multipart non-JSON non-OK body surfaces as ApiError", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    stubFetch(() => new Response("oops", { status: 503 }));

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 503);
        assert.match((err as ApiError).message, /upstream error \(HTTP 503\)/);
        return true;
      }
    );
  });

  it("createDeploy → requireAuth gate throws AuthRequiredError when no token", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("createDeploy → bubbles ApiError fields from JSON error envelope", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    stubFetch(() =>
      new Response(
        JSON.stringify({
          error: "deploy_limit_reached",
          message: "hobby tier is capped at 1 deployment",
          upgrade_url: "https://instanode.dev/pricing",
          agent_action: "Tell the user to upgrade to Pro for 10 deployments",
        }),
        { status: 402, headers: { "content-type": "application/json" } }
      )
    );

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => {
        const e = err as ApiError;
        assert.equal(e.status, 402);
        assert.equal(e.code, "deploy_limit_reached");
        assert.equal(e.upgradeURL, "https://instanode.dev/pricing");
        assert.match(e.agentAction ?? "", /upgrade to Pro/);
        return true;
      }
    );
  });

  it("createDeploy → empty-2xx multipart resolves to safe sentinel (then .item.app_id read)", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    stubFetch(() => new Response("", { status: 202 }));
    // The body-less 2xx path resolves to `{ ok: true }`. createDeploy then
    // reads raw.item.app_id which is undefined — TypeScript-level the call
    // can throw. We assert it surfaces a TypeError-shaped failure rather
    // than silently succeeding.
    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => err instanceof TypeError
    );
  });

  it("getApiToken → uses default name 'instanode-mcp' when none supplied", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, id: "k1", name: "n", key: "K", created_at: "t" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.getApiToken();
    assert.equal(r.token, "K");
    assert.equal(r.expires_in, 0);
    assert.equal(body.name, "instanode-mcp");
  });

  it("getApiToken → uses supplied name when non-empty", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, id: "k1", name: "custom", key: "K", created_at: "t" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.getApiToken("my-tool");
    assert.equal(body.name, "my-tool");
  });

  it("createVector → passes optional dimensions through", async () => {
    let captured: any = null;
    stubFetch((_input: any, init?: any) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", tier: "anonymous", name: "v", connection_url: "postgres://x" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createVector("v", 3072);
    assert.equal(captured.name, "v");
    assert.equal(captured.dimensions, 3072);
  });

  it("createVector → omits dimensions field when not supplied", async () => {
    let captured: any = null;
    stubFetch((_input: any, init?: any) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", tier: "anonymous", name: "v", connection_url: "postgres://x" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createVector("v");
    assert.equal(captured.name, "v");
    assert.equal("dimensions" in captured, false);
  });
});

describe("ApiError + AuthRequiredError shapes", () => {
  it("AuthRequiredError carries the canonical message + name", () => {
    const e = new AuthRequiredError();
    assert.equal(e.name, "AuthRequiredError");
    assert.match(e.message, /requires authentication/i);
    assert.match(e.message, /INSTANODE_TOKEN/);
  });

  it("ApiError stores every constructor field on the instance", () => {
    const e = new ApiError(402, "boom", "code_x", "https://up/", "do thing", "https://claim/");
    assert.equal(e.status, 402);
    assert.equal(e.message, "boom");
    assert.equal(e.code, "code_x");
    assert.equal(e.upgradeURL, "https://up/");
    assert.equal(e.agentAction, "do thing");
    assert.equal(e.claimURL, "https://claim/");
    assert.equal(e.name, "ApiError");
  });
});
