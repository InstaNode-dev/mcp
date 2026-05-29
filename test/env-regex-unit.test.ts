/**
 * env-regex-unit.test.ts — BUG-MCP-003 + BUG-MCP-010 regression.
 *
 * The api enforces `env` against `^[a-z0-9-]{1,32}$` (see
 * api/internal/handlers/env.go + the `invalid_env` 400 branch). Pre-fix
 * the MCP schema declared `env` as a bare `z.string()`, so a hostile
 * agent could send `env=HACKERLAND` or `env=<33-chars>` and the
 * validation failure only surfaced from the API (extra round trip and a
 * confusing error path). Enforcing here matches the API regex one-shot
 * and surfaces a clean zod error to the calling agent.
 *
 * What this test does:
 *   - Imports src/index.ts so `server` is built with the real schemas.
 *   - For every tool whose `env` field exists (create_postgres,
 *     create_vector, create_cache, create_nosql, create_queue,
 *     create_webhook, create_storage, create_deploy, create_stack),
 *     reads `_registeredTools[<name>].inputSchema._def.shape().env` and
 *     asserts the underlying zod schema has a regex constraint.
 *   - Smokes a positive case ("staging") and a negative case
 *     ("HACKERLAND") through the schema's safeParse so the regression is
 *     end-to-end at the zod level.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

// Disable the server's auto-connect side effect.
process.env["INSTANODE_MCP_NO_LISTEN"] = "1";

let server: any;

before(async () => {
  const mod: any = await import("../src/index.js");
  server = mod.server;
});

// The set of tools that expose an `env` arg per BUG-MCP-003/010.
const envToolNames = [
  "create_postgres",
  "create_vector",
  "create_cache",
  "create_nosql",
  "create_queue",
  "create_webhook",
  "create_storage",
  "create_deploy",
  "create_stack",
];

function envSchemaOf(toolName: string): any {
  const reg = (server as any)._registeredTools as Record<
    string,
    { inputSchema?: any }
  >;
  const t = reg[toolName];
  assert.ok(t, `tool not registered: ${toolName}`);
  // The mcp-sdk wraps the registered ZodRawShape into a ZodObject and
  // hangs it off `inputSchema`. Zod v4 exposes the per-field shape via
  // `.shape` (a plain object). The env field is wrapped in ZodOptional;
  // safeParse against the optional itself rejects bad input and accepts
  // undefined — which is exactly what we want to test.
  return (t as any).inputSchema?.shape?.env ?? null;
}

describe("BUG-MCP-003/010 — env field carries ^[a-z0-9-]{1,32}$ regex", () => {
  for (const toolName of envToolNames) {
    it(`${toolName}.env REJECTS the api invalid_env shape "HACKERLAND" client-side`, () => {
      const env = envSchemaOf(toolName);
      assert.ok(env, `${toolName} env schema not located via _def.shape()`);
      const out = env.safeParse("HACKERLAND");
      assert.equal(
        out.success,
        false,
        `BUG-MCP-010: ${toolName} env must reject uppercase (api regex is lowercase only). Got: ${JSON.stringify(out)}`
      );
    });

    it(`${toolName}.env REJECTS over-cap (>32 chars) client-side`, () => {
      const env = envSchemaOf(toolName);
      assert.ok(env);
      const over = "a".repeat(33);
      const out = env.safeParse(over);
      assert.equal(
        out.success,
        false,
        `BUG-MCP-003: ${toolName} env must reject >32 chars (api cap). Got: ${JSON.stringify(out)}`
      );
    });

    it(`${toolName}.env ACCEPTS the canonical "staging" value`, () => {
      const env = envSchemaOf(toolName);
      assert.ok(env);
      const out = env.safeParse("staging");
      assert.equal(out.success, true, `staging must pass: ${JSON.stringify(out)}`);
    });

    it(`${toolName}.env ACCEPTS undefined (optional field)`, () => {
      const env = envSchemaOf(toolName);
      assert.ok(env);
      const out = env.safeParse(undefined);
      assert.equal(out.success, true, `undefined must pass — env is optional: ${JSON.stringify(out)}`);
    });
  }
});

// Note on JSON Schema serialisation: the mcp-sdk converts each
// registered ZodObject into a JSON Schema lazily when `tools/list` is
// served over the wire (see integration.test.ts:1004). The zod-direct
// safeParse tests above are the authoritative regression check; the
// wire-format end-to-end is exercised by the live-smoke + integration
// suites that already drive `client.listTools()`.
