/**
 * OPTIONAL live smoke test — provision-then-teardown against a REAL backend.
 *
 * This file is build-flagged: it is a no-op unless INSTANODE_LIVE_SMOKE=1 is
 * set. The hermetic integration suite (integration.test.ts) is the CI gate;
 * this is a manual confidence check an operator can run against a live
 * cluster, e.g.:
 *
 *   INSTANODE_LIVE_SMOKE=1 \
 *   INSTANODE_API_URL=http://localhost:8080 \
 *   INSTANODE_TOKEN=<paid bearer> \
 *   npm test
 *
 * It deliberately exercises ONLY the cheap, fully-reversible path:
 *   create_postgres → list_resources (assert present) → delete_resource.
 *
 * RESOURCE CLEANUP IS MANDATORY here too: the provisioned database is deleted
 * in a finally block, and a failure to delete fails the test loudly. It does
 * NOT exercise create_deploy — a real kaniko build + k8s pod is too costly
 * and slow for a smoke test; the hermetic suite covers the deploy path.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const LIVE = process.env["INSTANODE_LIVE_SMOKE"] === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

function resultText(callResult: unknown): string {
  const r = callResult as { content?: Array<{ text?: string }> };
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

describe("live smoke (provision-then-teardown)", { skip: !LIVE }, () => {
  it("create_postgres → list_resources → delete_resource against the real API", async () => {
    const apiUrl = process.env["INSTANODE_API_URL"];
    const token = process.env["INSTANODE_TOKEN"];
    assert.ok(apiUrl, "INSTANODE_API_URL must be set for the live smoke test");
    assert.ok(token, "INSTANODE_TOKEN (a paid bearer) must be set for the live smoke test");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: {
        PATH: process.env["PATH"] ?? "",
        INSTANODE_API_URL: apiUrl,
        INSTANODE_TOKEN: token,
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "live-smoke", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    let provisionedToken = "";
    try {
      const created = await client.callTool({
        name: "create_postgres",
        arguments: { name: `mcp-live-smoke-${Date.now()}` },
      });
      const text = resultText(created);
      assert.ok(text.includes("Postgres database provisioned."), `provision failed:\n${text}`);
      provisionedToken = /Token:\s+(\S+)/.exec(text)?.[1] ?? "";
      assert.ok(provisionedToken, "could not parse the provisioned token");

      const listed = await client.callTool({ name: "list_resources", arguments: {} });
      assert.ok(
        resultText(listed).includes(provisionedToken),
        "provisioned resource not visible in list_resources"
      );
    } finally {
      // MANDATORY teardown — a leaked live resource costs money.
      if (provisionedToken) {
        const deleted = await client.callTool({
          name: "delete_resource",
          arguments: { token: provisionedToken },
        });
        assert.ok(
          resultText(deleted).includes("Resource deleted."),
          `LIVE CLEANUP FAILED — resource ${provisionedToken} may be orphaned`
        );
      }
      await client.close();
    }
  });
});
