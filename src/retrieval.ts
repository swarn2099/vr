import { randomUUID } from "node:crypto";
import { Engine } from "./engine.js";
import { scan, affectedPaths, git } from "./scanner.js";
import { json, key, type Link } from "./contracts.js";
import { embed, EMBEDDING_ID } from "./embeddings.js";
import path from "node:path";
import { learningCoverage } from "./coverage.js";
// A projection can propose stable IDs; authoritative hydration always rechecks access and revision.
export interface RetrievalAdapter {
  searchCandidates(
    product: string,
    query: string,
    paths: string[],
    limit: number,
  ): Promise<Array<{ id: string; score: number; method: string }>>;
  expandRelationships(
    product: string,
    ids: string[],
    limit: number,
  ): Promise<string[]>;
  hydrate(product: string, ids: string[]): Promise<any[]>;
  relationshipDetails?(
    product: string,
    ids: string[],
    limit: number,
  ): Promise<any[]>;
}
const allowed = `EXISTS(SELECT 1 FROM vr_support u WHERE u.behavior_id=b.id AND u.revision=b.revision)
 AND NOT EXISTS(SELECT 1 FROM vr_support u JOIN vr_evidence e ON e.id=u.evidence_id JOIN vr_sources s ON s.id=e.source_id WHERE u.behavior_id=b.id AND u.revision=b.revision AND (NOT s.enabled OR NOT (s.principals ? $2)))`;
