import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/cli.ts", "src/mcp.ts", "src/hook.ts", "src/setup.ts"],
  outdir: "dist",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  sourcemap: true,
});
await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
});
await build({
  entryPoints: ["src/ui.tsx"],
  outfile: "dist/ui.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile("src/schema.sql", "dist/schema.sql");
