import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../src/scanner.js";
import { openDatabase } from "../src/database.js";
import { Engine } from "../src/engine.js";
import { Learning, preparePrompt } from "../src/learning.js";
import { ContextService } from "../src/retrieval.js";
import {
  discoverRepositories,
  queueEstateConnections,
  integrationSignals,
} from "../src/estate.js";
import { readJiraProject, jiraSearchTools } from "../src/portable-jira.js";
import { runEstate, type EstateManifest } from "../src/estate-runner.js";

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vr-multiple-"));
  const roots = [path.join(dir, "web"), path.join(dir, "services", "billing")];
  for (const [i, root] of roots.entries()) {
    await mkdir(root, { recursive: true });
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "VR test");
    await git(root, "config", "user.email", "test@example.invalid");
    await writeFile(
      path.join(root, "same.ts"),
      i === 0
        ? 'export function pay(){ return fetch("/api/bills/pay"); }'
        : 'export function pay(role:string){ return role === "manager"; }\nexport const route="/api/bills/pay";',
    );
    if (i === 1)
      await writeFile(
        path.join(root, "BillController.java"),
        'class BillController { public boolean allowed(String role) { return role.equals("manager"); } }',
      );
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "Initial rule");
  }
  const db = await openDatabase(path.join(dir, ".vr-estate", "state"));
  const engine = new Engine(
    db,
    path.join(dir, ".vr-estate", "state"),
    "local-user",
    0,
  );
  const a = await engine.connect("Spend", roots[0]);
  const b = await engine.connect("Spend", roots[1], [], a.productId);
  for (const id of [a.sourceId, b.sourceId]) {
    await engine.configurePipeline(id, {
      version: 1,
      stages: {
        currentCode: true,
        historicalCode: false,
        jira: false,
        githubIssues: false,
      },
    });
    await engine.refresh(id);
  }
  return {
    dir,
    roots,
    db,
    engine,
    a,
    b,
    learning: new Learning(engine),
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function fixtureProposal(b: any) {
  return {
    analyses:
      b.stage === "current"
        ? b.evidence.map((e: any) => ({
            evidence: e.id,
            summary: "Fixture source summary",
            symbols: (e.metadata.functions ?? [])
              .filter(
                (f: any) => f.start >= e.start_line && f.start <= e.end_line,
              )
              .map((f: any) => ({
                name: f.name,
                start: f.start,
                summary: "Fixture symbol interpretation",
              })),
          }))
        : [],
    findings:
      b.stage === "current"
        ? [
            {
              key: "same-rule",
              title: "Payment approval",
              statement: "Fixture payment behavior scoped to its repository.",
              conditions: [],
              exceptions: [],
              basis: "observation",
              temporal: "current",
              evidence: [b.evidence[0].id],
              contradicts: [],
              paths: [b.evidence[0].path],
              checks: [],
              extensions: {},
            },
          ]
        : b.stage === "estate-connections"
          ? [
              {
                key: "cross-payment",
                title: "Frontend payment uses the billing contract",
                statement:
                  "Fixture inference connects the frontend and backend route.",
                conditions: [],
                exceptions: [],
                basis: "inference",
                temporal: "current",
                evidence: b.evidence.map((e: any) => e.id),
                contradicts: [],
                paths: ["same.ts"],
                checks: [],
                extensions: {},
              },
            ]
          : [],
    relationships: [],
    questions: [],
  };
}
async function drain(f: Awaited<ReturnType<typeof fixture>>, stages: string[]) {
  let calls = 0;
  while (true) {
    const b: any = await f.learning.next(
      f.a.productId,
      "fixture",
      40000,
      stages,
    );
    if (b.done) break;
    assert.ok(!b.waiting);
    await f.learning.publish(b.batchId, fixtureProposal(b));
    calls++;
  }
  return calls;
}

test("discovers nested repositories, skips dependencies and symlinks, keeps one product and repository-qualified source freshness", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.dir, "node_modules", "ignore"), {
      recursive: true,
    });
    await symlink(f.roots[0], path.join(f.dir, "alias"));
    const discovered = await discoverRepositories(f.dir);
    assert.deepEqual(
      discovered.repositories,
      (await Promise.all(f.roots.map((r) => realpath(r)))).sort(),
    );
    assert.equal(f.a.productId, f.b.productId);
    assert.equal((await f.engine.overview(f.a.productId)).sources.length, 2);
    assert.equal(
      (await f.engine.connect("Spend", f.roots[0], [], f.a.productId)).sourceId,
      f.a.sourceId,
    );
    const other = await f.engine.connect(
      "Another",
      await mkRepo(f.dir, "other"),
    );
    await assert.rejects(
      () => f.engine.connect("Spend", f.roots[0], [], other.productId),
      /already belongs/,
    );
    await drain(f, ["current", "connections"]);
    const aliases = (
      await f.db.query("SELECT alias FROM vr_behaviors WHERE product_id=$1", [
        f.a.productId,
      ])
    ).rows.map((x) => x.alias);
    assert.equal(new Set(aliases).size, 2);
    const context = new ContextService(f.engine);
    const p = await context.context(
      f.a.productId,
      "payment approval",
      ["same.ts"],
      30000,
      f.dir,
    );
    assert.equal(p.freshness.length, 2);
    assert.ok(
      p.behaviors.every(
        (b: any) => b.applicability === "matches-inspected-scope",
      ),
    );
    await writeFile(
      path.join(f.roots[0], "same.ts"),
      "export function pay(){ return false; }",
    );
    const changed = await context.context(
      f.a.productId,
      "payment approval",
      ["same.ts"],
      30000,
      f.dir,
    );
    const same = changed.behaviors.find((b: any) =>
      b.evidence.some((e: any) => e.sourceId === f.b.sourceId),
    );
    assert.equal(
      same?.applicability,
      "matches-inspected-scope",
      "same relative filename in other repo must stay fresh",
    );
  } finally {
    await f.close();
  }
});
async function mkRepo(parent: string, name: string) {
  const r = path.join(parent, name);
  await mkdir(r);
  await git(r, "init", "-q");
  await git(r, "config", "user.name", "Test");
  await git(r, "config", "user.email", "x@example.invalid");
  await writeFile(path.join(r, "a.ts"), "export const a=1;");
  await git(r, "add", ".");
  await git(r, "commit", "-qm", "test");
  return r;
}

