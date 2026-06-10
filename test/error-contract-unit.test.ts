/**
 * Tests for the MCP error-contract + rendering fixes (live-cohort dogfood).
 *
 * Five fixes, all driven through the REAL registered-tool dispatch path
 * (`server._registeredTools[name].handler(args)`) — the same surface the
 * MCP-SDK invokes at the wire boundary, NOT a hand-rolled handler bypass —
 * or through the exported pure render helpers (formatError / appendIgnoredFields
 * / the capabilities handler), so the assertions reflect what an agent host
 * actually receives.
 *
 * FIX 1 — every API-side failure now sets `isError: true` on the CallToolResult.
 *         Before this, a 402/404/409/503/501 came back as a NORMAL successful
 *         tool result whose text merely said "instanode.dev error (...)", so a
 *         host could not distinguish failure from success. The MCP spec reports
 *         a tool-execution failure IN the result via `isError: true`. SUCCESS
 *         results must NOT carry the flag.
 * FIX 2 — the rendered error text now includes `request_id` (always) and
 *         `retry_after_seconds` (when present), which the raw envelope carried
 *         but the MCP previously dropped.
 * FIX 3 — get_capabilities now renders resource-count + backup + RPO/RTO, which
 *         its description had promised but the body omitted.
 * FIX 4 — anon-STACK TTL prose corrected from 24h to 6h (the real value; api
 *         PR #214). The anon RESOURCE TTL stays 24h.
 * FIX 5 — provision responses echo `ignored_fields` (api #283) so an agent
 *         learns its hallucinated params were dropped.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  startMockApi,
  VALID_TOKEN,
  HOBBY_TOKEN,
  MOCK_REQUEST_ID,
  type MockApiHandle,
} from "./mock-api.js";
import { ApiError } from "../src/client.js";

// Keep the side-effecting `await server.connect(transport)` off, same flag
// every in-process suite uses.
process.env["INSTANODE_MCP_NO_LISTEN"] = "1";

let mock: MockApiHandle;
let server: any;
let formatError: (err: unknown) => string;
let appendIgnoredFields: (lines: string[], r: { ignored_fields?: string[] }) => void;

// Resolve the registered tool's handler — the SAME function the MCP-SDK
// dispatch (CallToolRequestSchema) invokes after input validation. Driving
// this exercises the real try/catch → errorResult path, not a bypass.
function handlerFor(name: string): (args: any, extra?: any) => Promise<any> {
  const reg = (server as any)._registeredTools as Record<string, { handler: any }>;
  const t = reg[name];
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t.handler as any;
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
  formatError = mod.formatError;
  appendIgnoredFields = mod.appendIgnoredFields;
});

after(async () => {
  delete process.env["INSTANODE_TOKEN"];
  await mock.close();
});

// ── FIX 1: isError on mapped API failures, absent on success ─────────────────

describe("FIX 1 — tool failures set isError:true (dispatch path)", () => {
  it("404 not_found (delete_resource) → result.isError === true", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("delete_resource")({
      token: "00000000-0000-0000-0000-000000000000",
    });
    delete process.env["INSTANODE_TOKEN"];
    assert.match(flat(res), /instanode\.dev error \(404/);
    assert.equal(
      res.isError,
      true,
      "a 404 API failure MUST set isError:true so the host knows the op did not happen"
    );
  });

  it("402 tier_upgrade_required (create_deploy private on hobby) → isError === true, agent_action preserved", async () => {
    process.env["INSTANODE_TOKEN"] = HOBBY_TOKEN;
    const { gzipSync } = await import("node:zlib");
    const tarball = gzipSync(Buffer.from("FROM scratch\n")).toString("base64");
    // private:true is coupled to a non-empty allowed_ips client-side, so we
    // pass one — this lets the request actually reach the api and trip its 402
    // tier-gate (private deploys require Pro+), which is the path we assert.
    const res = await handlerFor("create_deploy")({
      name: "u-priv-deploy",
      tarball_base64: tarball,
      private: true,
      allowed_ips: ["203.0.113.42"],
    });
    delete process.env["INSTANODE_TOKEN"];
    const text = flat(res);
    // A 402 "upgrade required" IS a failure — the deploy did not happen.
    assert.equal(res.isError, true, "a 402 upgrade-gate is a tool FAILURE → isError:true");
    // ...but the agent_action path forward is still preserved (FIX 1 caveat).
    assert.match(text, /Action:/, "agent_action must survive on the isError result");
  });

  it("AuthRequiredError (delete_resource, no token) → isError === true", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("delete_resource")({ token: "any-token" });
    assert.match(flat(res), /requires authentication/i);
    assert.equal(res.isError, true, "an auth-required failure is a tool failure → isError:true");
  });

  it("SUCCESS results do NOT set isError (anonymous create_postgres)", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("create_postgres")({ name: "u-ok-pg" });
    assert.match(flat(res), /Postgres database provisioned\./);
    assert.notEqual(res.isError, true, "a SUCCESS result must NOT carry isError:true");
  });

  it("SUCCESS results do NOT set isError (get_capabilities, no auth)", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("get_capabilities")({});
    assert.match(flat(res), /tier\(s\)/);
    assert.notEqual(res.isError, true, "a successful capabilities read must NOT set isError");
  });
});

// ── FIX 2: request_id + retry_after_seconds in rendered error text ───────────

describe("FIX 2 — request_id + retry_after_seconds surfaced in error text", () => {
  it("request_id from the envelope appears in the rendered error (dispatch path)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("delete_resource")({
      token: "00000000-0000-0000-0000-000000000000",
    });
    delete process.env["INSTANODE_TOKEN"];
    const text = flat(res);
    assert.match(
      text,
      new RegExp(`Request ID: ${MOCK_REQUEST_ID}`),
      "the support/correlation request_id must be quotable in the rendered error"
    );
  });

  it("formatError renders request_id for an ApiError that carries one", () => {
    const out = formatError(
      new ApiError(409, "already claimed", "already_claimed", undefined, undefined, undefined, "req_abc123")
    );
    assert.match(out, /Request ID: req_abc123/);
  });

  it("formatError renders retry_after_seconds when the api asks the caller to back off", () => {
    const out = formatError(
      new ApiError(
        429,
        "rate limited",
        "rate_limited",
        undefined,
        undefined,
        undefined,
        "req_rl_9",
        42
      )
    );
    assert.match(out, /Retry after: 42s/);
    assert.match(out, /Request ID: req_rl_9/);
  });

  it("formatError omits retry-after + request-id lines when absent (no empty 'Request ID:')", () => {
    const out = formatError(new ApiError(404, "not found", "not_found"));
    assert.doesNotMatch(out, /Retry after:/);
    assert.doesNotMatch(out, /Request ID:/);
  });
});

// ── FIX 3: capabilities renders what its description promises ─────────────────

describe("FIX 3 — get_capabilities renders resource-count + backup + RPO/RTO", () => {
  it("renders resource count, backups, and RPO/RTO for a paid tier", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("get_capabilities")({});
    const text = flat(res);
    // resource_count_limit — promised by the description, previously omitted.
    assert.match(text, /resource count:/, "resource_count_limit must be rendered");
    // backups — restore-enabled paid tiers show retention + manual quota.
    assert.match(text, /backups: \d+d retention/, "backup promise must be rendered");
    // RPO/RTO durability promise (the pro/hobby tiers promise these in the mock).
    assert.match(text, /durability: RPO \d+m, RTO \d+m/, "RPO/RTO must be rendered");
  });
});

// ── FIX 5: ignored_fields echo ───────────────────────────────────────────────

describe("FIX 5 — ignored_fields surfaced when the api drops unknown params", () => {
  it("appendIgnoredFields lists dropped fields on a non-empty array", () => {
    const lines: string[] = ["Postgres database provisioned."];
    appendIgnoredFields(lines, { ignored_fields: ["region", "size"] });
    const text = lines.join("\n");
    assert.match(text, /ignored 2 unknown field\(s\)/);
    assert.match(text, /region, size/);
  });

  it("appendIgnoredFields is a no-op on an empty array", () => {
    const lines: string[] = ["x"];
    appendIgnoredFields(lines, { ignored_fields: [] });
    assert.equal(lines.length, 1, "empty ignored_fields must add no lines");
  });

  it("appendIgnoredFields is a no-op when the field is absent", () => {
    const lines: string[] = ["x"];
    appendIgnoredFields(lines, {});
    assert.equal(lines.length, 1, "absent ignored_fields must add no lines");
  });
});

// ── FIX 4: anon-STACK TTL prose is 6h, not 24h ───────────────────────────────

describe("FIX 4 — anon-stack TTL prose corrected to 6h", () => {
  // This test file compiles to dist-test/test/error-contract-unit.test.js, so
  // the repo root is two levels up from the compiled file's dir, NOT one. We
  // assert against the canonical TypeScript SOURCE (src/*.ts) + README.md, which
  // live only at the repo root — not the compiled dist-test copy.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");

  function read(rel: string): string {
    return readFileSync(join(repoRoot, rel), "utf8");
  }

  it("create_stack tool description says 6h (not 24h) for the anon stack TTL", () => {
    const reg = (server as any)._registeredTools as Record<string, { description?: string }>;
    const desc = reg["create_stack"]?.description ?? "";
    assert.ok(desc.length > 0, "create_stack must be registered with a description");
    assert.match(desc, /6h TTL/, "anon stack TTL must read 6h");
    // No bare "24h TTL" stack claim — but the description MAY mention the 24h
    // RESOURCE TTL for contrast ("tighter than the 24h ... RESOURCE TTL").
    assert.doesNotMatch(
      desc,
      /anonymous tier with a 24h TTL/,
      "the stale '24h TTL' anon-stack claim must be gone"
    );
  });

  it("README anon-stack TTL prose reads 6h, not a 24h-TTL stack", () => {
    const readme = read("README.md");
    assert.match(readme, /6h-TTL stack/, "README must describe the anon stack as 6h-TTL");
    assert.doesNotMatch(readme, /24h-TTL stack/, "no stale 24h-TTL stack claim in README");
  });

  it("no source string pairs 'stack' with a 24h TTL claim", () => {
    for (const rel of ["src/index.ts", "src/client.ts", "README.md"]) {
      const body = read(rel);
      // Reject either ordering of stack + 24h within a short window — the same
      // shape the brief's grep checks. A 24h RESOURCE mention near the word
      // "stack" in a contrastive sentence is allowed ONLY when it is explicitly
      // the RESOURCE TTL; we exclude that phrasing.
      const stackTtl =
        /stack[^\n]{0,40}24h TTL|24h TTL[^\n]{0,40}stack/i.exec(body);
      assert.equal(
        stackTtl,
        null,
        `${rel} still pairs 'stack' with a 24h TTL claim: ${stackTtl?.[0]}`
      );
    }
  });
});
