import { flagsFor, stageEnabled } from "./pipeline.js";

// Advance collection only when the enabled understanding prerequisites have finished.
// The caller invokes this again after a batch completes; failed optional sources are tried once per session.
export async function advancePipeline(
  overview: any,
  sourceId: string,
  attempted: Set<string>,
  actions: {
    history(): Promise<unknown>;
    collect(stage: "jira" | "github-issues"): Promise<unknown>;
    failed(stage: "jira" | "github-issues", error: string): Promise<unknown>;
  },
) {
  const source = overview.sources.find((s: any) => s.id === sourceId);
  if (!source) throw Error("Estate source unavailable");
  const flags = flagsFor(source),
    jobs = overview.jobs.filter(
      (j: any) =>
        j.source_id === sourceId &&
        j.snapshot_id === source.checkpoint &&
        !j.details?.localOverlay,
    );
  for (const stage of ["current", "connections", "history"]) {
    if (!stageEnabled(stage, flags)) continue;
    const job = jobs.findLast((j: any) => j.stage === stage);
    if (!job && stage === "history" && !attempted.has(stage)) {
      attempted.add(stage);
      await actions.history();
      return true;
    }
    if (job?.state !== "completed" || job.details?.errors?.length) return false;
  }
  let changed = false;
  for (const stage of ["jira", "github-issues"] as const) {
    if (!stageEnabled(stage, flags) || attempted.has(stage)) continue;
    attempted.add(stage);
    try {
      await actions.collect(stage);
    } catch (error) {
      await actions.failed(stage, String(error));
    }
    changed = true;
  }
  return changed;
}
