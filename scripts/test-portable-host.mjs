// Integration test: real setup command, packaged extension code, service and database.
// The VS Code host/model/Jira transport are controlled fixtures, not a live semantic-quality test.
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import Module, { createRequire } from "node:module";
import assert from "node:assert/strict";
const codeRoot = process.cwd(),
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "vr-host-"))),
  estate = path.join(dir, "Spend Estate");
await mkdir(estate);
const run = (cmd, args, cwd = estate) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
let servicePid,
  subscriptions = [];
try {
  for (const [name, file, body] of [
    [
      "web",
      "App.tsx",
      'export const Pay = () => <button onClick={() => fetch("/api/bills/pay")}>Pay</button>;',
    ],
    [
      "billing",
      "BillController.java",
      'class BillController { public boolean pay(String role) { return role.equals("manager"); } }',
    ],
    [
      "events",
      "payments.ts",
      'export const route="/api/bills/pay"; export const topic="BillApprovedEvent";',
    ],
  ]) {
    const repo = path.join(estate, name);
    await mkdir(repo);
    run("git", ["init", "-q"], repo);
    run("git", ["config", "user.name", "VR fixture"], repo);
    run("git", ["config", "user.email", "test@example.invalid"], repo);
    await writeFile(path.join(repo, file), body);
    if (name === "billing")
      await writeFile(
        path.join(repo, "transactions.txt"),
        Buffer.from([0, 1, 2, 3]),
      );
    run("git", ["add", "."], repo);
    run("git", ["commit", "-qm", "Initial payment behavior"], repo);
  }
  console.log(
    run(
      process.execPath,
      [
        "dist/setup.js",
        estate,
        "--no-open",
        "--history-years",
        "1",
        "--semantic",
        "off",
      ],
      codeRoot,
    ),
  );
  const meta = path.join(estate, ".vr-estate"),
    manifestPath = path.join(meta, "estate.json"),
    m = JSON.parse(await readFile(manifestPath));
  servicePid = JSON.parse(
    await readFile(path.join(m.state, "connection.json")),
  ).pid;
  const values = new Map(),
    events = [],
    host = { modelCalls: 0, jiraCalls: 0, packets: [], mcp: [] };
  const disposable = () => ({ dispose() {} });
  class CancellationTokenSource {
    constructor() {
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: () => disposable(),
      };
    }
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  }
  class LanguageModelTextPart {
    constructor(value) {
      this.value = value;
    }
  }
  const model = {
    id: "fixture",
    vendor: "controlled-test",
    name: "Controlled fixture model",
    version: "1",
    maxInputTokens: 100000,
    countTokens: async () => 1000,
    sendRequest: async (messages) => {
      host.modelCalls++;
      const prompt = messages[0].content;
      const evidence = JSON.parse(prompt.split("\nEVIDENCE: ")[1]);
      const current = prompt.includes("REQUIRED: Include one analyses");
      const historical = prompt.includes("Interpret historical baseline");
      const jira = prompt.includes("Reconcile written issue reports");
      const connection = prompt.includes("Connect behavior across");
      const p = {
        analyses: current
          ? evidence.map((e) => ({
              evidence: e.id,
              summary: "Fixture source summary",
              symbols: e.metadata.functions.map((f) => ({
                name: f.name,
                start: f.start,
                summary: "Fixture interpretation",
              })),
            }))
          : [],
        findings: [
          {
            key:
              "rule-" +
              (current
                ? "current"
                : historical
                  ? "history"
                  : jira
                    ? "jira"
                    : "connection"),
            title: "Payment approval fixture",
            statement:
              "Controlled fixture finding; not semantic-quality evidence.",
            conditions: [],
            exceptions: [],
            basis: connection ? "inference" : jira ? "intent" : "observation",
            temporal: historical ? "historical" : jira ? "proposed" : "current",
            evidence: evidence.map((e) => e.id),
            contradicts: [],
            paths: evidence.map((e) => e.path),
            checks: [],
            extensions: {},
          },
        ],
        relationships: [],
        questions: [],
      };
      return {
        text: (async function* () {
          yield JSON.stringify(p);
        })(),
      };
    },
  };
  const config = { portableConfig: manifestPath, nodePath: process.execPath };
  const vscode = {
    CancellationTokenSource,
    LanguageModelTextPart,
    LanguageModelChatMessage: { User: (content) => ({ content }) },
    McpStdioServerDefinition: class {
      constructor(...args) {
        this.args = args;
      }
    },
    ProgressLocation: { Notification: 1 },
    ViewColumn: { One: 1, Beside: 2 },
    Uri: { file: (fsPath) => ({ fsPath, scheme: "file" }) },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (k, f) => config[k] ?? f }),
      textDocuments: [],
      openTextDocument: async (x) => x,
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (t) => events.push(t),
        show() {},
        dispose() {},
      }),
      createWebviewPanel: () => ({
        webview: {
          html: "",
          postMessage: async (p) => {
            host.packets.push(p);
          },
          asWebviewUri: (u) => u.fsPath,
          onDidReceiveMessage: () => disposable(),
        },
        onDidDispose: () => disposable(),
        reveal() {},
      }),
      showQuickPick: async (items) => items[0],
      showInputBox: async (opts) =>
        opts.prompt.includes("site URL")
          ? "https://jira.example.invalid"
          : opts.prompt.includes("project keys")
            ? "SPEND"
            : "Fixture reviewer",
      showWarningMessage: async () => undefined,
      showErrorMessage: async (e) => {
        throw Error(e);
      },
      showTextDocument: async () => {},
      withProgress: async (_, fn) =>
        fn({ report() {} }, new CancellationTokenSource().token),
    },
    commands: { registerCommand: () => disposable() },
    authentication: { getSession: async () => undefined },
    lm: {
      selectChatModels: async () => [model],
      tools: [
        {
          name: "company_jira_search",
          inputSchema: {
            properties: {
              jql: { type: "string" },
              start_at: { type: "integer" },
              limit: { type: "integer" },
              fields: { type: "string" },
            },
            required: ["jql"],
          },
        },
      ],
      invokeTool: async (name, { input }) => {
        host.jiraCalls++;
        assert.equal(name, "company_jira_search");
        assert.match(input.jql, /SPEND/);
        return {
          content: [
            new LanguageModelTextPart(
              JSON.stringify({
                issues: [
                  {
                    id: "1",
                    key: "SPEND-1",
                    summary: "Manager payment policy",
                    description: "Managers can approve bills.",
                    updated: "2026-09-10",
                    status: "Done",
                    comment: { comments: [], total: 0 },
                  },
                ],
                total: 1,
                start_at: 0,
              }),
            ),
          ],
        };
      },
      registerMcpServerDefinitionProvider: (_, p) => {
        host.mcp.push(p);
        return disposable();
      },
    },
  };
  const original = Module._load;
  Module._load = function (id, ...args) {
    if (id === "vscode") return vscode;
    return original.call(this, id, ...args);
  };
  const extension = createRequire(import.meta.url)(
    path.join(codeRoot, "dist/extension.cjs"),
  );
  const api = await extension.activate({
    extensionPath: codeRoot,
    subscriptions,
    workspaceState: {
      get: (k) => values.get(k),
      update: async (k, v) => values.set(k, v),
    },
  });
  let status;
  for (let i = 0; i < 150; i++) {
    status = JSON.parse(await readFile(path.join(meta, "progress.json")));
    if (["ready", "ready-with-gaps", "paused"].includes(status.phase)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(status.phase, "ready", JSON.stringify(status));
  assert.equal(status.repositories, 3);
  assert.ok(host.modelCalls > 0);
  assert.equal(host.jiraCalls, 1);
  assert.ok(
    status.jobs.some(
      (j) => j.stage === "estate-connections" && j.state === "completed",
    ),
  );
  assert.ok(
    status.jobs.some((j) => j.stage === "history" && j.state === "completed"),
  );
  assert.ok(
    status.jobs.some((j) => j.stage === "jira" && j.state === "completed"),
  );
  assert.equal(
    new Set(
      status.jobs.filter((j) => j.stage === "current").map((j) => j.sourceId),
    ).size,
    3,
  );
  const before = host.modelCalls;
  await api.start();
  assert.equal(
    host.modelCalls,
    before,
    "Unchanged setup must reuse completed interpretations",
  );
  const definitions = await host.mcp[0].provideMcpServerDefinitions();
  assert.equal(definitions.length, 1);
  const result = {
    at: new Date().toISOString(),
    passed: true,
    host: "controlled VS Code/model/Jira fixture",
    realSetupCommand: true,
    realServiceAndDatabase: true,
    repositories: 3,
    allConfiguredStagesCompleted: true,
    unchangedRerunModelCalls: host.modelCalls - before,
    modelCalls: host.modelCalls,
    uiProgressMessages: host.packets.length,
    jiraTool: "company-hosted offset JQL fixture",
    crossRepositoryStage: true,
  };
  await mkdir("verification", { recursive: true });
  await writeFile(
    "verification/portable-host.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const d of subscriptions) d.dispose?.();
  if (servicePid) {
    try {
      process.kill(servicePid, "SIGTERM");
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  await rm(dir, { recursive: true, force: true });
}
