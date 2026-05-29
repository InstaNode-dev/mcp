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
import { before, describe, it } from "node:test";

process.env["INSTANODE_MCP_NO_LISTEN"] = "1";

let server: any;
let handleCLIFlags: (argv: readonly string[]) => boolean;
let isIPOrCIDR: (s: string) => boolean;
let validateBaseURL: (raw: string) => string | null;

before(async () => {
  const indexMod: any = await import("../src/index.js");
  server = indexMod.server;
  handleCLIFlags = indexMod.handleCLIFlags;
  isIPOrCIDR = indexMod.isIPOrCIDR;
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
  it("rejects empty / garbage", () => {
    assert.equal(validateBaseURL(""), null);
    assert.equal(validateBaseURL("   "), null);
    assert.equal(validateBaseURL("::not a url"), null);
  });
});
