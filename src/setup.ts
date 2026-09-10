import { spawn, execFileSync } from "node:child_process";
import {
  open,
  mkdir,
  access,
  readFile,
  unlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discoverRepositories, readJson, writeJson } from "./estate.js";
import { rpc } from "./client.js";
import type { EstateManifest } from "./estate-runner.js";
const args = process.argv.slice(2),
  option = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
const positional = args.filter(
  (a, i) =>
    !a.startsWith("--") &&
    (i === 0 ||
      !args[i - 1].startsWith("--") ||
      ["--status", "--scan-only", "--no-open"].includes(args[i - 1])),
)[0];
if (args.includes("--help") || !positional) {
  console.log(
    `VR portable estate setup\n\nnpm run setup -- /absolute/path/to/estate\n\nOptions:\n --history-years N  History window (default 1)\n --max-calls N      Calls per session (default 2000)\n --jira off        Skip Jira (default: reuse VS Code MCP)\n --semantic off    Use lexical search without model downloads\n --scan-only       Discover, create database and scan; no model calls\n --no-open         Prepare files without launching VS Code\n --code PATH       VS Code executable\n --status          Print saved setup status\n\nRerun the same command to refresh changed inputs and resume. No customer dependencies are installed or executed.`,
  );
  process.exit(args.includes("--help") || positional ? 0 : 1);
}
const root = await realpath(path.resolve(positional)),
  meta = path.join(root, ".vr-estate"),
  manifestPath = path.join(meta, "estate.json"),
  statusFile = path.join(meta, "progress.json");
if (args.includes("--status")) {
  console.log(JSON.stringify(await readJson(statusFile), null, 2));
  process.exit(0);
}
if (Number(process.versions.node.split(".")[0]) < 24)
  throw Error("VR requires Node.js 24 or later.");
