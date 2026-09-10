import { mkdir, cp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = process.cwd(),
  release = path.join(root, "release"),
  name = "vr-portable-0.2.0",
  dest = path.join(release, name);
await mkdir(release, { recursive: true });
await rm(dest, { recursive: true, force: true });
await mkdir(dest);
for (const n of ["src", "tests", "scripts", "verification"])
  await cp(path.join(root, n), path.join(dest, n), { recursive: true });
for (const n of [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "LICENSE",
  "README.md",
])
  await cp(path.join(root, n), path.join(dest, n));
await mkdir(path.join(dest, "dist"));
for (const n of [
  "setup.js",
  "cli.js",
  "mcp.js",
  "extension.cjs",
  "ui.js",
  "hook.js",
  "schema.sql",
  "vr-portable-0.2.0.vsix",
])
  await cp(path.join(root, "dist", n), path.join(dest, "dist", n));
const files = {};
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) await walk(f);
    else
      files[path.relative(dest, f)] = createHash("sha256")
        .update(await readFile(f))
        .digest("hex");
  }
}
await walk(dest);
await writeFile(
  path.join(dest, "RELEASE-MANIFEST.json"),
  JSON.stringify(
    { version: "0.2.0", createdAt: new Date().toISOString(), files },
    null,
    2,
  ) + "\n",
);
const zip = path.join(release, name + ".zip");
await rm(zip, { force: true });
execFileSync("/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  dest,
  zip,
]);
console.log(zip);
