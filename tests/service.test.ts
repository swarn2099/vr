import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serve } from "../src/service.js";
import { rpc } from "../src/client.js";
import { git } from "../src/scanner.js";

test("one service owns the database, MCP uses its permitted operations, and hook delivery is once per prompt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vr-service-")),
    root = path.join(directory, "app"),
    state = path.join(directory, "state");
  await mkdir(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "VR fixture");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await writeFile(
    path.join(root, "pay.ts"),
    'export function canPay(role:string){return role === "manager";}',
  );
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "Payment fixture");
  const service = await serve(state);
  let client: Client | undefined;
  try {
    await assert.rejects(() => serve(state), /already owns/);
    await assert.rejects(
      () => rpc(state, "connect", { name: "Denied", root }),
      /not available/,
    );
    const ids = await rpc(
      state,
      "connect",
      { name: "Delivery fixture", root },
      true,
    );
    await rpc(state, "refresh", { sourceId: ids.sourceId }, true);
    for (let i = 0; i < 8; i++) {
      const b: any = await service.learning.next(
        ids.productId,
        "controlled-fixture",
      );
      if (b.done) break;
      const current = b.stage === "current";
      await service.learning.publish(b.batchId, {
        analyses: current
          ? b.evidence.map((e: any) => ({
              evidence: e.id,
              summary: "Controlled payment rule",
              symbols: e.metadata.functions.map((f: any) => ({
                name: f.name,
                start: f.start,
                summary: "Accepts manager role",
              })),
            }))
          : [],
        findings: current
          ? [
              {
                key: "payment-role",
                title: "Payment role",
                statement: "Managers satisfy the payment predicate.",
                conditions: [],
                exceptions: [],
                basis: "observation",
                temporal: "current",
                evidence: [b.evidence[0].id],
                paths: ["pay.ts"],
                contradicts: [],
                checks: [],
                extensions: {},
              },
            ]
          : [],
        relationships: [],
        questions: [],
      });
    }
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        VR_STATE_DIRECTORY: state,
        VR_PRODUCT_ID: ids.productId,
        VR_WORKSPACE_ROOT: root,
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    client = new Client({ name: "qualification", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", path.resolve("src/mcp.ts")],
        env,
        stderr: "pipe",
      }),
    );
    assert.equal((await client.listTools()).tools.length, 7);
    const status: any = await client.callTool({
      name: "vr_status",
      arguments: {},
    });
    assert.equal(
      JSON.parse(status.content[0].text).product,
      "Delivery fixture",
    );
    const context: any = await client.callTool({
      name: "vr_context",
      arguments: { task: "Review payment roles" },
    });
    assert.equal(JSON.parse(context.content[0].text).behaviors.length, 1);
    const hook = (event: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            path.resolve("src/hook.ts"),
            state,
            ids.productId,
            root,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (b) => (out += b));
        child.stderr.on("data", (b) => (err += b));
        child.on("error", reject);
        child.on("close", (code) =>
          code ? reject(Error(err)) : resolve(out.trim()),
        );
        child.stdin.end(
          JSON.stringify({
            hook_event_name: event,
            session_id: "fixture-session",
            cwd: root,
            prompt: "Review the bill payment role behavior",
          }),
        );
      });
    assert.deepEqual(JSON.parse(await hook("UserPromptSubmit")), {});
    const attached = JSON.parse(await hook("PreToolUse"));
    assert.equal(attached.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.ok(
      attached.hookSpecificOutput.additionalContext.includes(
        "Managers satisfy",
      ),
    );
    assert.deepEqual(JSON.parse(await hook("PreToolUse")), {});
    assert.equal(
      Number(
        (
          await service.engine.db.query(
            "SELECT count(*) AS n FROM vr_receipts WHERE kind='context-hook-output'",
          )
        ).rows[0].n,
      ),
      1,
    );
  } finally {
    await client?.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
