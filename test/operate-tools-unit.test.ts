/**
 * Direct-handler unit tests for the OPERATE tools (the full-bundle-lifecycle
 * wave): set_vault_key, rotate_vault_key, update_deploy_env, update_stack_env,
 * presign_storage, pause_resource, resume_resource, rotate_credentials,
 * wake_deployment.
 *
 * Companion to tools-unit.test.ts (the create_* / deploy / claim handlers). The
 * same wiring: import the tool callbacks out of `_registeredTools`, drive each
 * in-process against the hermetic mock-api (test/mock-api.ts), assert the
 * agent-facing text. Each tool gets (a) a success path and (b) at least one
 * error/contract path (401 / 402 / 404 / 409 / 501 / validation) so the
 * ApiError → formatError → agent_action/upgrade_url passthrough is covered.
 *
 * Wiring mirrors tools-unit.test.ts:
 *   - INSTANODE_MCP_NO_LISTEN=1 keeps the stdio transport off.
 *   - INSTANODE_API_URL points at startMockApi().
 *   - VALID_TOKEN = a Pro-tier bearer; HOBBY_TOKEN = a hobby bearer (tier gate).
 *   - mock.seedResource / mock.seedDeployment set up deterministic rows so the
 *     mutate-an-existing-thing tools have a known target.
 */

import { strict as assert } from "node:assert";
import { gzipSync } from "node:zlib";
import { after, afterEach, before, describe, it } from "node:test";

import {
  startMockApi,
  VALID_TOKEN,
  HOBBY_TOKEN,
  type MockApiHandle,
} from "./mock-api.js";

process.env["INSTANODE_MCP_NO_LISTEN"] = "1";

let mock: MockApiHandle;
let server: any;

function handlerFor(name: string): (args: any, extra?: any) => Promise<any> {
  const reg = (server as any)._registeredTools as Record<string, { handler: any }>;
  const t = reg[name];
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t.handler as any;
}

// The mcp-sdk validates args against the registered ZodRawShape at the WIRE
// boundary, not inside the handler we call directly. So client-side schema
// rejection is asserted via the per-field zod schema's safeParse (same pattern
// as env-regex-unit.test.ts), not by invoking the handler with bad args.
function fieldSchemaOf(toolName: string, field: string): any {
  const reg = (server as any)._registeredTools as Record<string, { inputSchema?: any }>;
  const t = reg[toolName];
  if (!t) throw new Error(`tool not registered: ${toolName}`);
  return (t as any).inputSchema?.shape?.[field] ?? null;
}

function flat(callResult: any): string {
  if (!callResult || !callResult.content) return "";
  return callResult.content.map((c: any) => c.text ?? "").join("\n");
}

function tarballBase64(): string {
  return gzipSync(Buffer.from("FROM scratch\n")).toString("base64");
}

// A syntactically-valid UUID the mock never minted → exercises the cross-team/
// absent 404 contract (indistinguishable, by design).
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

before(async () => {
  mock = await startMockApi();
  process.env["INSTANODE_API_URL"] = mock.url;
  delete process.env["INSTANODE_TOKEN"];
  const mod: any = await import("../src/index.js");
  server = mod.server;
});

after(async () => {
  await mock.close();
});

afterEach(() => {
  delete process.env["INSTANODE_TOKEN"];
});

