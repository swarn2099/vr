import { mkdir, copyFile, writeFile, readFile, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = process.cwd(),
  stage = path.join(root, "dist", "extension-package");
await mkdir(path.join(stage, "dist"), { recursive: true });
for (const file of [
  "cli.js",
  "mcp.js",
  "extension.cjs",
  "ui.js",
  "hook.js",
  "schema.sql",
])
  await copyFile(path.join(root, "dist", file), path.join(stage, "dist", file));
await copyFile(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
await writeFile(
  path.join(stage, "README.md"),
  (await readFile("README.md", "utf8"))
    .replace("[VR PRD](VR-PRD.md)", "VR PRD")
    .replace(
      /\[([^\]]+)\]\(((?:evaluation|docs)\/[^)]+)\)/g,
      "$1 ($2 in the source checkout)",
    ),
);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
// The staging folder has no Git metadata; VSCE needs a repository to resolve README links.
pkg.repository ??= {
  type: "git",
  url: "https://github.com/swarn2099/vr.git",
};
delete pkg.devDependencies;
delete pkg.scripts;
pkg.files = [
  "dist/**",
  "node_modules/**",
  "README.md",
  "LICENSE",
  "package.json",
];
await writeFile(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2));
await copyFile(
  path.join(root, "package-lock.json"),
  path.join(stage, "package-lock.json"),
);
execFileSync(
  "npm",
  ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: stage, stdio: "inherit" },
);
execFileSync(
  path.join(root, "node_modules", ".bin", "vsce"),
  [
    "package",
    "--githubBranch",
    "main",
    "--out",
    path.join(root, "dist", `vr-portable-${pkg.version}.vsix`),
  ],
  { cwd: stage, stdio: "inherit" },
);
