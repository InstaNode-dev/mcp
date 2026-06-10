/**
 * input-hardening-unit.test.ts — regression coverage for:
 *
 *   BUG-MCP-017: --version / --help flags
 *   BUG-MCP-020: tarball_base64 size cap (50 MiB decoded ≈ 70 MiB encoded)
 *   BUG-MCP-021: private + allowed_ips coupling enforcement
 *   BUG-MCP-022: allowed_ips CIDR validation
 *   BUG-MCP-024: delete_resource.token UUID validation
 *   BUG-MCP-025: get_deployment / redeploy / delete_deployment id UUID validation
 *   BUG-MCP-040: INSTANODE_API_URL scheme/host validation
 *
 * Each test pokes the zod input schema for the relevant tool via
 * server._registeredTools so we cover the schema-level contract without
 * having to spin up a real MCP transport.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

process.env["INSTANODE_MCP_NO_LISTEN"] = "1";

const SERVER_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "index.js"
);

// Cold-start budget for spawning the real built binary. Under the coverage
// run's V8 instrumentation + full-suite parallel load the child's cold start
// can exceed a tight 5s budget → status:null (killed) → flaky failure on the
// `npm test` (coverage) variant. 15s absorbs that load; the binary still exits
// near-instantly for --version/--help in the common case.
const BINARY_SPAWN_TIMEOUT_MS = 15000;

let server: any;
let handleCLIFlags: (argv: readonly string[]) => boolean;
let isIPOrCIDR: (s: string) => boolean;
let validateBaseURL: (raw: string) => string | null;
let maybeShortCircuit: (argv: readonly string[], exit?: (n: number) => void) => boolean;

before(async () => {
  const indexMod: any = await import("../src/index.js");
  server = indexMod.server;
  handleCLIFlags = indexMod.handleCLIFlags;
  isIPOrCIDR = indexMod.isIPOrCIDR;
  maybeShortCircuit = indexMod.maybeShortCircuit;
  const clientMod: any = await import("../src/client.js");
  validateBaseURL = clientMod.validateBaseURL;
});

function schemaFor(toolName: string, field: string): any {
  const tool = server._registeredTools?.[toolName];
  assert.ok(tool, `tool ${toolName} not registered`);
  // Zod v4 exposes the per-field shape via `.shape` (plain object). Mirrors
  // env-regex-unit.test.ts.
  const shape = tool.inputSchema?.shape ?? {};
  return shape[field];
}

// ── BUG-MCP-017: --version / --help ─────────────────────────────────────────

// Spawn the real binary (no INSTANODE_MCP_NO_LISTEN) so the production
// short-circuit path at the bottom of index.ts is exercised — required for
// the 100% patch-coverage gate. Tests use --version (small output, exits 0).
describe("BUG-MCP-017: real-binary short-circuit", () => {
  it("instanode-mcp --version writes the version to stdout and exits 0", () => {
    const r = spawnSync(process.execPath, [SERVER_ENTRY, "--version"], {
      env: { ...process.env, INSTANODE_MCP_NO_LISTEN: "" },
      encoding: "utf8",
      timeout: BINARY_SPAWN_TIMEOUT_MS,
    });
    assert.equal(r.status, 0, `non-zero exit: stderr=${r.stderr}`);
    assert.match(r.stdout, /\d+\.\d+\.\d+|dev/);
  });
  it("instanode-mcp --help writes the usage block and exits 0", () => {
    const r = spawnSync(process.execPath, [SERVER_ENTRY, "--help"], {
      env: { ...process.env, INSTANODE_MCP_NO_LISTEN: "" },
      encoding: "utf8",
      timeout: BINARY_SPAWN_TIMEOUT_MS,
    });
    assert.equal(r.status, 0, `non-zero exit: stderr=${r.stderr}`);
    assert.match(r.stdout, /instanode-mcp/);
    assert.match(r.stdout, /Usage:/);
  });
});

describe("BUG-MCP-017: maybeShortCircuit branches", () => {
  it("returns true and calls exit(0) on --version", () => {
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = () => true;
    let exitCode: number | undefined;
    try {
      const out = maybeShortCircuit(["--version"], (n) => {
        exitCode = n;
      });
      assert.equal(out, true);
      assert.equal(exitCode, 0);
    } finally {
      (process.stdout as any).write = origWrite;
    }
  });
  it("returns false and does not call exit on empty argv", () => {
    let called = false;
    const out = maybeShortCircuit([], () => {
      called = true;
    });
    assert.equal(out, false);
    assert.equal(called, false);
  });
});

describe("BUG-MCP-017: CLI flag short-circuits", () => {
  it("returns true for --version", () => {
    // We can't easily capture stdout from inside the same process without
    // monkey-patching; just assert the boolean return — the side-effect
    // path is exercised in the binary smoke test.
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    (process.stdout as any).write = (chunk: any) => {
      captured += String(chunk);
      return true;
    };
    try {
      assert.equal(handleCLIFlags(["--version"]), true);
      assert.match(captured, /\d+\.\d+\.\d+|dev/);
    } finally {
      (process.stdout as any).write = origWrite;
    }
  });
  it("returns true for -v / --help / -h", () => {
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = () => true;
    try {
      assert.equal(handleCLIFlags(["-v"]), true);
      assert.equal(handleCLIFlags(["--help"]), true);
      assert.equal(handleCLIFlags(["-h"]), true);
    } finally {
      (process.stdout as any).write = origWrite;
    }
  });
  it("returns false for empty / unknown args", () => {
    assert.equal(handleCLIFlags([]), false);
    assert.equal(handleCLIFlags(["--mystery"]), false);
  });
});

// ── BUG-MCP-020: tarball cap ────────────────────────────────────────────────

describe("BUG-MCP-020: tarball_base64 max length", () => {
  it("accepts a small payload", () => {
    const s = schemaFor("create_deploy", "tarball_base64");
    assert.equal(s.safeParse("aGVsbG8=").success, true);
  });
  it("rejects a 71 MiB encoded payload", () => {
    const s = schemaFor("create_deploy", "tarball_base64");
    const huge = "a".repeat(71 * 1024 * 1024);
    const r = s.safeParse(huge);
    assert.equal(r.success, false);
  });
});

// ── BUG-MCP-022: allowed_ips CIDR validation ────────────────────────────────

describe("BUG-MCP-022: isIPOrCIDR", () => {
  it("accepts canonical IPv4 + CIDR", () => {
    assert.equal(isIPOrCIDR("203.0.113.42"), true);
    assert.equal(isIPOrCIDR("10.0.0.0/8"), true);
    assert.equal(isIPOrCIDR("0.0.0.0/0"), true);
  });
  it("accepts IPv6 + CIDR", () => {
    assert.equal(isIPOrCIDR("2001:db8::1"), true);
    assert.equal(isIPOrCIDR("2001:db8::/32"), true);
    assert.equal(isIPOrCIDR("::1"), true);
  });
  it("rejects garbage and bad octets", () => {
    assert.equal(isIPOrCIDR("192.168.1"), false);
    assert.equal(isIPOrCIDR("999.0.0.0"), false);
    assert.equal(isIPOrCIDR("10.0.0.0/33"), false);
    assert.equal(isIPOrCIDR(""), false);
    assert.equal(isIPOrCIDR("hello"), false);
    assert.equal(isIPOrCIDR("::/0g"), false);
  });
});

describe("BUG-MCP-022: allowed_ips zod array", () => {
  it("rejects a malformed entry", () => {
    const s = schemaFor("create_deploy", "allowed_ips");
    const r = s.safeParse(["nope-not-an-ip"]);
    assert.equal(r.success, false);
  });
  it("accepts a well-formed list", () => {
    const s = schemaFor("create_deploy", "allowed_ips");
    const r = s.safeParse(["203.0.113.42/32", "10.0.0.0/8"]);
    assert.equal(r.success, true);
  });
});

describe("BUG-MCP-022: isIPOrCIDR exhaustive branches", () => {
  it("rejects over-long input (>64 chars)", () => {
    assert.equal(isIPOrCIDR("1".repeat(65)), false);
  });
  it("rejects bad IPv4 with NaN octet", () => {
    assert.equal(isIPOrCIDR("10.0.0.x"), false);
  });
  it("rejects IPv4 CIDR with mask >32", () => {
    assert.equal(isIPOrCIDR("10.0.0.0/33"), false);
  });
  it("accepts IPv4 CIDR /0 boundary", () => {
    assert.equal(isIPOrCIDR("0.0.0.0/0"), true);
  });
  it("rejects IPv6 with two ::", () => {
    assert.equal(isIPOrCIDR("2001::db8::1"), false);
  });
  it("rejects all-hex but no colon (treated as not IPv6)", () => {
    assert.equal(isIPOrCIDR("abcd"), false);
  });
  it("rejects IPv6 CIDR with mask >128", () => {
    assert.equal(isIPOrCIDR("2001:db8::/129"), false);
  });
  it("accepts plain IPv6 (no CIDR)", () => {
    assert.equal(isIPOrCIDR("::1"), true);
  });
  it("rejects mask that is not an integer", () => {
    assert.equal(isIPOrCIDR("10.0.0.0/abc"), false);
    assert.equal(isIPOrCIDR("2001:db8::/abc"), false);
  });
});

// BUG-MCP-021 — coupling handler. These hit the early-return branches
// inside the create_deploy handler.
describe("BUG-MCP-021: create_deploy private+allowed_ips coupling (handler)", () => {
  function getHandler(): (p: any) => Promise<any> {
    const t = server._registeredTools?.create_deploy;
    return t.handler ?? t.cb ?? t.callback;
  }
  it("rejects private=true with empty allowed_ips", async () => {
    const h = getHandler();
    const r = await h({
      tarball_base64: "aGVsbG8=",
      name: "u-priv-empty",
      private: true,
      allowed_ips: [],
    });
    const txt = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
    assert.match(txt, /private=true requires a non-empty allowed_ips/);
  });
  it("rejects private=true with missing allowed_ips", async () => {
    const h = getHandler();
    const r = await h({
      tarball_base64: "aGVsbG8=",
      name: "u-priv-missing",
      private: true,
    });
    const txt = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
    assert.match(txt, /private=true requires a non-empty allowed_ips/);
  });
  it("warns when allowed_ips is set but private is falsy", async () => {
    const h = getHandler();
    const r = await h({
      tarball_base64: "aGVsbG8=",
      name: "u-priv-false-ips",
      allowed_ips: ["10.0.0.0/8"],
    });
    const txt = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
    assert.match(txt, /allowed_ips set but private=false/);
  });
});

// ── BUG-MCP-024 / 025: UUID schemas ─────────────────────────────────────────

describe("BUG-MCP-024/025: UUID validation on token/id fields", () => {
  const uuidSamples = {
    good: "8b1f3c9e-1234-4abc-9def-0123456789ab",
    bad: "not-a-uuid",
  };
  for (const [tool, field] of [
    ["delete_resource", "token"],
    ["get_deployment", "id"],
    ["redeploy", "id"],
    ["delete_deployment", "id"],
  ] as const) {
    it(`${tool}.${field} accepts a real UUID`, () => {
      const s = schemaFor(tool, field);
      assert.equal(s.safeParse(uuidSamples.good).success, true);
    });
    it(`${tool}.${field} rejects a non-UUID`, () => {
      const s = schemaFor(tool, field);
      assert.equal(s.safeParse(uuidSamples.bad).success, false);
    });
  }
});

// ── BUG-MCP-040: API_URL validation ─────────────────────────────────────────

describe("BUG-MCP-040: validateBaseURL", () => {
  it("accepts https + http", () => {
    assert.equal(validateBaseURL("https://api.instanode.dev"), "https://api.instanode.dev");
    assert.equal(validateBaseURL("http://localhost:8080"), "http://localhost:8080");
  });
  it("rejects javascript: and file:", () => {
    assert.equal(validateBaseURL("javascript:alert(1)"), null);
    assert.equal(validateBaseURL("file:///etc/passwd"), null);
  });
  it("rejects empty / garbage (URL constructor throws → catch branch)", () => {
    assert.equal(validateBaseURL(""), null);
    assert.equal(validateBaseURL("   "), null);
    assert.equal(validateBaseURL("not a url"), null);
    assert.equal(validateBaseURL("http://"), null); // empty host
    assert.equal(validateBaseURL(":/foo"), null);   // URL ctor throws
  });
});

describe("BUG-MCP-040: InstantClient constructor falls back on bad URL", () => {
  it("warns on stderr and falls back to default when override URL is bad", async () => {
    const { InstantClient } = await import("../src/client.js");
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as any).write = (chunk: any) => {
      captured += String(chunk);
      return true;
    };
    try {
      const c = new InstantClient({ baseURL: "javascript:alert(1)" });
      assert.equal(c.apiBaseURL(), "https://api.instanode.dev");
      assert.match(captured, /refusing INSTANODE_API_URL/);
      assert.match(captured, /Falling back/);
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });
  it("accepts a valid override URL silently", async () => {
    const { InstantClient } = await import("../src/client.js");
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as any).write = (chunk: any) => {
      captured += String(chunk);
      return true;
    };
    try {
      const c = new InstantClient({ baseURL: "http://localhost:8080/" });
      assert.equal(c.apiBaseURL(), "http://localhost:8080");
      assert.equal(captured, "");
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });
});
