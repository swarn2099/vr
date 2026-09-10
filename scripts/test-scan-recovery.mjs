import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const code = process.cwd();
const temp = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "vr-scan-recovery-")),
);
const estate = path.join(temp, "Spend Estate");
const run = (command, args, cwd = code) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const setup = [
  "dist/setup.js",
  estate,
  "--scan-only",
  "--semantic",
  "off",
  "--jira",
  "off",
  "--history-years",
  "0",
];
const stop = ["scripts/stop-estate-service.mjs", estate];
let connection;
try {
  await mkdir(estate);
  for (let n = 1; n <= 9; n++) {
    const repo = path.join(estate, `repo-${n}`);
    await mkdir(repo);
    run("git", ["init", "-q"], repo);
    run("git", ["config", "user.name", "VR fixture"], repo);
    run("git", ["config", "user.email", "test@example.invalid"], repo);
    await writeFile(
      path.join(repo, "app.ts"),
      "export const canApprove=(role: string)=>role==='manager';\n",
    );
    if (n === 4)
      await writeFile(
        path.join(repo, "transactions.txt"),
        Buffer.from([0, 1, 2, 3]),
      );
    run("git", ["add", "."], repo);
    run("git", ["commit", "-qm", "Code and transaction fixture"], repo);
  }
  const first = run(process.execPath, setup);
  assert.match(first, /Scanning repository 9\/9/);
  assert.match(first, /Skipped 1 file/);
  const meta = path.join(estate, ".vr-estate");
  const manifestFile = path.join(meta, "estate.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  connection = JSON.parse(
    await readFile(path.join(manifest.state, "connection.json"), "utf8"),
  );
  await writeFile(
    path.join(meta, "setup.lock"),
    JSON.stringify({ pid: process.pid }),
  );
  assert.throws(
    () => run(process.execPath, stop),
    /still setting up or learning/,
  );
  process.kill(connection.pid, 0);
  await rm(path.join(meta, "setup.lock"));
  // An initial scan failure can leave a database before the manifest is saved.
  await rm(manifestFile);
  assert.match(
    run(process.execPath, stop),
    /Stopped this estate's VR service cleanly/,
  );
  assert.match(run(process.execPath, stop), /already stopped/);
  const second = run(process.execPath, setup);
  assert.match(second, /Scanning repository 9\/9/);
  assert.match(second, /Skipped 1 file/);
  const resumed = JSON.parse(await readFile(manifestFile, "utf8"));
  const newConnection = JSON.parse(
    await readFile(path.join(manifest.state, "connection.json"), "utf8"),
  );
  assert.notEqual(newConnection.pid, connection.pid);
  connection = newConnection;
  assert.equal(resumed.productId, manifest.productId);
  assert.deepEqual(resumed.repositories, manifest.repositories);
  const result = {
    at: new Date().toISOString(),
    passed: true,
    repositories: 9,
    binaryFixtureInRepository: 4,
    reachedFinalRepository: true,
    exclusionVisibleOnFirstScanAndRetry: true,
    activeRunProtectedFromRestart: true,
    cleanServiceRestart: true,
    recoveryWithoutManifest: true,
    productAndRepositoryIdentitiesRetained: true,
    modelCalls: 0,
  };
  await writeFile(
    path.join(code, "verification/scanner-fix-recovery.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (connection) {
    try {
      run(process.execPath, stop);
    } catch {
      try {
        process.kill(connection.pid, "SIGTERM");
      } catch {}
    }
  }
  await rm(temp, { recursive: true, force: true });
}