// ───────────────────────────────────────────────────────────────────────────
// set_vault_key  (PUT /api/v1/vault/:env/:key)  — closes D4
// ───────────────────────────────────────────────────────────────────────────
describe("set_vault_key", () => {
  it("writes a secret → v1 on first write, surfaces the vault:// reference", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("set_vault_key")({
      env: "production",
      key: "DATABASE_URL",
      value: "postgres://u:p@h/db",
    });
    const text = flat(res);
    assert.match(text, /Secret written to the vault\./);
    assert.match(text, /Env:\s+production/);
    assert.match(text, /Key:\s+DATABASE_URL/);
    assert.match(text, /Version:\s+1/);
    assert.match(text, /vault:\/\/production\/DATABASE_URL/);
  });

  it("a second write to the same key returns v2 (always-new-version)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    await handlerFor("set_vault_key")({ env: "staging", key: "API_KEY", value: "v1" });
    const res = await handlerFor("set_vault_key")({ env: "staging", key: "API_KEY", value: "v2" });
    assert.match(flat(res), /Version:\s+2/);
  });

  it("missing bearer → 401 headline pointing at the dashboard", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("set_vault_key")({
      env: "production",
      key: "SECRET",
      value: "x",
    });
    assert.match(flat(res), /requires authentication|401/i);
  });

  it("invalid env shape is rejected at the zod boundary (no api round-trip)", () => {
    const envSchema = fieldSchemaOf("set_vault_key", "env");
    assert.ok(envSchema, "set_vault_key.env schema not located");
    // A '/' is not in [A-Za-z0-9_-] → must fail the vault env regex.
    assert.equal(envSchema.safeParse("bad/env").success, false);
    // The canonical 'production' must pass.
    assert.equal(envSchema.safeParse("production").success, true);
    // Over-cap key must fail.
    const keySchema = fieldSchemaOf("set_vault_key", "key");
    assert.equal(keySchema.safeParse("a".repeat(257)).success, false);
    assert.equal(keySchema.safeParse("DATABASE_URL").success, true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// rotate_vault_key  (POST /api/v1/vault/:env/:key/rotate)
// ───────────────────────────────────────────────────────────────────────────
describe("rotate_vault_key", () => {
  it("rotates an existing secret → new version + redeploy reminder", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    await handlerFor("set_vault_key")({ env: "production", key: "ROT", value: "old" });
    const res = await handlerFor("rotate_vault_key")({
      env: "production",
      key: "ROT",
      value: "new",
    });
    const text = flat(res);
    assert.match(text, /Vault secret rotated\./);
    assert.match(text, /a new version was minted/);
    assert.match(text, /Redeploy any app referencing vault:\/\/production\/ROT/);
  });

  it("missing bearer → 401", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("rotate_vault_key")({
      env: "production",
      key: "ROT",
      value: "new",
    });
    assert.match(flat(res), /requires authentication|401/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// update_deploy_env  (PATCH /deploy/:id/env)
// ───────────────────────────────────────────────────────────────────────────
describe("update_deploy_env", () => {
  it("merges env into a deployment → redacted map + redeploy note", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const appId = mock.seedDeployment({ env: { EXISTING: "1" } });
    const res = await handlerFor("update_deploy_env")({
      id: appId,
      env: { NEW_KEY: "secret-value" },
    });
    const text = flat(res);
    assert.match(text, new RegExp(`Env vars merged into deployment ${appId}`));
    assert.match(text, /redeploy/i);
    // Secret value is redacted in the echoed map.
    assert.match(text, /NEW_KEY=\*\*\*/);
    assert.doesNotMatch(text, /secret-value/);
    // The mock actually persisted the merge.
    assert.equal(mock.deployEnvFor(appId)?.["NEW_KEY"], "secret-value");
  });

  it("empty env map → friendly no-op message (no api call)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("update_deploy_env")({ id: UNKNOWN_UUID, env: {} });
    assert.match(flat(res), /No env vars supplied/);
  });

  it("unknown deployment id → 404 not_found", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("update_deploy_env")({
      id: UNKNOWN_UUID,
      env: { K: "v" },
    });
    assert.match(flat(res), /404 not_found|deployment not found/i);
  });

  it("missing bearer → 401", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("update_deploy_env")({
      id: UNKNOWN_UUID,
      env: { K: "v" },
    });
    assert.match(flat(res), /requires authentication|401/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// update_stack_env  (PATCH /stacks/:slug/env)
// ───────────────────────────────────────────────────────────────────────────
describe("update_stack_env", () => {
  it("merges env into a stack created via create_stack → persisted + redacted", async () => {
    // Create a real stack first so there's a slug to mutate.
    const created = flat(
      await handlerFor("create_stack")({
        name: "op-stack",
        manifest: "services:\n  web:\n    build: .\n    port: 8080\n    expose: true\n",
        service_tarballs: { web: tarballBase64() },
      })
    );
    const slug = /Stack ID:\s+(stk-[0-9a-f]{8})/.exec(created)![1];
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("update_stack_env")({
      stack_id: slug,
      env: { FEATURE_FLAG: "on" },
    });
    const text = flat(res);
    assert.match(text, new RegExp(`Env vars merged into stack ${slug}`));
    assert.match(text, /FEATURE_FLAG=\*\*\*/);
    assert.equal(mock.stackEnvFor(slug)?.["FEATURE_FLAG"], "on");
  });

  it("empty-string value deletes a key", async () => {
    const created = flat(
      await handlerFor("create_stack")({
        name: "op-stack-del",
        manifest: "services:\n  web:\n    build: .\n    port: 8080\n    expose: true\n",
        service_tarballs: { web: tarballBase64() },
      })
    );
    const slug = /Stack ID:\s+(stk-[0-9a-f]{8})/.exec(created)![1];
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    await handlerFor("update_stack_env")({ stack_id: slug, env: { A: "1", B: "2" } });
    await handlerFor("update_stack_env")({ stack_id: slug, env: { A: "" } });
    const env = mock.stackEnvFor(slug);
    assert.equal(env?.["A"], undefined, "A should have been deleted by the empty-string value");
    assert.equal(env?.["B"], "2");
  });

  it("empty env map → friendly no-op", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("update_stack_env")({ stack_id: "stk-deadbeef", env: {} });
    assert.match(flat(res), /No env vars supplied/);
  });

  it("missing bearer → 401 (anonymous stacks cannot be mutated)", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("update_stack_env")({
      stack_id: "stk-deadbeef",
      env: { K: "v" },
    });
    assert.match(flat(res), /requires authentication|401/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// presign_storage  (POST /storage/:token/presign)  — token-in-path auth
// ───────────────────────────────────────────────────────────────────────────
describe("presign_storage", () => {
  it("mints a presigned PUT URL for a live storage resource (no bearer needed)", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const token = mock.seedResource({ resource_type: "storage", tier: "anonymous" });
    const res = await handlerFor("presign_storage")({
      token,
      operation: "PUT",
      key: "uploads/avatar.png",
    });
    const text = flat(res);
    assert.match(text, /Presigned PUT URL minted/);
    assert.match(text, /Key:\s+uploads\/avatar\.png/);
    assert.match(text, /X-Amz-Signature=mock/);
  });

  it("unknown storage token → 404 not_found", async () => {
    const res = await handlerFor("presign_storage")({
      token: UNKNOWN_UUID,
      operation: "GET",
      key: "x.txt",
    });
    assert.match(flat(res), /404 not_found|storage resource not found/i);
  });

  it("DELETE is not an allowed operation (zod enum rejects it client-side)", () => {
    const opSchema = fieldSchemaOf("presign_storage", "operation");
    assert.ok(opSchema, "presign_storage.operation schema not located");
    assert.equal(opSchema.safeParse("DELETE").success, false, "DELETE must be rejected");
    for (const ok of ["GET", "PUT", "HEAD"]) {
      assert.equal(opSchema.safeParse(ok).success, true, `${ok} must be accepted`);
    }
  });

  it("path-traversal key → 400 path_unsafe from the api", async () => {
    const token = mock.seedResource({ resource_type: "storage" });
    const res = await handlerFor("presign_storage")({
      token,
      operation: "GET",
      key: "../../etc/passwd",
    });
    assert.match(flat(res), /path_unsafe|leading slash/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// pause_resource / resume_resource  (POST /api/v1/resources/:id/{pause,resume})
// ───────────────────────────────────────────────────────────────────────────
describe("pause_resource / resume_resource", () => {
  it("pauses then resumes a Pro-tier resource (status round-trips)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const token = mock.seedResource({ tier: "pro", resource_type: "postgres" });
    const paused = flat(await handlerFor("pause_resource")({ id: token }));
    assert.match(paused, /Resource paused\./);
    assert.match(paused, /Status:\s+paused/);
    const resumed = flat(await handlerFor("resume_resource")({ id: token }));
    assert.match(resumed, /Resource resumed\./);
    assert.match(resumed, /Status:\s+active/);
  });

  it("pausing an already-paused resource → 409", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const token = mock.seedResource({ tier: "pro", status: "paused" });
    const res = await handlerFor("pause_resource")({ id: token });
    assert.match(flat(res), /409|already_paused|already paused/i);
  });

  it("pause on a hobby-tier resource → 402 with agent_action + upgrade URL", async () => {
    process.env["INSTANODE_TOKEN"] = HOBBY_TOKEN;
    const token = mock.seedResource({ tier: "hobby" });
    const res = await handlerFor("pause_resource")({ id: token });
    const text = flat(res);
    assert.match(text, /402 tier_upgrade_required/);
    assert.match(text, /\nAction: .*upgrade.*pricing/i);
    assert.match(text, /\nUpgrade: https:\/\/instanode\.dev\/pricing/);
  });

  it("resume on an unknown token → 404", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("resume_resource")({ id: UNKNOWN_UUID });
    assert.match(flat(res), /404 not_found|resource not found/i);
  });

  it("pause with missing bearer → 401", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("pause_resource")({ id: UNKNOWN_UUID });
    assert.match(flat(res), /requires authentication|401/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// rotate_credentials  (POST /api/v1/resources/:id/rotate-credentials)
// ───────────────────────────────────────────────────────────────────────────
describe("rotate_credentials", () => {
  it("returns a fresh plaintext connection_url for a postgres resource", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const token = mock.seedResource({ tier: "pro", resource_type: "postgres" });
    const res = await handlerFor("rotate_credentials")({ id: token });
    const text = flat(res);
    assert.match(text, new RegExp(`Credentials rotated for resource ${token}`));
    assert.match(text, /postgres:\/\/user:rotated_/);
    assert.match(text, /old connection URL no longer works/i);
  });

  it("unknown token → 404", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const res = await handlerFor("rotate_credentials")({ id: UNKNOWN_UUID });
    assert.match(flat(res), /404 not_found|resource not found/i);
  });

  it("missing bearer → 401", async () => {
    delete process.env["INSTANODE_TOKEN"];
    const res = await handlerFor("rotate_credentials")({ id: UNKNOWN_UUID });
    assert.match(flat(res), /requires authentication|401/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// wake_deployment  (POST /deploy/:id/wake)  — flag-gated
// ───────────────────────────────────────────────────────────────────────────
describe("wake_deployment", () => {
  it("flag ON → wakes a scaled-to-zero deployment (cold-start reminder)", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const appId = mock.seedDeployment({ wakeEnabled: true });
    const res = await handlerFor("wake_deployment")({ id: appId });
    const text = flat(res);
    assert.match(text, new RegExp(`Deployment ${appId} woken`));
    assert.match(text, /cold-start/i);
  });

  it("flag OFF (default) → 501 scale_to_zero_disabled surfaced verbatim", async () => {
    process.env["INSTANODE_TOKEN"] = VALID_TOKEN;
    const appId = mock.seedDeployment({}); // not wake-enabled → flag off
    const res = await handlerFor("wake_deployment")({ id: appId });
    assert.match(flat(res), /501 scale_to_zero_disabled|not enabled/i);
  });
});
