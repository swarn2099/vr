import { flagsFor, stageEnabled, stageOrder } from "./pipeline.js";
// Keep the primary stages visible even when many small investigations follow.
export function learningCoverage(overview: any) {
  const active = new Set(
    overview.sources
      .filter((s: any) => s.kind === "git")
      .map((s: any) => s.checkpoint),
  );
  const jobs = overview.jobs.filter(
    (j: any) =>
      active.has(j.snapshot_id) &&
      !j.details?.localOverlay &&
      j.state !== "superseded",
  );
  const primary = jobs.filter((j: any) => j.stage !== "investigation");
  const investigations = jobs.filter((j: any) => j.stage === "investigation");
  const compact = (j: any) => ({
    id: j.id,
    stage: j.stage,
    sourceId: j.source_id,
    repository: overview.sources.find((s: any) => s.id === j.source_id)
      ?.identity,
    state: j.state,
    processed: j.processed,
    total: j.total,
    reused: j.reused,
    calls: j.calls,
    details: {
      errorCount: j.details?.errors?.length ?? 0,
      complete: j.details?.complete,
      fixture: j.details?.fixture,
    },
  });
  return {
    stages: overview.sources
      .filter((s: any) => s.kind === "git")
      .flatMap((source: any) =>
        stageOrder
          .filter((stage) => stage !== "investigation")
          .filter(
            (stage) =>
              !["jira", "github-issues", "estate-connections"].includes(
                stage,
              ) ||
              source.id ===
                (jobs.findLast((j: any) => j.stage === stage)?.source_id ??
                  overview.sources.find((s: any) => s.kind === "git")?.id),
          )
          .map((stage) => {
            const enabled = stageEnabled(stage, flagsFor(source));
            const job = jobs.findLast(
              (j: any) => j.source_id === source.id && j.stage === stage,
            );
            const collection = source.attributes.externalStatus?.[stage];
            return {
              sourceId: source.id,
              stage,
              enabled,
              state: !enabled
                ? "disabled"
                : collection?.state === "failed"
                  ? "failed"
                  : (job?.state ?? collection?.state ?? "not-started"),
              collection: enabled ? collection : undefined,
            };
          }),
      ),
    jobs: primary.map((j: any) => ({
      ...compact(j),
      state: stageEnabled(
        j.stage,
        flagsFor(overview.sources.find((s: any) => s.id === j.source_id)),
      )
        ? j.state
        : "disabled",
    })),
    investigations: {
      total: investigations.length,
      completed: investigations.filter((j: any) => j.state === "completed")
        .length,
      budgetExhausted: investigations.filter(
        (j: any) => j.state === "budget-exhausted",
      ).length,
      pending: investigations.filter((j: any) =>
        ["pending", "running", "paused"].includes(j.state),
      ).length,
      calls: investigations.reduce((n: number, j: any) => n + j.calls, 0),
    },
    localOverlays: overview.jobs
      .filter(
        (j: any) =>
          j.details?.localOverlay && active.has(j.details.baseCheckpoint),
      )
      .slice(-3)
      .map(compact),
  };
}
