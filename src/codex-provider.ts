import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Proposal } from "./contracts.js";

export const CODEX_MODEL = "gpt-5.6-sol";
export const CODEX_REASONING = "medium";
export function codexArguments(root: string, output: string, schema: string) {
  return [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--model",
    CODEX_MODEL,
    "--config",
    `model_reasoning_effort="${CODEX_REASONING}"`,
    "--config",
    'forced_login_method="chatgpt"',
    "--config",
    'web_search="disabled"',
    "--config",
    "project_doc_max_bytes=0",
    "--config",
    "suppress_unstable_features_warning=true",
    "--config",
    'developer_instructions="You are an evidence interpretation worker. Interpret only the supplied prompt data. Do not use tools, browse, execute commands, inspect local files, or modify the estate. Return only the requested JSON."',
    ...[
      "shell_tool",
      "apps",
      "plugins",
      "hooks",
      "multi_agent",
      "browser_use",
      "computer_use",
      "image_generation",
      "memories",
    ].flatMap((f) => ["--disable", f]),
    "--enable",
    "skip_host_skill_discovery",
    "--sandbox",
    "read-only",
    "--cd",
    root,
    "--json",
    "--output-schema",
    schema,
    "--output-last-message",
    output,
    "-",
  ];
}
export function proposalOutputSchema() {
  const schema: any = z.toJSONSchema(Proposal);
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    delete value.default;
    delete value.$schema;
    delete value.propertyNames;
    if (value.type === "object") {
      // Core finding extensions are optional enrichment; this worker emits {}.
      value.properties ??= {};
      value.additionalProperties = false;
      value.required = Object.keys(value.properties);
    }
    for (const child of Object.values(value))
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
  };
  visit(schema);
  return schema;
}
export function inspectCodexEvents(events: any[]) {
  const failed = events.findLast(
    (e) => e.type === "turn.failed" || e.type === "error",
  );
  if (failed)
    throw Error(failed.error?.message ?? failed.message ?? "Codex turn failed");
  const forbidden = events.filter(
    (e) =>
      ["item.started", "item.completed"].includes(e.type) &&
      e.item &&
      !["agent_message", "reasoning"].includes(e.item.type),
  );
  if (forbidden.length)
    throw Error(`Understanding worker used a tool: ${forbidden[0].item.type}`);
  const complete = events.findLast((e) => e.type === "turn.completed");
  if (!complete) throw Error("Codex did not report a completed turn");
  return {
    threadId: events.find((e) => e.type === "thread.started")?.thread_id,
    usage: complete.usage,
  };
}
export async function interpretWithCodex(options: {
  root: string;
  directory: string;
  prompt: string;
  executable?: string;
  timeoutMs?: number;
}) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const output = path.join(options.directory, "response.json"),
    schema = path.join(options.directory, "schema.json"),
    args = codexArguments(options.root, output, schema);
  await writeFile(schema, JSON.stringify(proposalOutputSchema()));
  await writeFile(path.join(options.directory, "prompt.txt"), options.prompt);
  await writeFile(
    path.join(options.directory, "invocation.json"),
    JSON.stringify(
      {
        model: CODEX_MODEL,
        reasoning: CODEX_REASONING,
        authentication: "ChatGPT subscription",
        executable: options.executable ?? "codex",
        args,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const started = Date.now();
  let stdout = "",
    stderr = "",
    interrupted = false;
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    // Inherit the existing Codex login, but prevent an API-key environment variable from selecting API billing.
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const child = spawn(options.executable ?? "codex", args, {
      cwd: options.root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      interrupted = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 480000);
    const stop = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const cleanup = () => {
      clearTimeout(timeout);
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    };
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > 4 * 1024 * 1024) stop();
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 1024 * 1024) stop();
    });
    child.once("error", (e) => {
      cleanup();
      reject(e);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.prompt);
  });
  await writeFile(path.join(options.directory, "events.jsonl"), stdout);
  await writeFile(path.join(options.directory, "stderr.txt"), stderr);
  if (interrupted)
    throw Error(
      "Codex worker was cancelled or exceeded its time/output budget",
    );
  const events = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const audit = inspectCodexEvents(events);
  if (result.code !== 0)
    throw Error(`Codex exited ${result.code}: ${stderr.slice(-2000)}`);
  const text = await readFile(output, "utf8");
  return {
    text,
    ...audit,
    elapsedMs: Date.now() - started,
    model: CODEX_MODEL,
    reasoning: CODEX_REASONING,
  };
}
