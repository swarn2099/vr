import { preparePrompt } from "./learning.js";
import { flagsFor, stageEnabled } from "./pipeline.js";
export type Call = (
  method: string,
  params?: Record<string, any>,
) => Promise<any>;
export interface EstateManifest {
  version: 1;
  runtimeDirectory?: string;
  root: string;
  name: string;
  productId: string;
  state: string;
  requestId: string;
  repositories: Array<{ root: string; sourceId: string }>;
  historyYears: number;
  maxCalls: number;
  semanticSearch: boolean;
  stages: {
    currentCode: boolean;
    historicalCode: boolean;
    jira: boolean;
    githubIssues: boolean;
  };
  jira?: {
    site: string;
    projects: string[];
    searchTool: string;
    cloudId?: string;
  };
  github?: Array<{ owner: string; repo: string }>;
}
export async function runEstate(
  m: EstateManifest,
  call: Call,
  host: {
    model: string;
    interpret(
      batch: any,
      prepared: ReturnType<typeof preparePrompt>,
    ): Promise<{ text: string; tokens?: number }>;
    collectJira(): Promise<any>;
    collectGitHub?(): Promise<any>;
    cancelled(): boolean;
    report(event: Record<string, any>): Promise<void>;
  },
) {
  let calls = 0;
  const optionalFailures: Array<{ stage: string; error: string }> = [];
  const report = async (phase: string, message: string, extra = {}) =>
    host.report({ phase, message, calls, ...extra });
  const check = () => {
    if (host.cancelled())
      throw Error(
        "Setup cancelled; completed work is saved. Run the setup command again to resume.",
      );
  };
  async function drain(stages: string[]) {
    let failures = 0;
    while (true) {
      check();
      const b = await call("learn.next", {
        productId: m.productId,
        model: host.model,
        charBudget: failures ? 16000 : 36000,
        stages,
      });
      if (b.done) break;
      if (b.waiting)
        throw Error(
          b.reason +
            "; resume once the active model request finishes or its lease expires.",
        );
      if (calls >= m.maxCalls) {
        await call("learn.fail", {
          batchId: b.batchId,
          error: "Setup model-call budget reached before invoking model.",
        });
        throw Error(
          "Model-call budget reached. Completed work is saved; rerun setup to continue.",
        );
      }
      calls++;
      await report(
        b.stage,
        `Understanding ${b.stage}: model call ${calls}/${m.maxCalls}`,
        { jobId: b.jobId },
      );
      const prepared = preparePrompt(b);
      try {
        await call("learn.request", {
          batchId: b.batchId,
          prompt: prepared.prompt,
          promptVersion: "vr-estate-1",
        });
        const response = await host.interpret(b, prepared);
        check();
        await call("learn.request", {
          batchId: b.batchId,
          prompt: prepared.prompt,
          promptVersion: "vr-estate-1",
          inputTokens: response.tokens,
        });
        await call("learn.response", {
          batchId: b.batchId,
          text: response.text,
          inputTokens: response.tokens,
        });
        await call("learn.publish", {
          batchId: b.batchId,
          proposal: prepared.resolve(response.text),
          inputTokens: response.tokens,
          outputChars: response.text.length,
        });
        failures = 0;
      } catch (e) {
        await call("learn.fail", { batchId: b.batchId, error: String(e) });
        failures++;
        if (
          host.cancelled() ||
          /quota|rate.limit|budget|auth|consent|cancel|context.*small/i.test(
            String(e),
          ) ||
          failures >= 3
        )
          throw e;
        await report(
          b.stage,
          "Retrying an invalid response with a smaller batch.",
        );
      }
      const o = await call("overview", { productId: m.productId });
      await report(b.stage, "Saved understanding.", {
        jobs: activeJobs(o),
        questions: o.questions.length,
      });
    }
    const o = await call("overview", { productId: m.productId });
    const bad = activeJobs(o).filter(
      (j: any) =>
        stages.includes(j.stage) &&
        j.state !== "completed" &&
        j.state !== "disabled" &&
        j.state !== "budget-exhausted",
    );
    if (bad.length)
      throw Error(
        "Incomplete source processing: " +
          bad.map((j: any) => j.stage + " " + j.state).join(", "),
      );
  }
  await report(
    "current",
    "Understanding current code across all repositories.",
  );
  await drain(["current", "connections"]);
  if (m.stages.currentCode) {
    await call("estate.connections", { productId: m.productId });
    await drain(["estate-connections"]);
  }
  if (m.stages.historicalCode) {
    for (const repo of m.repositories) {
      check();
      await report("history", "Collecting Git history: " + repo.root);
      await call("history", { sourceId: repo.sourceId, years: m.historyYears });
    }
    await drain(["history"]);
  }
  for (const [stage, enabled, collect] of [
    ["jira", m.stages.jira, host.collectJira],
    ["github-issues", m.stages.githubIssues, host.collectGitHub],
  ] as const) {
    if (!enabled) continue;
    check();
    try {
      await report(stage, "Reading " + stage + " evidence.");
      if (!collect) throw Error("Connector is not configured.");
      const result = await collect();
      if (result?.state === "failed" || result?.state === "not-configured")
        throw Error(result.error ?? "Source is not configured.");
      if (result?.partial)
        optionalFailures.push({
          stage,
          error: "Collection is partial; see source limitations.",
        });
      await drain([stage]);
    } catch (e) {
      if (host.cancelled()) throw e;
      optionalFailures.push({ stage, error: String(e) });
      for (const repo of m.repositories)
        await call("source.status", {
          sourceId: repo.sourceId,
          stage,
          status: { state: "failed", error: String(e) },
        });
      await report(
        stage,
        "Optional source incomplete; other stages will continue.",
        { error: String(e) },
      );
    }
  }
  await drain(["investigation"]);
  for (const repo of m.repositories) {
    check();
    await call("overlay.queue", { sourceId: repo.sourceId });
  }
  await drain(["current"]);
  if (m.semanticSearch)
    try {
      await report("index", "Building local semantic search.");
      for (let i = 0; i < 10000; i++) {
        check();
        const r = await call("index", { productId: m.productId, limit: 100 });
        if (!r.remaining) break;
        if (!r.indexed)
          throw Error("Semantic indexing stopped before completion.");
        if (i === 9999) throw Error("Semantic indexing budget exhausted.");
      }
    } catch (e) {
      if (host.cancelled()) throw e;
      optionalFailures.push({ stage: "semantic-search", error: String(e) });
    }
  const o = await call("overview", { productId: m.productId });
  const result = {
    phase: optionalFailures.length ? "ready-with-gaps" : "ready",
    message: optionalFailures.length
      ? "Code knowledge is ready; some optional sources need attention."
      : "Estate setup and configured understanding are complete.",
    calls,
    optionalFailures,
    jobs: activeJobs(o),
    questions: o.questions.filter((q: any) => q.state !== "answered").length,
    repositories: m.repositories.length,
  };
  await host.report(result);
  return result;
}
export function activeJobs(o: any) {
  const ids = new Set(
    o.sources
      .filter((s: any) => s.kind === "git")
      .map((s: any) => s.checkpoint),
  );
  return o.jobs
    .filter((j: any) => ids.has(j.snapshot_id) && j.state !== "superseded")
    .map((j: any) => ({
      id: j.id,
      sourceId: j.source_id,
      stage: j.stage,
      state: j.state,
      processed: j.processed,
      total: j.total,
      reused: j.reused,
      errors: j.details?.errors ?? [],
    }));
}
