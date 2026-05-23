/**
 * Unit tests for src/index.ts pure-helper exports.
 *
 * The integration suite (test/integration.test.ts) spawns the built server and
 * drives it over real stdio JSON-RPC, which exercises the tool *handlers* but
 * leaves several non-success formatError branches and formatLimits / appendUpgradeBlock
 * edges uncovered: it doesn't drive a 401, a 429, or the PAT-mints-PAT 403
 * sentence-match path; it doesn't observe empty agentAction/upgradeURL/claimURL
 * vs absent ones; it doesn't cover plain Error / non-Error coercion.
 *
 * This file imports the helpers directly with INSTANODE_MCP_NO_LISTEN=1 set so
 * the module's top-level `await server.connect(transport)` is skipped — tests
 * see the same code that production runs, but without binding to a stdio
 * transport.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import { ApiError, AuthRequiredError } from "../src/client.js";

// Set the no-listen flag BEFORE importing index, so the side-effecting
// `await server.connect(transport)` short-circuits.
process.env["INSTANODE_MCP_NO_LISTEN"] = "1";
// Also clear any auth env vars that might lead to a network call when the
// module's `new InstantClient()` initialises — InstantClient itself doesn't
// reach the network at construction time, but we keep the env minimal anyway.
delete process.env["INSTANODE_TOKEN"];

// Late import so the env var above is observed.
let formatError: (err: unknown) => string;
let formatLimits: (limits: any) => string[];
let appendUpgradeBlock: (lines: string[], result: { note?: string; upgrade?: string }) => void;
let textResult: (text: string) => { content: { type: "text"; text: string }[] };

before(async () => {
  const mod: any = await import("../src/index.js");
  formatError = mod.formatError;
  formatLimits = mod.formatLimits;
  appendUpgradeBlock = mod.appendUpgradeBlock;
  textResult = mod.textResult;
});

describe("formatError — every branch in the cascade", () => {
  it("AuthRequiredError → returns its own canonical message verbatim", () => {
    const out = formatError(new AuthRequiredError());
    assert.match(out, /requires authentication/i);
    assert.match(out, /INSTANODE_TOKEN/);
  });

  it("plain Error (not ApiError, not AuthRequiredError) → coerced to 'instanode.dev error: <msg>'", () => {
    const out = formatError(new Error("kaboom"));
    assert.equal(out, "instanode.dev error: kaboom");
  });

  it("non-Error throwable → String(err) coercion", () => {
    const out = formatError("a bare string was thrown");
    assert.equal(out, "instanode.dev error: a bare string was thrown");
  });

  it("non-Error object with toString → String(err) coercion", () => {
    const out = formatError({ toString: () => "weird shape" });
    assert.equal(out, "instanode.dev error: weird shape");
  });

  it("ApiError(401) → 'Request rejected (401 unauthorized)' headline", () => {
    const out = formatError(new ApiError(401, "any message"));
    assert.match(out, /401 unauthorized/i);
    assert.match(out, /Mint a token at https:\/\/instanode\.dev\/dashboard/);
  });

  it("ApiError(403 paid_tier_only) → 'Free-tier resource cannot be deleted' headline", () => {
    const out = formatError(new ApiError(403, "ignored", "paid_tier_only"));
    assert.match(out, /Free-tier resource cannot be deleted/);
    assert.match(out, /auto-expire in 24h/);
  });

  it("ApiError(403, code=pat_cannot_mint_pat) → PAT-creation guidance branch", () => {
    const out = formatError(new ApiError(403, "irrelevant", "pat_cannot_mint_pat"));
    assert.match(out, /Cannot mint a new API key from another API key/);
    assert.match(out, /one-step trust chain/);
    assert.match(out, /https:\/\/instanode\.dev\/dashboard\/settings/);
  });

  it("ApiError(403, code=forbidden, message names PAT + session) → PAT-creation guidance via message-match", () => {
    const out = formatError(
      new ApiError(
        403,
        "PAT creation requires a user session, not another PAT",
        "forbidden"
      )
    );
    assert.match(out, /Cannot mint a new API key from another API key/);
  });

  it("ApiError(403, no code, 'PAT creation requires a user session' message) → PAT path via message regex", () => {
    const out = formatError(
      new ApiError(403, "PAT creation requires a user session", undefined)
    );
    assert.match(out, /Cannot mint a new API key from another API key/);
  });

  it("ApiError(403, code=forbidden, message names 'Personal Access Token' + 'session') → PAT path", () => {
    const out = formatError(
      new ApiError(
        403,
        "Personal Access Token cannot be used: requires a session",
        "forbidden"
      )
    );
    assert.match(out, /Cannot mint a new API key from another API key/);
  });

  it("ApiError(403, code=forbidden, generic message) → falls through to code-branch headline", () => {
    const out = formatError(new ApiError(403, "some other reason", "forbidden"));
    // Does NOT match PAT path because message lacks PAT/session signals.
    assert.doesNotMatch(out, /Cannot mint a new API key/);
    // Falls into the generic "code + message" branch.
    assert.match(out, /403 forbidden/);
    assert.match(out, /some other reason/);
  });

  it("ApiError(429) → rate-limit headline", () => {
    const out = formatError(new ApiError(429, "rate limited"));
    assert.match(out, /Rate limited/);
    assert.match(out, /5 anonymous provisions\/day/);
    assert.match(out, /INSTANODE_TOKEN/);
  });

  it("ApiError with code → 'instanode.dev error (<status> <code>): <message>' headline", () => {
    const out = formatError(
      new ApiError(402, "Tier limit", "deploy_limit_reached")
    );
    assert.match(out, /instanode\.dev error \(402 deploy_limit_reached\): Tier limit/);
  });

  it("ApiError with no code → 'instanode.dev error (<status>): <message>' headline", () => {
    const out = formatError(new ApiError(500, "internal server error"));
    assert.match(out, /instanode\.dev error \(500\): internal server error/);
  });

  it("ApiError with agentAction → appends 'Action: ...' block", () => {
    const out = formatError(
      new ApiError(
        402,
        "limit",
        "deploy_limit_reached",
        undefined,
        "Tell the user to upgrade."
      )
    );
    assert.match(out, /Action: Tell the user to upgrade\./);
  });

  it("ApiError with EMPTY-STRING agentAction → does NOT append Action block", () => {
    const out = formatError(
      new ApiError(402, "limit", "deploy_limit_reached", undefined, "")
    );
    assert.doesNotMatch(out, /\nAction:/);
  });

  it("ApiError with upgradeURL → appends 'Upgrade: ...' line", () => {
    const out = formatError(
      new ApiError(
        402,
        "limit",
        "deploy_limit_reached",
        "https://instanode.dev/pricing"
      )
    );
    assert.match(out, /Upgrade: https:\/\/instanode\.dev\/pricing/);
  });

  it("ApiError with EMPTY-STRING upgradeURL → does NOT append Upgrade line", () => {
    const out = formatError(
      new ApiError(402, "limit", "deploy_limit_reached", "")
    );
    assert.doesNotMatch(out, /\nUpgrade:/);
  });

  it("ApiError with claimURL → appends 'Claim:' line", () => {
    const out = formatError(
      new ApiError(
        403,
        "claim required",
        "free_tier_recycle_requires_claim",
        undefined,
        undefined,
        "https://instanode.dev/claim?t=abc"
      )
    );
    assert.match(out, /Claim:\s+https:\/\/instanode\.dev\/claim\?t=abc/);
  });

  it("ApiError with EMPTY-STRING claimURL → does NOT append Claim line", () => {
    const out = formatError(
      new ApiError(403, "x", "y", undefined, undefined, "")
    );
    assert.doesNotMatch(out, /\nClaim:/);
  });

  it("ApiError(403, code=forbidden, NON-string message via cast) → falls through PAT path (typeof check)", () => {
    // Construct an ApiError with a non-string message via cast — the PAT
    // detection chain has a `typeof err.message === "string"` guard, and
    // we want to hit the false-branch of that guard.
    const err = new ApiError(403, undefined as unknown as string, "forbidden");
    const out = formatError(err);
    assert.doesNotMatch(out, /Cannot mint a new API key/);
    // Falls into the generic "code + message" branch.
    assert.match(out, /403 forbidden/);
  });

  it("ApiError(403, code=forbidden, message has only 'PAT' or only 'session' but not both → does NOT match PAT path", () => {
    // The second message-match branch requires both "Personal Access Token"
    // AND "session" present. Just "PAT" without "session" should NOT
    // trigger the PAT headline.
    const err = new ApiError(403, "Personal Access Token revoked", "forbidden");
    const out = formatError(err);
    // Doesn't have "session" → falls through.
    assert.doesNotMatch(out, /Cannot mint a new API key/);
  });

  it("ApiError(403, code=forbidden, message has 'session' but not 'PAT' / 'Personal Access Token'", () => {
    const err = new ApiError(403, "session expired, please refresh", "forbidden");
    const out = formatError(err);
    assert.doesNotMatch(out, /Cannot mint a new API key/);
  });

  it("ApiError(403, no code, generic message → falls through to 'instanode.dev error (403): <msg>'", () => {
    const err = new ApiError(403, "some random reason");
    const out = formatError(err);
    assert.doesNotMatch(out, /Cannot mint a new API key/);
    assert.match(out, /instanode\.dev error \(403\): some random reason/);
  });

  it("ApiError(0) network error has neither status 401 nor 403 nor 429 → generic 'no code' branch", () => {
    const err = new ApiError(0, "network failure");
    const out = formatError(err);
    assert.match(out, /instanode\.dev error \(0\): network failure/);
  });

  it("ApiError(500) with code → 'instanode.dev error (500 <code>): <msg>' headline", () => {
    const err = new ApiError(500, "boom", "internal");
    const out = formatError(err);
    assert.match(out, /instanode\.dev error \(500 internal\): boom/);
  });

  it("ApiError with all three envelope fields → all three appended in order", () => {
    const out = formatError(
      new ApiError(
        402,
        "limit reached",
        "deploy_limit_reached",
        "https://instanode.dev/pricing",
        "Upgrade the user.",
        "https://instanode.dev/claim?t=xyz"
      )
    );
    const lines = out.split("\n");
    const actionIdx = lines.findIndex((l) => l.startsWith("Action:"));
    const upgradeIdx = lines.findIndex((l) => l.startsWith("Upgrade:"));
    const claimIdx = lines.findIndex((l) => l.startsWith("Claim:"));
    assert.ok(actionIdx > 0, "Action line present");
    assert.ok(upgradeIdx > actionIdx, "Upgrade after Action");
    assert.ok(claimIdx > upgradeIdx, "Claim after Upgrade");
  });
});

describe("formatLimits — every typed-limit branch", () => {
  it("undefined limits → empty array", () => {
    assert.deepEqual(formatLimits(undefined), []);
  });

  it("empty limits → empty array (all fields absent / non-numeric / non-string)", () => {
    assert.deepEqual(formatLimits({}), []);
  });

  it("storage_mb only", () => {
    assert.deepEqual(formatLimits({ storage_mb: 10 }), ["Storage: 10 MB"]);
  });

  it("connections only", () => {
    assert.deepEqual(formatLimits({ connections: 2 }), ["Max connections: 2"]);
  });

  it("requests_stored only", () => {
    assert.deepEqual(formatLimits({ requests_stored: 100 }), [
      "Requests stored: 100",
    ]);
  });

  it("expires_in only", () => {
    assert.deepEqual(formatLimits({ expires_in: "24h" }), ["Expires in: 24h"]);
  });

  it("all four set → all four emitted, in declared order", () => {
    assert.deepEqual(
      formatLimits({
        storage_mb: 10,
        connections: 2,
        requests_stored: 100,
        expires_in: "24h",
      }),
      [
        "Storage: 10 MB",
        "Max connections: 2",
        "Requests stored: 100",
        "Expires in: 24h",
      ]
    );
  });

  it("wrong-typed fields ignored (no NaN / 'undefined MB')", () => {
    assert.deepEqual(
      formatLimits({
        storage_mb: "10" as any,
        connections: null as any,
        requests_stored: undefined as any,
        expires_in: 24 as any,
      }),
      []
    );
  });
});

describe("appendUpgradeBlock — note + upgrade rendering", () => {
  it("both absent → leaves lines unchanged", () => {
    const lines: string[] = ["preexisting"];
    appendUpgradeBlock(lines, {});
    assert.deepEqual(lines, ["preexisting"]);
  });

  it("only note → single 'Note: ...' line appended", () => {
    const lines: string[] = [];
    appendUpgradeBlock(lines, { note: "claim within 24h" });
    assert.deepEqual(lines, ["Note: claim within 24h"]);
  });

  it("only upgrade → blank + heading + indented URL appended (3 lines)", () => {
    const lines: string[] = [];
    appendUpgradeBlock(lines, { upgrade: "https://instanode.dev/start?t=jwt" });
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "");
    assert.match(lines[1] ?? "", /Claim URL/);
    assert.match(lines[2] ?? "", /https:\/\/instanode\.dev\/start\?t=jwt/);
  });

  it("both → note line then 3-line upgrade block (4 lines total)", () => {
    const lines: string[] = [];
    appendUpgradeBlock(lines, {
      note: "claim now",
      upgrade: "https://instanode.dev/start?t=jwt",
    });
    assert.equal(lines.length, 4);
    assert.equal(lines[0], "Note: claim now");
  });
});

describe("textResult — MCP content-array envelope", () => {
  it("wraps a string into the canonical MCP CallToolResult shape", () => {
    const res = textResult("hello world");
    assert.deepEqual(res, {
      content: [{ type: "text", text: "hello world" }],
    });
  });

  it("preserves empty strings", () => {
    const res = textResult("");
    assert.equal(res.content[0]?.text, "");
  });
});