await mkdir(meta, { recursive: true, mode: 0o700 });
const lockFile = path.join(meta, "setup.lock");
try {
  const old = await readJson(lockFile);
  try {
    process.kill(old.pid, 0);
    throw Error("Setup is already running for this estate.");
  } catch (e: any) {
    if (e.code !== "ESRCH") throw e;
    await unlink(lockFile);
  }
} catch (e: any) {
  if (e.code !== "ENOENT") throw e;
}
const lock = await open(lockFile, "wx", 0o600);
await lock.writeFile(JSON.stringify({ pid: process.pid }));
await lock.close();
let manifest: EstateManifest | undefined;
let otherWorker = false;
const log = async (phase: string, message: string, extra = {}) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
  await writeJson(statusFile, {
    at: new Date().toISOString(),
    phase,
    message,
    ...extra,
  });
};
const stop = async () => {
  if (manifest)
    await writeJson(path.join(meta, "control.json"), {
      requestId: manifest.requestId,
      cancel: true,
    });
  await unlink(lockFile).catch(() => {});
  console.log(
    "\nStopped waiting. Cancellation requested; completed knowledge is saved.",
  );
  process.exit(130);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  let previous: EstateManifest | undefined;
  try {
    previous = await readJson(manifestPath);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  if (previous) {
    const owner = await readJson(
      path.join(previous.state, "understanding.lock"),
    ).catch(() => null);
    if (owner) {
      try {
        process.kill(owner.pid, 0);
        otherWorker = true;
        throw Error(
          "VS Code is still learning this estate. Cancel its progress notification before restarting setup.",
        );
      } catch (e: any) {
        if (e.code !== "ESRCH") throw e;
      }
    }
  }
  await log("discovery", "Discovering Git repositories under " + root);
  const discovered = await discoverRepositories(root);
  const state = previous?.state ?? path.join(meta, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  async function healthy() {
    try {
      const c = await readJson(path.join(state, "connection.json"));
      const r = await fetch(c.url + "/health", {
        headers: { Authorization: "Bearer " + c.readToken },
        signal: AbortSignal.timeout(1000),
      });
      return r.ok && ((await r.json()) as any).version === "vr-portable-0.2.0";
    } catch {
      return false;
    }
  }
  if (!(await healthy())) {
    const fd = await open(path.join(meta, "service.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "cli.js"), "serve", state],
      {
        detached: true,
        stdio: ["ignore", fd.fd, fd.fd],
        env: {
          ...process.env,
          VR_DATABASE_URL: undefined,
          VR_SEMANTIC_SEARCH:
            option(
              "--semantic",
              previous?.semanticSearch === false ? "off" : "on",
            ) === "off"
              ? "0"
              : "1",
        },
      },
    );
    child.unref();
    await fd.close();
    let ok = false;
    for (let i = 0; i < 120; i++) {
      if (await healthy()) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ok)
      throw Error(
        "Local database service did not start. See .vr-estate/service.log.",
      );
  }
  const call = (method: string, params: any = {}) =>
    rpc(state, method, params, true);
  await call("retrieval.configure", {
    semantic:
      option(
        "--semantic",
        previous?.semanticSearch === false ? "off" : "on",
      ) !== "off",
  });
  let productId = previous?.productId;
  const repositories: EstateManifest["repositories"] = [];
  const stages = {
    currentCode: true,
    historicalCode:
      Number(option("--history-years", String(previous?.historyYears ?? 1))) >
      0,
    jira:
      option("--jira", previous?.stages.jira === false ? "off" : "on") !==
      "off",
    githubIssues: previous?.stages.githubIssues ?? false,
  };
  const years = Number(
      option("--history-years", String(previous?.historyYears ?? 1)),
    ),
    maxCalls = Number(
      option("--max-calls", String(previous?.maxCalls ?? 2000)),
    );
  if (
    !Number.isFinite(years) ||
    years < 0 ||
    years > 100 ||
    !Number.isInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 10000
  )
    throw Error("Use history years 0–100 and max calls 1–10000.");
  for (const repo of discovered.repositories) {
    await log(
      "scan",
      `Scanning repository ${repositories.length + 1}/${discovered.repositories.length}: ${path.relative(root, repo) || "."}`,
    );
    const ids = await call("connect", {
      name: previous?.name ?? path.basename(root),
      root: repo,
      productId,
    });
    productId = ids.productId;
    repositories.push({ root: repo, sourceId: ids.sourceId });
    await call("pipeline.configure", {
      sourceId: ids.sourceId,
      pipeline: { version: 1, stages },
    });
    const scan = await call("refresh", { sourceId: ids.sourceId });
    if (scan.coverage?.nonTextFiles?.length) {
      const files: string[] = scan.coverage.nonTextFiles;
      console.log(
        `  Skipped ${files.length} file(s) containing NUL characters (binary data or unsupported text encoding). Exclusions are recorded in the database.`,
      );
      for (const file of files.slice(0, 10)) console.log(`    ${file}`);
      if (files.length > 10)
        console.log(`    ... and ${files.length - 10} more`);
    }
    if (scan.coverage?.errors?.length)
      throw Error("Source scan has errors: " + scan.coverage.errors.join("; "));
  }
  const discoveredIds = new Set(repositories.map((r) => r.sourceId));
  if (previous?.repositories.some((r) => !discoveredIds.has(r.sourceId)))
    throw Error(
      "A previously registered repository is missing. Restore it before resuming; VR will not silently drop its knowledge.",
    );
  manifest = {
    version: 1,
    runtimeDirectory: import.meta.dirname,
    root,
    name: previous?.name ?? path.basename(root),
    productId: productId!,
    state,
    repositories,
    historyYears: years,
    maxCalls,
    semanticSearch:
      option(
        "--semantic",
        previous?.semanticSearch === false ? "off" : "on",
      ) !== "off",
    stages,
    jira: previous?.jira,
    github: previous?.github,
    requestId: randomUUID(),
  };
  await writeJson(manifestPath, manifest);
  await writeJson(path.join(meta, "control.json"), {
    requestId: manifest.requestId,
    cancel: false,
  });
  const workspace = path.join(meta, "Spend-Management-VR.code-workspace");
  await writeJson(workspace, {
    folders: [
      { name: "Estate", path: root },
      ...repositories
        .filter((r) => r.root !== root)
        .map((r) => ({ name: path.relative(root, r.root), path: r.root })),
    ],
    settings: {
      "vrV1.portableConfig": manifestPath,
      "vrV1.nodePath": process.execPath,
      "vrV1.semanticSearch": manifest.semanticSearch,
      "files.exclude": { "**/.vr-estate": true },
    },
  });
  if (args.includes("--scan-only")) {
    await log(
      "scanned",
      "Repository scans and database are ready. Model understanding has not run.",
      { repositories: repositories.length, productId },
    );
  } else if (args.includes("--no-open")) {
    await log(
      "awaiting-vscode",
      "Open " + workspace + " to continue understanding.",
      { requestId: manifest.requestId },
    );
  } else {
    let code = option("--code") ?? "code";
    try {
      execFileSync(code, ["--version"], { stdio: "ignore" });
    } catch {
      code =
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
      await access(code);
    }
    await log("install", "Installing the portable VR extension in VS Code.");
    const vsix = path.join(import.meta.dirname, "vr-portable-0.2.0.vsix");
    await access(vsix);
    execFileSync(code, ["--install-extension", vsix, "--force"], {
      stdio: "inherit",
    });
    await log(
      "awaiting-vscode",
      "Opening VS Code. Complete workspace trust, model access and Jira prompts there.",
      { requestId: manifest.requestId },
    );
    execFileSync(code, ["--new-window", workspace], { stdio: "ignore" });
    let last = "",
      idleWarning = Date.now();
    while (true) {
      const s = await readJson(statusFile);
      const summary = JSON.stringify([s.phase, s.message, s.calls, s.jobs]);
      if (summary !== last) {
        console.log(`[${new Date().toLocaleTimeString()}] ${s.message}`);
        for (const j of s.jobs ?? [])
          console.log(
            `  ${path.basename(repositories.find((r) => r.sourceId === j.sourceId)?.root ?? "estate")} · ${j.stage}: ${j.processed}/${j.total} (${j.state})`,
          );
        last = summary;
      }
      if (["ready", "ready-with-gaps", "paused", "failed"].includes(s.phase)) {
        if (s.phase !== "ready") process.exitCode = 2;
        console.log("Details: " + statusFile);
        break;
      }
      if (Date.now() - idleWarning > 60000) {
        console.log(
          "Waiting for VS Code. Check its VR output panel and any trust/model/Jira prompts.",
        );
        idleWarning = Date.now();
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
} catch (e) {
  if (otherWorker) console.error(String(e));
  else await log("failed", String(e));
  process.exitCode = 1;
} finally {
  await unlink(lockFile).catch(() => {});
}
