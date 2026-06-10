/**
 * DONE-BAR / DRIFT-GUARD test for the MCP tool registry.
 *
 * Spec: docs/sessions/2026-06-04/USER-FLOW-INVENTORY-AND-TEST-MATRIX.md §4.2 —
 *   "MCP-tool-coverage test (mcp/test/tool-coverage.test.ts, NEW): iterate the
 *    live server.tool(...) registry; fail if any tool name lacks a J-row mapping
 *    + a live or unit test."
 *
 * This is a REGISTRY-ITERATING test (reliability rule 18): it walks the live
 * `server._registeredTools` map rather than a hand-typed slice, so it CANNOT
 * silently miss a tool. It fails CI the moment someone:
 *
 *   (a) registers a new `server.tool(...)` without adding a J-row mapping to the
 *       MAPPED_TOOLS registry below (the §1 flow-inventory drift guard), OR
 *   (b) registers a new tool whose schema/handler is malformed, OR
 *   (c) registers a new tool with no test exercising it anywhere in test/*.test.ts
 *       (the "every tool has a live or unit test" half of the done-bar).
 *
 * It also reds if a J-row mapping points at a tool that no longer exists (stale
 * mapping after a rename/removal) — both directions of drift are caught.
 *
 * No network, no mock-api: this asserts structure + cross-references the test
 * sources on disk. It is deliberately the cheapest test in the suite.
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

// Keep the side-effecting `await server.connect(transport)` off when index.js
// is imported (same flag the other in-process suites use).
process.env["INSTANODE_MCP_NO_LISTEN"] = "1";

/**
 * The canonical J-row mapping from the flow matrix §1.J. Each registered MCP
 * tool MUST appear here with its backing endpoint + flow ID. This is the single
 * source the drift guard compares the live registry against — adding a tool to
 * src/index.ts without a row here reds the build (and vice-versa).
 */
interface ToolMapping {
  /** Flow-inventory ID (matrix §1.J). */
  flow: string;
  /** Backing api endpoint (matrix "Backing endpoint" column). */
  endpoint: string;
}

const MAPPED_TOOLS: Record<string, ToolMapping> = {
  create_postgres: { flow: "J1", endpoint: "POST /db/new" },
  create_vector: { flow: "J2", endpoint: "POST /vector/new" },
  create_cache: { flow: "J3", endpoint: "POST /cache/new" },
  create_nosql: { flow: "J4", endpoint: "POST /nosql/new" },
  create_queue: { flow: "J5", endpoint: "POST /queue/new" },
  create_storage: { flow: "J6", endpoint: "POST /storage/new" },
  create_webhook: { flow: "J7", endpoint: "POST /webhook/new" },
  claim_resource: { flow: "J8", endpoint: "helper (builds /start URL)" },
  claim_token: { flow: "J9", endpoint: "POST /claim" },
  list_resources: { flow: "J10", endpoint: "GET /api/v1/resources" },
  delete_resource: { flow: "J11", endpoint: "DELETE /api/v1/resources/:id" },
  get_api_token: { flow: "J12", endpoint: "POST /api/v1/auth/api-keys" },
  create_deploy: { flow: "J13", endpoint: "POST /deploy/new" },
  create_stack: { flow: "J14", endpoint: "POST /stacks/new" },
  get_stack: { flow: "J15", endpoint: "GET /api/v1/stacks/:slug" },
  list_deployments: { flow: "J16", endpoint: "GET /api/v1/deployments" },
  get_deployment: { flow: "J17", endpoint: "GET /api/v1/deployments/:id" },
  redeploy: { flow: "J18", endpoint: "POST /deploy/:id/redeploy" },
  delete_deployment: { flow: "J19", endpoint: "DELETE /deploy/:id" },
  get_capabilities: { flow: "J20", endpoint: "GET /api/v1/capabilities" },
  get_deployment_events: { flow: "J21", endpoint: "GET /api/v1/deployments/:id/events" },
  // ── operate tools (full-lifecycle, not just create) ──
  set_vault_key: { flow: "J22", endpoint: "PUT /api/v1/vault/:env/:key" },
  rotate_vault_key: { flow: "J23", endpoint: "POST /api/v1/vault/:env/:key/rotate" },
  update_deploy_env: { flow: "J24", endpoint: "PATCH /deploy/:id/env" },
  update_stack_env: { flow: "J25", endpoint: "PATCH /stacks/:slug/env" },
  presign_storage: { flow: "J26", endpoint: "POST /storage/:token/presign" },
  pause_resource: { flow: "J27", endpoint: "POST /api/v1/resources/:id/pause" },
  resume_resource: { flow: "J28", endpoint: "POST /api/v1/resources/:id/resume" },
  rotate_credentials: { flow: "J29", endpoint: "POST /api/v1/resources/:id/rotate-credentials" },
  wake_deployment: { flow: "J30", endpoint: "POST /deploy/:id/wake" },
};