test("cross-repository candidates are reconciled, cached, and reject a changed participating repository", async () => {
  const f = await fixture();
  try {
    assert.equal(
      ((await queueEstateConnections(f.engine, f.a.productId)) as any).waiting,
      true,
    );
    await drain(f, ["current", "connections"]);
    const q: any = await queueEstateConnections(f.engine, f.a.productId);
    assert.ok(q.candidatePairs >= 1);
    const b: any = await f.learning.next(f.a.productId, "fixture", 40000, [
      "estate-connections",
    ]);
    assert.equal(new Set(b.evidence.map((e: any) => e.source_id)).size, 2);
    assert.match(preparePrompt(b).prompt, /sourceId/);
    await writeFile(
      path.join(f.roots[1], "same.ts"),
      'export const route="/api/bills/pay"; export const changed=true;',
    );
    await git(f.roots[1], "add", ".");
    await git(f.roots[1], "commit", "-qm", "backend changed");
    await f.engine.refresh(f.b.sourceId);
    await assert.rejects(
      () => f.learning.publish(b.batchId, fixtureProposal(b)),
      /repository changed|checkpoint changed/i,
    );
    await f.learning.fail(b.batchId, "Fixture rejected stale response");
    await drain(f, ["current", "connections"]);
    await queueEstateConnections(f.engine, f.a.productId);
    await drain(f, ["estate-connections"]);
    const q2: any = await queueEstateConnections(f.engine, f.a.productId);
    assert.equal(q2.unchanged, true);
    const c = await new ContextService(f.engine).context(
      f.a.productId,
      "frontend payment billing contract",
      [],
      30000,
      f.dir,
    );
    assert.ok(
      c.behaviors.some(
        (b: any) => b.evidence.length >= 2 && b.basis === "inference",
      ),
    );
  } finally {
    await f.close();
  }
});

