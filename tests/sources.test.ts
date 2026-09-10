import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  GitHubIssuesConnector,
  GitHubBinding,
  normalizeGitHubIssue,
} from "../src/connectors/github-issues.js";
import { collectIssues } from "../src/connectors/collect.js";
import { Engine } from "../src/engine.js";
import { Learning } from "../src/learning.js";
import { ContextService } from "../src/retrieval.js";
import { openDatabase } from "../src/database.js";
import { git } from "../src/scanner.js";
import { advancePipeline } from "../src/orchestration.js";
import { learningCoverage } from "../src/coverage.js";

const issue = (number = 1) => ({
  id: number,
  number,
  title: "Payment restriction",
  body: "Only managers should pay.",
  state: "closed",
  state_reason: "completed",
  html_url: `https://github.com/org/app/issues/${number}`,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-02-01T00:00:00Z",
  closed_at: "2025-02-01T00:00:00Z",
  comments: 0,
  user: { login: "maintainer" },
  labels: [{ name: "policy" }],
});
const empty = { analyses: [], findings: [], relationships: [], questions: [] };
const response = (body: unknown, next = false) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: next ? { link: '<https://evil.invalid/stolen>; rel="next"' } : {},
  });
test("GitHub reads all issue states, filters pull requests, follows bounded local pagination, and preserves provenance", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/comments?"))
      return response([
        {
          id: 50,
          body: "Preserve the manager guard.",
          updated_at: "2025-02-02T00:00:00Z",
          html_url: "https://github.com/org/app/issues/1#issuecomment-50",
          user: { login: "reviewer" },
        },
      ]);
    return url.endsWith("page=1")
      ? response(
          [
            { ...issue(), comments: 1 },
            {
              ...issue(2),
              pull_request: {
                url: "https://api.github.com/repos/org/app/pulls/2",
              },
            },
          ],
          true,
        )
      : response([issue(3)]);
  };
  const result = await collectIssues(
    new GitHubIssuesConnector(
      { owner: "org", repo: "app" },
      "fixture-token",
      transport,
    ),
  );
  assert.equal(result.state, "ready");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].metadata.commentsComplete, true);
  assert.ok(result.items[0].body.includes("reviewer"));
  assert.equal(result.items[0].url, "https://github.com/org/app/issues/1");
  assert.ok(
    calls.every(
      (c) =>
        c.url.startsWith("https://api.github.com/repos/org/app/") &&
        c.init?.method === "GET",
    ),
  );
  assert.ok(calls.some((c) => c.url.includes("state=all")));
  assert.ok(!JSON.stringify(result).includes("fixture-token"));
  await assert.rejects(
    () =>
      new GitHubIssuesConnector(
        { owner: "org", repo: "app" },
        undefined,
        transport,
      ).page("https://evil.invalid"),
    /cursor/,
  );
});
test("empty, failed, partial pages and omitted comments remain distinct; comment edits change the source revision", async () => {
  const binding = GitHubBinding.parse({
    owner: "org",
    repo: "app",
    maxCommentRequests: 0,
  });
  const emptyResult = await collectIssues(
    new GitHubIssuesConnector(binding, undefined, async () => response([])),
  );
  assert.equal(emptyResult.state, "empty");
  assert.equal(emptyResult.options.complete, true);
  const failed = await collectIssues(
    new GitHubIssuesConnector(
      binding,
      undefined,
      async () => new Response("no", { status: 403 }),
    ),
  );
  assert.equal(failed.state, "failed");
  assert.equal(failed.options.complete, false);
  let page = 0;
  const partial = await collectIssues(
    new GitHubIssuesConnector(binding, undefined, async () =>
      ++page === 1
        ? response([{ ...issue(), comments: 5 }], true)
        : new Response("failure", { status: 503 }),
    ),
  );
  assert.equal(partial.state, "partial");
  assert.equal(partial.items.length, 1);
  assert.equal(partial.items[0].metadata.commentsComplete, false);
  const first = normalizeGitHubIssue(issue(), binding);
  const edited = normalizeGitHubIssue(
    { ...issue(), body: "Managers and assistants should pay." },
    binding,
  );
  assert.notEqual(first.revision, edited.revision);
  assert.throws(
    () =>
      normalizeGitHubIssue(
        { ...issue(), html_url: "https://github.com/other/app/issues/1" },
        binding,
      ),
    /outside/,
  );
  const bounded = await collectIssues(
    new GitHubIssuesConnector(
      { ...binding, maxPages: 1 },
      undefined,
      async () => response([issue()], true),
    ),
    1,
  );
  assert.equal(bounded.state, "partial");
});

