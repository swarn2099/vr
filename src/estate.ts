import {
  readdir,
  lstat,
  realpath,
  readFile,
  mkdir,
  writeFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { git } from "./scanner.js";
import { key } from "./contracts.js";
import { randomUUID } from "node:crypto";
import type { Engine } from "./engine.js";

const excluded = new Set([
  "node_modules",
  ".git",
  ".vr",
  ".vr-estate",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  "coverage",
]);
export async function discoverRepositories(directory: string) {
  const root = await realpath(directory),
    repositories: string[] = [];
  let visited = 0;
  async function visit(dir: string, depth: number) {
    if (++visited > 50000 || depth > 20)
      throw Error(
        "Discovery limit reached; point VR at a smaller estate folder.",
      );
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.name === ".git")) {
      const top = await realpath(
        (await git(dir, "rev-parse", "--show-toplevel")).trim(),
      );
      if (top === dir) {
        await git(dir, "rev-parse", "HEAD");
        repositories.push(dir);
      }
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !excluded.has(e.name) && !e.name.startsWith("."))
        await visit(path.join(dir, e.name), depth + 1);
    }
  }
  await visit(root, 0);
  if (!repositories.length)
    throw Error(
      "No Git repositories with a commit found in this folder. Clone the repositories first.",
    );
  return { root, repositories: [...new Set(repositories)].sort() };
}
export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

// These are discovery candidates, never assertions that matching names prove an integration.
export function integrationSignals(text: string) {
  const terms = new Set<string>();
  for (const m of text.matchAll(
    /["'`]((?:https?:\/\/[^/\s"'`]+)?\/[A-Za-z][^\s"'`]{2,150})["'`]/g,
  )) {
    let value = m[1]
      .replace(/^https?:\/\/[^/]+/, "")
      .replace(/\?.*$/, "")
      .replace(/\$\{[^}]+\}|\{[^}]+\}|:[A-Za-z_][\w]*/g, ":param")
      .replace(/\/$/, "");
    if (!/\.(?:png|svg|jpg|css|map)$/.test(value)) {
      terms.add("route:" + value);
      const tail = value.split("/").filter(Boolean).at(-1);
      if (tail && tail !== ":param" && tail.length >= 3)
        terms.add("route-tail:" + tail);
    }
  }
  for (const m of text.matchAll(
    /\b[A-Z][A-Za-z0-9_]{3,}(?:DTO|Dto|Request|Response|Event|Command|Message)\b/g,
  ))
    terms.add("contract:" + m[0]);
  for (const m of text.matchAll(
    /(?:topic|queue|destination|service|url|baseURL|artifactId|name)[\s"']*[:=][\s"']*([\w.-]{4,100})/g,
  ))
    terms.add("named:" + m[1]);
  return [...terms];
}
export async function queueEstateConnections(engine: Engine, product: string) {
  const o = await engine.overview(product),
    sources = o.sources.filter((s: any) => s.kind === "git");
  if (sources.length < 2) return { notRequired: true };
  for (const s of sources)
    for (const stage of ["current", "connections"]) {
      if (s.attributes.pipeline?.stages.currentCode === false) continue;
      const j = o.jobs.findLast(
        (j: any) =>
          j.source_id === s.id &&
          j.snapshot_id === s.checkpoint &&
          j.stage === stage &&
          !j.details.localOverlay,
      );
      if (j?.state !== "completed" || j.details.errors?.length)
        return { waiting: true, sourceId: s.id, stage };
    }
  const primary = await engine.source(sources[0].id),
    checkpoints = Object.fromEntries(
      sources.map((s: any) => [s.id, s.checkpoint]),
    );
  const signature = key("estate-connection-v2", checkpoints);
  const prior = o.jobs.find(
    (j: any) =>
      j.stage === "estate-connections" && j.details.signature === signature,
  );
  if (prior) return { jobId: prior.id, state: prior.state, unchanged: true };
  const rows = (
    await engine.db.query(
      `SELECT e.* FROM vr_evidence e JOIN vr_sources s ON s.id=e.source_id JOIN vr_snapshot_evidence se ON se.evidence_id=e.id WHERE s.product_id=$1 AND se.snapshot_id=s.checkpoint AND e.kind='code' AND s.enabled AND s.principals ? $2`,
      [product, engine.principal],
    )
  ).rows;
  const buckets = new Map<string, any[]>();
  for (const e of rows)
    for (const term of integrationSignals(e.body)) {
      const b = buckets.get(term) ?? [];
      b.push(e);
      buckets.set(term, b);
    }
  const work: any[] = [];
  const seenPairs = new Set<string>();
  let omittedPairs = 0;
  for (const [signal, bucket] of buckets) {
    const unique = [...new Map(bucket.map((e) => [e.id, e])).values()];
    for (let i = 0; i < unique.length; i++)
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i],
          b = unique[j];
        if (a.source_id === b.source_id) continue;
        const pairKey = key("estate-connection-v2", [a.id, b.id].sort());
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        if (work.length >= 10000) {
          omittedPairs++;
          continue;
        }
        work.push({
          key: pairKey,
          evidence: [a.id, b.id],
        });
      }
  }
  return engine.db.transaction(async (tx) => {
    await tx.query(
      `UPDATE vr_jobs SET state='superseded' WHERE product_id=$1 AND stage='estate-connections' AND state<>'completed'`,
      [product],
    );
    const id = await engine.createJob(
      tx,
      primary,
      primary.checkpoint,
      "estate-connections",
      work,
      {
        signature,
        sourceCheckpoints: checkpoints,
        candidatePairs: work.length,
        omittedPairs,
        errors: omittedPairs
          ? [
              "Cross-repository candidate limit reached; some pairs remain unprocessed.",
            ]
          : [],
        grouping:
          "Cross-repository route/contract/event candidates; matches require model reconciliation and are not proof of runtime wiring.",
      },
    );
    return { jobId: id, candidatePairs: work.length, omittedPairs };
  });
}
