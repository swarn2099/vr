import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scan, git } from "../src/scanner.js";
import { openDatabase } from "../src/database.js";
import { Engine } from "../src/engine.js";

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vr-nontext-"));
  const root = path.join(dir, "repo");
  await mkdir(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "VR fixture");
  await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(
    path.join(root, "app.ts"),
    "export const permitted = (role: string) => role === 'manager';\n",
  );
  await writeFile(
    path.join(root, "transactions.txt"),
    Buffer.from([0, 1, 2, 3, 65]),
  );
  await writeFile(
    path.join(root, "utf16.txt"),
    Buffer.from("\ufeffLegacy transaction fixture", "utf16le"),
  );
  await writeFile(
    path.join(root, "notes.txt"),
    "A regular text fixture stays in scope.\n",
  );
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "Source and non-text fixtures");
  return { dir, root };
}

test("non-text files are inventoried as excluded while source and ordinary text are scanned", async () => {
  const f = await fixture();
  try {
    const s = await scan(f.root, "source");
    assert.deepEqual(s.errors, []);
    assert.equal(s.files.length, 4);
    for (const file of ["transactions.txt", "utf16.txt"]) {
      const record = s.files.find((entry) => entry.path === file)!;
      assert.equal(record.status, "excluded");
      assert.match(record.reason!, /binary data or unsupported text encoding/);
      assert.equal(record.units, 0);
      assert.ok(!s.units.some((unit) => unit.path === file));
    }
    assert.equal(
      s.files.find((entry) => entry.path === "app.ts")?.functions,
      1,
    );
    assert.ok(s.units.some((unit) => unit.path === "notes.txt"));
    const before = await scan(f.root, "source", { overlay: true });
    await writeFile(
      path.join(f.root, "transactions.txt"),
      Buffer.from([0, 9, 8]),
    );
    const after = await scan(f.root, "source", { overlay: true });
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.deepEqual(after.errors, []);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("refresh stores exclusions and preserves real scan errors on an unchanged retry", async () => {
  const f = await fixture();
  const state = path.join(f.dir, "state");
  const db = await openDatabase(state);
  try {
    const engine = new Engine(db, state);
    const ids = await engine.connect("Fixture", f.root);
    const first = await engine.refresh(ids.sourceId);
    assert.deepEqual(first.coverage.errors, []);
    assert.deepEqual(first.coverage.nonTextFiles, [
      "transactions.txt",
      "utf16.txt",
    ]);
    const stored = (
      await db.query(
        "SELECT status,reason,units FROM vr_files WHERE snapshot_id=$1 AND path=$2",
        [first.snapshotId, "transactions.txt"],
      )
    ).rows[0];
    assert.equal(stored.status, "excluded");
    assert.match(stored.reason, /NUL/);
    const repeat = await engine.refresh(ids.sourceId);
    assert.ok("unchanged" in repeat && repeat.unchanged);
    assert.deepEqual(repeat.coverage, first.coverage);
    await writeFile(
      path.join(f.root, "broken.ts"),
      "export const broken = ;\n",
    );
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-qm", "Real syntax error");
    const bad = await engine.refresh(ids.sourceId);
    assert.ok(bad.coverage.errors.some((error) => error.includes("broken.ts")));
    const retried = await engine.refresh(ids.sourceId);
    assert.ok("unchanged" in retried && retried.unchanged);
    assert.deepEqual(retried.coverage.errors, bad.coverage.errors);
  } finally {
    await db.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