async function fixture(
  flags = {
    currentCode: true,
    historicalCode: true,
    jira: true,
    githubIssues: true,
  },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vr-sources-")),
    root = path.join(dir, "app");
  await mkdir(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(
    path.join(root, "pay.ts"),
    'export function pay(role:string){return role === "manager";}',
  );
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "Payment guard");
  const db = await openDatabase(path.join(dir, "state")),
    engine = new Engine(db, path.join(dir, "state"), "local-user", 0),
    ids = await engine.connect("App", root),
    learning = new Learning(engine);
  await engine.configurePipeline(ids.sourceId, { version: 1, stages: flags });
  await engine.refresh(ids.sourceId);
  const finish = async () => {
    for (let i = 0; i < 20; i++) {
      const b: any = await learning.next(ids.productId, "fixture");
      if (b.done) return;
      assert.ok(!b.waiting, b.reason);
      await learning.publish(b.batchId, {
        ...empty,
        analyses:
          b.stage === "current"
            ? b.evidence.map((e: any) => ({
                evidence: e.id,
                summary: "Fixture",
                symbols: (e.metadata.functions ?? []).map((f: any) => ({
                  name: f.name,
                  start: f.start,
                  summary: "Fixture",
                })),
              }))
            : [],
      });
    }
    throw Error("Unfinished fixture");
  };
  return {
    dir,
    root,
    db,
    engine,
    ids,
    learning,
    finish,
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("flags skip semantic stages, keep the structural checkpoint, and reject publication disabled mid-flight", async () => {
  const f = await fixture();
  try {
    const pending: any = await f.learning.next(f.ids.productId, "fixture");
    await f.engine.configurePipeline(f.ids.sourceId, {
      stages: {
        currentCode: false,
        historicalCode: false,
        jira: false,
        githubIssues: true,
      },
    });
    await assert.rejects(
      () => f.learning.publish(pending.batchId, empty),
      /publishable|disabled/,
    );
    assert.equal(
      ((await f.engine.collectHistory(f.ids.sourceId, 1)) as any).disabled,
      true,
    );
    assert.equal(
      ((await f.engine.importJira(f.ids.productId, "jira", [])) as any)
        .disabled,
      true,
    );
    const source = await f.engine.source(f.ids.sourceId);
    assert.ok(source.checkpoint);
    const item = normalizeGitHubIssue(
      issue(),
      GitHubBinding.parse({ owner: "org", repo: "app" }),
    );
    await f.engine.importIssues(
      f.ids.productId,
      "github-issues",
      "https://github.com/org/app",
      [item],
    );
    const b: any = await f.learning.next(f.ids.productId, "fixture");
    assert.equal(b.stage, "github-issues");
    await f.learning.publish(b.batchId, empty);
    await f.finish();
    const coverage = learningCoverage(await f.engine.overview(f.ids.productId));
    assert.equal(
      coverage.stages.find((s: any) => s.stage === "jira").state,
      "disabled",
    );
    assert.equal(
      coverage.stages.find((s: any) => s.stage === "current").state,
      "disabled",
    );
    await f.engine.configurePipeline(f.ids.sourceId, {
      stages: {
        currentCode: true,
        historicalCode: false,
        jira: false,
        githubIssues: true,
      },
    });
    assert.equal(
      ((await f.learning.next(f.ids.productId, "fixture")) as any).stage,
      "current",
    );
  } finally {
    await f.close();
  }
});
test("history can run with current understanding disabled, and queued issues wait for enabled history", async () => {
  const f = await fixture({
    currentCode: false,
    historicalCode: true,
    jira: false,
    githubIssues: true,
  });
  try {
    await f.engine.importIssues(
      f.ids.productId,
      "github-issues",
      "https://github.com/org/app",
      [
        normalizeGitHubIssue(
          issue(),
          GitHubBinding.parse({ owner: "org", repo: "app" }),
        ),
      ],
    );
    const waiting: any = await f.learning.next(f.ids.productId, "fixture");
    assert.equal(waiting.requiredStage, "history");
    await f.engine.collectHistory(f.ids.sourceId, 1);
    const b: any = await f.learning.next(f.ids.productId, "fixture");
    assert.equal(b.stage, "history");
    await f.learning.publish(b.batchId, empty);
    await f.finish();
  } finally {
    await f.close();
  }
});
test("Jira failure and an empty Jira collection both allow GitHub, with read and interpretation order preserved", async () => {
  const f = await fixture({
    currentCode: true,
    historicalCode: false,
    jira: true,
    githubIssues: true,
  });
  try {
    await f.finish();
    const attempts = new Set<string>(),
      order: string[] = [];
    const actions = {
      history: async () => {
        throw Error("Disabled history ran");
      },
      collect: async (stage: "jira" | "github-issues") => {
        order.push(stage);
        if (stage === "jira") throw Error("Jira MCP unavailable");
        return f.engine.importIssues(
          f.ids.productId,
          stage,
          "https://github.com/org/app",
          [
            normalizeGitHubIssue(
              issue(),
              GitHubBinding.parse({ owner: "org", repo: "app" }),
            ),
          ],
        );
      },
      failed: (stage: "jira" | "github-issues", error: string) =>
        f.engine.sourceStatus(f.ids.sourceId, stage, {
          state: "failed",
          error,
        }),
    };
    await advancePipeline(
      await f.engine.overview(f.ids.productId),
      f.ids.sourceId,
      attempts,
      actions,
    );
    assert.deepEqual(order, ["jira", "github-issues"]);
    assert.equal(
      ((await f.learning.next(f.ids.productId, "fixture")) as any).stage,
      "github-issues",
    );
    await advancePipeline(
      await f.engine.overview(f.ids.productId),
      f.ids.sourceId,
      attempts,
      actions,
    );
    assert.equal(order.length, 2);
    const o = await f.engine.overview(f.ids.productId);
    assert.equal(
      learningCoverage(o).stages.find((s: any) => s.stage === "jira").collection
        .state,
      "failed",
    );
    const imported = await f.engine.importJira(f.ids.productId, "jira", []);
    assert.ok("jobId" in imported);
    const updated = await f.engine.overview(f.ids.productId);
    assert.equal(
      learningCoverage(updated).stages.find((s: any) => s.stage === "jira")
        .collection.state,
      "empty",
    );
  } finally {
    await f.close();
  }
});
test("GitHub assertions stay intent, reuse unchanged evidence, retain history, invalidate revisions, and respect revocation", async () => {
  const f = await fixture({
    currentCode: true,
    historicalCode: false,
    jira: false,
    githubIssues: true,
  });
  try {
    await f.finish();
    const binding = GitHubBinding.parse({ owner: "org", repo: "app" }),
      item = normalizeGitHubIssue(issue(), binding);
    const imported = await f.engine.importIssues(
      f.ids.productId,
      "github-issues",
      "https://github.com/org/app",
      [item],
    );
    assert.ok("sourceId" in imported);
    const b: any = await f.learning.next(f.ids.productId, "fixture");
    const finding = {
      key: "manager-payment-intent",
      title: "Payment restriction",
      statement: "The issue requests a manager-only payment restriction.",
      conditions: [],
      exceptions: [],
      paths: ["pay.ts"],
      basis: "intent",
      temporal: "proposed",
      checks: [],
      contradicts: [],
      evidence: [b.evidence[0].id],
      extensions: {},
    };
    await assert.rejects(
      () =>
        f.learning.publish(b.batchId, {
          ...empty,
          findings: [{ ...finding, temporal: "current" }],
        }),
      /not current implementation/,
    );
    await f.learning.publish(b.batchId, { ...empty, findings: [finding] });
    await f.finish();
    await f.engine.importIssues(
      f.ids.productId,
      "github-issues",
      "https://github.com/org/app",
      [item],
    );
    assert.equal(
      ((await f.learning.next(f.ids.productId, "fixture")) as any).done,
      true,
    );
    const o = await f.engine.overview(f.ids.productId);
    assert.ok(o.jobs.some((j) => j.stage === "github-issues" && j.reused > 0));
    const changed = normalizeGitHubIssue(
      { ...issue(), body: "Managers and assistants should pay." },
      binding,
    );
    await f.engine.importIssues(
      f.ids.productId,
      "github-issues",
      "https://github.com/org/app",
      [changed],
    );
    const packet = await new ContextService(f.engine).context(
      f.ids.productId,
      "Payment restriction",
      ["pay.ts"],
    );
    assert.ok(
      packet.behaviors.some(
        (x: any) => x.applicability === "needs-source-revalidation",
      ),
    );
    const evidence = (
      await f.db.query("SELECT revision FROM vr_evidence WHERE source_id=$1", [
        imported.sourceId,
      ])
    ).rows;
    assert.equal(new Set(evidence.map((e) => e.revision)).size, 2);
    await f.engine.revoke(imported.sourceId);
    const hidden = await new ContextService(f.engine).context(
      f.ids.productId,
      "Payment restriction",
      ["pay.ts"],
    );
    assert.equal(hidden.behaviors.length, 0);
    await assert.rejects(
      () =>
        f.engine.importIssues(
          f.ids.productId,
          "github-issues",
          "https://github.com/org/app",
          [item],
        ),
      /access denied/,
    );
  } finally {
    await f.close();
  }
});
test("Jira is interpreted before GitHub and conflicting tracker intent cannot overwrite its counterpart", async () => {
  const f = await fixture({
    currentCode: true,
    historicalCode: false,
    jira: true,
    githubIssues: true,
  });
  try {
    await f.finish();
    await f.engine.importIssues(
      f.ids.productId,
      "github-issues",
      "https://github.com/org/app",
      [
        normalizeGitHubIssue(
          issue(),
          GitHubBinding.parse({ owner: "org", repo: "app" }),
        ),
      ],
    );
    await f.engine.importJira(f.ids.productId, "jira", [
      {
        id: "KAN-1",
        title: "Payment restriction",
        body: "Managers and assistants should pay.",
        revision: "one",
      },
    ]);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const b: any = await f.learning.next(f.ids.productId, "fixture");
      if (b.done) break;
      seen.push(b.stage);
      await f.learning.publish(b.batchId, {
        ...empty,
        findings: [
          {
            key: "payment-role",
            title: "Payment intent",
            statement:
              b.stage === "jira"
                ? "Jira requests managers and assistants."
                : "GitHub requests managers only.",
            conditions: [],
            exceptions: [],
            paths: ["pay.ts"],
            basis: "intent",
            temporal: "proposed",
            checks: [],
            contradicts: [],
            evidence: [b.evidence[0].id],
            extensions: {},
          },
        ],
      });
    }
    assert.deepEqual(seen, ["jira", "github-issues"]);
    const packet = await new ContextService(f.engine).context(
      f.ids.productId,
      "Payment intent",
      ["pay.ts"],
    );
    assert.equal(packet.behaviors.length, 2);
    assert.ok(
      packet.behaviors.some((b: any) => b.statement.includes("assistants")),
    );
    assert.ok(
      packet.behaviors.some((b: any) => b.statement.includes("managers only")),
    );
  } finally {
    await f.close();
  }
});
test("a scoped learning worker cannot reserve unrelated pending investigations", async () => {
  const f = await fixture({
    currentCode: true,
    historicalCode: false,
    jira: false,
    githubIssues: true,
  });
  try {
    await f.finish();
    const source = await f.engine.source(f.ids.sourceId);
    const evidence = (
      await f.db.query(
        "SELECT id FROM vr_evidence WHERE source_id=$1 LIMIT 1",
        [f.ids.sourceId],
      )
    ).rows[0].id;
    const investigation = await f.db.transaction((tx) =>
      f.engine.createJob(
        tx,
        source,
        source.checkpoint,
        "investigation",
        [{ key: "unrelated-question", evidence: [evidence] }],
        { question: "Unrelated pending question", maxCalls: 2 },
      ),
    );
    const done: any = await f.learning.next(
      f.ids.productId,
      "scoped-fixture",
      44000,
      ["history", "github-issues"],
    );
    assert.equal(done.done, true);
    const job = (
      await f.db.query("SELECT state,calls FROM vr_jobs WHERE id=$1", [
        investigation,
      ])
    ).rows[0];
    assert.equal(job.state, "pending");
    assert.equal(job.calls, 0);
    await assert.rejects(
      () => f.learning.next(f.ids.productId, "fixture", 44000, ["unknown"]),
      /valid learning stages/,
    );
  } finally {
    await f.close();
  }
});