export class PostgresRetrieval implements RetrievalAdapter {
  constructor(
    readonly engine: Engine,
    public semantic = false,
  ) {}
  async searchCandidates(
    product: string,
    query: string,
    paths: string[],
    limit = 40,
  ) {
    const terms = (query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])
        .filter(
          (t) =>
            ![
              "the",
              "and",
              "with",
              "that",
              "this",
              "from",
              "please",
              "should",
              "would",
              "could",
            ].includes(t),
        )
        .slice(0, 40),
      tsq = terms.length ? terms.join(" | ") : "vr_no_terms";
    const rows = (
      await this.engine.db.query(
        `SELECT b.id,ts_rank_cd(d.lexemes,to_tsquery('english',$3)) AS rank,CASE WHEN a.paths ?| $4::text[] THEN 1 ELSE 0 END AS exact FROM vr_behaviors b JOIN vr_search d ON d.behavior_id=b.id AND d.revision=b.revision JOIN vr_assertions a ON a.behavior_id=b.id AND a.revision=b.revision WHERE b.product_id=$1 AND ${allowed} AND (d.lexemes @@ to_tsquery('english',$3) OR a.paths ?| $4::text[] OR b.alias=$5) ORDER BY exact DESC,rank DESC,b.id LIMIT $6`,
        [product, this.engine.principal, tsq, paths, query, limit],
      )
    ).rows;
    const scores = new Map(
      rows.map((r, i) => [
        r.id,
        {
          id: r.id,
          score: 1 / (60 + i) + (r.exact ? 0.1 : 0),
          method: r.exact ? "exact+lexical" : "lexical",
        },
      ]),
    );
    if (this.semantic) {
      try {
        const vector = await embed(
          query,
          path.join(this.engine.directory, "models"),
        );
        const nearest = (
          await this.engine.db.query(
            `SELECT b.id FROM vr_behaviors b JOIN vr_search d ON d.behavior_id=b.id AND d.revision=b.revision WHERE b.product_id=$1 AND ${allowed} AND d.embedding IS NOT NULL AND d.embedding_model=$3 ORDER BY d.embedding <=> $4::vector LIMIT $5`,
            [product, this.engine.principal, EMBEDDING_ID, json(vector), limit],
          )
        ).rows;
        nearest.forEach((r, i) => {
          const old = scores.get(r.id);
          scores.set(r.id, {
            id: r.id,
            score: (old?.score ?? 0) + 1 / (60 + i),
            method: old ? "hybrid" : "semantic",
          });
        });
      } catch {
        /* Exact and lexical retrieval remain available if local embedding runtime is unavailable. */
      }
    }
    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  async expandRelationships(product: string, ids: string[], limit = 30) {
    if (!ids.length) return [];
    const rows = (
      await this.engine.db.query(
        `SELECT DISTINCT CASE WHEN from_id=ANY($3::text[]) THEN to_id ELSE from_id END AS id FROM vr_relations r WHERE r.product_id=$1 AND (r.from_id=ANY($3::text[]) OR r.to_id=ANY($3::text[])) AND NOT EXISTS(SELECT 1 FROM vr_evidence e JOIN vr_sources s ON s.id=e.source_id WHERE r.evidence ? e.id AND (NOT s.enabled OR NOT(s.principals ? $2))) LIMIT $4`,
        [product, this.engine.principal, ids, limit],
      )
    ).rows;
    return rows.map((r) => r.id);
  }
  async hydrate(product: string, ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.engine.db.query(
        `SELECT b.id,b.alias,b.title,a.*,(SELECT jsonb_agg(jsonb_build_object('id',e.id,'sourceId',e.source_id,'path',e.path,'revision',e.revision,'hash',e.content_hash,'kind',e.kind,'role',u.role,'startLine',e.start_line,'endLine',e.end_line)) FROM vr_support u JOIN vr_evidence e ON e.id=u.evidence_id WHERE u.behavior_id=b.id AND u.revision=b.revision) AS evidence FROM vr_behaviors b JOIN vr_assertions a ON a.behavior_id=b.id AND a.revision=b.revision WHERE b.product_id=$1 AND ${allowed} AND b.id=ANY($3::text[])`,
        [product, this.engine.principal, ids],
      )
    ).rows;
  }
  async relationshipDetails(product: string, ids: string[], limit = 10) {
    if (ids.length < 2) return [];
    return (
      await this.engine.db.query(
        `SELECT r.id,r.from_id,r.to_id,r.kind,r.basis,
          (SELECT jsonb_agg(jsonb_build_object('id',e.id,'sourceId',e.source_id,'path',e.path,'revision',e.revision,'hash',e.content_hash,'kind',e.kind,'startLine',e.start_line,'endLine',e.end_line)) FROM vr_evidence e WHERE r.evidence ? e.id) AS anchors
         FROM vr_relations r WHERE r.product_id=$1 AND r.from_id=ANY($3::text[]) AND r.to_id=ANY($3::text[])
          AND jsonb_array_length(r.evidence)>0
          AND NOT EXISTS(SELECT 1 FROM vr_evidence e JOIN vr_sources s ON s.id=e.source_id WHERE r.evidence ? e.id AND (NOT s.enabled OR NOT(s.principals ? $2)))
         ORDER BY array_position($3::text[],r.from_id),array_position($3::text[],r.to_id),r.id LIMIT $4`,
        [product, this.engine.principal, ids, limit],
      )
    ).rows;
  }
}
export class ContextService {
  constructor(
    readonly engine: Engine,
    readonly retrieval: RetrievalAdapter = new PostgresRetrieval(engine),
  ) {}
  async context(
    product: string,
    task: string,
    focus: string[] = [],
    budget = 14000,
    workspaceRoot?: string,
    buffers?: Record<string, string>,
  ) {
    if (!task.trim() || task.length > 12000)
      throw Error("Provide a task between 1 and 12000 characters");
    budget = Math.max(3000, Math.min(40000, budget));
    const start = Date.now();
    await this.engine.product(product);
    const sources = (
      await this.engine.db.query(
        "SELECT s.*,p.revision AS analyzed_revision FROM vr_sources s LEFT JOIN vr_snapshots p ON p.id=s.checkpoint WHERE product_id=$1 AND enabled AND principals ? $2",
        [product, this.engine.principal],
      )
    ).rows;
    const freshness: any[] = [],
      affected = new Set<string>(),
      qualifiedAffected = new Set<string>(),
      currentHashes = new Map<string, string>(),
      ancestors = new Set<string>(),
      liveUnits: any[] = [];
    const gitSources = sources.filter((s) => s.kind === "git" && s.checkpoint);
    for (const s of gitSources) {
      const root =
        gitSources.length === 1 ? (workspaceRoot ?? s.identity) : s.identity;
      const sourceBuffers =
        gitSources.length === 1
          ? buffers
          : Object.fromEntries(
              Object.entries(buffers ?? {})
                .filter(([p]) => p.startsWith(root + "/"))
                .map(([p, v]) => [p.slice(root.length + 1), v]),
            );
      const live = await scan(root, s.id, {
        overlay: true,
        exclude: s.attributes.exclude,
        buffers: sourceBuffers,
      });
      const files = (
          await this.engine.db.query(
            "SELECT * FROM vr_files WHERE snapshot_id=$1",
            [s.checkpoint],
          )
        ).rows,
        before = new Map(files.map((f) => [f.path, f.content_hash])),
        after = new Map(
          live.files
            .filter((f) => f.status === "included")
            .map((f) => [f.path, f.hash]),
        );
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
        (p) => {
          const f = files.find((f) => f.path === p);
          return f?.status !== "excluded" && before.get(p) !== after.get(p);
        },
      );
      const stored = (
        await this.engine.db.query(
          "SELECT * FROM vr_edges WHERE snapshot_id=$1",
          [s.checkpoint],
        )
      ).rows.map((e) => ({
        from: e.from_path,
        to: e.to_path,
        kind: e.kind,
        basis: e.basis,
        resolved: e.resolved,
      }));
      const impact = affectedPaths(changed, [...stored, ...live.links]);
      for (const p of impact.paths) {
        affected.add(p);
        qualifiedAffected.add(`${s.id}:${p}`);
      }
      for (const [p, h] of after) currentHashes.set(`${s.id}:${p}`, h);
      liveUnits.push(...live.units.filter((u) => changed.includes(u.path)));
      for (const c of (await git(root, "rev-list", live.revision))
        .trim()
        .split("\n"))
        ancestors.add(`${s.id}:${c}`);
      freshness.push({
        sourceId: s.id,
        workspaceRoot: root,
        analyzedRevision: s.analyzed_revision,
        workspaceHead: live.revision,
        branch: live.branch,
        worktreeFingerprint: live.fingerprint,
        remoteObservedTip: s.remote_tip,
        remoteCheckedAt: s.remote_checked_at,
        changedPaths: changed,
        affectedPaths: impact.paths,
        dependencyTraversalTruncated: impact.truncated,
        structuralErrors: live.errors,
        semanticRefreshPending: changed.length > 0,
        unsavedBuffersIncluded: !!buffers,
      });
    }
    const ranked = await this.retrieval.searchCandidates(
        product,
        task,
        focus,
        40,
      ),
      expanded = await this.retrieval.expandRelationships(
        product,
        ranked.map((r) => r.id),
        30,
      ),
      ids = [...new Set([...ranked.map((r) => r.id), ...expanded])];
    const hydrated = (await this.retrieval.hydrate(product, ids)).filter(
        (a) =>
          !a.scope.localOverlay ||
          freshness.some(
            (f) =>
              f.workspaceRoot === a.scope.workspaceRoot &&
              f.worktreeFingerprint === a.scope.worktreeFingerprint,
          ),
      ),
      rank = new Map(ids.map((id, i) => [id, i]));
    hydrated.sort((a, b) => (rank.get(a.id) ?? 100) - (rank.get(b.id) ?? 100));
    const findings = hydrated.map((a) => {
      const stale =
        a.temporal === "current" &&
        !a.scope.localOverlay &&
        (a.evidence.some((e: any) =>
          qualifiedAffected.has(`${e.sourceId}:${e.path}`),
        ) ||
          a.evidence.some(
            (e: any) =>
              e.kind === "code" &&
              currentHashes.get(`${e.sourceId}:${e.path}`) !== e.hash,
          ));
      const intentStale = a.evidence.some(
        (e: any) =>
          ["jira", "github-issues"].includes(e.kind) &&
          sources.find((s) => s.id === e.sourceId)?.attributes.revisions?.[
            e.path
          ] !== e.revision,
      );
      const historyMismatch =
        a.temporal === "historical" &&
        a.evidence.some(
          (e: any) =>
            ["git-diff", "history-baseline"].includes(e.kind) &&
            !ancestors.has(`${e.sourceId}:${e.revision}`),
        );
      return {
        id: a.id,
        version: a.revision,
        title: a.title,
        statement: a.statement,
        conditions: a.conditions,
        exceptions: a.exceptions,
        basis: a.basis,
        temporal: a.temporal,
        review: a.review,
        localOverlay: !!a.scope.localOverlay,
        applicability: historyMismatch
          ? "outside-workspace-ancestry"
          : intentStale
            ? "needs-source-revalidation"
            : stale
              ? "needs-targeted-refresh"
              : "matches-inspected-scope",
        evidence: a.evidence.map((e: any) => ({
          id: e.id,
          sourceId: e.sourceId,
          repository: sources.find((s) => s.id === e.sourceId)?.identity,
          path: e.path,
          revision: e.revision,
          startLine: e.startLine,
          endLine: e.endLine,
          role: e.role,
        })),
        suggestedChecks: a.checks,
      };
    });
    const links =
      (await this.retrieval.relationshipDetails?.(
        product,
        findings.map((f) => f.id),
        10,
      )) ?? [];
    const relationships = links.map((r: any) => ({
      id: r.id,
      from: r.from_id,
      to: r.to_id,
      kind: r.kind,
      explanation: r.basis,
      basis: "model-inference",
      applicability:
        [r.from_id, r.to_id].some(
          (id) =>
            findings.find((f) => f.id === id)?.applicability !==
            "matches-inspected-scope",
        ) ||
        (r.anchors ?? []).some((e: any) =>
          e.kind === "code"
            ? currentHashes.get(`${e.sourceId}:${e.path}`) !== e.hash ||
              qualifiedAffected.has(`${e.sourceId}:${e.path}`)
            : ["jira", "github-issues"].includes(e.kind)
              ? sources.find((s) => s.id === e.sourceId)?.attributes
                  .revisions?.[e.path] !== e.revision
              : ["git-diff", "history-baseline"].includes(e.kind) &&
                !ancestors.has(`${e.sourceId}:${e.revision}`),
        )
          ? "needs-source-revalidation"
          : "matches-inspected-scope",
      evidence: (r.anchors ?? []).map((e: any) => ({
        id: e.id,
        sourceId: e.sourceId,
        repository: sources.find((s) => s.id === e.sourceId)?.identity,
        path: e.path,
        revision: e.revision,
        startLine: e.startLine,
        endLine: e.endLine,
      })),
    }));
    const overview = await this.engine.overview(product),
      focusSet = new Set([...focus, ...hydrated.flatMap((a) => a.paths)]);
    const terms = [
      ...new Set(task.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []),
    ].filter(
      (t) =>
        ![
          "the",
          "and",
          "with",
          "that",
          "this",
          "from",
          "what",
          "does",
          "should",
          "would",
          "could",
          "have",
        ].includes(t),
    );
    const scoreQuestion = (q: any) =>
      (q.paths.some((p: string) => focus.includes(p)) ? 100 : 0) +
      (q.paths.some((p: string) => focusSet.has(p)) ? 10 : 0) +
      terms.filter((t) => q.question.toLowerCase().includes(t)).length * 5;
    const questions = overview.questions
      .filter((q: any) => scoreQuestion(q) > 0)
      .sort(
        (a: any, b: any) =>
          scoreQuestion(b) - scoreQuestion(a) || a.id.localeCompare(b.id),
      );
    const unresolved = questions.filter((q: any) => q.state !== "answered");
    const questionRank = new Map(
      questions.map((q: any, i: number) => [q.id, i]),
    );
    const reviews = (
      await this.engine.db.query(
        "SELECT DISTINCT ON(target_id) * FROM vr_reviews WHERE product_id=$1 ORDER BY target_id,revision DESC",
        [product],
      )
    ).rows
      .filter((r) => questionRank.has(r.target_id))
      .sort(
        (a, b) =>
          questionRank.get(a.target_id)! - questionRank.get(b.target_id)!,
      );
    // Audit history remains in storage. Context carries the latest answer, never
    // predecessor values or the full imported analysis/provenance payload.
    const compactReview = (r: any) => {
      const q = questions.find((q: any) => q.id === r.target_id)!;
      return {
        id: r.id,
        target_id: r.target_id,
        revision: r.revision,
        question: q.question,
        actor: r.actor,
        action: r.action,
        created_at: r.created_at,
        new_value: r.new_value,
        scope: {
          paths: q.paths,
          evidence: q.evidence,
          provenance: r.scope?.provenance,
          basis: r.scope?.basis,
          implementationStatus: r.scope?.implementationStatus,
          originalAuthor: r.scope?.originalAuthor,
          factualGap: r.scope?.factualGap,
        },
      };
    };
    const agentReviews = reviews.filter(
      (r) => r.actor?.type === "agent" && r.action !== "requirement",
    );
    // A visible uncertainty can already have a scoped answer. Reserve its
    // assessment before other reviews so "deferred" is not read as "no answer".
    const primaryUnresolved = unresolved[0]?.id;
    agentReviews.sort(
      (a, b) =>
        Number(b.target_id === primaryUnresolved) -
        Number(a.target_id === primaryUnresolved),
    );
    const agentAssessments: any[] = [];
    let assessmentCharacters = 0;
    for (const review of agentReviews) {
      const entry = compactReview(review),
        size = json(entry).length;
      if (assessmentCharacters + size <= budget * 0.4) {
        agentAssessments.push(entry);
        assessmentCharacters += size;
      }
    }
    const receipt = randomUUID(),
      packet: any = {
        schemaVersion: 1,
        receiptId: receipt,
        task,
        contextState: findings.some(
          (f) => f.applicability !== "matches-inspected-scope",
        )
          ? "partial-needs-refresh"
          : findings.length
            ? "available"
            : "no-finding-retrieved",
        freshness,
        explicitRequirements: reviews
          .filter((r) => r.action === "requirement")
          .map(compactReview),
        humanClarifications: reviews
          .filter((r) => r.action === "clarify" && r.actor?.type === "human")
          .map(compactReview),
        agentAssessments,
        behaviors: [],
        relationships: [],
        unresolvedForTask: unresolved.slice(0, 10).map((q: any) => ({
          ...q,
          assessmentAvailable: agentReviews.some((r) => r.target_id === q.id),
          assessmentIncluded: false,
        })),
        changedSource: liveUnits.slice(0, 6).map((u) => ({
          path: u.path,
          revision: u.revision,
          startLine: u.start,
          endLine: u.end,
          text: u.text.slice(0, 1800),
          semanticInterpretation: "pending",
        })),
        retrieval: {
          methods: [...new Set(ranked.map((r) => r.method))],
          semanticConfigured:
            this.retrieval instanceof PostgresRetrieval &&
            this.retrieval.semantic,
        },
        coverage: {
          ...learningCoverage(overview),
          retrievedCandidates: ids.length,
          relationshipLimit: 30,
          relationshipDetailsLimit: 10,
          relationshipDetailsOmittedByBudget: 0,
          retrievedAssertionsOmittedByBudget: 0,
          retrievalIsExhaustive: false,
          agentAssessmentsOmittedByBudget:
            agentReviews.length - agentAssessments.length,
        },
        limitations: [
          "Source analysis does not prove runtime behavior, deployment, or complete impact coverage.",
          "Unresolved external imports and dynamic dependencies can hide effects.",
          "Historical and proposed intent are distinct from current implementation.",
          "Agent assessments can contain delegated decisions and unresolved facts; they do not establish implemented behavior.",
          "An omitted assessment is not an unanswered decision. For a question with assessmentAvailable, narrow vr_context to its exact question and paths to retrieve the scoped answer.",
        ],
      };
    // Metadata itself is bounded independently of assertion omission accounting.
    for (const f of packet.freshness) {
      f.changedPathCount = f.changedPaths.length;
      f.affectedPathCount = f.affectedPaths.length;
      f.changedPaths = f.changedPaths.slice(0, 15);
      f.affectedPaths = f.affectedPaths.slice(0, 15);
    }
    packet.coverage.jobs = packet.coverage.jobs.slice(-6).map((j: any) => ({
      ...j,
      details: {
        errorCount: j.details.errorCount ?? 0,
        complete: j.details.complete,
        fixture: j.details.fixture,
      },
    }));
    packet.unresolvedForTask = packet.unresolvedForTask.slice(0, 3);
    packet.changedSource = packet.changedSource
      .slice(0, 2)
      .map((u: any) => ({ ...u, text: u.text.slice(0, 600) }));
    packet.coverage.relevantQuestionsNotIncluded = Math.max(
      0,
      unresolved.length - packet.unresolvedForTask.length,
    );
    if (json(packet).length > budget / 2) {
      packet.changedSource = [];
      packet.unresolvedForTask = packet.unresolvedForTask.slice(0, 1);
      packet.coverage.relevantQuestionsNotIncluded = Math.max(
        0,
        unresolved.length - packet.unresolvedForTask.length,
      );
    }
    const includedRelationships = () => {
      const selected = new Set(packet.behaviors.map((b: any) => b.id));
      return relationships.filter(
        (r) => selected.has(r.from) && selected.has(r.to),
      );
    };
    for (const finding of findings) {
      packet.behaviors.push(finding);
      packet.relationships = includedRelationships();
      if (json(packet).length > budget - 200) {
        packet.behaviors.pop();
        packet.relationships = includedRelationships();
        packet.coverage.retrievedAssertionsOmittedByBudget++;
      }
    }
    // Preserve explicit requirements before optional context; never silently truncate a claim.
    packet.coverage.requirementsOmittedByBudget = 0;
    packet.coverage.clarificationsOmittedByBudget = 0;
    while (
      json(packet).length > budget - 200 &&
      packet.unresolvedForTask.length
    ) {
      packet.unresolvedForTask.pop();
      packet.coverage.relevantQuestionsNotIncluded++;
    }
    while (
      json(packet).length > budget - 200 &&
      packet.agentAssessments.length
    ) {
      packet.agentAssessments.pop();
      packet.coverage.agentAssessmentsOmittedByBudget++;
    }
    while (
      json(packet).length > budget - 200 &&
      packet.humanClarifications.length
    ) {
      packet.humanClarifications.pop();
      packet.coverage.clarificationsOmittedByBudget++;
    }
    while (
      json(packet).length > budget - 200 &&
      packet.explicitRequirements.length
    ) {
      packet.explicitRequirements.pop();
      packet.coverage.requirementsOmittedByBudget++;
    }
    if (json(packet).length > budget - 200) {
      packet.task = task.slice(0, 250);
      packet.taskTruncated = task.length > 250;
      packet.changedSource = [];
      packet.freshness = packet.freshness.map((f: any) => ({
        sourceId: f.sourceId,
        analyzedRevision: f.analyzedRevision,
        workspaceHead: f.workspaceHead,
        worktreeFingerprint: f.worktreeFingerprint,
        changedPathCount: f.changedPathCount,
        affectedPathCount: f.affectedPathCount,
        semanticRefreshPending: f.semanticRefreshPending,
        structuralErrorCount: f.structuralErrors.length,
      }));
    }
    while (json(packet).length > budget - 200 && packet.behaviors.length) {
      packet.behaviors.pop();
      packet.relationships = includedRelationships();
      packet.coverage.retrievedAssertionsOmittedByBudget++;
    }
    if (json(packet).length > budget - 200) {
      packet.freshness = [];
      packet.coverage.freshnessDetailsOmitted = true;
      packet.coverage.jobs = [];
    }
    if (packet.coverage.requirementsOmittedByBudget)
      packet.contextState = "partial-requirements-omitted";
    packet.coverage.relationshipDetailsOmittedByBudget =
      relationships.length - packet.relationships.length;
    for (const q of packet.unresolvedForTask) {
      q.assessmentIncluded = packet.agentAssessments.some(
        (r: any) => r.target_id === q.id,
      );
    }
    packet.elapsedMs = Date.now() - start;
    await this.engine.db.query(
      "INSERT INTO vr_receipts(id,product_id,kind,details) VALUES($1,$2,$3,$4)",
      [
        receipt,
        product,
        "context-generated",
        json({
          taskHash: key(task),
          ids: packet.behaviors.map((b: any) => [b.id, b.version]),
          freshness: packet.freshness,
          elapsedMs: packet.elapsedMs,
        }),
      ],
    );
    return packet;
  }
  async evidence(product: string, ids: string[], budget = 35000) {
    if (ids.length > 20)
      throw Error("Read up to 20 evidence references per request");
    await this.engine.product(product);
    const rows = (
      await this.engine.db.query(
        "SELECT e.*,s.identity AS repository FROM vr_evidence e JOIN vr_sources s ON s.id=e.source_id WHERE e.id=ANY($1::text[]) AND s.product_id=$2 AND s.enabled AND s.principals ? $3",
        [ids, product, this.engine.principal],
      )
    ).rows;
    let used = 0;
    const evidence: any[] = [],
      omitted: any[] = [];
    for (const id of ids) {
      const e = rows.find((e) => e.id === id);
      if (!e) {
        omitted.push({ id, reason: "not-found-or-inaccessible" });
        continue;
      }
      if (used + json(e).length > budget) {
        omitted.push({ id, reason: "budget" });
        continue;
      }
      used += json(e).length;
      evidence.push({
        ...e,
        id: e.id,
        untrusted: true,
        sourceRevisionIsImmutable: true,
      });
    }
    const receipt = randomUUID();
    await this.engine.db.query(
      "INSERT INTO vr_receipts VALUES($1,$2,$3,$4,now())",
      [
        receipt,
        product,
        "evidence-delivered",
        json({ ids: evidence.map((e) => e.id) }),
      ],
    );
    return { schemaVersion: 1, evidence, omitted, receiptId: receipt };
  }
  async index(product: string, limit = 100) {
    await this.engine.product(product);
    limit = Math.max(1, Math.min(500, limit));
    const eligible = `FROM vr_search d JOIN vr_behaviors b ON b.id=d.behavior_id WHERE b.product_id=$1 AND d.revision=b.revision AND ${allowed} AND (d.embedding IS NULL OR d.embedding_model IS DISTINCT FROM $3)`;
    const args = [product, this.engine.principal, EMBEDDING_ID],
      rows = (
        await this.engine.db.query(
          `SELECT d.* ${eligible} ORDER BY b.id LIMIT $4`,
          [...args, limit],
        )
      ).rows;
    let indexed = 0;
    for (const row of rows) {
      const vector = await embed(
        row.body,
        path.join(this.engine.directory, "models"),
      );
      if (vector.length !== 384 || vector.some((n) => !Number.isFinite(n)))
        throw Error("Invalid embedding output");
      const updated = await this.engine.db.query(
        "UPDATE vr_search SET embedding=$2::vector,embedding_model=$3 WHERE behavior_id=$1 AND revision=$4 RETURNING behavior_id",
        [row.behavior_id, json(vector), EMBEDDING_ID, row.revision],
      );
      indexed += updated.rows.length;
    }
    const remaining = Number(
      (await this.engine.db.query(`SELECT count(*) AS n ${eligible}`, args))
        .rows[0].n,
    );
    return { indexed, remaining, model: EMBEDDING_ID };
  }
}
