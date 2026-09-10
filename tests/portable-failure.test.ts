import test from "node:test";
import assert from "node:assert/strict";
import { runEstate, type EstateManifest } from "../src/estate-runner.js";
const m: EstateManifest = {
  version: 1,
  root: "/fixture",
  state: "/state",
  name: "Test",
  productId: "product",
  requestId: "run",
  repositories: [{ sourceId: "source", root: "/fixture" }],
  historyYears: 0,
  maxCalls: 1,
  semanticSearch: false,
  stages: {
    currentCode: true,
    historicalCode: false,
    jira: false,
    githubIssues: false,
  },
};
const batch = {
  batchId: "b1",
  stage: "current",
  details: {},
  evidence: [
    {
      id: "e1",
      path: "app.ts",
      revision: "abc",
      body: "export const a=1",
      start_line: 1,
      end_line: 1,
      metadata: { functions: [] },
    },
  ],
  catalog: [],
};
test("budget exhaustion releases the reserved batch and cannot be reported as ready", async () => {
  let count = 0;
  const failed: any[] = [];
  const events: any[] = [];
  const call = async (method: string, p: any) => {
    if (method === "learn.next") return { ...batch, batchId: "b" + ++count };
    if (method === "learn.fail") {
      failed.push(p);
      return {};
    }
    if (method === "overview") return { sources: [], jobs: [], questions: [] };
    return {};
  };
  await assert.rejects(
    () =>
      runEstate(m, call, {
        model: "fixture",
        cancelled: () => false,
        collectJira: async () => {},
        report: async (e) => {
          events.push(e);
        },
        interpret: async () => ({
          text: JSON.stringify({
            analyses: [{ evidence: "E1", summary: "Fixture", symbols: [] }],
            findings: [],
            relationships: [],
            questions: [],
          }),
        }),
      }),
    /budget reached/,
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].batchId, "b2");
  assert.ok(!events.some((e) => e.phase === "ready"));
});
test("cancelled setup does not call a model or claim readiness", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runEstate(
        m,
        async () => {
          calls++;
        },
        {
          model: "fixture",
          cancelled: () => true,
          collectJira: async () => {},
          report: async () => {},
          interpret: async () => {
            throw Error("must not call");
          },
        },
      ),
    /cancelled/,
  );
  assert.equal(calls, 0);
});