let registry: Record<string, { description?: string; inputSchema?: unknown; handler?: unknown }>;
let registeredNames: string[];

/**
 * Read every TS test source so we can prove each tool is exercised by at least
 * one test. We scan the .ts sources (not the compiled dist-test/*.js) because
 * they are the human-authored intent and survive a `tsc` clean. Excludes THIS
 * file so a tool isn't "covered" merely by being listed in MAPPED_TOOLS.
 */
function loadTestSources(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // import.meta.url is dist-test/test/tool-coverage.test.js → repo test/ dir is
  // ../../test relative to here. Fall back to <cwd>/test (CI runs from root).
  const candidates = [join(here, "..", "..", "test"), join(process.cwd(), "test")];
  for (const dir of candidates) {
    try {
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".test.ts") && f !== "tool-coverage.test.ts"
      );
      if (files.length === 0) continue;
      return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    } catch {
      // try next candidate
    }
  }
  throw new Error("could not locate test/*.test.ts sources for coverage cross-reference");
}

before(async () => {
  const mod: any = await import("../src/index.js");
  registry = mod.server._registeredTools;
  registeredNames = Object.keys(registry);
});

describe("MCP tool-coverage done-bar (drift guard, matrix §4.2)", () => {
  it("registers exactly 30 tools (sanity vs matrix §1.J)", () => {
    assert.equal(
      registeredNames.length,
      30,
      `expected 30 registered tools, got ${registeredNames.length}: ${registeredNames.join(", ")}`
    );
  });

  it("every registered tool has a J-row mapping in MAPPED_TOOLS", () => {
    const unmapped = registeredNames.filter((n) => !(n in MAPPED_TOOLS));
    assert.deepEqual(
      unmapped,
      [],
      `new tool(s) registered with no flow-matrix J-row mapping — add them to ` +
        `MAPPED_TOOLS (and to the matrix §1.J + a test): ${unmapped.join(", ")}`
    );
  });

  it("every MAPPED_TOOLS entry corresponds to a live registered tool (no stale mappings)", () => {
    const stale = Object.keys(MAPPED_TOOLS).filter((n) => !registeredNames.includes(n));
    assert.deepEqual(
      stale,
      [],
      `MAPPED_TOOLS lists tool(s) that are no longer registered (rename/removal ` +
        `drift) — fix the mapping: ${stale.join(", ")}`
    );
  });

  it("every registered tool exposes a callable handler + an input schema + a description", () => {
    for (const name of registeredNames) {
      const t = registry[name];
      assert.equal(typeof t.handler, "function", `${name}: missing callable handler`);
      assert.ok(t.inputSchema !== undefined, `${name}: missing inputSchema`);
      assert.equal(
        typeof t.description,
        "string",
        `${name}: missing description (agents read this to choose the tool)`
      );
      assert.ok(
        (t.description as string).length > 0,
        `${name}: empty description`
      );
    }
  });

  it("every registered tool is exercised by at least one test in test/*.test.ts", () => {
    const sources = loadTestSources();
    const untested = registeredNames.filter((name) => {
      // A tool is "tested" if its name appears as a quoted string anywhere in
      // the test sources — handlerFor("name"), an integration tools/call with
      // name:"name", or a client-method assertion referencing its endpoint.
      return !sources.includes(`"${name}"`);
    });
    assert.deepEqual(
      untested,
      [],
      `tool(s) registered with NO test exercising them (done-bar violation) — ` +
        `add a tools-unit/integration test: ${untested.join(", ")}`
    );
  });
});
