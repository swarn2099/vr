import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/database.js";
import { Engine } from "../src/engine.js";
import { Learning, preparePrompt } from "../src/learning.js";
import { ContextService } from "../src/retrieval.js";
import { scan, git, analyzeText, history } from "../src/scanner.js";
import { project } from "../src/projections.js";
const empty = { findings: [], relationships: [], questions: [] };
const local = (b: any) => ({
  analyses:
    b.stage === "current"
      ? b.evidence.map((e: any) => ({
          evidence: e.id,
          summary:
            "Controlled fixture summary, not a semantic accuracy assessment.",
          symbols: (e.metadata.functions ?? [])
            .filter(
              (s: any) => s.start >= e.start_line && s.start <= e.end_line,
            )
            .map((s: any) => ({
              name: s.name,
              start: s.start,
              summary: "Controlled fixture function interpretation.",
            })),
        }))
      : [],
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vr-v1-")),
    root = path.join(dir, "app");
  await mkdir(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "VR Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(
    path.join(root, "policy.ts"),
    'export const canPay = (role: string) => role === "manager" || role === "assistant";\n',
  );
  await writeFile(
    path.join(root, "pay.ts"),
    'import {canPay} from "./policy"; export function pay(role: string) { if (!canPay(role)) throw new Error("denied"); return "paid"; }\n',
  );
  await writeFile(
    path.join(root, "form.tsx"),
    'import {canPay} from "./policy"; export const Form = ({role}: {role:string}) => <button disabled={!canPay(role)}>Pay</button>;\n',
  );
  await writeFile(
    path.join(root, "health.ts"),
    'export function health() { return "ok"; }\n',
  );
  await writeFile(
    path.join(root, "BillController.java"),
    'class BillController { public boolean allowed(String userType) { return userType.equals("manager"); } }\n',
  );
  await writeFile(path.join(root, ".env"), "SECRET=do-not-ingest\n");
  await git(root, "add", ".");
  await git(
    root,
    "commit",
    "-qm",
    "Support manager and assistant bill payment",
  );
  const before = (await git(root, "rev-parse", "HEAD")).trim();
  await writeFile(
    path.join(root, "policy.ts"),
    'export const canPay = (role: string) => role === "manager";\n',
  );
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "Restrict bill payment to managers");
  const db = await openDatabase(path.join(dir, "state")),
    engine = new Engine(db, path.join(dir, "state")),
    ids = await engine.connect("Billing", root);
  await engine.refresh(ids.sourceId);
  return {
    dir,
    root,
    db,
    engine,
    ids,
    before,
    learning: new Learning(engine),
    context: new ContextService(engine),
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function finish(f: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 30; i++) {
    const b: any = await f.learning.next(f.ids.productId, "test-fixture");
    if (b.done) return;
    assert.ok(!b.waiting, b.reason);
    await f.learning.publish(b.batchId, { ...empty, ...local(b), ...local(b) });
  }
  throw Error("Learning did not terminate");
}
test("inventory covers methods, nested callbacks and Java, with explicit exclusions", async () => {
  const f = await fixture();
  try {
    const s = await scan(f.root, f.ids.sourceId);
    assert.equal(s.files.length, 6);
    assert.equal(s.files.find((x) => x.path === ".env")?.status, "excluded");
    assert.equal(
      s.files.find((x) => x.path === "BillController.java")?.functions,
      1,
    );
    assert.ok(
      s.links.some(
        (l) => l.from === "form.tsx" && l.to === "policy.ts" && l.resolved,
      ),
    );
    assert.equal(
      analyzeText(
        "a.ts",
        "class A { get x(){ return 1; } run(){ return [1].map(x=>x+1); } }",
      ).functions.length,
      3,
    );
    assert.ok(!s.units.some((u) => u.text.includes("do-not-ingest")));
  } finally {
    await f.close();
  }
});
test("stages resume unchanged work and reject stale model publications", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.engine.collectHistory(f.ids.sourceId, 1),
      /Finish/,
    );
    const b: any = await f.learning.next(f.ids.productId, "mock-model");
    await writeFile(
      path.join(f.root, "health.ts"),
      'export function health() { return "healthy"; }',
    );
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-qm", "Change health response");
    await f.engine.refresh(f.ids.sourceId);
    await assert.rejects(
      () =>
        f.learning.publish(b.batchId, { ...empty, ...local(b), ...local(b) }),
      /checkpoint changed/,
    );
    await finish(f);
    await writeFile(
      path.join(f.root, "health.ts"),
      'export function health() { return "ready"; }',
    );
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-qm", "Change one leaf");
    await f.engine.refresh(f.ids.sourceId);
    const o = await f.engine.overview(f.ids.productId);
    assert.ok(o.jobs.at(-2)!.reused >= 4);
    await finish(f);
    await f.engine.collectHistory(f.ids.sourceId, 1);
    await finish(f);
    assert.equal(
      (await f.engine.overview(f.ids.productId)).jobs.at(-1)!.state,
      "completed",
    );
  } finally {
    await f.close();
  }
});
test("context invalidates consumers after local edits and keeps independent rules fresh", async () => {
  const f = await fixture();
  try {
    const b: any = await f.learning.next(f.ids.productId, "mock-model");
    const e = b.evidence.find((e: any) => e.path === "pay.ts"),
      health = b.evidence.find((e: any) => e.path === "health.ts");
    assert.ok(e && health);
    const finding = (key: string, statement: string, ev: any) => ({
      key,
      title: key,
      statement,
      conditions: [],
      exceptions: [],
      basis: "observation",
      temporal: "current",
      evidence: [ev.id],
      contradicts: [],
      paths: [ev.path],
      checks: ["Inspect current source"],
      extensions: {},
    });
    await f.learning.publish(b.batchId, {
      ...empty,
      ...local(b),
      findings: [
        finding(
          "bill-payment",
          "Bill payment uses the shared payment policy.",
          e,
        ),
        finding("health-response", "The health response returns ok.", health),
      ],
    });
    await finish(f);
    let p = await f.context.context(
      f.ids.productId,
      "bill payment health",
      [],
      20000,
    );
    assert.equal(p.behaviors.length, 2);
    assert.ok(
      p.behaviors.every(
        (b: any) => b.applicability === "matches-inspected-scope",
      ),
    );
    await writeFile(
      path.join(f.root, "policy.ts"),
      "export const canPay = (role: string) => true;",
    );
    p = await f.context.context(
      f.ids.productId,
      "bill payment health",
      [],
      20000,
    );
    assert.equal(
      p.behaviors.find((b: any) => b.title === "bill-payment").applicability,
      "needs-targeted-refresh",
    );
    assert.equal(
      p.behaviors.find((b: any) => b.title === "health-response").applicability,
      "matches-inspected-scope",
    );
    assert.ok(p.freshness[0].affectedPaths.includes("form.tsx"));
    assert.ok(p.changedSource.length);
    const read = await f.context.evidence(f.ids.productId, [e.id]);
    assert.equal(read.evidence[0].body, e.body);
    const stranger = new Engine(f.db, f.dir, "someone-else");
    await assert.rejects(
      () =>
        new ContextService(stranger).context(f.ids.productId, "bill payment"),
      /access denied/,
    );
    await f.engine.revoke(f.ids.sourceId);
    await assert.rejects(
      () => f.context.evidence(f.ids.productId, [e.id]),
      /access denied/,
    );
  } finally {
    await f.close();
  }
});
test("history retains intermediate changes and Jira creates bounded investigations", async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.root, "policy.ts"),
      'export const canPay = (role: string) => role === "manager" || role === "assistant";\n',
    );
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-qm", "Restore assistants");
    await f.engine.refresh(f.ids.sourceId);
    await finish(f);
    const h = await history(
      f.root,
      f.ids.sourceId,
      (await git(f.root, "rev-parse", "HEAD")).trim(),
      1,
    );
    assert.ok(h.units.some((u) => u.text.includes("Restrict bill payment")));
    assert.ok(h.units.some((u) => u.text.includes("Restore assistants")));
    await f.engine.collectHistory(f.ids.sourceId, 1);
    await finish(f);
    const imported = await f.engine.importJira(
      f.ids.productId,
      "fixture/KAN",
      [
        {
          id: "KAN-10",
          title: "Payment policy",
          body: "Only managers should pay bills.",
          revision: "2026-09-10T00:00:00Z",
        },
      ],
      { complete: true, fixture: true },
    );
    assert.equal(imported.issues, 1);
    const b: any = await f.learning.next(f.ids.productId, "mock-model");
    assert.equal(b.stage, "jira");
    await f.learning.publish(b.batchId, {
      ...empty,
      ...local(b),
      questions: [
        {
          question:
            "Does assistant payment conflict with the supplied manager-only intent?",
          reason: "Avoid unintentionally retaining assistant permission.",
          paths: ["policy.ts", "pay.ts"],
          evidence: [b.evidence[0].id],
        },
      ],
    });
    const o = await f.engine.overview(f.ids.productId);
    assert.ok(
      o.jobs.some(
        (j: any) => j.stage === "investigation" && j.details.maxCalls === 2,
      ),
    );
    assert.ok(o.questions.length);
    assert.equal(
      o.jobs.find(
        (j: any) => j.id === ("jobId" in imported ? imported.jobId : undefined),
      )!.details.fixture,
      true,
    );
  } finally {
    await f.close();
  }
});
test("human corrections use immutable attributed revisions and compare-and-swap", async () => {
  const f = await fixture();
  try {
    const b: any = await f.learning.next(f.ids.productId, "mock-model");
    await f.learning.publish(b.batchId, {
      ...empty,
      ...local(b),
      questions: [
        {
          question: "Should assistants pay?",
          reason: "Observed scope needs confirmation.",
          paths: ["policy.ts"],
          evidence: [b.evidence[0].id],
        },
      ],
    });
    const q = (await f.engine.overview(f.ids.productId)).questions[0];
    const input = {
      targetId: q.id,
      expectedRevision: 0,
      action: "clarify",
      answer: "Managers only",
      reason: "Confirmed product policy",
      actor: {
        id: "engineer@example.invalid",
        name: "Engineer",
        type: "human",
        identityBasis: "self-reported",
      },
    };
    const a = await f.engine.review(f.ids.productId, input);
    await assert.rejects(
      () => f.engine.review(f.ids.productId, input),
      /changed/,
    );
    const second = await f.engine.review(f.ids.productId, {
      ...input,
      expectedRevision: 1,
      action: "reopen",
      reason: "Need backend confirmation",
    });
    const history = await f.engine.reviews(f.ids.productId, q.id);
    assert.equal(history.length, 2);
    assert.equal(history[1].predecessor, a.id);
    assert.equal(history[1].old_value.answer, "Managers only");
    assert.equal(second.revision, 2);
    assert.ok(history[0].created_at);
    assert.equal(history[0].actor.id, input.actor.id);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM vr_outbox WHERE kind='review.revised'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await f.close();
  }
});
test("unknown citations and invalid temporal claims never enter knowledge", async () => {
  const f = await fixture();
  try {
    const b: any = await f.learning.next(f.ids.productId, "mock-model");
    const prepared = preparePrompt(b);
    assert.throws(
      () =>
        prepared.resolve(
          JSON.stringify({
            ...empty,
            questions: [
              { question: "x", reason: "y", paths: [], evidence: ["invented"] },
            ],
          }),
        ),
      /Unknown evidence/,
    );
    await assert.rejects(
      () =>
        f.learning.publish(b.batchId, {
          ...empty,
          ...local(b),
          questions: [
            {
              question: "x",
              reason: "y",
              paths: [],
              evidence: ["not-in-batch"],
            },
          ],
        }),
      /outside this batch/,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM vr_questions")).rows[0]
        .n,
      0,
    );
  } finally {
    await f.close();
  }
});
test("local understanding stays scoped and rejects an edit made during analysis", async () => {
  const f = await fixture();
  try {
    await finish(f);
    const checkpoint = (await f.engine.source(f.ids.sourceId)).checkpoint;
    await writeFile(
      path.join(f.root, "policy.ts"),
      "export const canPay = (role: string) => true;",
    );
    const queued: any = await f.engine.queueOverlay(f.ids.sourceId);
    assert.equal(queued.localOnly, true);
    assert.ok(queued.changed.includes("policy.ts"));
    const b: any = await f.learning.next(f.ids.productId, "mock");
    assert.equal(b.details.localOverlay, true);
    const e = b.evidence.find((e: any) => e.path === "policy.ts");
    await f.learning.publish(b.batchId, {
      ...empty,
      ...local(b),
      findings: [
        {
          key: "local-payment",
          title: "Local payment policy",
          statement: "The local predicate accepts every supplied role.",
          basis: "observation",
          temporal: "current",
          evidence: [e.id],
          paths: [e.path],
          conditions: [],
          exceptions: [],
          contradicts: [],
          checks: [],
          extensions: {},
        },
      ],
    });
    await finish(f);
    const p = await f.context.context(f.ids.productId, "local payment");
    assert.ok(
      p.behaviors.some(
        (b: any) =>
          b.localOverlay && b.applicability === "matches-inspected-scope",
      ),
    );
    assert.equal(
      (await f.engine.source(f.ids.sourceId)).checkpoint,
      checkpoint,
    );
    await writeFile(
      path.join(f.root, "policy.ts"),
      "export const canPay = () => false;",
    );
    assert.ok(
      !(
        await f.context.context(f.ids.productId, "local payment")
      ).behaviors.some((b: any) => b.localOverlay),
    );
    await f.engine.queueOverlay(f.ids.sourceId);
    const stale: any = await f.learning.next(f.ids.productId, "mock");
    await writeFile(
      path.join(f.root, "policy.ts"),
      "export const canPay = () => true;",
    );
    await assert.rejects(
      () => f.learning.publish(stale.batchId, { ...empty, ...local(stale) }),
      /Working tree changed/,
    );
  } finally {
    await f.close();
  }
});
test("remote reconciliation queues changed semantics without modifying the checkout", async () => {
  const f = await fixture();
  try {
    await finish(f);
    const upstream = path.join(f.dir, "remote");
    await git(f.dir, "clone", "-q", f.root, upstream);
    await git(upstream, "config", "user.name", "Remote Engineer");
    await git(upstream, "config", "user.email", "remote@example.invalid");
    await git(f.root, "remote", "add", "origin", upstream);
    const localHead = (await git(f.root, "rev-parse", "HEAD")).trim(),
      localBody = await readFile(path.join(f.root, "health.ts"), "utf8");
    await writeFile(
      path.join(upstream, "health.ts"),
      'export function health(){return "remote-ready";}',
    );
    await git(upstream, "add", ".");
    await git(upstream, "commit", "-qm", "Remote health behavior");
    const r: any = await f.engine.pollRemote(f.ids.sourceId);
    assert.equal(r.localCheckoutModified, false);
    assert.equal(r.refresh.changed, 1);
    assert.equal((await git(f.root, "rev-parse", "HEAD")).trim(), localHead);
    assert.equal(
      await readFile(path.join(f.root, "health.ts"), "utf8"),
      localBody,
    );
    assert.equal((await f.engine.source(f.ids.sourceId)).remote_tip, r.tip);
    assert.ok(
      (await f.engine.overview(f.ids.productId)).jobs.at(-2)!.reused >= 4,
    );
  } finally {
    await f.close();
  }
});
test("projection delivery replays a failed unacknowledged event", async () => {
  const f = await fixture();
  try {
    let first = 0;
    await assert.rejects(
      () =>
        project(f.engine, "test-graph", async (e) => {
          first = Number(e.sequence);
          throw Error("Projection unavailable");
        }),
      /Projection unavailable/,
    );
    const received: number[] = [];
    await project(f.engine, "test-graph", async (e) => {
      received.push(Number(e.sequence));
    });
    assert.equal(received[0], first);
    assert.equal(
      (await project(f.engine, "test-graph", async () => {})).delivered,
      0,
    );
  } finally {
    await f.close();
  }
});
test("revoking Jira removes its questions and reviews even when code remains accessible", async () => {
  const f = await fixture();
  try {
    await finish(f);
    await f.engine.collectHistory(f.ids.sourceId, 1);
    await finish(f);
    const j = await f.engine.importJira(
      f.ids.productId,
      "fixture/ACL",
      [
        {
          id: "KAN-ACL",
          title: "Private intent",
          body: "Private policy",
          revision: "1",
        },
      ],
      { complete: true, fixture: true },
    );
    const b: any = await f.learning.next(f.ids.productId, "mock");
    await f.learning.publish(b.batchId, {
      ...empty,
      questions: [
        {
          question: "Private policy question?",
          reason: "Requires source permission",
          paths: ["policy.ts"],
          evidence: [b.evidence[0].id],
        },
      ],
    });
    const q = (await f.engine.overview(f.ids.productId)).questions[0];
    await f.engine.review(f.ids.productId, {
      targetId: q.id,
      expectedRevision: 0,
      action: "clarify",
      answer: "Private answer",
      reason: "Source clarification",
      actor: {
        id: "reviewer",
        name: "Reviewer",
        type: "human",
        identityBasis: "self-reported",
      },
    });
    await f.engine.revoke("sourceId" in j ? j.sourceId : "disabled");
    assert.equal(
      (await f.engine.overview(f.ids.productId)).questions.length,
      0,
    );
    await assert.rejects(
      () => f.engine.reviews(f.ids.productId, q.id),
      /access denied/,
    );
    await assert.rejects(
      () => f.engine.investigate(f.ids.productId, q.id),
      /access denied/,
    );
    assert.ok(
      !JSON.stringify(
        await f.context.context(f.ids.productId, "Private policy"),
      ).includes("Private answer"),
    );
  } finally {
    await f.close();
  }
});
test("context respects a small budget with a long task and large review", async () => {
  const f = await fixture();
  try {
    const b: any = await f.learning.next(f.ids.productId, "mock");
    await f.learning.publish(b.batchId, {
      ...empty,
      ...local(b),
      questions: [
        {
          question: "Payment policy?",
          reason: "Confirm expected roles",
          paths: ["policy.ts"],
          evidence: [b.evidence[0].id],
        },
      ],
    });
    const q = (await f.engine.overview(f.ids.productId)).questions[0];
    await f.engine.review(f.ids.productId, {
      targetId: q.id,
      expectedRevision: 0,
      action: "requirement",
      answer: "Manager payment ".repeat(1000),
      authority: { establishedBy: "Test policy owner" },
      reason: "Supplied policy",
      actor: {
        id: "test",
        name: "Test",
        type: "human",
        identityBasis: "self-reported",
      },
    });
    const p = await f.context.context(
      f.ids.productId,
      "payment ".repeat(1000),
      ["policy.ts"],
      3000,
    );
    assert.ok(JSON.stringify(p).length <= 3000);
    assert.equal(p.coverage.requirementsOmittedByBudget, 1);
    assert.equal(p.contextState, "partial-requirements-omitted");
  } finally {
    await f.close();
  }
});
test("agent assessment context preserves deferred answers without audit bloat or human attribution", async () => {
  const f = await fixture();
  try {
    const b: any = await f.learning.next(f.ids.productId, "mock-model");
    await f.learning.publish(b.batchId, {
      ...empty,
      ...local(b),
      questions: ["Payment role decision?", "Payment provider guarantee?"].map(
        (question) => ({
          question,
          reason: "Assessment needs attribution and uncertainty.",
          paths: ["policy.ts"],
          evidence: [b.evidence[0].id],
        }),
      ),
    });
    const questions = (await f.engine.overview(f.ids.productId)).questions;
    const actor = {
      id: "model-reviewer",
      name: "Model reviewer",
      type: "agent",
      identityBasis: "configured",
    };
    const decision = questions.find(
      (q: any) => q.question === "Payment role decision?",
    )!;
    const uncertain = questions.find(
      (q: any) => q.question === "Payment provider guarantee?",
    )!;
    const scope = {
      basis: "delegated-product-decision",
      implementationStatus: "not-implemented",
      assessment: { audit: "large-audit-detail ".repeat(4000) },
    };
    await f.engine.review(f.ids.productId, {
      targetId: decision.id,
      expectedRevision: 0,
      action: "clarify",
      answer: "old-answer-detail ".repeat(4000),
      reason: "Earlier draft",
      actor,
      scope,
    });
    await f.engine.review(f.ids.productId, {
      targetId: decision.id,
      expectedRevision: 1,
      action: "clarify",
      answer: "Chosen role policy; implementation unchanged.",
      reason: "Revised decision",
      actor,
      scope,
    });
    await f.engine.review(f.ids.productId, {
      targetId: uncertain.id,
      expectedRevision: 0,
      action: "defer",
      answer:
        "Provider guarantee remains unverified; require a complete session.",
      reason: "No hosted observation",
      actor,
      scope: { ...scope, factualGap: "No live provider observation." },
    });
    const packet = await f.context.context(
      f.ids.productId,
      "Payment role decision and provider guarantee",
      ["policy.ts"],
      10000,
    );
    assert.equal(packet.agentAssessments.length, 2);
    assert.equal(packet.humanClarifications.length, 0);
    assert.equal(packet.explicitRequirements.length, 0);
    assert.ok(
      packet.agentAssessments.every(
        (r: any) =>
          r.actor.type === "agent" &&
          r.new_value.verification === "not-verified",
      ),
    );
    assert.ok(
      packet.agentAssessments.some(
        (r: any) =>
          r.target_id === uncertain.id && r.new_value.state === "deferred",
      ),
    );
    assert.ok(!packet.unresolvedForTask.some((q: any) => q.id === decision.id));
    assert.ok(packet.unresolvedForTask.some((q: any) => q.id === uncertain.id));
    assert.ok(!JSON.stringify(packet).includes("old-answer-detail"));
    assert.ok(!JSON.stringify(packet).includes("large-audit-detail"));
    assert.ok(JSON.stringify(packet).length <= 10000);
    assert.equal(
      (await f.engine.reviews(f.ids.productId, decision.id)).length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("a crowded context preserves the scoped assessment for its visible uncertainty", async () => {
  const f = await fixture();
  try {
    const b: any = await f.learning.next(f.ids.productId, "mock");
    await f.learning.publish(b.batchId, {
      ...empty,
      ...local(b),
      questions: [
        "Payment role decision one?",
        "Payment role decision two?",
        "Payment provider guarantee?",
      ].map((question) => ({
        question,
        reason: "Review required",
        paths: ["policy.ts"],
        evidence: [b.evidence[0].id],
      })),
    });
    const qs = (await f.engine.overview(f.ids.productId)).questions;
    const uncertain = qs.find((q: any) => q.question.includes("guarantee"))!;
    for (const q of qs) {
      await f.engine.review(f.ids.productId, {
        targetId: q.id,
        expectedRevision: 0,
        action: q.id === uncertain.id ? "defer" : "clarify",
        answer:
          q.id === uncertain.id
            ? "Provider behavior is unverified. Proposed policy: require a complete session."
            : "Policy proposal. ".repeat(75),
        reason: "Scoped assessment",
        actor: {
          id: "agent",
          name: "Agent",
          type: "agent",
          identityBasis: "configured",
        },
        scope: { implementationStatus: "not-implemented" },
      });
    }
    const packet = await f.context.context(
      f.ids.productId,
      "Payment role decision",
      ["policy.ts"],
      10000,
    );
    assert.ok(packet.coverage.agentAssessmentsOmittedByBudget > 0);
    assert.ok(
      packet.agentAssessments.some((r: any) => r.target_id === uncertain.id),
    );
    const q = packet.unresolvedForTask.find((q: any) => q.id === uncertain.id);
    assert.equal(q.assessmentAvailable, true);
    assert.equal(q.assessmentIncluded, true);
    assert.ok(JSON.stringify(packet).length <= 10000);
  } finally {
    await f.close();
  }
});
test("a behavior correction retains source knowledge and queues scoped reconciliation", async () => {
  const f = await fixture();
  try {
    const b: any = await f.learning.next(f.ids.productId, "mock"),
      e = b.evidence.find((e: any) => e.path === "policy.ts");
    await f.learning.publish(b.batchId, {
      ...empty,
      ...local(b),
      findings: [
        {
          key: "payment-role",
          title: "Payment roles",
          statement: "Managers satisfy the payment predicate.",
          basis: "observation",
          temporal: "current",
          evidence: [e.id],
          paths: [e.path],
          conditions: [],
          exceptions: [],
          contradicts: [],
          checks: [],
          extensions: {},
        },
      ],
    });
    await finish(f);
    const finding = (await f.context.context(f.ids.productId, "payment roles"))
      .behaviors[0];
    await f.engine.collectHistory(f.ids.sourceId, 1);
    await finish(f);
    const corrected = await f.engine.correctBehavior(f.ids.productId, {
      behaviorId: finding.id,
      behaviorVersion: finding.version,
      answer: "The requested policy also allows assistants.",
      reason: "Explicit clarification of intended policy",
      actor: {
        id: "engineer",
        name: "Engineer",
        type: "human",
        identityBasis: "self-reported",
        executorId: "vr-agent",
      },
    });
    const p = await f.context.context(f.ids.productId, "payment roles");
    assert.equal(p.behaviors[0].statement, finding.statement);
    assert.equal(p.humanClarifications[0].actor.executorId, "vr-agent");
    assert.equal(
      p.humanClarifications[0].new_value.verification,
      "not-verified",
    );
    assert.equal(
      (
        await f.engine.investigationStatus(
          f.ids.productId,
          corrected.investigation.id,
        )
      ).maxCalls,
      4,
    );
    await assert.rejects(
      () =>
        f.engine.correctBehavior(f.ids.productId, {
          behaviorId: finding.id,
          behaviorVersion: 999,
        }),
      /Behavior changed/,
    );
    const investigation: any = await f.learning.next(f.ids.productId, "mock");
    assert.equal(investigation.stage, "investigation");
    const historical = investigation.evidence.find(
      (e: any) => e.kind === "git-diff",
    );
    assert.ok(
      historical,
      "Targeted investigation should include historical support",
    );
    await f.learning.publish(investigation.batchId, {
      ...empty,
      findings: [
        {
          key: "payment-role",
          title: "Earlier payment roles",
          statement: "An earlier predicate also accepted assistants.",
          basis: "observation",
          temporal: "historical",
          evidence: [historical.id],
          paths: [historical.path],
          conditions: [],
          exceptions: [],
          contradicts: [],
          checks: [],
          extensions: {},
        },
      ],
    });
    const after = await f.context.context(f.ids.productId, "payment roles");
    assert.equal(
      after.behaviors.find((b: any) => b.id === finding.id).statement,
      finding.statement,
    );
    assert.equal(
      after.behaviors.find((b: any) => b.id === finding.id).temporal,
      "current",
    );
    assert.ok(after.behaviors.some((b: any) => b.temporal === "historical"));
  } finally {
    await f.close();
  }
});
test("schema upgrades retain data and a newer incompatible schema is rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vr-migration-"));
  let db = await openDatabase(dir);
  try {
    await db.query(
      "INSERT INTO vr_products(id,name) VALUES('retained','Retained knowledge')",
    );
    await db.exec(
      "ALTER TABLE vr_questions DROP COLUMN source_ids; DELETE FROM vr_migrations WHERE version>1;",
    );
    await db.close();
    db = await openDatabase(dir);
    assert.equal(
      (await db.query("SELECT name FROM vr_products WHERE id='retained'"))
        .rows[0].name,
      "Retained knowledge",
    );
    assert.equal(
      Number(
        (await db.query("SELECT max(version) AS n FROM vr_migrations")).rows[0]
          .n,
      ),
      3,
    );
    await db.query("INSERT INTO vr_migrations(version) VALUES(99)");
    await db.close();
    await assert.rejects(() => openDatabase(dir), /newer VR schema/);
  } finally {
    await db.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spring annotations and Java lambdas retain the actual function identity", () => {
  const a = analyzeText(
    "BillController.java",
    '@RestController class BillController { @PostMapping("/pay") public Bill pay(@RequestBody BillDto dto) { return null; } @Autowired public BillController() {} public void hooks(){ var f = (String role) -> role.equals("manager"); } }',
  );
  assert.deepEqual(a.errors, []);
  assert.deepEqual(
    a.functions.slice(0, 3).map((f) => f.name),
    ["pay", "BillController", "hooks"],
  );
  assert.match(a.functions[3].name, /^lambda@/);
  assert.deepEqual(
    analyzeText(
      "BillDto.java",
      "record BillDto(UserType userType) {} enum UserType { MANAGER, ASSISTANT_MANAGER, CUSTOMER }",
    ).errors,
    [],
  );
});

test("graph retrieval explains source-backed relationships and revalidates after a dependency edit", async () => {
  const f = await fixture();
  try {
    const batch: any = await f.learning.next(f.ids.productId, "fixture-model");
    const form = batch.evidence.find((e: any) => e.path === "form.tsx");
    const policy = batch.evidence.find((e: any) => e.path === "policy.ts");
    const finding = (key: string, statement: string, evidence: any) => ({
      key,
      title: key,
      statement,
      conditions: [],
      exceptions: [],
      basis: "observation",
      temporal: "current",
      evidence: [evidence.id],
      contradicts: [],
      paths: [evidence.path],
      checks: [],
      extensions: {},
    });
    await f.learning.publish(batch.batchId, {
      ...empty,
      ...local(batch),
      findings: [
        finding(
          "submit-button",
          "The submit button uses canPay to control its disabled state.",
          form,
        ),
        finding(
          "manager-policy",
          "The shared predicate returns true for a manager role.",
          policy,
        ),
      ],
      relationships: [
        {
          from: "submit-button",
          to: "manager-policy",
          kind: "depends_on",
          basis:
            "Form imports canPay from the shared policy and uses its result for the disabled attribute.",
          evidence: [form.id, policy.id],
        },
      ],
    });
    await finish(f);
    let packet = await f.context.context(
      f.ids.productId,
      "submit button",
      [],
      16000,
    );
    assert.equal(
      packet.behaviors.length,
      2,
      "Graph expansion should retrieve the predicate missed by the lexical query",
    );
    assert.equal(packet.relationships.length, 1);
    const relation = packet.relationships[0];
    assert.equal(relation.kind, "depends_on");
    assert.equal(relation.basis, "model-inference");
    assert.match(relation.explanation, /imports canPay/);
    assert.deepEqual(
      new Set(relation.evidence.map((e: any) => e.id)),
      new Set([form.id, policy.id]),
    );
    assert.equal(relation.applicability, "matches-inspected-scope");
    await writeFile(
      path.join(f.root, "policy.ts"),
      "export const canPay = () => true;\n",
    );
    packet = await f.context.context(
      f.ids.productId,
      "submit button",
      [],
      16000,
    );
    assert.equal(
      packet.relationships[0].applicability,
      "needs-source-revalidation",
    );
    const small = await f.context.context(
      f.ids.productId,
      "submit button",
      [],
      3000,
    );
    assert.ok(JSON.stringify(small).length <= 3000);
    assert.ok(
      small.relationships.every((r: any) =>
        [r.from, r.to].every((id) =>
          small.behaviors.some((b: any) => b.id === id),
        ),
      ),
    );
  } finally {
    await f.close();
  }
});
