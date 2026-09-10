import * as vscode from "vscode";
import path from "node:path";
import { readFile, mkdir, writeFile, open, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rpc as request } from "./client.js";
import { readJson, writeJson } from "./estate.js";
import { runEstate, activeJobs, type EstateManifest } from "./estate-runner.js";
import { jiraSearchTools, readJiraProject } from "./portable-jira.js";
import {
  GitHubIssuesConnector,
  GitHubBinding,
} from "./connectors/github-issues.js";
import { collectIssues } from "./connectors/collect.js";
export async function activatePortable(
  context: vscode.ExtensionContext,
  file: string,
) {
  if (!vscode.workspace.isTrusted)
    throw Error("Trust the estate workspace before running VR.");
  let m: EstateManifest = await readJson(file);
  if (m.version !== 1 || !m.repositories?.length || !path.isAbsolute(m.state))
    throw Error("Invalid VR estate manifest. Run the portable setup command.");
  const output = vscode.window.createOutputChannel("VR Estate Setup");
  context.subscriptions.push(output);
  const statusFile = path.join(path.dirname(file), "progress.json"),
    controlFile = path.join(path.dirname(file), "control.json");
  let panel: vscode.WebviewPanel | undefined,
    running = false,
    current: any,
    tokenSource: vscode.CancellationTokenSource | undefined;
  let starting: Promise<void> | undefined;
  const node = () =>
    vscode.workspace.getConfiguration("vrV1").get<string>("nodePath", "node");
  const runtime = () =>
    m.runtimeDirectory ?? path.join(context.extensionPath, "dist");
  const ensure = () =>
    (starting ??= (async () => {
      async function healthy() {
        try {
          const c = await readJson(path.join(m.state, "connection.json"));
          const r = await fetch(c.url + "/health", {
            headers: { Authorization: "Bearer " + c.readToken },
            signal: AbortSignal.timeout(1000),
          });
          return (
            r.ok && ((await r.json()) as any).version === "vr-portable-0.2.0"
          );
        } catch {
          return false;
        }
      }
      if (await healthy()) return;
      const log = await open(
        path.join(path.dirname(file), "service.log"),
        "a",
        0o600,
      );
      const child = spawn(
        node(),
        [path.join(runtime(), "cli.js"), "serve", m.state],
        {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: undefined,
            VR_DATABASE_URL: undefined,
            VR_SEMANTIC_SEARCH: m.semanticSearch ? "1" : "0",
          },
        },
      );
      child.unref();
      await log.close();
      for (let i = 0; i < 120; i++) {
        if (await healthy()) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw Error("VR service could not start. Check Node 24 and service.log.");
    })().catch((e) => {
      starting = undefined;
      throw e;
    }));
  const call = async (method: string, p: any = {}) => {
    await ensure();
    return request(m.state, method, p, true);
  };
  const overview = () => call("overview", { productId: m.productId });
  const update = async () => {
    if (panel)
      await panel.webview.postMessage({
        type: "overview",
        data: { ...(await overview()), onboarding: current },
      });
  };
  const report = async (event: any) => {
    current = {
      ...event,
      at: new Date().toISOString(),
      requestId: m.requestId,
    };
    if (
      ![
        "ready",
        "ready-with-gaps",
        "failed",
        "paused",
        "awaiting-model",
        "awaiting-jira",
      ].includes(event.phase)
    )
      current = { ...current, stage: event.phase, phase: "learning" };
    await writeJson(statusFile, current);
    output.appendLine(event.message);
    await update();
  };
  const invoke = async (name: string, input: any) => {
    const cancel = new vscode.CancellationTokenSource();
    const sub = tokenSource?.token.onCancellationRequested(() =>
      cancel.cancel(),
    );
    const timer = setTimeout(() => cancel.cancel(), 120000);
    try {
      const r = await vscode.lm.invokeTool(
        name,
        { input, toolInvocationToken: undefined },
        cancel.token,
      );
      const text = r.content
        .filter(
          (p): p is vscode.LanguageModelTextPart =>
            p instanceof vscode.LanguageModelTextPart,
        )
        .map((p) => p.value)
        .join("\n");
      if (text.length > 1500000)
        throw Error("Jira response too large; reduce page size.");
      return text;
    } finally {
      clearTimeout(timer);
      sub?.dispose();
      cancel.dispose();
    }
  };
  async function configureJira() {
    await report({
      phase: "awaiting-jira",
      message: "Checking existing Jira MCP tools in VS Code.",
    });
    let tools = jiraSearchTools(vscode.lm.tools);
    if (!tools.length) {
      await vscode.window.showWarningMessage(
        "VR cannot see a JQL search tool. Start your existing Jira MCP server, then choose Retry. Code learning can proceed without Jira.",
        "Retry",
        "Continue without Jira",
      );
      tools = jiraSearchTools(vscode.lm.tools);
    }
    if (!tools.length)
      throw Error(
        "Existing Jira MCP server exposes no supported JQL search tool. Start it and rerun setup.",
      );
    const saved = m.jira;
    const tool =
      tools.find((t) => t.name === saved?.searchTool) ??
      (tools.length === 1
        ? tools[0]
        : (
            await vscode.window.showQuickPick(
              tools.map((t) => ({
                label: t.name,
                description: t.description,
                tool: t,
              })),
              { title: "Select your existing Jira read-only JQL search tool" },
            )
          )?.tool);
    if (!tool) throw Error("Jira tool selection was cancelled.");
    const site =
      saved?.site ??
      (await vscode.window.showInputBox({
        prompt: "Your Jira site URL (Cloud or company-hosted)",
        ignoreFocusOut: true,
      }));
    const projects =
      saved?.projects ??
      (
        await vscode.window.showInputBox({
          prompt: "Jira project keys for Spend Management, separated by commas",
          ignoreFocusOut: true,
        })
      )
        ?.split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    if (!site || !projects?.length)
      throw Error("Jira site and project keys are required.");
    let cloudId = saved?.cloudId;
    if (tool.inputSchema.properties.cloudId && !cloudId) {
      const resourceName = tool.name.replace(
        /searchJiraIssuesUsingJql$/,
        "getAccessibleAtlassianResources",
      );
      if (vscode.lm.tools.some((t) => t.name === resourceName)) {
        const resources = JSON.parse(await invoke(resourceName, {}));
        cloudId = resources.find(
          (r: any) => r.url && new URL(r.url).origin === new URL(site).origin,
        )?.id;
      }
      if (!cloudId)
        cloudId = await vscode.window.showInputBox({
          prompt: "This Jira tool needs the Atlassian Cloud site ID",
          ignoreFocusOut: true,
        });
    }
    m.jira = { site, projects, searchTool: tool.name, cloudId };
    await writeJson(file, m);
    return tool;
  }
  async function collectJira() {
    const tool = await configureJira();
    let partial = false;
    for (const project of m.jira!.projects) {
      const collected = await readJiraProject(
        tool,
        { site: m.jira!.site, project, cloudId: m.jira!.cloudId },
        invoke,
      );
      await call("jira.import", {
        productId: m.productId,
        identity: `${m.jira!.site}/${project}`,
        items: collected.items,
        options: collected.options,
      });
      partial ||=
        collected.partial ||
        collected.items.some(
          (i: any) => i.metadata?.commentsComplete === false,
        );
    }
    return { partial };
  }
  async function collectGitHub() {
    if (!m.github?.length)
      throw Error(
        "No GitHub repositories configured; add github owner/repo entries to estate.json.",
      );
    let partial = false;
    const session = await vscode.authentication.getSession("github", ["repo"], {
      silent: true,
    });
    for (const b of m.github) {
      const result = await collectIssues(
        new GitHubIssuesConnector(GitHubBinding.parse(b), session?.accessToken),
      );
      if (result.state === "failed") throw Error(result.options.error);
      await call("github.import", {
        productId: m.productId,
        identity: `https://github.com/${b.owner}/${b.repo}`,
        items: result.items,
        options: result.options,
      });
      partial ||= result.state === "partial";
    }
    return { partial };
  }
  const openPanel = async () => {
    if (panel) {
      panel.reveal();
      await update();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      "vrV1.review",
      "VR · Estate setup",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, "dist")),
        ],
      },
    );
    const nonce = randomBytes(16).toString("hex");
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';"></head><body><div id="root"></div><script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "dist/ui.js")))}"></script></body></html>`;
    panel.onDidDispose(() => (panel = undefined));
    panel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          if (message.type === "ready") await update();
          if (message.type === "history")
            await panel?.webview.postMessage({
              type: "history",
              id: message.id,
              data: await call("reviews", {
                productId: m.productId,
                targetId: message.id,
              }),
            });
          if (message.type === "review") {
            let actor = context.workspaceState.get<any>("actor");
            if (!actor) {
              const name = await vscode.window.showInputBox({
                prompt: "Your name for the review history",
              });
              if (!name) return;
              actor = {
                id: name,
                name,
                type: "human",
                identityBasis: "self-reported",
              };
              await context.workspaceState.update("actor", actor);
            }
            await call("review", {
              ...message.input,
              productId: m.productId,
              actor,
            });
            await update();
          }
          if (message.type === "investigate") {
            await call("investigate", {
              productId: m.productId,
              questionId: message.id,
              budget: 4,
            });
            await update();
          }
          if (message.type === "evidence") {
            const d = await vscode.workspace.openTextDocument({
              content: JSON.stringify(
                await call("vr_evidence", {
                  productId: m.productId,
                  ids: message.ids,
                }),
                null,
                2,
              ),
              language: "json",
            });
            await vscode.window.showTextDocument(d, vscode.ViewColumn.Beside);
          }
        } catch (e) {
          await panel?.webview.postMessage({
            type: "error",
            message: String(e),
          });
        }
      },
      undefined,
      context.subscriptions,
    );
    await update();
  };
  async function chooseModel() {
    const saved = context.workspaceState.get<any>("model");
    const models = await vscode.lm.selectChatModels(saved ?? {});
    if (saved && models.length) return models[0];
    const all = models.length ? models : await vscode.lm.selectChatModels({});
    if (!all.length)
      throw Error(
        "No VS Code language models are available. Sign into your approved Copilot account and resume setup.",
      );
    await report({
      phase: "awaiting-model",
      message: "Choose your work-approved understanding model in VS Code.",
    });
    const choice = await vscode.window.showQuickPick(
      all.map((model) => ({
        label: model.name,
        description: model.vendor,
        model,
      })),
      {
        title:
          "VR understanding model — source excerpts will be sent through this provider",
        ignoreFocusOut: true,
      },
    );
    if (!choice) throw Error("Model selection cancelled.");
    await context.workspaceState.update("model", {
      vendor: choice.model.vendor,
      id: choice.model.id,
    });
    return choice.model;
  }
  const start = async () => {
    if (running) return;
    running = true;
    m = await readJson(file);
    tokenSource = new vscode.CancellationTokenSource();
    const owner = path.join(m.state, "understanding.lock");
    let owns = false;
    try {
      const prior = await readJson(owner).catch(() => null);
      if (prior) {
        try {
          process.kill(prior.pid, 0);
          throw Error("Another VS Code window is learning this estate.");
        } catch (e: any) {
          if (e.code !== "ESRCH") throw e;
          await unlink(owner);
        }
      }
      const lock = await open(owner, "wx", 0o600);
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, requestId: m.requestId }),
      );
      await lock.close();
      owns = true;
      await call("retrieval.configure", { semantic: m.semanticSearch });
      for (const repo of m.repositories)
        await call("pipeline.configure", {
          sourceId: repo.sourceId,
          pipeline: { version: 1, stages: m.stages },
        });
      await writeJson(controlFile, { requestId: m.requestId, cancel: false });
      await openPanel();
      output.show(true);
      const model = await chooseModel();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "VR: setting up " + m.name,
          cancellable: true,
        },
        async (progress, token) => {
          const sub = token.onCancellationRequested(() =>
            tokenSource?.cancel(),
          );
          try {
            return await runEstate(m, call, {
              model: `${model.vendor}/${model.id}/${model.version}`,
              cancelled: () => tokenSource!.token.isCancellationRequested,
              report: async (e) => {
                progress.report({ message: e.message });
                await report(e);
              },
              collectJira,
              collectGitHub,
              interpret: async (_batch, prepared) => {
                const tokens = await model.countTokens(
                  prepared.prompt,
                  tokenSource!.token,
                );
                if (tokens > model.maxInputTokens - 6000)
                  throw Error(
                    "Selected model context is too small; choose a larger-context model.",
                  );
                const cancel = new vscode.CancellationTokenSource();
                const subscription = tokenSource!.token.onCancellationRequested(
                  () => cancel.cancel(),
                );
                const timer = setTimeout(() => cancel.cancel(), 240000);
                try {
                  let text = "";
                  const response = await model.sendRequest(
                    [vscode.LanguageModelChatMessage.User(prepared.prompt)],
                    {},
                    cancel.token,
                  );
                  for await (const part of response.text) {
                    text += part;
                    if (text.length > 180000)
                      throw Error("Model response too large.");
                  }
                  if (cancel.token.isCancellationRequested)
                    throw Error("Model request cancelled or timed out.");
                  return { text, tokens };
                } finally {
                  clearTimeout(timer);
                  subscription.dispose();
                  cancel.dispose();
                }
              },
            });
          } finally {
            sub.dispose();
          }
        },
      );
      await context.workspaceState.update("lastRequest", m.requestId);
    } catch (e) {
      if (!owns) {
        output.appendLine(String(e));
        return;
      }
      await report({
        phase: "paused",
        message:
          String(e) +
          " Completed work is retained. Run the same setup command or VR: Learn or Resume Estate.",
        jobs: activeJobs(await overview()),
      });
    } finally {
      if (owns) await unlink(owner).catch(() => {});
      tokenSource?.dispose();
      running = false;
    }
  };
  const register = (id: string, fn: () => Promise<unknown>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () =>
        fn().catch((e) => vscode.window.showErrorMessage(String(e))),
      ),
    );
  register("vrV1.learn", start);
  register("vrV1.setup", start);
  register("vrV1.review", openPanel);
  register("vrV1.model", async () => {
    await context.workspaceState.update("model", undefined);
    return chooseModel();
  });
  register("vrV1.jira", collectJira);
  register("vrV1.github", collectGitHub);
  register("vrV1.configure", async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
  });
  register("vrV1.refresh", async () => {
    for (const r of m.repositories)
      await call("refresh", { sourceId: r.sourceId });
    await report({
      phase: "paused",
      message:
        "Changed code collected. Run VR: Learn or Resume Estate to update interpretations.",
    });
  });
  register("vrV1.context", async () => {
    const task = await vscode.window.showInputBox({
      prompt: "What are you changing or trying to understand?",
    });
    if (!task) return;
    const buffers = Object.fromEntries(
      vscode.workspace.textDocuments
        .filter((d) => d.isDirty && d.uri.scheme === "file")
        .map((d) => [d.uri.fsPath, d.getText()]),
    );
    const packet = await call("vr_context", {
      productId: m.productId,
      task,
      buffers,
    });
    const doc = await vscode.workspace.openTextDocument({
      content: JSON.stringify(packet, null, 2),
      language: "json",
    });
    await vscode.window.showTextDocument(doc);
  });
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("vr-v1.mcp", {
      provideMcpServerDefinitions: async () => {
        await ensure();
        return [
          new vscode.McpStdioServerDefinition(
            "VR Product Knowledge",
            node(),
            [path.join(runtime(), "mcp.js")],
            { VR_STATE_DIRECTORY: m.state, VR_PRODUCT_ID: m.productId },
            "0.2.0",
          ),
        ];
      },
    }),
  );
  const timer = setInterval(
    () =>
      void (async () => {
        const control = await readJson(controlFile).catch(() => null);
        if (control?.requestId === m.requestId && control.cancel)
          tokenSource?.cancel();
        if (running && current)
          await writeJson(path.join(path.dirname(file), "heartbeat.json"), {
            requestId: m.requestId,
            pid: process.pid,
            at: new Date().toISOString(),
          });
      })().catch((e) => output.appendLine(String(e))),
    2000,
  );
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      tokenSource?.cancel();
    },
  });
  const poll = setInterval(() => {
    if (!running)
      for (const r of m.repositories)
        void call("remote.poll", { sourceId: r.sourceId }).catch((e) =>
          output.appendLine(String(e)),
        );
  }, 600000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  await ensure();
  if (context.workspaceState.get("lastRequest") !== m.requestId) void start();
  else {
    current = await readJson(statusFile).catch(() => undefined);
    await openPanel();
  }
  return { start, overview, collectJira, openPanel, call, manifest: () => m };
}
