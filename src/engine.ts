import { randomUUID } from "node:crypto";
import { realpath, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Database, Sql } from "./database.js";
import {
  key,
  hash,
  json,
  Actor,
  type Unit,
  type Snapshot,
  type Stage,
} from "./contracts.js";
import { scan, git, history, PARSER, affectedPaths } from "./scanner.js";
import {
  PipelineConfig,
  flagsFor,
  stageEnabled,
  stageOrder,
  isIssueStage,
} from "./pipeline.js";
import type { ExternalItem } from "./connectors/contracts.js";
const inputHash = (u: Unit) =>
  key(
    u.path,
    u.contentHash,
    u.kind,
    u.start,
    u.end,
    u.metadata.characterOffset ?? 0,
  );
export class Engine {
  constructor(
    readonly db: Database,
    readonly directory: string,
    readonly principal = "local-user",
    readonly autoInvestigationLimit = 12,
  ) {}
  async source(id: string, tx: Sql = this.db) {
    const s = (
      await tx.query("SELECT * FROM vr_sources WHERE id=$1 AND enabled", [id])
    ).rows[0];
    if (!s || !(s.principals as string[]).includes(this.principal))
      throw Error("Source unavailable or access denied");
    return s;
  }
  async product(id: string) {
    const rows = (
      await this.db.query(
        "SELECT p.* FROM vr_products p WHERE p.id=$1 AND EXISTS(SELECT 1 FROM vr_sources s WHERE s.product_id=p.id AND s.enabled AND s.principals ? $2)",
        [id, this.principal],
      )
    ).rows;
    if (!rows.length) throw Error("Product unavailable or access denied");
    return rows[0];
  }
  async event(
    tx: Sql,
    product: string,
    kind: string,
    entity: string,
    version: number,
    payload: unknown,
  ) {
    await tx.query(
      "INSERT INTO vr_outbox(product_id,kind,entity_id,version,payload) VALUES($1,$2,$3,$4,$5)",
      [product, kind, entity, version, json(payload)],
    );
  }
  async configurePipeline(sourceId: string, value: unknown) {
    const pipeline = PipelineConfig.parse(value);
    return this.db.transaction(async (tx) => {
      const source = await this.source(sourceId, tx);
      if (source.kind !== "git")
        throw Error("Configure stages on the estate's Git source");
      const old = PipelineConfig.parse(source.attributes.pipeline ?? {});
      if (json(old) === json(pipeline)) return pipeline;
      await tx.query(
        "UPDATE vr_sources SET attributes=attributes || $2::jsonb,generation=generation+1 WHERE id=$1",
        [sourceId, json({ pipeline })],
      );
      for (const stage of stageOrder.filter((s) => s !== "investigation")) {
        const enabled = stageEnabled(stage, pipeline.stages);
        if (!enabled) {
          await tx.query(
            "UPDATE vr_batches SET state='interrupted',error='Stage disabled by estate configuration',finished_at=now() WHERE state='reserved' AND job_id IN (SELECT id FROM vr_jobs WHERE source_id=$1 AND stage=$2)",
            [sourceId, stage],
          );
          await tx.query(
            "UPDATE vr_jobs SET state='disabled',updated_at=now() WHERE source_id=$1 AND stage=$2 AND state IN ('pending','running','paused','failed')",
            [sourceId, stage],
          );
        } else {
          await tx.query(
            "UPDATE vr_jobs SET state='pending',updated_at=now() WHERE source_id=$1 AND stage=$2 AND state='disabled'",
            [sourceId, stage],
          );
        }
      }
      await this.event(
        tx,
        source.product_id,
        "pipeline.configured",
        sourceId,
        source.generation + 1,
        { previous: old, pipeline, actor: this.principal },
      );
      return pipeline;
    });
  }
  async sourceStatus(
    sourceId: string,
    stage: "jira" | "github-issues",
    status: {
      state: string;
      error?: string;
      count?: number;
      limitations?: string[];
    },
  ) {
    if (
      !isIssueStage(stage) ||
      ![
        "not-configured",
        "collecting",
        "ready",
        "empty",
        "partial",
        "failed",
      ].includes(status.state)
    )
      throw Error("Invalid external source status");
    return this.db.transaction(async (tx) => {
      const source = await this.source(sourceId, tx);
      if (source.kind !== "git")
        throw Error("Status belongs to the estate Git source");
      const value = {
        ...status,
        checkedAt: new Date().toISOString(),
        snapshotId: source.checkpoint,
      };
      await tx.query(
        "UPDATE vr_sources SET attributes=jsonb_set(attributes,'{externalStatus}',COALESCE(attributes->'externalStatus','{}'::jsonb) || $2::jsonb) WHERE id=$1",
        [sourceId, json({ [stage]: value })],
      );
      return value;
    });
  }
  async connect(
    name: string,
    root: string,
    exclude: string[] = [],
    productId?: string,
  ) {
    root = await realpath(root);
    const old = (
      await this.db.query(
        "SELECT * FROM vr_sources WHERE identity=$1 AND kind='git'",
        [root],
      )
    ).rows[0];
    if (old) {
      await this.source(old.id);
      if (productId && productId !== old.product_id)
        throw Error(
          "Repository already belongs to another product; use its existing estate.",
        );
      return { productId: old.product_id, sourceId: old.id };
    }
    if (productId) await this.product(productId);
    const product = productId ?? randomUUID(),
      source = randomUUID();
    await this.db.transaction(async (tx) => {
      if (!productId)
        await tx.query("INSERT INTO vr_products(id,name) VALUES($1,$2)", [
          product,
          name,
        ]);
      await tx.query(
        "INSERT INTO vr_sources(id,product_id,kind,identity,principals,attributes) VALUES($1,$2,'git',$3,$4,$5)",
        [source, product, root, json([this.principal]), json({ exclude })],
      );
    });
    return { productId: product, sourceId: source };
  }
  async insertEvidence(tx: Sql, source: string, u: Unit) {
    await tx.query(
      "INSERT INTO vr_evidence(id,source_id,path,revision,content_hash,kind,label,start_line,end_line,body,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING",
      [
        u.id,
        source,
        u.path,
        u.revision,
        u.contentHash,
        u.kind,
        u.label,
        u.start,
        u.end,
        u.text,
        json(u.metadata),
      ],
    );
  }
  async saveSnapshot(tx: Sql, source: string, s: Snapshot) {
    const sid = key(source, s.revision, s.fingerprint, s.overlay, PARSER);
    await tx.query(
      "INSERT INTO vr_snapshots(id,source_id,revision,fingerprint,overlay,coverage) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [
        sid,
        source,
        s.revision,
        s.fingerprint,
        s.overlay,
        json({
          inventory: s.files.length,
          included: s.files.filter((f) => f.status === "included").length,
          excluded: s.files.filter((f) => f.status === "excluded").length,
          functions: s.files.reduce((n, f) => n + f.functions, 0),
          units: s.units.length,
          errors: s.errors,
          parser: PARSER,
          branch: s.branch,
          unresolvedImports: s.links.filter((l) => !l.resolved).length,
        }),
      ],
    );
    for (const f of s.files)
      await tx.query(
        "INSERT INTO vr_files VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        [sid, f.path, f.hash, f.status, f.reason ?? null, f.functions, f.units],
      );
    for (const u of s.units) {
      await this.insertEvidence(tx, source, u);
      await tx.query(
        "INSERT INTO vr_snapshot_evidence VALUES($1,$2) ON CONFLICT DO NOTHING",
        [sid, u.id],
      );
    }
    for (const l of s.links)
      await tx.query(
        "INSERT INTO vr_edges VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [sid, l.from, l.to, l.kind, l.basis, l.resolved],
      );
    return sid;
  }
  async createJob(
    tx: Sql,
    source: any,
    sid: string,
    stage: Stage,
    work: Array<{ key: string; evidence: string[] }>,
    details: unknown = {},
  ) {
    const prior = (
      await tx.query(
        "SELECT id,details FROM vr_jobs WHERE snapshot_id=$1 AND stage=$2 ORDER BY created_at DESC LIMIT 1",
        [sid, stage],
      )
    ).rows[0];
    if (
      prior &&
      (["current", "connections"].includes(stage) ||
        (stage === "history" && prior.details.years === (details as any).years))
    )
      return prior.id;
    const id = randomUUID();
    await tx.query(
      "INSERT INTO vr_jobs(id,product_id,source_id,snapshot_id,stage,details) VALUES($1,$2,$3,$4,$5,$6)",
      [id, source.product_id, source.id, sid, stage, json(details)],
    );
    for (const unit of work) {
      const cache = (
        await tx.query(
          "SELECT 1 FROM vr_analysis_cache WHERE source_id=$1 AND stage=$2 AND input_hash=$3 AND parser_version=$4",
          [source.id, stage, unit.key, PARSER],
        )
      ).rows.length;
      await tx.query(
        "INSERT INTO vr_work(job_id,unit_id,evidence_ids,state) VALUES($1,$2,$3,$4)",
        [id, unit.key, json(unit.evidence), cache ? "reused" : "pending"],
      );
    }
    if (!stageEnabled(stage, flagsFor(source)))
      await tx.query("UPDATE vr_jobs SET state='disabled' WHERE id=$1", [id]);
    else if (!work.length)
      await tx.query("UPDATE vr_jobs SET state='completed' WHERE id=$1", [id]);
    return id;
  }
  async refresh(sourceId: string, ref = "HEAD", rootOverride?: string) {
    const source = await this.source(sourceId),
      analysisRoot =
        rootOverride ?? source.attributes.analysisRoot ?? source.identity;
    if (ref === "HEAD" && source.attributes.analysisRoot && source.remote_tip)
      ref = source.remote_tip;
    const s = await scan(analysisRoot, sourceId, {
      ref,
      exclude: source.attributes.exclude,
    });
    const sid = key(sourceId, s.revision, s.fingerprint, s.overlay, PARSER);
    if (source.checkpoint === sid)
      return { snapshotId: sid, unchanged: true, coverage: s.files.length };
    return this.db.transaction(async (tx) => {
      const locked = (
        await tx.query("SELECT * FROM vr_sources WHERE id=$1 FOR UPDATE", [
          sourceId,
        ])
      ).rows[0];
      if (locked.generation !== source.generation)
        throw Error("A newer source refresh won; retry using its checkpoint");
      await this.saveSnapshot(tx, sourceId, s);
      const previous = source.checkpoint
        ? (
            await tx.query(
              "SELECT path,content_hash FROM vr_files WHERE snapshot_id=$1",
              [source.checkpoint],
            )
          ).rows
        : [];
      const before = new Map(previous.map((f) => [f.path, f.content_hash])),
        after = new Map(s.files.map((f) => [f.path, f.hash]));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
        (p) => before.get(p) !== after.get(p),
      );
      const impacted = affectedPaths(changed, s.links);
      await tx.query(
        "UPDATE vr_sources SET checkpoint=$2,generation=generation+1,attributes=attributes || $3::jsonb WHERE id=$1",
        [
          sourceId,
          sid,
          json({
            branch: s.branch,
            revision: s.revision,
            ...(rootOverride ? { analysisRoot: rootOverride } : {}),
          }),
        ],
      );
      await tx.query(
        "UPDATE vr_jobs SET state='superseded',updated_at=now() WHERE source_id=$1 AND stage IN ('current','connections','estate-connections','history','jira','github-issues') AND snapshot_id<>$2 AND state<>'completed'",
        [sourceId, sid],
      );
      const current = await this.createJob(
        tx,
        source,
        sid,
        "current",
        s.units.map((u) => ({ key: inputHash(u), evidence: [u.id] })),
        { errors: s.errors, changed, impacted },
      );
      const work = [];
      for (const file of s.files.filter(
        (f) =>
          f.status === "included" && /\.(?:[cm]?[jt]sx?|java)$/.test(f.path),
      )) {
        const neighbors = s.links
          .filter(
            (l) => l.resolved && (l.from === file.path || l.to === file.path),
          )
          .map((l) => (l.from === file.path ? l.to : l.from));
        const paths = new Set([file.path, ...neighbors]);
        const evidence = s.units.filter((u) => paths.has(u.path));
        // Each local dependency neighborhood is revisited; large groups are split into bounded jobs.
        for (let i = 0; i < evidence.length; i += 8) {
          const part = evidence.slice(i, i + 8);
          work.push({
            key: key(file.path, part.map(inputHash)),
            evidence: part.map((u) => u.id),
          });
        }
      }
      const connections = await this.createJob(
        tx,
        source,
        sid,
        "connections",
        work,
        {
          grouping:
            "Resolved import neighborhoods; unresolved runtime dependencies remain explicit.",
        },
      );
      await this.event(
        tx,
        source.product_id,
        "source.refreshed",
        sourceId,
        source.generation + 1,
        { snapshotId: sid, changed, impacted },
      );
      return {
        snapshotId: sid,
        jobs: { current, connections },
        changed: changed.length,
        impacted: impacted.paths.length,
        coverage: {
          files: s.files.length,
          units: s.units.length,
          errors: s.errors,
        },
      };
    });
  }
  async collectHistory(sourceId: string, years: number) {
    if (!Number.isFinite(years) || years < 0 || years > 100)
      throw Error("History years must be between 0 and 100");
    const s = await this.source(sourceId);
    if (!flagsFor(s).historicalCode)
      return { disabled: true, stage: "history" };
    await this.requireStages(s.checkpoint, ["current", "connections"]);
    const snapshot = (
      await this.db.query("SELECT * FROM vr_snapshots WHERE id=$1", [
        s.checkpoint,
      ])
    ).rows[0];
    const existing = (
      await this.db.query(
        "SELECT * FROM vr_jobs WHERE snapshot_id=$1 AND stage='history' AND (details->>'years')::numeric=$2",
        [s.checkpoint, years],
      )
    ).rows[0];
    if (existing) return existing;
    const h = await history(
      s.attributes.analysisRoot ?? s.identity,
      s.id,
      snapshot.revision,
      years,
      s.attributes.exclude,
    );
    return this.db.transaction(async (tx) => {
      const live = (
        await tx.query(
          "SELECT checkpoint FROM vr_sources WHERE id=$1 FOR UPDATE",
          [s.id],
        )
      ).rows[0];
      if (live.checkpoint !== s.checkpoint)
        throw Error("Code changed during history collection");
      for (const u of h.units) await this.insertEvidence(tx, s.id, u);
      const id = await this.createJob(
        tx,
        s,
        s.checkpoint,
        "history",
        h.units.map((u) => ({ key: inputHash(u), evidence: [u.id] })),
        h.coverage,
      );
      return { id, ...h.coverage };
    });
  }
  async queueOverlay(sourceId: string) {
    const source = await this.source(sourceId);
    if (!flagsFor(source).currentCode)
      return { disabled: true, unchanged: true };
    await this.requireStages(source.checkpoint, ["current", "connections"]);
    const live = await scan(source.identity, sourceId, {
        overlay: true,
        exclude: source.attributes.exclude,
      }),
      files = (
        await this.db.query("SELECT * FROM vr_files WHERE snapshot_id=$1", [
          source.checkpoint,
        ])
      ).rows;
    const before = new Map(
        files
          .filter((f) => f.status !== "excluded")
          .map((f) => [f.path, f.content_hash]),
      ),
      after = new Map(
        live.files
          .filter((f) => f.status !== "excluded")
          .map((f) => [f.path, f.hash]),
      );
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (p) => before.get(p) !== after.get(p),
    );
    if (!changed.length) return { unchanged: true };
    const oldLinks = (
      await this.db.query("SELECT * FROM vr_edges WHERE snapshot_id=$1", [
        source.checkpoint,
      ])
    ).rows.map((e) => ({
      from: e.from_path,
      to: e.to_path,
      kind: e.kind,
      basis: e.basis,
      resolved: e.resolved,
    }));
    const impacted = affectedPaths(changed, [...oldLinks, ...live.links]);
    const scoped = {
      ...live,
      units: live.units.filter((u) => impacted.paths.includes(u.path)),
      errors: live.errors.filter((e) =>
        impacted.paths.some((p) => e.startsWith(p + ":")),
      ),
    };
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query(
          "SELECT checkpoint FROM vr_sources WHERE id=$1 FOR UPDATE",
          [sourceId],
        )
      ).rows[0];
      if (current.checkpoint !== source.checkpoint)
        throw Error("Committed checkpoint changed during local refresh");
      const sid = await this.saveSnapshot(tx, sourceId, scoped);
      const id = await this.createJob(
        tx,
        source,
        sid,
        "current",
        scoped.units.map((u) => ({
          key: key("overlay", sid, u.path, u.contentHash, u.start, u.end),
          evidence: [u.id],
        })),
        {
          localOverlay: true,
          baseCheckpoint: source.checkpoint,
          workspaceRoot: source.identity,
          worktreeFingerprint: live.fingerprint,
          changed,
          impacted,
          errors: scoped.errors,
        },
      );
      return {
        id,
        snapshotId: sid,
        units: scoped.units.length,
        changed,
        localOnly: true,
      };
    });
  }
  async requireStages(snapshot: string, stages: Stage[]) {
    const source = (
      await this.db.query(
        "SELECT s.* FROM vr_sources s JOIN vr_snapshots n ON n.source_id=s.id WHERE n.id=$1",
        [snapshot],
      )
    ).rows[0];
    for (const stage of stages.filter((s) =>
      stageEnabled(s, flagsFor(source)),
    )) {
      const job = (
        await this.db.query(
          "SELECT state,details FROM vr_jobs WHERE snapshot_id=$1 AND stage=$2 ORDER BY created_at DESC LIMIT 1",
          [snapshot, stage],
        )
      ).rows[0];
      if (!job || job.state !== "completed" || job.details.errors?.length)
        throw Error(`Finish the ${stage} stage before continuing`);
    }
  }
  async importJira(
    product: string,
    identity: string,
    items: IssueRecord[],
    options: IssueOptions = { complete: true },
  ) {
    return this.importIssues(product, "jira", identity, items, options);
  }
  async importIssues(
    product: string,
    kind: "jira" | "github-issues",
    identity: string,
    items: IssueRecord[],
    options: IssueOptions = { complete: true },
  ) {
    if (!isIssueStage(kind)) throw Error("Unsupported issue source");
    const gitSource = (
      await this.db.query(
        "SELECT * FROM vr_sources WHERE product_id=$1 AND kind='git' AND enabled AND principals ? $2 ORDER BY id LIMIT 1",
        [product, this.principal],
      )
    ).rows[0];
    await this.source(gitSource?.id);
    if (!stageEnabled(kind, flagsFor(gitSource)))
      return { disabled: true, stage: kind, issues: 0 };
    if (!gitSource.checkpoint)
      throw Error(
        "Create a structural code checkpoint before collecting external evidence",
      );
    const sid = key(product, kind, identity);
    return this.db.transaction(async (tx) => {
      const live = await this.source(gitSource.id, tx);
      if (!stageEnabled(kind, flagsFor(live)))
        throw Error("Issue stage was disabled during collection");
      const old = (
        await tx.query("SELECT * FROM vr_sources WHERE id=$1", [sid])
      ).rows[0];
      if (old && (!old.enabled || !old.principals.includes(this.principal)))
        throw Error("Source unavailable or access denied");
      const mergedItems = new Map(items.map((i) => [i.id, i]));
      const revisions = {
        ...old?.attributes.revisions,
        ...Object.fromEntries(
          [...mergedItems.values()].map((i) => [i.id, i.revision]),
        ),
      };
      await tx.query(
        "INSERT INTO vr_sources(id,product_id,kind,identity,principals,attributes) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET attributes=vr_sources.attributes || EXCLUDED.attributes,generation=vr_sources.generation+1",
        [
          sid,
          product,
          kind,
          identity,
          json([this.principal]),
          json({ ...options, revisions }),
        ],
      );
      for (const item of mergedItems.values()) {
        for (const unit of chunkIssue(sid, kind, item, !!options.fixture)) {
          await this.insertEvidence(tx, sid, unit);
        }
      }
      // A new reconciliation replaces unfinished work for this same source and checkpoint.
      await tx.query(
        "UPDATE vr_batches SET state='interrupted',error='New issue source revision collected',finished_at=now() WHERE state='reserved' AND job_id IN (SELECT id FROM vr_jobs WHERE source_id=$1 AND snapshot_id=$2 AND details->>'externalSource'=$3)",
        [live.id, live.checkpoint, sid],
      );
      await tx.query(
        "UPDATE vr_jobs SET state='superseded' WHERE source_id=$1 AND snapshot_id=$2 AND details->>'externalSource'=$3 AND state<>'completed'",
        [live.id, live.checkpoint, sid],
      );
      // Full retained collection is queued: unchanged ranges reuse the analysis cache.
      const retained = (
        await tx.query(
          "SELECT e.* FROM vr_evidence e JOIN vr_sources s ON s.id=e.source_id WHERE e.source_id=$1 AND s.attributes->'revisions'->>e.path=e.revision",
          [sid],
        )
      ).rows;
      const allWork = retained.map((e) => ({
        key: key(
          sid,
          inputHash({
            path: e.path,
            contentHash: e.content_hash,
            kind: e.kind,
            start: e.start_line,
            end: e.end_line,
            metadata: e.metadata,
          } as Unit),
          e.revision,
        ),
        evidence: [e.id],
      }));
      const job = await this.createJob(
        tx,
        live,
        live.checkpoint,
        kind,
        allWork,
        {
          ...options,
          externalSource: sid,
          ...(kind === "jira" ? { jiraSource: sid } : {}),
        },
      );
      const status = {
        state: options.error
          ? items.length
            ? "partial"
            : "failed"
          : options.complete
            ? retained.length
              ? "ready"
              : "empty"
            : "partial",
        count: new Set(retained.map((e) => e.path)).size,
        complete: options.complete,
        error: options.error,
        limitations: options.limitations,
        checkedAt: new Date().toISOString(),
        snapshotId: live.checkpoint,
      };
      await tx.query(
        "UPDATE vr_sources SET attributes=jsonb_set(attributes,'{externalStatus}',COALESCE(attributes->'externalStatus','{}'::jsonb) || $2::jsonb) WHERE id=$1",
        [live.id, json({ [kind]: status })],
      );
      await this.event(
        tx,
        product,
        `${kind}.ingested`,
        sid,
        (old?.generation ?? -1) + 1,
        { count: items.length, ...options },
      );
      return {
        sourceId: sid,
        jobId: job,
        issues: mergedItems.size,
        ...options,
      };
    });
  }
  async overview(product: string) {
    await this.product(product);
    const sources = (
      await this.db.query(
        "SELECT id,identity,kind,checkpoint,generation,remote_tip,remote_checked_at,attributes FROM vr_sources WHERE product_id=$1 AND enabled AND principals ? $2",
        [product, this.principal],
      )
    ).rows;
    const jobs = (
      await this.db.query(
        `SELECT j.*,count(w.unit_id)::int AS total,count(w.unit_id) FILTER(WHERE w.state IN ('completed','reused'))::int AS processed,count(w.unit_id) FILTER(WHERE w.state='reused')::int AS reused FROM vr_jobs j LEFT JOIN vr_work w ON w.job_id=j.id JOIN vr_sources s ON s.id=j.source_id WHERE j.product_id=$1 AND s.enabled AND s.principals ? $2 GROUP BY j.id ORDER BY j.created_at`,
        [product, this.principal],
      )
    ).rows;
    const questions = (
      await this.db.query(
        "SELECT q.* FROM vr_questions q WHERE product_id=$1 AND NOT EXISTS(SELECT 1 FROM vr_sources s WHERE q.source_ids ? s.id AND (NOT s.enabled OR NOT(s.principals ? $2))) ORDER BY created_at DESC",
        [product, this.principal],
      )
    ).rows;
    return {
      schemaVersion: 1,
      product: await this.product(product),
      sources,
      jobs,
      questions,
    };
  }
  async question(product: string, id: string, tx: Sql = this.db, lock = false) {
    const q = (
      await tx.query(
        "SELECT q.* FROM vr_questions q WHERE q.id=$1 AND q.product_id=$2 AND EXISTS(SELECT 1 FROM vr_sources allowed_source WHERE allowed_source.product_id=q.product_id AND allowed_source.enabled AND allowed_source.principals ? $3) AND NOT EXISTS(SELECT 1 FROM vr_sources s WHERE q.source_ids ? s.id AND (NOT s.enabled OR NOT(s.principals ? $3)))" +
          (lock ? " FOR UPDATE" : ""),
        [id, product, this.principal],
      )
    ).rows[0];
    if (!q) throw Error("Question unavailable or access denied");
    return q;
  }
  async investigationStatus(product: string, id: string) {
    await this.product(product);
    const job = (
      await this.db.query(
        "SELECT * FROM vr_jobs WHERE id=$1 AND product_id=$2 AND stage='investigation'",
        [id, product],
      )
    ).rows[0];
    if (!job) throw Error("Investigation unavailable");
    await this.question(product, job.details.questionId);
    return {
      id: job.id,
      state: job.state,
      calls: job.calls,
      maxCalls: job.details.maxCalls,
      updatedAt: job.updated_at,
      needsModelSession: ["pending", "paused"].includes(job.state),
    };
  }
  async review(product: string, input: any) {
    await this.product(product);
    const actor = Actor.parse(input.actor);
    if (!input.reason?.trim()) throw Error("A reason is required");
    if (!["clarify", "defer", "reopen", "requirement"].includes(input.action))
      throw Error("Unsupported review action");
    return this.db.transaction(async (tx) => {
      const q = await this.question(product, input.targetId, tx, true);
      if (q.revision !== input.expectedRevision)
        throw Error("This question changed; reload before saving");
      const old = (
          await tx.query(
            "SELECT * FROM vr_reviews WHERE target_id=$1 ORDER BY revision DESC LIMIT 1",
            [q.id],
          )
        ).rows[0],
        revision = q.revision + 1,
        id = randomUUID();
      if (
        ["clarify", "requirement"].includes(input.action) &&
        !input.answer?.trim()
      )
        throw Error("An answer is required");
      if (input.action === "requirement" && !input.authority?.establishedBy)
        throw Error(
          "Record the identified authority and scope of this supplied requirement",
        );
      const value = {
        answer: input.answer ?? null,
        authority: input.authority ?? null,
        verification: "not-verified",
        state:
          input.action === "defer"
            ? "deferred"
            : input.action === "reopen"
              ? "open"
              : "answered",
      };
      await tx.query(
        "INSERT INTO vr_reviews(id,product_id,target_id,revision,predecessor,actor,action,old_value,new_value,reason,scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          product,
          q.id,
          revision,
          old?.id ?? null,
          json(actor),
          input.action,
          json(old?.new_value ?? { question: q.question, state: q.state }),
          json(value),
          input.reason,
          json(input.scope ?? { paths: q.paths }),
        ],
      );
      await tx.query(
        "UPDATE vr_questions SET revision=$2,state=$3 WHERE id=$1",
        [q.id, revision, value.state],
      );
      await this.event(tx, product, "review.revised", q.id, revision, {
        id,
        actor,
      });
      return { id, revision, ...value };
    });
  }
  async reviews(product: string, target: string) {
    await this.question(product, target);
    return (
      await this.db.query(
        "SELECT * FROM vr_reviews WHERE product_id=$1 AND target_id=$2 ORDER BY revision",
        [product, target],
      )
    ).rows;
  }
  async correctBehavior(product: string, input: any) {
    await this.product(product);
    const b = (
      await this.db.query(
        `SELECT b.*,a.paths FROM vr_behaviors b JOIN vr_assertions a ON a.behavior_id=b.id AND a.revision=b.revision WHERE b.product_id=$1 AND b.id=$2 AND EXISTS(SELECT 1 FROM vr_support u WHERE u.behavior_id=b.id AND u.revision=b.revision) AND NOT EXISTS(SELECT 1 FROM vr_support u JOIN vr_evidence e ON e.id=u.evidence_id JOIN vr_sources s ON s.id=e.source_id WHERE u.behavior_id=b.id AND u.revision=b.revision AND (NOT s.enabled OR NOT(s.principals ? $3)))`,
        [product, input.behaviorId, this.principal],
      )
    ).rows[0];
    if (!b) throw Error("Behavior unavailable or access denied");
    if (b.revision !== input.behaviorVersion)
      throw Error(
        "Behavior changed; retrieve its latest version before correcting it",
      );
    const evidence = (
        await this.db.query(
          "SELECT e.id,e.source_id FROM vr_support u JOIN vr_evidence e ON e.id=u.evidence_id WHERE u.behavior_id=$1 AND u.revision=$2",
          [b.id, b.revision],
        )
      ).rows,
      id = key(product, "correction", b.id);
    await this.db.query(
      "INSERT INTO vr_questions(id,product_id,question,reason,paths,evidence,source_ids) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
      [
        id,
        product,
        `Correction to: ${b.title}`,
        "A supplied correction needs reconciliation against source evidence.",
        json(b.paths),
        json(evidence.map((e) => e.id)),
        json([...new Set(evidence.map((e) => e.source_id))]),
      ],
    );
    const q = await this.question(product, id);
    const result = await this.review(product, {
      ...input,
      targetId: id,
      expectedRevision: input.expectedReviewRevision ?? 0,
      action: "clarify",
      scope: { paths: b.paths, behaviorId: b.id, behaviorVersion: b.revision },
    });
    const investigation = await this.investigate(product, q.id, 4);
    return {
      ...result,
      questionId: q.id,
      investigation,
      verification: "not-verified",
    };
  }
  async investigate(
    product: string,
    questionId: string,
    budget = 8,
    automatic = false,
  ) {
    if (!Number.isInteger(budget) || budget < 1 || budget > 32)
      throw Error("Investigation budget must be 1–32 calls");
    const q = await this.question(product, questionId);
    const sources = (
      await this.db.query(
        "SELECT * FROM vr_sources WHERE product_id=$1 AND kind='git' AND enabled AND principals ? $2 ORDER BY id",
        [product, this.principal],
      )
    ).rows;
    if (!sources.length)
      throw Error("No accessible repositories for investigation");
    const s =
      sources.find((r: any) => q.source_ids?.includes(r.id)) ?? sources[0];
    const evidence = (
      await this.db.query(
        `SELECT DISTINCT e.* FROM vr_evidence e JOIN vr_sources source ON source.id=e.source_id WHERE source.product_id=$1 AND source.kind='git' AND source.enabled AND source.principals ? $2 AND (e.path=ANY($3::text[]) OR e.id=ANY($4::text[])) AND (EXISTS(SELECT 1 FROM vr_snapshot_evidence se WHERE se.snapshot_id=source.checkpoint AND se.evidence_id=e.id) OR EXISTS(SELECT 1 FROM vr_work w JOIN vr_jobs j ON j.id=w.job_id WHERE j.snapshot_id=source.checkpoint AND j.stage='history' AND w.evidence_ids ? e.id)) ORDER BY kind,path,revision`,
        [product, this.principal, q.paths, q.evidence],
      )
    ).rows;
    const work = evidence.map((e) => ({
      key: key(questionId, q.revision, e.id),
      evidence: [e.id],
    }));
    const clarification = (await this.reviews(product, q.id)).at(-1);
    const id = await this.db.transaction((tx) =>
      this.createJob(tx, s, s.checkpoint, "investigation", work, {
        questionId,
        sourceCheckpoints: Object.fromEntries(
          sources.map((s: any) => [s.id, s.checkpoint]),
        ),
        question: q.question,
        reason: q.reason,
        clarification: clarification
          ? {
              answer: clarification.new_value.answer,
              actor: clarification.actor,
              scope: clarification.scope,
              authority: clarification.new_value.authority,
              verification: "not-verified",
            }
          : null,
        maxCalls: budget,
        automatic,
        noEvidence: !work.length,
      }),
    );
    return {
      id,
      status: work.length ? "pending-model-session" : "no-evidence-in-scope",
      budget,
    };
  }
  async pollRemote(sourceId: string) {
    const s = await this.source(sourceId);
    if (s.kind !== "git") throw Error("Git source required");
    const remote = (
      await git(s.identity, "remote", "get-url", "origin").catch(() => "")
    ).trim();
    if (!remote) return { available: false, reason: "No origin remote" };
    const mirror = path.join(this.directory, "mirrors", s.id);
    await mkdir(mirror, { recursive: true });
    await git(mirror, "init", "--bare", "-q");
    await git(mirror, "fetch", "--no-tags", remote, "+HEAD:refs/vr/observed");
    const tip = (await git(mirror, "rev-parse", "refs/vr/observed")).trim();
    await this.db.query(
      "UPDATE vr_sources SET remote_tip=$2,remote_checked_at=now() WHERE id=$1",
      [s.id, tip],
    );
    const refresh = await this.refresh(s.id, tip, mirror);
    return {
      tip,
      refresh,
      localCheckoutModified: false,
      semanticRefresh:
        "unchanged" in refresh
          ? "No source changes"
          : "Queued for a user-started model session",
    };
  }
  async revoke(sourceId: string) {
    const s = await this.source(sourceId);
    await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE vr_sources SET enabled=false,generation=generation+1 WHERE id=$1",
        [sourceId],
      );
      await this.event(
        tx,
        s.product_id,
        "source.revoked",
        sourceId,
        s.generation + 1,
        {},
      );
    });
    return { revoked: true };
  }
}
type IssueRecord = Pick<ExternalItem, "id" | "title" | "body" | "revision"> &
  Partial<ExternalItem>;
type IssueOptions = {
  complete: boolean;
  fixture?: boolean;
  limitations?: string[];
  error?: string;
};
function chunkIssue(
  source: string,
  kind: string,
  item: IssueRecord,
  fixture: boolean,
): Unit[] {
  const units: Unit[] = [];
  // Bounded model inputs retain exact character and line anchors in the normalized record.
  for (let offset = 0; offset < Math.max(1, item.body.length); offset += 8000) {
    const text = item.body.slice(offset, offset + 8000),
      start = 1 + item.body.slice(0, offset).split("\n").length - 1;
    units.push({
      id: key(source, item.id, item.revision, offset, hash(text)),
      path: item.id,
      revision: item.revision,
      contentHash: hash(text),
      kind,
      label: item.title,
      start,
      end: start + text.split("\n").length - 1,
      text,
      metadata: {
        ...item.metadata,
        url: item.url,
        sourceCreatedAt: item.sourceCreatedAt,
        sourceUpdatedAt: item.sourceUpdatedAt,
        fixture,
        intentOnly: true,
        characterOffset: offset,
        recordCharacters: item.body.length,
      },
    });
  }
  return units;
}
export { inputHash };
