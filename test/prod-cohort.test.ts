/**
 * PROD cohort integration test for the operate-tools wave.
 *
 * This is the live-backend counterpart to the hermetic integration suite: it
 * runs the REAL MCP server binary against PRODUCTION (https://api.instanode.dev)
 * using a synthetic test-cohort account so nothing touches the real funnel /
 * billing / email surfaces. The cohort owning team carries is_test_cohort=true
 * (migration 067), the flag every background job + funnel/billing path no-ops on.
 *
 * Lifecycle (mint → exercise → reap, always reaped in a finally):
 *   1. POST /internal/e2e/account  (X-E2E-Token guard) → a real pro-tier cohort
 *      with seeded resources + a 1h session JWT.
 *   2. Drive the MCP server (spawned binary, real stdio JSON-RPC) pointed at prod
 *      with that JWT as INSTANODE_TOKEN:
 *        - read-only NEW tool:  get_capabilities  (auth-optional discovery)
 *        - safe NEW write:      set_vault_key      (writes a secret to the cohort
 *                               vault — reversible, self-contained, no infra; the
 *                               whole vault is purged when the cohort is reaped)
 *   3. DELETE /internal/e2e/account/:team_id → reap the cohort (cascades vault +
 *      resources). This NEVER deletes a real team: the api 403s any non-cohort id.
 *
 * GATING — this test is a NO-OP unless BOTH are set:
 *   INSTANODE_PROD_COHORT=1
 *   E2E_ACCOUNT_TOKEN=<the X-E2E-Token secret>
 *       kubectl get secret instant-secrets -n instant \
 *         -o jsonpath='{.data.E2E_ACCOUNT_TOKEN}' | base64 -d
 * Optionally INSTANODE_PROD_API_URL overrides the prod host (default
 * https://api.instanode.dev). With the gate off it skips clean in CI / locally,
 * so `npm test` stays hermetic by default (matches live-smoke.test.ts).
 *
 * NO FLOODS: exactly one cohort is minted and reaped; the only write is a single
 * vault key that the reap cascades away. The vault key is also explicitly
 * rotated-then-left for the reap to clean (no orphan: reap drops the whole team).
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const GATE_ON = process.env["INSTANODE_PROD_COHORT"] === "1";
const E2E_TOKEN = process.env["E2E_ACCOUNT_TOKEN"] ?? "";
const PROD_API_URL = (process.env["INSTANODE_PROD_API_URL"] ?? "https://api.instanode.dev").replace(
  /\/$/,
  ""
);
const ENABLED = GATE_ON && E2E_TOKEN.length > 0;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

function resultText(callResult: unknown): string {
  const r = callResult as { content?: Array<{ text?: string }> };
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

interface CohortAccount {
  team_id: string;
  session_jwt: string;
  tier: string;
  seeded_tokens?: string[];
}

async function mintCohort(): Promise<CohortAccount> {
  const resp = await fetch(`${PROD_API_URL}/internal/e2e/account`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-E2E-Token": E2E_TOKEN,
    },
    // pro tier so vault (unlimited) + pause/resume are available; seed
    // resources so a populated account is realistic.
    body: JSON.stringify({ tier: "pro", env: "production", with_resources: true }),
  });
  const text = await resp.text();
  assert.equal(
    resp.status,
    200,
    `cohort mint failed (HTTP ${resp.status}). Body: ${text}\n` +
      `If 404, the X-E2E-Token is wrong/unset on prod or E2E_ACCOUNT_TOKEN doesn't match.`
  );
  const body = JSON.parse(text) as CohortAccount;
  assert.ok(body.team_id, "cohort response missing team_id");
  assert.ok(body.session_jwt, "cohort response missing session_jwt");
  return body;
}

async function reapCohort(teamId: string): Promise<void> {
  const resp = await fetch(`${PROD_API_URL}/internal/e2e/account/${encodeURIComponent(teamId)}`, {
    method: "DELETE",
    headers: { "X-E2E-Token": E2E_TOKEN },
  });
  const text = await resp.text();
  assert.equal(
    resp.status,
    200,
    `COHORT REAP FAILED for team ${teamId} (HTTP ${resp.status}). Body: ${text}\n` +
      `The synthetic account may be orphaned — reap it manually.`
  );
}

async function connectMcp(token: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      PATH: process.env["PATH"] ?? "",
      INSTANODE_API_URL: PROD_API_URL,
      INSTANODE_TOKEN: token,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "prod-cohort", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe("PROD cohort (operate-tools live verification)", { skip: !ENABLED }, () => {
  let cohort: CohortAccount | null = null;

  before(async () => {
    cohort = await mintCohort();
  });

  after(async () => {
    // MANDATORY reap — a leaked cohort lingers in prod until the worker purge.
    if (cohort?.team_id) {
      await reapCohort(cohort.team_id);
      cohort = null;
    }
  });

  it("get_capabilities (read-only NEW-wave-adjacent discovery) returns the live tier matrix", async () => {
    // Auth-optional, but we connect with the cohort JWT to prove the bearer
    // path works against prod too.
    const { client, close } = await connectMcp(cohort!.session_jwt);
    try {
      const res = await client.callTool({ name: "get_capabilities", arguments: {} });
      const text = resultText(res);
      assert.match(text, /tier\(s\) \(cheapest first\)/, `get_capabilities failed:\n${text}`);
      assert.match(text, /\[pro\]/, "pro tier must appear in the live matrix");
      assert.match(text, /\[team\].*\(top tier\)/, "team must be the terminal tier");
    } finally {
      await close();
    }
  });

  it("set_vault_key writes a secret to the cohort vault (safe, reversible write)", async () => {
    const { client, close } = await connectMcp(cohort!.session_jwt);
    try {
      const key = `MCP_PROD_COHORT_${Date.now()}`;
      const res = await client.callTool({
        name: "set_vault_key",
        arguments: { env: "production", key, value: "ephemeral-cohort-secret" },
      });
      const text = resultText(res);
      assert.match(text, /Secret written to the vault\./, `set_vault_key failed:\n${text}`);
      assert.match(text, /Version:\s+1/, "first write to a fresh key must be v1");
      assert.match(text, new RegExp(`vault://production/${key}`));
      // The plaintext value must never echo back from the tool.
      assert.doesNotMatch(text, /ephemeral-cohort-secret/);

      // Rotate it once to exercise the rotate path too — still self-contained,
      // the reap cascades the whole vault away.
      const rot = await client.callTool({
        name: "rotate_vault_key",
        arguments: { env: "production", key, value: "rotated-cohort-secret" },
      });
      const rotText = resultText(rot);
      assert.match(rotText, /Vault secret rotated\./, `rotate_vault_key failed:\n${rotText}`);
      assert.match(rotText, /Version:\s+2/, "rotate must mint v2");
    } finally {
      await close();
    }
  });
});

// Visibility line so an operator who forgot the gate sees WHY it skipped,
// instead of a silent zero-test run.
if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    `[prod-cohort] skipped — set INSTANODE_PROD_COHORT=1 and E2E_ACCOUNT_TOKEN ` +
      `(kubectl get secret instant-secrets -n instant -o jsonpath='{.data.E2E_ACCOUNT_TOKEN}' | base64 -d) ` +
      `to run against ${PROD_API_URL}.`
  );
}
