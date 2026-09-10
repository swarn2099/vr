import { queueEstateConnections } from "./estate.js";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "./database.js";
import { Engine } from "./engine.js";
import { Learning } from "./learning.js";
import { ContextService, PostgresRetrieval } from "./retrieval.js";
import { errorText } from "./contracts.js";
import { acquireServiceLock } from "./service-lock.js";
import { learningCoverage } from "./coverage.js";
export async function serve(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unlock = await acquireServiceLock(directory);
  let db;
  try {
    db = await openDatabase(directory, process.env.VR_DATABASE_URL);
  } catch (e) {
    await unlock();
    throw e;
  }
  const engine = new Engine(
      db,
      directory,
      "local-user",
      Math.max(
        0,
        Math.min(100, Number(process.env.VR_MAX_AUTO_INVESTIGATIONS ?? 12)),
      ),
    ),
    learning = new Learning(engine),
    context = new ContextService(
      engine,
      new PostgresRetrieval(engine, process.env.VR_SEMANTIC_SEARCH === "1"),
    );
  const readToken = randomBytes(32).toString("hex"),
    managementToken = randomBytes(32).toString("hex");
  const reporter = (p: any) =>
    p.initiator
      ? {
          id: p.initiator.id,
          name: p.initiator.name,
          type: "human",
          identityBasis: "self-reported",
          executorId: "vr-agent",
        }
      : {
          id: "vr-agent",
          name: "Agent reporting conversation clarification",
          type: "agent",
          identityBasis: "configured",
        };
  const methods: Record<string, (p: any) => Promise<any>> = {
    connect: (p) => engine.connect(p.name, p.root, p.exclude, p.productId),
    "estate.connections": (p) => queueEstateConnections(engine, p.productId),
    "pipeline.configure": (p) =>
      engine.configurePipeline(p.sourceId, p.pipeline),
    "source.status": (p) => engine.sourceStatus(p.sourceId, p.stage, p.status),
    "github.import": (p) =>
      engine.importIssues(
        p.productId,
        "github-issues",
        p.identity,
        p.items,
        p.options,
      ),
    refresh: (p) => engine.refresh(p.sourceId, p.ref),
    "overlay.queue": (p) => engine.queueOverlay(p.sourceId),
    status: async (p) => {
      const o = await engine.overview(p.productId);
      return {
        schemaVersion: 1,
        product: o.product.name,
        sources: o.sources.map((s) => ({
          id: s.id,
          kind: s.kind,
          checkpoint: s.checkpoint,
          generation: s.generation,
        })),
        ...learningCoverage(o),
        unresolvedQuestions: o.questions.filter((q) => q.state === "open")
          .length,
        automaticInvestigationLimit: engine.autoInvestigationLimit,
        coverageIsNotCompletenessProof: true,
      };
    },
    overview: (p) => engine.overview(p.productId),
    "retrieval.configure": async (p) => {
      if (typeof p.semantic !== "boolean")
        throw Error("semantic must be boolean");
      (context.retrieval as PostgresRetrieval).semantic = p.semantic;
      return { semantic: p.semantic };
    },
    history: (p) => engine.collectHistory(p.sourceId, p.years),
    "learn.next": (p) =>
      learning.next(p.productId, p.model, p.charBudget, p.stages),
    "learn.publish": (p) =>
      learning.publish(p.batchId, p.proposal, p.inputTokens, p.outputChars),
    "learn.fail": (p) => learning.fail(p.batchId, p.error),
    "learn.request": async (p) => {
      await db.query(
        "UPDATE vr_batches SET request=$2,input_tokens=$3 WHERE id=$1 AND state='reserved'",
        [
          p.batchId,
          JSON.stringify({ prompt: p.prompt, version: p.promptVersion }),
          p.inputTokens,
        ],
      );
      return { saved: true };
    },
    "learn.response": async (p) => {
      await db.query(
        "UPDATE vr_batches SET raw_response=$2,output_chars=$3,input_tokens=$4 WHERE id=$1 AND state='reserved'",
        [p.batchId, p.text, p.text.length, p.inputTokens],
      );
      return { saved: true };
    },
    "jira.import": (p) =>
      engine.importJira(p.productId, p.identity, p.items, p.options),
    review: (p) => engine.review(p.productId, p),
    reviews: (p) => engine.reviews(p.productId, p.targetId),
    "investigation.status": (p) =>
      engine.investigationStatus(p.productId, p.id),
    "behavior.correct": (p) =>
      engine.correctBehavior(p.productId, { ...p, actor: reporter(p) }),
    "clarification.record": (p) =>
      engine.review(p.productId, {
        targetId: p.questionId,
        expectedRevision: p.expectedRevision,
        action: "clarify",
        answer: p.answer,
        reason: p.reason,
        actor: reporter(p),
        scope: {
          provenance: "agent-reported-user-statement",
          humanIdentityVerified: false,
        },
      }),
    investigate: (p) => engine.investigate(p.productId, p.questionId, p.budget),
    revoke: (p) => engine.revoke(p.sourceId),
    "remote.poll": (p) => engine.pollRemote(p.sourceId),
    vr_context: (p) =>
      context.context(
        p.productId,
        p.task,
        p.focusPaths,
        p.charBudget,
        p.workspaceRoot,
        p.buffers,
      ),
    vr_evidence: (p) => context.evidence(p.productId, p.ids, p.charBudget),
    index: (p) => context.index(p.productId, p.limit),
    receipt: async (p) => {
      await db.query(
        "INSERT INTO vr_receipts(id,product_id,kind,details) VALUES($1,$2,$3,$4)",
        [
          randomBytes(16).toString("hex"),
          p.productId,
          p.kind,
          JSON.stringify(p.details),
        ],
      );
      return { recorded: true };
    },
  };
  const readOnly = new Set([
    "status",
    "overview",
    "reviews",
    "vr_context",
    "vr_evidence",
    "receipt",
    "investigate",
    "investigation.status",
    "clarification.record",
    "behavior.correct",
  ]);
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const auth = req.headers.authorization;
    const management = auth === `Bearer ${managementToken}`;
    if (!management && auth !== `Bearer ${readToken}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.url === "/health") {
      res.end(
        JSON.stringify({ version: "vr-portable-0.2.0", pid: process.pid }),
      );
      return;
    }
    if (req.url !== "/rpc" || req.method !== "POST") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    try {
      let body = "";
      for await (const part of req) {
        body += part;
        if (body.length > 4 * 1024 * 1024) throw Error("Request exceeds 4 MiB");
      }
      const { method, params = {} } = JSON.parse(body);
      if (!methods[method] || (!management && !readOnly.has(method)))
        throw Error("Operation not available for this token");
      res.end(JSON.stringify({ result: await methods[method](params) }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: errorText(e) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as any;
  const connection = {
    url: `http://127.0.0.1:${address.port}`,
    readToken,
    managementToken,
    pid: process.pid,
    version: "vr-portable-0.2.0",
  };
  await writeFile(
    path.join(directory, "connection.json"),
    JSON.stringify(connection),
    { mode: 0o600 },
  );
  await chmod(path.join(directory, "connection.json"), 0o600);
  return {
    connection,
    engine,
    learning,
    context,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      await unlock();
    },
  };
}
