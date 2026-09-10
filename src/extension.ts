import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { rpc as request } from "./client.js";
import { preparePrompt } from "./learning.js";
import {
  JiraMcpConnector,
  decodeJiraPayload,
  type JiraBinding,
} from "./connectors/jira.js";
import { isJiraSearchTool, jiraToolReader } from "./jira-tools.js";
import { PipelineConfig } from "./pipeline.js";
import {
  GitHubBinding,
  GitHubIssuesConnector,
} from "./connectors/github-issues.js";
import { collectIssues } from "./connectors/collect.js";
import { advancePipeline } from "./orchestration.js";
import { activatePortable } from "./portable-extension.js";
export async function activate(context: vscode.ExtensionContext) {
  const portable = vscode.workspace
    .getConfiguration("vrV1")
    .get<string>("portableConfig");
  if (portable) return activatePortable(context, portable);
  const output = vscode.window.createOutputChannel("VR Product Knowledge"),
    state = path.join(context.globalStorageUri.fsPath, "state");
  context.subscriptions.push(output);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const config = () => vscode.workspace.getConfiguration("vrV1"),
    node = () => config().get<string>("nodePath", "node");
  let child: ChildProcess | undefined,
    startup: Promise<void> | undefined,
    running = false,
    panel: vscode.WebviewPanel | undefined;
  let binding = context.workspaceState.get<{
    productId: string;
    sourceId: string;
    root: string;
  }>("estate");
  const ensure = () =>
    (startup ??= (async () => {
      try {
        const c = JSON.parse(
          await readFile(path.join(state, "connection.json"), "utf8"),
        );
        const h = await fetch(c.url + "/health", {
          headers: { Authorization: `Bearer ${c.readToken}` },
          signal: AbortSignal.timeout(1000),
        });
        if (h.ok && ((await h.json()) as any).version === "vr-portable-0.2.0")
          return;
      } catch {}
      child = spawn(
        node(),
        [path.join(context.extensionPath, "dist/cli.js"), "serve", state],
        {
          cwd: context.extensionPath,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: undefined,
            VR_MAX_AUTO_INVESTIGATIONS: String(
              config().get<number>("maxAutomaticInvestigations", 12),
            ),
            VR_SEMANTIC_SEARCH: config().get<boolean>("semanticSearch", true)
              ? "1"
              : "0",
          },
        },
      );
      child.stderr?.on("data", (d) => output.appendLine(d.toString()));
      let failure = "";
      child.on("error", (e) => {
        failure = e.message;
      });
      child.on("exit", (code) => {
        failure = `Service exited: ${code}`;
        startup = undefined;
      });
      for (let i = 0; i < 150; i++) {
        if (failure) throw Error(failure);
        try {
          const c = JSON.parse(
            await readFile(path.join(state, "connection.json"), "utf8"),
          );
          if (
            c.pid === child.pid &&
            (
              await fetch(c.url + "/health", {
                headers: { Authorization: `Bearer ${c.readToken}` },
                signal: AbortSignal.timeout(500),
              })
            ).ok
          )
            return;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      throw Error("VR service failed to start; check the Node 24 path.");
    })());
  const rpc = async (method: string, p: Record<string, any> = {}) => {
    await ensure();
    try {
      return await request(state, method, p, true);
    } catch (e) {
      if (e instanceof TypeError && String(e).includes("fetch failed")) {
        startup = undefined;
        await ensure();
        return request(state, method, p, true);
      }
      throw e;
    }
  };
  const estate = () => {
    if (!binding) throw Error("Run VR: Set Up This Estate first");
    return binding;
  };
  const overview = () => rpc("overview", { productId: estate().productId });
  const update = async () => {
    if (panel && binding)
      await panel.webview.postMessage({
        type: "overview",
        data: await overview(),
      });
  };
  const events = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    events,
    vscode.lm.registerMcpServerDefinitionProvider("vr-v1.mcp", {
      onDidChangeMcpServerDefinitions: events.event,
      provideMcpServerDefinitions: async () => {
        if (!binding) return [];
        await ensure();
        return [
          new vscode.McpStdioServerDefinition(
            "VR Product Knowledge",
            node(),
            [path.join(context.extensionPath, "dist/mcp.js")],
            {
              VR_STATE_DIRECTORY: state,
              VR_PRODUCT_ID: binding.productId,
              VR_WORKSPACE_ROOT: binding.root,
            },
            "0.1.0",
          ),
        ];
      },
    }),
  );
  const installDelivery = async (root: string) => {
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'",
      command = [
        node(),
        path.join(context.extensionPath, "dist/hook.js"),
        state,
        estate().productId,
        root,
      ]
        .map(quote)
        .join(" ");
    await mkdir(path.join(root, ".github/hooks"), { recursive: true });
    await writeFile(
      path.join(root, ".github/hooks/vr-context.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ type: "command", command, timeout: 15 }],
            PreToolUse: [{ type: "command", command, timeout: 30 }],
          },
        },
        null,
        2,
      ),
    );
  };
  const readEstateConfig = async () => {
    const e = estate();
    try {
      return JSON.parse(
        await readFile(path.join(e.root, ".vr/config.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  const applyPipeline = async () => {
    const file = await readEstateConfig();
    const pipeline = PipelineConfig.parse(file.pipeline ?? {});
    await rpc("pipeline.configure", { sourceId: estate().sourceId, pipeline });
    return { file, pipeline };
  };
  const setup = async (
    root?: string,
    name?: string,
    exclude: string[] = [],
  ) => {
    if (!vscode.workspace.isTrusted)
      throw Error("Trust this workspace before setup");
    root ??= vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw Error("Open the code estate in a VS Code workspace");
    const result = await rpc("connect", {
      name: name ?? path.basename(root),
      root,
      exclude,
    });
    binding = { ...result, root };
    await context.workspaceState.update("estate", binding);
    await mkdir(path.join(root, ".vr"), { recursive: true });
    const previous = await readEstateConfig();
    await writeFile(
      path.join(root, ".vr/config.json"),
      JSON.stringify(
        {
          ...previous,
          schemaVersion: 1,
          ...binding,
          exclude,
          pipeline: PipelineConfig.parse(previous.pipeline ?? {}),
        },
        null,
        2,
      ),
    );
    await applyPipeline();
    const scan = await rpc("refresh", { sourceId: binding!.sourceId });
    await installDelivery(root);
    events.fire();
    return { ...binding, ...scan };
  };
  const chooseModel = async () => {
    const models = await vscode.lm.selectChatModels({});
    const choice = await vscode.window.showQuickPick(
      models.map((model) => ({
        label: model.name,
        description: `${model.vendor}/${model.id}`,
        model,
      })),
      { title: "Choose VR’s understanding model" },
    );
    if (choice)
      await context.workspaceState.update("model", {
        vendor: choice.model.vendor,
        id: choice.model.id,
      });
    return choice?.model;
  };
  const learn = async (
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
    progress: (text: string) => void,
    maxCalls = config().get<number>("maxModelCalls", 200),
  ) => {
    if (running) throw Error("A learning session is already running");
    running = true;
    let calls = 0,
      failures = 0,
      overlayQueued = false;
    const e = estate(),
      attempted = new Set<string>();
    const advance = async () =>
      advancePipeline(await overview(), e.sourceId, attempted, {
        history: () =>
          rpc("history", {
            sourceId: e.sourceId,
            years: config().get<number>("historyYears", 1),
          }),
        collect: async (stage) => {
          if (stage === "github-issues") return syncGitHub(undefined, token);
          const file = await readEstateConfig(),
            b = file.jira ?? context.workspaceState.get<JiraBinding>("jira");
          if (!b)
            return rpc("source.status", {
              sourceId: e.sourceId,
              stage,
              status: { state: "not-configured" },
            });
          return syncJira(b, token);
        },
        failed: async (stage, error) => {
          progress(`${stage} unavailable; continuing other enabled sources.`);
          return rpc("source.status", {
            sourceId: e.sourceId,
            stage,
            status: { state: "failed", error },
          });
        },
      });
    try {
      await applyPipeline();
      await rpc("refresh", { sourceId: e.sourceId });
      while (calls < maxCalls && !token.isCancellationRequested) {
        await advance();
        const batch = await rpc("learn.next", {
          productId: e.productId,
          model: `${model.vendor}/${model.id}/${model.version}`,
          charBudget: Math.max(
            10000,
            Math.min(
              failures ? 18000 : 44000,
              (model.maxInputTokens - 10000) * 2,
            ),
          ),
        });
        if (batch.waiting) {
          if (await advance()) continue;
          progress(batch.reason);
          break;
        }
        if (batch.done) {
          if (await advance()) continue;
          if (!overlayQueued) {
            overlayQueued = true;
            const local = await rpc("overlay.queue", { sourceId: e.sourceId });
            if (!local.unchanged) {
              progress(
                "Interpreting the changed worktree and affected consumers…",
              );
              continue;
            }
          }
          break;
        }
        const prepared = preparePrompt(batch),
          tokens = await model.countTokens(prepared.prompt, token);
        if (tokens > model.maxInputTokens - 6000) {
          await rpc("learn.fail", {
            batchId: batch.batchId,
            error: "Input exceeds selected model context",
          });
          throw Error("Selected model context is too small for this batch");
        }
        await rpc("learn.request", {
          batchId: batch.batchId,
          prompt: prepared.prompt,
          promptVersion: "vr-understanding-2",
          inputTokens: tokens,
        });
        calls++;
        progress(`${batch.stage}: model call ${calls}/${maxCalls}`);
        let text = "";
        const cancel = new vscode.CancellationTokenSource(),
          subscription = token.onCancellationRequested(() => cancel.cancel()),
          timer = setTimeout(() => cancel.cancel(), 240000);
        try {
          const response = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User(prepared.prompt)],
            {},
            cancel.token,
          );
          for await (const part of response.text) {
            text += part;
            if (text.length > 180000) throw Error("Model output too large");
          }
          if (cancel.token.isCancellationRequested)
            throw Error("Model call cancelled or timed out");
          await rpc("learn.response", {
            batchId: batch.batchId,
            text,
            inputTokens: tokens,
          });
          await rpc("learn.publish", {
            batchId: batch.batchId,
            proposal: prepared.resolve(text),
            inputTokens: tokens,
            outputChars: text.length,
          });
          failures = 0;
        } catch (error) {
          await rpc("learn.fail", {
            batchId: batch.batchId,
            error: String(error),
          });
          failures++;
          if (
            cancel.token.isCancellationRequested ||
            /quota|rate.limit|authentication|unauthorized|consent/i.test(
              String(error),
            ) ||
            failures >= 3
          )
            throw error;
          progress(
            "Retrying an incomplete model response with a smaller batch.",
          );
        } finally {
          clearTimeout(timer);
          subscription.dispose();
          cancel.dispose();
        }
        await update();
      }
      if (
        !token.isCancellationRequested &&
        config().get<boolean>("semanticSearch", true)
      ) {
        progress("Updating local semantic search…");
        for (let i = 0; i < 100; i++) {
          const indexed = await rpc("index", {
            productId: e.productId,
            limit: 100,
          });
          if (!indexed.remaining || !indexed.indexed) break;
          if (token.isCancellationRequested) break;
        }
      }
      return {
        calls,
        cancelled: token.isCancellationRequested,
        budgetExhausted: calls >= maxCalls,
        overview: await overview(),
      };
    } finally {
      running = false;
      await update();
    }
  };
  const syncJira = async (b: JiraBinding, token?: vscode.CancellationToken) => {
    const { pipeline } = await applyPipeline();
    if (!pipeline.stages.jira) return { disabled: true, stage: "jira" };
    await context.workspaceState.update("jira", b);
    try {
      const invoke = async (name: string, input: Record<string, unknown>) => {
        const cancel = new vscode.CancellationTokenSource();
        const subscription = token?.onCancellationRequested(() =>
          cancel.cancel(),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (token?.isCancellationRequested)
            throw Error("Jira collection cancelled");
          const result = await Promise.race([
            vscode.lm.invokeTool(
              name,
              { input, toolInvocationToken: undefined },
              cancel.token,
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                cancel.cancel();
                reject(Error("Jira MCP read timed out after 30 seconds"));
              }, 30000);
            }),
          ]);
          return result.content
            .filter(
              (p): p is vscode.LanguageModelTextPart =>
                p instanceof vscode.LanguageModelTextPart,
            )
            .map((p) => p.value)
            .join("\n");
        } finally {
          if (timer) clearTimeout(timer);
          subscription?.dispose();
          cancel.dispose();
        }
      };
      const resourceName = b.searchTool.replace(
          /searchJiraIssuesUsingJql$/,
          "getAccessibleAtlassianResources",
        ),
        resources = decodeJiraPayload(await invoke(resourceName, {}));
      if (!Array.isArray(resources))
        throw Error("Atlassian site discovery failed");
      const resource = resources.find(
        (r) => r.url && new URL(r.url).origin === new URL(b.site).origin,
      );
      if (!resource) throw Error("Configured Jira site is not accessible");
      b.cloudId = resource.id;
      const connector = new JiraMcpConnector(
        jiraToolReader(vscode.lm.tools, b.searchTool, invoke),
        b,
      );
      const collected = await collectIssues(connector);
      if (collected.state === "failed") throw Error(collected.options.error);
      const result = await rpc("jira.import", {
        productId: estate().productId,
        identity: `${b.site}/${b.projectKey}`,
        items: collected.items,
        options: collected.options,
      });
      await context.workspaceState.update("jira", b);
      await update();
      return result;
    } catch (error) {
      await rpc("source.status", {
        sourceId: estate().sourceId,
        stage: "jira",
        status: { state: "failed", error: String(error) },
      });
      output.appendLine(
        `Jira read failed; code and history retained: ${error}`,
      );
      return { stage: "jira", state: "failed", error: String(error) };
    }
  };
  const syncGitHub = async (
    requested?: GitHubBinding,
    token?: vscode.CancellationToken,
  ) => {
    const { file, pipeline } = await applyPipeline();
    if (!pipeline.stages.githubIssues)
      return { disabled: true, stage: "github-issues" };
    if (!requested && !file.githubIssues)
      return rpc("source.status", {
        sourceId: estate().sourceId,
        stage: "github-issues",
        status: { state: "not-configured" },
      });
    try {
      if (token?.isCancellationRequested)
        throw Error("GitHub collection cancelled");
      const b = GitHubBinding.parse(requested ?? file.githubIssues);
      // Reuse an existing authorized session when available; no token is persisted by VR.
      const session = await vscode.authentication
        .getSession("github", ["repo"], { silent: true })
        .then(
          (value) => value,
          () => undefined,
        );
      const collected = await collectIssues(
        new GitHubIssuesConnector(b, session?.accessToken),
        b.maxPages,
      );
      if (token?.isCancellationRequested)
        throw Error("GitHub collection cancelled");
      if (collected.state === "failed") throw Error(collected.options.error);
      const result = await rpc("github.import", {
        productId: estate().productId,
        identity: `https://github.com/${b.owner}/${b.repo}`,
        items: collected.items,
        options: collected.options,
      });
      await update();
      return result;
    } catch (error) {
      await rpc("source.status", {
        sourceId: estate().sourceId,
        stage: "github-issues",
        status: { state: "failed", error: String(error) },
      });
      output.appendLine(
        `GitHub read failed; prior evidence retained: ${error}`,
      );
      return { stage: "github-issues", state: "failed", error: String(error) };
    }
  };
  const taskContext = async (task: string, focusPaths: string[] = []) => {
    const e = estate(),
      buffers: Record<string, string> = {};
    for (const d of vscode.workspace.textDocuments)
      if (
        d.isDirty &&
        d.uri.scheme === "file" &&
        d.uri.fsPath.startsWith(e.root + path.sep)
      )
        buffers[path.relative(e.root, d.uri.fsPath)] = d.getText();
    return rpc("vr_context", {
      productId: e.productId,
      task,
      focusPaths,
      workspaceRoot: e.root,
      buffers,
    });
  };
  const openPanel = async () => {
    if (panel) {
      panel.reveal();
      await update();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      "vrV1.review",
      "VR · Product knowledge",
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
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          if (message.type === "ready") await update();
          else if (message.type === "review") {
            const saved = context.workspaceState.get<any>("actor");
            let actor = saved;
            if (!actor) {
              const name = await vscode.window.showInputBox({
                prompt: "Your name for the permanent review history",
              });
              if (!name) return;
              const id = await vscode.window.showInputBox({
                prompt:
                  "Your stable work identity (for example your work email)",
              });
              if (!id) return;
              actor = {
                id,
                name,
                type: "human",
                identityBasis: "self-reported",
              };
              await context.workspaceState.update("actor", actor);
            }
            await rpc("review", {
              ...message.input,
              productId: estate().productId,
              actor,
            });
            await update();
          } else if (message.type === "investigate") {
            await rpc("investigate", {
              productId: estate().productId,
              questionId: message.id,
              budget: 4,
            });
            await update();
          } else if (message.type === "history")
            await panel?.webview.postMessage({
              type: "history",
              id: message.id,
              data: await rpc("reviews", {
                productId: estate().productId,
                targetId: message.id,
              }),
            });
          else if (message.type === "evidence") {
            const result = await rpc("vr_evidence", {
              productId: estate().productId,
              ids: message.ids,
            });
            const doc = await vscode.workspace.openTextDocument({
              content: JSON.stringify(result, null, 2),
              language: "json",
            });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
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
  };
  const command = (id: string, fn: () => Promise<unknown>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () =>
        fn().catch((e) => {
          output.appendLine(String(e));
          void vscode.window.showErrorMessage(String(e));
        }),
      ),
    );
  command("vrV1.setup", async () => {
    await setup();
    await openPanel();
  });
  command("vrV1.model", chooseModel);
  command("vrV1.review", openPanel);
  command("vrV1.learn", async () => {
    const selected = context.workspaceState.get<any>("model"),
      model = selected
        ? (await vscode.lm.selectChatModels(selected))[0]
        : await chooseModel();
    if (!model) return;
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `VR: understanding with ${model.name}`,
        cancellable: true,
      },
      (progress, token) =>
        learn(model, token, (text) => progress.report({ message: text })),
    );
  });
  command("vrV1.configure", async () => {
    const e = estate(),
      file = await readEstateConfig(),
      pipeline = PipelineConfig.parse(file.pipeline ?? {});
    const labels = {
      currentCode: "1. Current code",
      historicalCode: "2. Historical code",
      jira: "3. Jira",
      githubIssues: "4. GitHub issues",
    };
    const choices = await vscode.window.showQuickPick(
      Object.entries(labels).map(([key, label]) => ({
        label,
        key,
        picked: pipeline.stages[key as keyof typeof pipeline.stages],
      })),
      { canPickMany: true, title: "Choose VR understanding stages" },
    );
    if (!choices) return;
    for (const key of Object.keys(pipeline.stages) as Array<
      keyof typeof pipeline.stages
    >)
      pipeline.stages[key] = choices.some((c) => c.key === key);
    if (pipeline.stages.githubIssues && !file.githubIssues) {
      const repository = await vscode.window.showInputBox({
        prompt: "GitHub repository (owner/repository)",
      });
      if (!repository) return;
      const [owner, repo, ...extra] = repository.trim().split("/");
      if (extra.length) throw Error("Use owner/repository");
      file.githubIssues = GitHubBinding.parse({ owner, repo });
    }
    await writeFile(
      path.join(e.root, ".vr/config.json"),
      JSON.stringify({ ...file, pipeline }, null, 2),
    );
    await applyPipeline();
    await update();
  });
  command("vrV1.github", () => syncGitHub());
  command("vrV1.refresh", async () => {
    await applyPipeline();
    const r = await rpc("refresh", { sourceId: estate().sourceId });
    await update();
    return r;
  });
  command("vrV1.context", async () => {
    const task = await vscode.window.showInputBox({
      prompt: "What are you changing or trying to understand?",
    });
    if (!task) return;
    const packet = await taskContext(task);
    const doc = await vscode.workspace.openTextDocument({
      content: JSON.stringify(packet, null, 2),
      language: "json",
    });
    await vscode.window.showTextDocument(doc);
  });
  command("vrV1.jira", async () => {
    if (!(await applyPipeline()).pipeline.stages.jira)
      return { disabled: true };
    const saved = context.workspaceState.get<JiraBinding>("jira"),
      site =
        saved?.site ??
        (await vscode.window.showInputBox({ prompt: "Jira site URL" }));
    if (!site) return;
    const projectKey =
      saved?.projectKey ??
      (await vscode.window.showInputBox({ prompt: "Jira project key" }));
    if (!projectKey) return;
    const tools = vscode.lm.tools.filter(isJiraSearchTool);
    if (!tools.length)
      throw Error("Start your authorized Atlassian MCP server in VS Code");
    return syncJira({
      site,
      projectKey,
      searchTool: tools[0].name,
      pageSize: 50,
    });
  });
  const poll = setInterval(
    () => {
      if (binding)
        void rpc("remote.poll", { sourceId: binding.sourceId }).catch((e) =>
          output.appendLine(`Remote check: ${e}`),
        );
    },
    config().get<number>("remotePollMinutes", 10) * 60000,
  );
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  if (!binding) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root)
      try {
        const file = JSON.parse(
          await readFile(path.join(root, ".vr/config.json"), "utf8"),
        );
        binding = { productId: file.productId, sourceId: file.sourceId, root };
      } catch {}
  }
  return {
    setup,
    learn,
    syncJira,
    syncGitHub,
    applyPipeline,
    overview,
    taskContext,
    rpc,
    openPanel,
    state,
    estate: () => binding,
    models: async () =>
      (await vscode.lm.selectChatModels({})).map((m) => ({
        id: m.id,
        vendor: m.vendor,
        version: m.version,
        maxInputTokens: m.maxInputTokens,
      })),
    tools: () =>
      vscode.lm.tools.map((t) => ({
        name: t.name,
        inputSchema: t.inputSchema,
      })),
  };
}