test("Jira supports company-hosted offset tools and Cloud cursor tools, reports missing pagination, refuses out-of-project evidence", async () => {
  const tool = {
    name: "mcp_company_jira_search",
    inputSchema: {
      type: "object",
      properties: {
        jql: { type: "string" },
        start_at: { type: "integer" },
        limit: { type: "integer" },
        fields: { type: "string" },
      },
      required: ["jql"],
    },
  };
  const inputs: any[] = [];
  const issue = (n: number) => ({
    id: String(n),
    key: "SPEND-" + n,
    summary: "Bill rule " + n,
    description: "Manager approval",
    updated: "2026-09-10",
    status: "Done",
  });
  const r = await readJiraProject(
    tool,
    { site: "https://jira.example.invalid", project: "SPEND" },
    async (_, p) => {
      inputs.push(p);
      return {
        issues: [issue(p.start_at + 1)],
        total: 2,
        start_at: p.start_at,
      };
    },
  );
  assert.equal(r.items.length, 2);
  assert.equal(r.partial, false);
  assert.equal(inputs[1].start_at, 1);
  assert.ok(!("cloudId" in inputs[0]));
  assert.equal(typeof inputs[0].fields, "string");
  const partial = await readJiraProject(
    tool,
    { site: "https://jira.example.invalid", project: "SPEND" },
    async () => [issue(1)],
  );
  assert.equal(partial.partial, true);
  assert.equal(partial.items.length, 1);
  await assert.rejects(
    () =>
      readJiraProject(
        tool,
        { site: "https://jira.example.invalid", project: "SPEND" },
        async () => ({ issues: [{ ...issue(1), key: "OTHER-1" }], total: 1 }),
      ),
    /outside/,
  );
  const cloud = {
    name: "mcp_atlassian_searchJiraIssuesUsingJql",
    inputSchema: {
      properties: { jql: {}, cloudId: {}, nextPageToken: {}, maxResults: {} },
      required: ["jql", "cloudId"],
    },
  };
  let pages = 0;
  const c = await readJiraProject(
    cloud,
    {
      site: "https://example.atlassian.net",
      project: "SPEND",
      cloudId: "site-id",
    },
    async (_, p) => {
      pages++;
      assert.equal(p.cloudId, "site-id");
      return {
        issues: [issue(pages)],
        nextPageToken: pages === 1 ? "next" : undefined,
        isLast: pages === 2,
      };
    },
  );
  assert.equal(c.items.length, 2);
  assert.equal(c.partial, false);
  assert.equal(
    jiraSearchTools([
      { name: "jira_delete", inputSchema: { properties: { jql: {} } } },
    ]).length,
    0,
  );
});

test("full estate runner advances all repositories, tolerates Jira failure, persists progress and resumes without repeat model work", async () => {
  const f = await fixture();
  try {
    const m: EstateManifest = {
      version: 1,
      name: "Spend",
      root: f.dir,
      state: path.join(f.dir, ".vr-estate/state"),
      productId: f.a.productId,
      requestId: "test",
      repositories: f.roots.map((root, i) => ({
        root,
        sourceId: i ? f.b.sourceId : f.a.sourceId,
      })),
      maxCalls: 50,
      historyYears: 0,
      semanticSearch: false,
      stages: {
        currentCode: true,
        historicalCode: false,
        jira: true,
        githubIssues: false,
      },
    };
    const call = async (method: string, p: any = {}) => {
      switch (method) {
        case "learn.next":
          return f.learning.next(p.productId, p.model, p.charBudget, p.stages);
        case "learn.publish":
          return f.learning.publish(p.batchId, p.proposal);
        case "learn.fail":
          return f.learning.fail(p.batchId, p.error);
        case "learn.request":
        case "learn.response":
          return {};
        case "estate.connections":
          return queueEstateConnections(f.engine, p.productId);
        case "overview":
          return f.engine.overview(p.productId);
        case "source.status":
          return f.engine.sourceStatus(p.sourceId, p.stage, p.status);
        case "overlay.queue":
          return f.engine.queueOverlay(p.sourceId);
        default:
          throw Error(method);
      }
    };
    const events: any[] = [];
    const host = {
      model: "fixture",
      interpret: async (b: any) => {
        const p = fixtureProposal(b);
        const ids = new Map(
          b.evidence.map((e: any, i: number) => [e.id, "E" + (i + 1)]),
        );
        for (const a of p.analyses) a.evidence = ids.get(a.evidence);
        for (const a of p.findings)
          a.evidence = a.evidence.map((id: any) => ids.get(id));
        return { text: JSON.stringify(p), tokens: 1 };
      },
      collectJira: async () => {
        throw Error("Fixture Jira unavailable");
      },
      cancelled: () => false,
      report: async (e: any) => {
        events.push(e);
      },
    };
    const result = await runEstate(m, call, host);
    assert.equal(result.phase, "ready-with-gaps");
    assert.equal(result.optionalFailures.length, 1);
    assert.ok(result.calls > 0);
    assert.ok(events.some((e) => e.phase === "estate-connections"));
    const second = await runEstate(m, call, host);
    assert.equal(second.calls, 0);
  } finally {
    await f.close();
  }
});

test("route suffixes connect configured API prefixes as candidates, never as proven facts", () => {
  assert.ok(
    integrationSignals('fetch("/api/bills/approve")').includes(
      "route-tail:approve",
    ),
  );
  assert.ok(
    integrationSignals('@PostMapping("/approve")').includes(
      "route-tail:approve",
    ),
  );
});
