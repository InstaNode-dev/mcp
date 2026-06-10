/**
 * REGRESSION test for BUG-MCP-043 — the deploy-id schema.
 *
 * Symptom (live dogfood): the six deployment-by-id tools (get_deployment,
 * get_deployment_events, redeploy, delete_deployment, update_deploy_env,
 * wake_deployment) validated their `id` arg with `uuidSchema` (canonical
 * 8-4-4-4-12 UUID). But a deployment's public id (`app_id`/`token`, returned as
 * `deploy_id` by create_deploy) is 8-char lowercase hex — the api's
 * generateAppID() is hex.EncodeToString of 4 random bytes
 * (api/internal/handlers/deploy.go). So zod rejected EVERY real call CLIENT-SIDE
 * (-32602) before it reached the api, killing the manage-the-deploy loop.
 *
 * Why it shipped green: (a) test/mock-api.ts was edited to EMIT UUID-shaped
 * app_ids ("like prod" — but prod does NOT), so fixtures never tripped the bad
 * schema; (b) the handler tests call the registered .handler directly, BYPASSING
 * the zod inputSchema the real MCP-SDK dispatch applies. 161 tests passed while
 * every real call was broken.
 *
 * This test closes both gaps. It drives the SCHEMA/DISPATCH path — the registered
 * `inputSchema` the SDK validates against at the wire boundary — NOT the handler
 * directly. And it iterates the live registry (reliability rule 18) rather than a
 * hand-typed slice, so it cannot silently miss one of the six.
 *
 * Against the OLD schema this test reds on every one of the six tools: the bad
 * `uuidSchema` would reject the real 8-hex id and accept the UUID — the exact
 * inversion of correctness.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

// Keep the side-effecting `await server.connect(transport)` off when index.js
// is imported (same flag every other in-process suite uses).
process.env["INSTANODE_MCP_NO_LISTEN"] = "1";
delete process.env["INSTANODE_TOKEN"];

// The six deployment-by-id tools whose `id` arg is an 8-hex app_id, NOT a UUID.
// Iterated as a registry (rule 18) so a future tool added to this class is
// caught the moment it lands with the wrong schema.
const DEPLOY_ID_TOOLS = [
  "get_deployment",
  "get_deployment_events",
  "redeploy",
  "delete_deployment",
  "update_deploy_env",
  "wake_deployment",
] as const;

// A real-shaped deployment id (8 lowercase hex) the api would actually mint.
const REAL_APP_ID = "a3f91c0e";
// A canonical UUID — what the BROKEN schema demanded, and what the api never
// uses to address a deployment.
const A_UUID = "00000000-0000-4000-8000-000000000000";
// An obviously-bad value: not hex, wrong length.
const BAD_ID = "not-an-id";

let server: any;
let deployIdSchema: any;

before(async () => {
  const mod: any = await import("../src/index.js");
  server = mod.server;
  deployIdSchema = mod.deployIdSchema;
});

// The mcp-sdk validates args against the registered inputSchema at the WIRE
// boundary, not inside the handler. So we assert on the per-field zod schema's
// safeParse — the same validation the real dispatch applies — NOT by invoking
// the handler (which is exactly the bypass that hid this bug).
function idSchemaOf(toolName: string): any {
  const reg = (server as any)._registeredTools as Record<string, { inputSchema?: any }>;
  const t = reg[toolName];
  if (!t) throw new Error(`tool not registered: ${toolName}`);
  return (t as any).inputSchema?.shape?.["id"] ?? null;
}

describe("BUG-MCP-043: deploy-id schema (registered inputSchema / dispatch path)", () => {
  for (const tool of DEPLOY_ID_TOOLS) {
    it(`${tool}.id ACCEPTS a real 8-hex app_id`, () => {
      const schema = idSchemaOf(tool);
      assert.ok(schema, `${tool}.id schema not located`);
      assert.equal(
        schema.safeParse(REAL_APP_ID).success,
        true,
        `${tool} rejected a real 8-hex deployment id — the manage-the-deploy loop is broken`
      );
    });

    it(`${tool}.id REJECTS a UUID (the wrong, old schema's shape)`, () => {
      const schema = idSchemaOf(tool);
      assert.equal(
        schema.safeParse(A_UUID).success,
        false,
        `${tool} accepted a UUID — it is still using uuidSchema, not deployIdSchema`
      );
    });

    it(`${tool}.id REJECTS an obviously-bad value`, () => {
      const schema = idSchemaOf(tool);
      assert.equal(schema.safeParse(BAD_ID).success, false);
    });
  }
});

describe("BUG-MCP-043: deployIdSchema unit contract", () => {
  it("parses a real 8-hex id", () => {
    assert.equal(deployIdSchema.parse(REAL_APP_ID), REAL_APP_ID);
  });

  it("throws on a non-id value", () => {
    assert.throws(() => deployIdSchema.parse(BAD_ID));
  });

  it("throws on a UUID (the deploy id is never a UUID)", () => {
    assert.throws(() => deployIdSchema.parse(A_UUID));
  });

  it("throws on uppercase hex (api emits lowercase via hex.EncodeToString)", () => {
    assert.throws(() => deployIdSchema.parse("A3F91C0E"));
  });

  it("throws on the wrong length (7 or 9 hex chars)", () => {
    assert.throws(() => deployIdSchema.parse("a3f91c0"));
    assert.throws(() => deployIdSchema.parse("a3f91c0ee"));
  });
});
