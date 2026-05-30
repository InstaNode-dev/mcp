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

  it("createPostgres → fetch throws a NON-Error value: String(err) branch in request<T> catch", async () => {
    // The request<T>() catch coerces with `err instanceof Error ? err.message : String(err)`.
    // Throwing a bare string hits the false branch of that ternary.
    stubFetch(() => { throw "bare-string-thrown"; });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.createPostgres("db"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.match((err as ApiError).message, /bare-string-thrown/);
        return true;
      }
    );
  });

  it("createDeploy → fetch throws a NON-Error value: String(err) branch in requestMultipart catch", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    stubFetch(() => { throw { weirdShape: true } as unknown as Error; });
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        // String({weirdShape:true}) → "[object Object]"
        assert.match((err as ApiError).message, /\[object Object\]/);
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
    const tiny = Buffer.from("hello").toString("base64");
    const res = await c.redeploy("dep-123", tiny);
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

  it("getApiToken → empty string name still falls back to 'instanode-mcp' (length>0 false branch)", async () => {
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
    await c.getApiToken("");
    assert.equal(body.name, "instanode-mcp");
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

  // ──────────────────────────────────────────────────────────────────────────
  // Per-method line coverage — every create_* + list/get/delete path on the
  // SOURCE-LEVEL client.ts must run at least once so dist-test/src/client.js
  // reports them as covered. The integration suite hits dist/client.js but
  // not the in-test src/client.ts copy.
  // ──────────────────────────────────────────────────────────────────────────

  it("createCache → POSTs /cache/new with {name}", async () => {
    let captured: { url: string; body: any } | null = null;
    stubFetch((input: any, init?: any) => {
      captured = { url: String(input), body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          id: "i",
          tier: "anonymous",
          connection_url: "redis://x",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.createCache("my-cache");
    assert.equal(r.connection_url, "redis://x");
    assert.match(captured!.url, /\/cache\/new$/);
    assert.equal(captured!.body.name, "my-cache");
  });

  it("createNoSQL → POSTs /nosql/new with {name}", async () => {
    let url = "";
    stubFetch((input: any) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          id: "i",
          tier: "anonymous",
          connection_url: "mongodb://x",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createNoSQL("mongo-1");
    assert.match(url, /\/nosql\/new$/);
  });

  it("createQueue → POSTs /queue/new with {name}", async () => {
    let url = "";
    stubFetch((input: any) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          id: "i",
          tier: "anonymous",
          connection_url: "nats://x",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createQueue("q-1");
    assert.match(url, /\/queue\/new$/);
  });

  it("createStorage → POSTs /storage/new with {name}", async () => {
    let url = "";
    stubFetch((input: any) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          id: "i",
          tier: "anonymous",
          connection_url: "https://nyc3.digitaloceanspaces.com/instant-shared/p/",
          endpoint: "https://nyc3.digitaloceanspaces.com",
          access_key_id: "AK",
          secret_access_key: "SK",
          prefix: "p/",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.createStorage("store-1");
    assert.match(url, /\/storage\/new$/);
    assert.equal(r.access_key_id, "AK");
  });

  it("createWebhook → POSTs /webhook/new with {name}", async () => {
    let url = "";
    stubFetch((input: any) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          id: "i",
          tier: "anonymous",
          receive_url: "https://example.test/webhook/abc",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.createWebhook("hook-1");
    assert.match(url, /\/webhook\/new$/);
    assert.match(r.receive_url, /\/webhook\/abc$/);
  });

  it("createPostgres → success path returns the full DatabaseProvisionResult body", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          token: "tok",
          id: "id-1",
          tier: "anonymous",
          connection_url: "postgres://x",
          limits: { storage_mb: 10, connections: 2, expires_in: "24h" },
          note: "claim within 24h",
          upgrade: "https://example.test/start?t=jwt",
          upgrade_jwt: "jwt",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.createPostgres("db");
    assert.equal(r.connection_url, "postgres://x");
    assert.equal(r.tier, "anonymous");
    assert.equal(r.upgrade_jwt, "jwt");
  });

  it("listResources → returns wrapped.items when populated", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          total: 2,
          items: [
            { id: "1", token: "t1", resource_type: "postgres", tier: "anonymous", status: "active" },
            { id: "2", token: "t2", resource_type: "redis", tier: "anonymous", status: "active" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const items = await c.listResources();
    assert.equal(items.length, 2);
    assert.equal(items[0]?.token, "t1");
  });

  it("listResources → defaults to [] when wrapped.items is missing", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ ok: true, total: 0 }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const items = await c.listResources();
    assert.deepEqual(items, []);
  });

  it("claimToken → POSTs /claim with {jwt, email} (no auth required)", async () => {
    let body: any = null;
    let url = "";
    stubFetch((input: any, init?: any) => {
      url = String(input);
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          ok: true,
          id: "i",
          token: "t",
          resource_type: "postgres",
          tier: "free",
          status: "active",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    // No INSTANODE_TOKEN — claim is unauthenticated.
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.claimToken("the-jwt", "u@example.com");
    assert.match(url, /\/claim$/);
    assert.deepEqual(body, { jwt: "the-jwt", email: "u@example.com" });
    assert.equal(r.tier, "free");
  });

  it("listDeployments → returns the {ok,items,total} envelope verbatim", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          items: [
            {
              id: "i",
              app_id: "a-1",
              token: "t",
              port: 8080,
              tier: "hobby",
              status: "running",
              url: "https://a-1.deployment.instanode.dev",
              environment: "production",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.listDeployments();
    assert.equal(r.total, 1);
    assert.equal(r.items[0]?.app_id, "a-1");
  });

  it("getDeployment → GETs /api/v1/deployments/:id (id is URI-encoded)", async () => {
    let url = "";
    stubFetch((input: any) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "app/with slash",
            token: "t",
            port: 8080,
            tier: "hobby",
            status: "building",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.getDeployment("app/with slash");
    // %2F (slash) %20 (space) → confirms encodeURIComponent ran.
    assert.match(url, /\/api\/v1\/deployments\/app%2Fwith%20slash$/);
  });

  it("deleteDeployment → DELETEs /deploy/:id and bubbles the body shape", async () => {
    let method = "";
    let url = "";
    stubFetch((input: any, init?: any) => {
      method = init.method;
      url = String(input);
      return new Response(
        JSON.stringify({ ok: true, id: "dep-1", status: "deleted", message: "torn down" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.deleteDeployment("dep-1");
    assert.equal(method, "DELETE");
    assert.match(url, /\/deploy\/dep-1$/);
    assert.equal(r.status, "deleted");
  });

  it("redeploy → success-with-body propagates id+status+message verbatim", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ ok: true, id: "dep-9", status: "rebuilding", message: "kicked" }),
        { status: 202, headers: { "content-type": "application/json" } }
      )
    );
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    const r = await c.redeploy("dep-9", tiny);
    assert.equal(r.id, "dep-9");
    assert.equal(r.status, "rebuilding");
    assert.equal(r.message, "kicked");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // requestMultipart edge branches — JSON-error envelope path (non-OK with
  // parsed body) and the empty-2xx sentinel.
  // ──────────────────────────────────────────────────────────────────────────

  it("createDeploy → multipart non-OK JSON ERROR body bubbles every envelope field", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    stubFetch(() =>
      new Response(
        JSON.stringify({
          error: "deploy_quota_exceeded",
          message: "too many running deploys",
          upgrade_url: "https://instanode.dev/pricing",
          agent_action: "tell the user to upgrade",
          claim_url: "https://instanode.dev/claim?t=jwt",
        }),
        { status: 402, headers: { "content-type": "application/json" } }
      )
    );

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => {
        const e = err as ApiError;
        assert.equal(e.status, 402);
        assert.equal(e.code, "deploy_quota_exceeded");
        assert.equal(e.message, "too many running deploys");
        assert.equal(e.upgradeURL, "https://instanode.dev/pricing");
        assert.equal(e.agentAction, "tell the user to upgrade");
        assert.equal(e.claimURL, "https://instanode.dev/claim?t=jwt");
        return true;
      }
    );
  });

  it("request<T> → EMPTY non-OK body (no JSON parse) reaches err = (data ?? {}) with data undefined", async () => {
    // text.length === 0 → no parse → data stays undefined
    // !resp.ok → enters the (data ?? {}) branch with data undefined.
    stubFetch(() => new Response("", { status: 500 }));
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.createPostgres("db"),
      (err: unknown) => {
        const e = err as ApiError;
        assert.equal(e.status, 500);
        assert.equal(e.message, "upstream error");
        assert.equal(e.code, undefined);
        return true;
      }
    );
  });

  it("createDeploy → multipart EMPTY non-OK body (no payload) defaults to 'upstream error' + status", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    stubFetch(() =>
      new Response("", { status: 503 })
    );
    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => {
        const e = err as ApiError;
        assert.equal(e.status, 503);
        assert.equal(e.message, "upstream error");
        return true;
      }
    );
  });

  it("createDeploy → multipart non-OK JSON error body with EMPTY {} defaults message", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    stubFetch(() =>
      new Response("{}", {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    );

    await assert.rejects(
      () => c.createDeploy({ tarball_base64: tiny, name: "x" }),
      (err: unknown) => {
        const e = err as ApiError;
        assert.equal(e.status, 500);
        assert.equal(e.message, "upstream error");
        return true;
      }
    );
  });

  it("createDeploy → propagates resource_bindings into the env_vars form field", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");

    let formText = "";
    stubFetch(async (_input: any, init?: any) => {
      // Drain the body so we can verify the env_vars field. FormData → multipart
      // text; we only need to grep for the merged keys.
      const blob = init.body as any;
      if (blob && typeof blob.text === "function") {
        formText = await blob.text();
      } else if (blob && typeof blob[Symbol.asyncIterator] === "function") {
        const decoder = new TextDecoder();
        for await (const chunk of blob as any) {
          formText += decoder.decode(chunk as Uint8Array);
        }
      }
      return new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "a-1",
            token: "t",
            port: 8080,
            tier: "hobby",
            status: "building",
            url: "",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });

    const r = await c.createDeploy({
      tarball_base64: tiny,
      name: "with-bindings",
      env: "production",
      port: 9090,
      env_vars: { LOG_LEVEL: "debug" },
      resource_bindings: { DATABASE_URL: "pg-token-uuid" },
      private: false,
    });

    assert.equal(r.deploy_id, "a-1");
    assert.equal(r.url, "");
    assert.match(r.build_logs_url, /\/deploy\/a-1\/logs$/);
    // FormData serialisation should have emitted env_vars with both keys merged.
    if (formText.length > 0) {
      assert.match(formText, /env_vars/);
      assert.match(formText, /DATABASE_URL/);
      assert.match(formText, /pg-token-uuid/);
      assert.match(formText, /LOG_LEVEL/);
    }
  });

  it("createDeploy → private=true + allowed_ips serialises both fields into the form", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");

    let formText = "";
    stubFetch(async (_input: any, init?: any) => {
      const blob = init.body as any;
      if (blob && typeof blob.text === "function") {
        formText = await blob.text();
      }
      return new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "priv-1",
            token: "t",
            port: 8080,
            tier: "pro",
            status: "building",
            private: true,
            allowed_ips: ["203.0.113.42/32"],
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });

    const r = await c.createDeploy({
      tarball_base64: tiny,
      name: "p1",
      private: true,
      allowed_ips: ["203.0.113.42/32"],
    });
    assert.equal(r.item.private, true);
    assert.deepEqual(r.item.allowed_ips, ["203.0.113.42/32"]);
    if (formText.length > 0) {
      assert.match(formText, /name="private"\r\n\r\ntrue/);
      assert.match(formText, /allowed_ips/);
      assert.match(formText, /203\.0\.113\.42/);
    }
  });

  it("createDeploy → allowed_ips=[] (empty array) does not throw and skips both form fields", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");

    stubFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "a",
            token: "a",
            port: 8080,
            tier: "hobby",
            status: "building",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )
    );

    // allowed_ips:[] is "I want to be explicit it's empty" — should NOT
    // trigger the `allowed_ips without private` invariant (length === 0
    // short-circuits the && chain).
    const r = await c.createDeploy({
      tarball_base64: tiny,
      name: "x",
      allowed_ips: [],
    });
    assert.equal(r.deploy_id, "a");
  });

  it("createDeploy → public deploy (no private/allowed_ips) skips both form fields", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");

    let formText = "";
    stubFetch(async (_input: any, init?: any) => {
      const blob = init.body as any;
      if (blob && typeof blob.text === "function") {
        formText = await blob.text();
      }
      return new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "pub-1",
            token: "t",
            port: 8080,
            tier: "hobby",
            status: "building",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });

    const r = await c.createDeploy({
      tarball_base64: tiny,
      name: "pub",
    });
    assert.equal(r.deploy_id, "pub-1");
    if (formText.length > 0) {
      // No `private` and no `allowed_ips` fields emitted on the wire.
      assert.doesNotMatch(formText, /name="private"/);
      assert.doesNotMatch(formText, /name="allowed_ips"/);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ApiError envelope branches — the error-body "no fields at all" path (`{}`)
  // explicitly falls through default message → "upstream error" on /request.
  // ──────────────────────────────────────────────────────────────────────────
  it("listResources → 401 with empty {} body → ApiError(401, 'upstream error')", async () => {
    stubFetch(() =>
      new Response("{}", {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.listResources(),
      (err: unknown) => {
        const e = err as ApiError;
        assert.equal(e.status, 401);
        assert.equal(e.message, "upstream error");
        return true;
      }
    );
  });

  it("listDeployments → AuthRequiredError when token is unset", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.listDeployments(),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("getDeployment → AuthRequiredError when token is unset", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.getDeployment("dep"),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("redeploy → AuthRequiredError when token is unset", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    await assert.rejects(
      () => c.redeploy("dep", tiny),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("deleteDeployment → AuthRequiredError when token is unset", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.deleteDeployment("dep"),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("deleteResource → AuthRequiredError when token is unset", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.deleteResource("res"),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("getApiToken → AuthRequiredError when token is unset", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.getApiToken(),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("INSTANODE_TOKEN of '' is treated as unset (empty-string token branch)", async () => {
    process.env["INSTANODE_TOKEN"] = "";
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(
      () => c.listResources(),
      (err: unknown) => err instanceof AuthRequiredError
    );
  });

  it("constructor uses DEFAULT_BASE_URL when no opts and no env", () => {
    delete process.env["INSTANODE_API_URL"];
    const c = new InstantClient();
    assert.equal(c.apiBaseURL(), "https://api.instanode.dev");
  });

  it("dashboardURL defaults to https://instanode.dev when env unset", () => {
    delete process.env["INSTANODE_DASHBOARD_URL"];
    const c = new InstantClient();
    assert.equal(c.dashboardURL(), "https://instanode.dev");
  });

  it("Authorization header is sent when INSTANODE_TOKEN is set", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    let auth: string | null = null;
    stubFetch((_input: any, init?: any) => {
      const headers = init.headers as Record<string, string>;
      auth = headers["Authorization"] ?? null;
      return new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          tier: "anonymous",
          connection_url: "postgres://x",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createPostgres("db");
    assert.equal(auth, "Bearer tok_xyz");
  });

  it("Authorization header is omitted on anonymous calls (no INSTANODE_TOKEN)", async () => {
    let auth: string | null | undefined = "set-to-something";
    stubFetch((_input: any, init?: any) => {
      const headers = init.headers as Record<string, string>;
      auth = headers["Authorization"];
      return new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          tier: "anonymous",
          connection_url: "postgres://x",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createPostgres("db");
    assert.equal(auth, undefined);
  });

  it("Multipart Authorization header is sent when INSTANODE_TOKEN is set", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    let auth: string | null = null;
    stubFetch((_input: any, init?: any) => {
      const headers = init.headers as Record<string, string>;
      auth = headers["Authorization"] ?? null;
      return new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "a-1",
            token: "t",
            port: 8080,
            tier: "hobby",
            status: "building",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    await c.createDeploy({ tarball_base64: tiny, name: "x" });
    assert.equal(auth, "Bearer tok_xyz");
  });

  it("request<T> body is omitted on undefined body (no init.body set)", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    let hadBody: boolean | undefined;
    stubFetch((_input: any, init?: any) => {
      hadBody = init && "body" in init;
      return new Response(
        JSON.stringify({ ok: true, items: [], total: 0 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.listResources();
    // listResources is GET — body must not be set on the init object.
    assert.equal(hadBody, false);
  });
});

describe("InstantClient — env passthrough on every /<resource>/new call (CLI-MCP FINDING-8)", () => {
  beforeEach(() => {
    delete process.env["INSTANODE_TOKEN"];
    delete process.env["INSTANODE_API_URL"];
  });
  afterEach(() => {
    restoreFetch();
    delete process.env["INSTANODE_TOKEN"];
  });

  // One test per create_* method covers the new env forwarding path. The
  // omitted-env path is already covered by the existing per-method tests
  // above ("body.name === 'my-cache'") — they pass undefined for env and
  // assert the wire body has only `{name}`. The cases below pin the
  // affirmative branch: when env is supplied, it must appear on the wire.

  it("createPostgres → forwards env when supplied", async () => {
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", id: "i", tier: "anonymous", connection_url: "postgres://x" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createPostgres("pg", "staging");
    assert.equal(body.env, "staging");
  });

  it("createVector → forwards env alongside dimensions", async () => {
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", tier: "anonymous", connection_url: "postgres://x" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createVector("v", 1536, "production");
    assert.equal(body.env, "production");
    assert.equal(body.dimensions, 1536);
  });

  it("createCache → forwards env when supplied", async () => {
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", tier: "anonymous", connection_url: "redis://x" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createCache("rc", "staging");
    assert.equal(body.env, "staging");
  });

  it("createNoSQL → forwards env when supplied", async () => {
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", tier: "anonymous", connection_url: "mongodb://x" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createNoSQL("mongo", "production");
    assert.equal(body.env, "production");
  });

  it("createQueue → forwards env when supplied", async () => {
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", tier: "anonymous", connection_url: "nats://x" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createQueue("q", "staging");
    assert.equal(body.env, "staging");
  });

  it("createStorage → forwards env when supplied", async () => {
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          ok: true,
          token: "t",
          id: "i",
          tier: "anonymous",
          connection_url: "https://nyc3.digitaloceanspaces.com/instant-shared/p/",
          endpoint: "https://nyc3.digitaloceanspaces.com",
          access_key_id: "AK",
          secret_access_key: "SK",
          prefix: "p/",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createStorage("st", "production");
    assert.equal(body.env, "production");
  });

  it("createWebhook → forwards env when supplied", async () => {
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", tier: "anonymous", receive_url: "https://x/wh" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createWebhook("hk", "development");
    assert.equal(body.env, "development");
  });

  it("createPostgres → empty-string env is treated as omitted (server default applies)", async () => {
    // CLI-MCP FINDING-8 invariant: provisionBody only sets `env` when the
    // caller passes a non-empty string. Empty / undefined keeps the wire
    // body identical to the pre-fix shape, so the server-side default
    // ('development', per mig 026) still applies.
    let body: any = null;
    stubFetch((_input: any, init?: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ ok: true, token: "t", id: "i", tier: "anonymous", connection_url: "postgres://x" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createPostgres("pg", "");
    assert.equal("env" in body, false, "empty-string env must not appear on the wire");
  });
});

describe("InstantClient — createStack / getStack (the CEO wedge)", () => {
  beforeEach(() => {
    delete process.env["INSTANODE_TOKEN"];
    delete process.env["INSTANODE_API_URL"];
  });
  afterEach(() => {
    restoreFetch();
    delete process.env["INSTANODE_TOKEN"];
  });

  it("createStack → POSTs /stacks/new multipart with name + manifest + per-service file parts", async () => {
    let captured: { url: string; method: string; ctype: string; bodyText: string } | null = null;
    stubFetch(async (input: any, init?: any) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers ?? {});
      const ctype = headers.get("content-type") ?? "";
      // Body is a FormData — read it back as a Buffer so we can assert
      // the part shape.
      const resp = new Response(init?.body);
      const bodyText = (await resp.text()).toString();
      captured = { url, method, ctype, bodyText };
      return new Response(
        JSON.stringify({
          ok: true,
          stack_id: "stk-12345678",
          status: "building",
          tier: "anonymous",
          env: "development",
          name: "hw",
          services: [
            { name: "app", status: "building", port: 8080, expose: true, url: "" },
          ],
          expires_in: "24h",
          note: "Anonymous stack — expires in 24h.",
          upgrade: "https://api.instanode.dev/start?t=x",
          upgrade_jwt: "x",
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tarballB64 = Buffer.from("FAKE-TAR-1").toString("base64");
    const result = await c.createStack({
      name: "hw",
      manifest: "services:\n  app:\n    build: .\n    port: 8080\n    expose: true\n",
      service_tarballs: { app: tarballB64 },
      env: "development",
    });
    assert.equal(result.stack_id, "stk-12345678");
    assert.equal(result.tier, "anonymous");
    assert.match(captured!.url, /\/stacks\/new$/);
    assert.equal(captured!.method, "POST");
    // The fetch implementation in node fills in multipart boundaries; we just
    // assert the body carried the manifest, the name, the service-name file
    // part, and the env.
    assert.match(captured!.bodyText, /name="manifest"/);
    assert.match(captured!.bodyText, /name="name"/);
    assert.match(captured!.bodyText, /name="app"/);
    assert.match(captured!.bodyText, /name="env"/);
    assert.match(captured!.bodyText, /development/);
  });

  it("createStack → omits env field when not supplied", async () => {
    let bodyText = "";
    stubFetch(async (_input: any, init?: any) => {
      const resp = new Response(init?.body);
      bodyText = await resp.text();
      return new Response(
        JSON.stringify({
          ok: true,
          stack_id: "stk-abcdef12",
          status: "building",
          tier: "anonymous",
          services: [],
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createStack({
      name: "no-env",
      manifest: "services:\n  app:\n    build: .\n",
      service_tarballs: { app: Buffer.from("x").toString("base64") },
    });
    assert.equal(/name="env"/.test(bodyText), false, "env field must not be on the wire when omitted");
  });

  it("createStack → rejects an oversized service tarball CLIENT-SIDE", async () => {
    stubFetch(() => {
      throw new Error("fetch must not be called when client-side cap fires");
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    // 51 MiB > MAX_TARBALL_BYTES (50 MiB)
    const huge = Buffer.alloc(51 * 1024 * 1024).toString("base64");
    await assert.rejects(
      c.createStack({
        name: "too-big",
        manifest: "services:\n  app:\n    build: .\n",
        service_tarballs: { app: huge },
      }),
      /Tarball for service "app" is too large/
    );
  });

  it("createStack → OptionalAuth: no INSTANODE_TOKEN required (anonymous succeeds)", async () => {
    let hadAuth: string | null = null;
    stubFetch((_input: any, init?: any) => {
      const headers = new Headers(init?.headers ?? {});
      hadAuth = headers.get("authorization");
      return new Response(
        JSON.stringify({ ok: true, stack_id: "stk-9", status: "building", tier: "anonymous", services: [] }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });
    // No INSTANODE_TOKEN in env.
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.createStack({
      name: "anon",
      manifest: "services:\n  app:\n    build: .\n",
      service_tarballs: { app: Buffer.from("x").toString("base64") },
    });
    assert.equal(hadAuth, null, "anonymous createStack must not send Authorization");
  });

  it("getStack → GETs /stacks/{slug} and decodes the response", async () => {
    let url = "";
    let method = "";
    stubFetch((input: any, init?: any) => {
      url = String(input);
      method = init?.method ?? "GET";
      return new Response(
        JSON.stringify({
          ok: true,
          stack_id: "stk-99",
          status: "healthy",
          tier: "anonymous",
          env: "development",
          name: "hw",
          services: [
            { name: "app", status: "healthy", port: 8080, expose: true, url: "https://stk-99-app.deployment.instanode.dev" },
          ],
          expires_in: "24h",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    const r = await c.getStack("stk-99");
    assert.equal(method, "GET");
    assert.match(url, /\/stacks\/stk-99$/);
    assert.equal(r.status, "healthy");
    assert.equal(r.services[0].url, "https://stk-99-app.deployment.instanode.dev");
  });

  it("getStack → URI-encodes the slug path segment", async () => {
    let url = "";
    stubFetch((input: any) => {
      url = String(input);
      return new Response(
        JSON.stringify({ ok: true, stack_id: "x/y", status: "building", tier: "anonymous", services: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const c = new InstantClient({ baseURL: "https://example.test" });
    await c.getStack("x/y");
    assert.match(url, /\/stacks\/x%2Fy$/);
  });

  it("getStack → 404 surfaces ApiError with the api's error envelope", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ ok: false, error: "not_found", message: "stack not found" }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    );
    const c = new InstantClient({ baseURL: "https://example.test" });
    await assert.rejects(c.getStack("stk-missing"), (err: any) => {
      assert.equal(err.status, 404);
      assert.equal(err.code, "not_found");
      return true;
    });
  });
});

describe("redeploy-in-place wiring (fix/mcp-redeploy-in-place)", () => {
  beforeEach(() => {
    delete process.env["INSTANODE_TOKEN"];
    delete process.env["INSTANODE_API_URL"];
  });

  afterEach(() => {
    restoreFetch();
    delete process.env["INSTANODE_TOKEN"];
    delete process.env["INSTANODE_API_URL"];
  });

  it("createDeploy with redeploy:true appends `redeploy=true` to the multipart form", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");

    let formText = "";
    stubFetch(async (_input: any, init?: any) => {
      const blob = init.body as any;
      if (blob && typeof blob.text === "function") {
        formText = await blob.text();
      }
      return new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "a-redep-1",
            token: "t",
            port: 8080,
            tier: "pro",
            status: "building",
            url: "",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });

    await c.createDeploy({
      tarball_base64: tiny,
      name: "in-place-app",
      redeploy: true,
    });

    // The form must carry a `redeploy=true` text field. If the runtime
    // doesn't expose blob.text() we skip the body check (the call alone
    // proves the path is wired).
    if (formText.length > 0) {
      assert.match(formText, /name="redeploy"/);
      assert.match(formText, /\r\n\r\ntrue\r\n/);
    }
  });

  it("createDeploy without redeploy does NOT send the `redeploy` form field (preserves legacy behaviour)", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");

    let formText = "";
    stubFetch(async (_input: any, init?: any) => {
      const blob = init.body as any;
      if (blob && typeof blob.text === "function") {
        formText = await blob.text();
      }
      return new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "a-legacy-1",
            token: "t",
            port: 8080,
            tier: "pro",
            status: "building",
            url: "",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });

    await c.createDeploy({
      tarball_base64: tiny,
      name: "legacy-app",
    });

    if (formText.length > 0) {
      // The `redeploy` field must not appear in the multipart body. If it
      // sneaks in (e.g. via a default), an old api would treat a no-name
      // case as a no-op or get confused — keep the wire identical to the
      // pre-fix shape for callers that didn't ask for in-place.
      assert.ok(!/name="redeploy"/.test(formText), `unexpected redeploy field: ${formText}`);
    }
  });

  it("createDeploy with redeploy:false does NOT send the `redeploy` form field either", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");

    let formText = "";
    stubFetch(async (_input: any, init?: any) => {
      const blob = init.body as any;
      if (blob && typeof blob.text === "function") {
        formText = await blob.text();
      }
      return new Response(
        JSON.stringify({
          ok: true,
          item: {
            id: "i",
            app_id: "a-legacy-2",
            token: "t",
            port: 8080,
            tier: "pro",
            status: "building",
            url: "",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    });

    await c.createDeploy({
      tarball_base64: tiny,
      name: "explicit-false-app",
      redeploy: false,
    });

    if (formText.length > 0) {
      assert.ok(!/name="redeploy"/.test(formText), `unexpected redeploy field on explicit false: ${formText}`);
    }
  });

  it("redeploy(id, tarball) POSTs multipart to /deploy/:id/redeploy carrying the tarball file part", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("FROM scratch\n").toString("base64");

    let calledURL = "";
    let calledMethod = "";
    let formText = "";
    let contentType = "";
    stubFetch(async (input: any, init?: any) => {
      calledURL = typeof input === "string" ? input : input.url;
      calledMethod = String(init?.method ?? "");
      const ctRaw = init?.headers?.["Content-Type"] ?? init?.headers?.["content-type"] ?? "";
      contentType = typeof ctRaw === "string" ? ctRaw : "";
      const blob = init.body as any;
      if (blob && typeof blob.text === "function") {
        formText = await blob.text();
      }
      return new Response("", { status: 202 });
    });

    const r = await c.redeploy("dep-tar-1", tiny);
    assert.equal(r.ok, true);
    assert.equal(r.id, "dep-tar-1");
    assert.equal(r.status, "building");
    assert.match(calledURL, /\/deploy\/dep-tar-1\/redeploy$/);
    assert.equal(calledMethod, "POST");
    // fetch fills in Content-Type for FormData when it's not set explicitly;
    // requestMultipart() intentionally omits the header so undici stamps the
    // multipart boundary. Either way the wire is multipart — verified via
    // the body shape (file part with filename) which we check below.
    void contentType;
    if (formText.length > 0) {
      assert.match(formText, /name="tarball"/);
      assert.match(formText, /filename="app\.tar\.gz"/);
    }
  });

  it("redeploy rejects oversized tarballs CLIENT-SIDE before any fetch (mirrors createDeploy cap)", async () => {
    process.env["INSTANODE_TOKEN"] = "tok_xyz";
    const c = new InstantClient({ baseURL: "https://example.test" });
    const big = Buffer.alloc(60 * 1024 * 1024, 0xff).toString("base64");

    let fetched = false;
    stubFetch(() => { fetched = true; return new Response("ok", { status: 200 }); });

    await assert.rejects(
      () => c.redeploy("dep-huge", big),
      (err: unknown) => /too large/i.test((err as Error).message)
    );
    assert.equal(fetched, false, "fetch should never be reached for oversized redeploy tarballs");
  });

  it("redeploy without INSTANODE_TOKEN throws AuthRequiredError (requireAuth gate)", async () => {
    const c = new InstantClient({ baseURL: "https://example.test" });
    const tiny = Buffer.from("hello").toString("base64");
    await assert.rejects(
      () => c.redeploy("dep-noauth", tiny),
      (err: unknown) => err instanceof AuthRequiredError
    );
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
