import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { parse as parseJava } from "java-parser";
import { redact } from "./redact.js";
import {
  hash,
  key,
  type Snapshot,
  type Unit,
  type Link,
  errorText,
} from "./contracts.js";
const exec = promisify(execFile);
export const PARSER = "vr-structure-1:typescript-6:java-parser-3";
export async function git(root: string, ...args: string[]) {
  return (
    await exec("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120000,
      env: {
        ...process.env,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    })
  ).stdout;
}
const blocked =
  /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.vr|\.vr-estate|\.next|\.env[^/]*)(\/|$)|(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.github\/hooks\/vr-context\.json$|\.(pem|key|p12|pfx)$/i;
const supported =
  /\.(?:[cm]?[jt]sx?|java|json|md|sql|ya?ml|xml|properties|graphql|gql|txt|css|scss|html)$/i;
const structuralCache = new Map<string, ReturnType<typeof analyzeText>>();
export interface ScanOptions {
  ref?: string;
  overlay?: boolean;
  exclude?: string[];
  buffers?: Record<string, string>;
}
export function analyzeText(file: string, text: string) {
  const functions: Array<{ name: string; start: number; end: number }> = [],
    imports: string[] = [],
    errors: string[] = [];
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
      line = (n: number) => ast.getLineAndCharacterOfPosition(n).line + 1;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionLike(n) && "body" in n && n.body) {
        const name =
          "name" in n && n.name
            ? n.name.getText(ast)
            : ts.isVariableDeclaration(n.parent)
              ? n.parent.name.getText(ast)
              : `callback@${line(n.getStart(ast))}`;
        functions.push({
          name,
          start: line(n.getStart(ast)),
          end: line(n.end),
        });
      }
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier))
        imports.push(n.moduleSpecifier.text);
      if (
        ts.isCallExpression(n) &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0]) &&
        (n.expression.getText(ast) === "require" ||
          n.expression.kind === ts.SyntaxKind.ImportKeyword)
      )
        imports.push(n.arguments[0].text);
      ts.forEachChild(n, visit);
    };
    visit(ast);
    if ((ast as any).parseDiagnostics?.length)
      errors.push(
        `${(ast as any).parseDiagnostics.length} TypeScript syntax diagnostics`,
      );
  } else if (file.endsWith(".java")) {
    try {
      const tree: any = parseJava(text);
      const tokens = (n: any): any[] =>
        n.children
          ? Object.values(n.children).flatMap((v: any) => v.flatMap(tokens))
          : [n];
      const visit = (n: any) => {
        if (
          [
            "methodDeclaration",
            "constructorDeclaration",
            "lambdaExpression",
          ].includes(n.name)
        ) {
          const t = tokens(n)
            .filter((t) => Number.isFinite(t.startLine))
            .sort((a, b) => a.startOffset - b.startOffset);
          const descend = (node: any, wanted: string): any => {
            if (node.name === wanted) return node;
            for (const children of Object.values(
              node.children ?? {},
            ) as any[][])
              for (const child of children) {
                const found = child.children && descend(child, wanted);
                if (found) return found;
              }
          };
          const declarator = descend(
              n,
              n.name === "methodDeclaration"
                ? "methodDeclarator"
                : "constructorDeclarator",
            ),
            named = declarator
              ? tokens(declarator).find(
                  (t) => t.tokenType?.name === "Identifier",
                )
              : undefined;
          functions.push({
            name:
              n.name === "lambdaExpression"
                ? `lambda@${t[0]?.startLine}:${t[0]?.startColumn}`
                : (named?.image ?? `function@${t[0]?.startLine}`),
            start: t[0]?.startLine ?? 1,
            end: t.at(-1)?.endLine ?? 1,
          });
        }
        if (n.name === "importDeclaration")
          imports.push(
            tokens(n)
              .map((t) => t.image)
              .join("")
              .replace(/^import(?:static)?/, "")
              .replace(/;$/, ""),
          );
        if (n.children)
          for (const children of Object.values(n.children) as any[][])
            for (const child of children) if (child.children) visit(child);
      };
      visit(tree);
    } catch (e) {
      errors.push(`Java syntax: ${errorText(e).slice(0, 300)}`);
    }
  }
  return { functions, imports, errors };
}
export function chunk(
  source: string,
  file: string,
  revision: string,
  text: string,
  kind = "code",
  metadata: Record<string, any> = {},
): Unit[] {
  const safe = redact(text),
    lines = safe.split("\n"),
    contentHash = hash(text),
    out: Unit[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start,
      size = 0;
    while (end < lines.length && (size < 10000 || end === start)) {
      size += lines[end].length + 1;
      end++;
    }
    // One long generated line is split by character; line anchors and the offset remain explicit.
    const body = lines.slice(start, end).join("\n");
    for (
      let offset = 0;
      offset < body.length || offset === 0;
      offset += 14000
    ) {
      const part = body.slice(offset, offset + 14000);
      out.push({
        id: key(
          source,
          file,
          revision,
          start + 1,
          end,
          kind,
          offset,
          hash(part),
        ),
        path: file,
        revision,
        contentHash,
        kind,
        label: file,
        start: start + 1,
        end,
        text: part,
        metadata: {
          ...metadata,
          characterOffset: offset,
          splitLongRange: body.length > 14000,
        },
      });
    }
    start = end;
  }
  return out;
}
export async function scan(
  root: string,
  source: string,
  options: ScanOptions = {},
): Promise<Snapshot> {
  root = await realpath(root);
  const revision = (
    await git(
      root,
      "rev-parse",
      "--verify",
      `${options.ref ?? "HEAD"}^{commit}`,
    )
  ).trim();
  const entries = (await git(root, "ls-tree", "-rz", "--full-tree", revision))
      .split("\0")
      .filter(Boolean),
    tree = new Map<string, { mode: string; blob: string }>();
  for (const entry of entries) {
    const m = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (m) tree.set(m[3], { mode: m[1], blob: m[2] });
  }
  if (options.overlay) {
    for (const file of (
      await git(root, "ls-files", "--others", "--exclude-standard", "-z")
    )
      .split("\0")
      .filter(Boolean))
      tree.set(file, { mode: "100644", blob: "" });
    for (const file of Object.keys(options.buffers ?? {}))
      if (!tree.has(file)) tree.set(file, { mode: "100644", blob: "" });
  }
  const result: Snapshot = {
    revision,
    branch: (await git(root, "branch", "--show-current")).trim() || null,
    files: [],
    units: [],
    links: [],
    errors: [],
    overlay: !!options.overlay,
    fingerprint: "",
  };
  const imports = new Map<string, string[]>();
  for (const [file, entry] of [...tree].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const excluded = blocked.test(file)
      ? "Dependency, generated output, local VR state, lockfile or credential material"
      : options.exclude?.some(
            (p) => file === p || file.startsWith(p.replace(/\/$/, "") + "/"),
          )
        ? "Configured exclusion"
        : !supported.test(file)
          ? "Unsupported file type"
          : !["100644", "100755"].includes(entry.mode)
            ? "Symlink or submodule"
            : "";
    if (excluded) {
      result.files.push({
        path: file,
        hash: entry.blob,
        status: "excluded",
        reason: excluded,
        functions: 0,
        units: 0,
      });
      continue;
    }
    try {
      let original: string;
      if (options.overlay) {
        const absolute = path.resolve(root, file);
        if (!absolute.startsWith(root + path.sep))
          throw Error("Path outside estate");
        if (options.buffers?.[file] !== undefined)
          original = options.buffers[file];
        else {
          const stat = await lstat(absolute);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw Error("Not a regular file");
          if (stat.size > 4 * 1024 * 1024)
            throw Error("Exceeds configured 4 MiB analysis limit");
          original = await readFile(absolute, "utf8");
        }
      } else {
        const size = Number(await git(root, "cat-file", "-s", entry.blob));
        if (size > 4 * 1024 * 1024)
          throw Error("Exceeds configured 4 MiB analysis limit");
        original = await git(root, "cat-file", "blob", entry.blob);
      }
      if (original.includes("\0")) throw Error("Binary content in text file");
      const h = hash(original),
        cacheKey = key(file, h, PARSER),
        structural =
          structuralCache.get(cacheKey) ?? analyzeText(file, original),
        rev = options.overlay ? `worktree:${revision}:${h}` : revision;
      structuralCache.set(cacheKey, structural);
      if (structuralCache.size > 20000)
        structuralCache.delete(structuralCache.keys().next().value!);
      const units = chunk(source, file, rev, original, "code", {
        parser: PARSER,
        functions: structural.functions,
        imports: structural.imports,
        structuralErrors: structural.errors,
      });
      result.units.push(...units);
      imports.set(file, structural.imports);
      result.errors.push(...structural.errors.map((e) => `${file}: ${e}`));
      result.files.push({
        path: file,
        hash: h,
        status: structural.errors.length ? "error" : "included",
        reason: structural.errors.join("; ") || undefined,
        functions: structural.functions.length,
        units: units.length,
      });
    } catch (e) {
      if (options.overlay && (e as any).code === "ENOENT") continue;
      const reason = errorText(e);
      result.files.push({
        path: file,
        hash: entry.blob,
        status: "error",
        reason,
        functions: 0,
        units: 0,
      });
      result.errors.push(`${file}: ${reason}`);
    }
  }
  const names = new Set(
    result.files.filter((f) => f.status === "included").map((f) => f.path),
  );
  for (const [file, specs] of imports)
    for (const spec of specs) {
      const base = spec.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
        : spec;
      let candidates = [
        base,
        ...[
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          "/index.ts",
          "/index.tsx",
          "/index.js",
          ".json",
        ].map((x) => base + x),
      ];
      if (file.endsWith(".java"))
        candidates = [...names].filter((n) =>
          n.endsWith("/" + spec.split(".").at(-1) + ".java"),
        );
      const target = candidates.find((n) => names.has(n));
      result.links.push({
        from: file,
        to: target ?? spec,
        kind: "imports",
        basis: target
          ? "Resolved source import"
          : "External package or unresolved import",
        resolved: !!target,
      });
    }
  result.fingerprint = hash(
    result.files.map((f) => [f.path, f.hash, f.status]),
  );
  return result;
}
export function affectedPaths(changed: string[], links: Link[], maxDepth = 4) {
  const affected = new Set(changed);
  let wave = [...changed],
    truncated = false;
  for (let depth = 0; wave.length && depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const link of links)
      if (link.resolved && wave.includes(link.to) && !affected.has(link.from)) {
        affected.add(link.from);
        next.push(link.from);
      }
    wave = next;
    if (depth === maxDepth - 1 && wave.length) truncated = true;
  }
  return { paths: [...affected], truncated };
}
export async function history(
  root: string,
  source: string,
  revision: string,
  years: number,
  exclude: string[] = [],
) {
  const date = (await git(root, "show", "-s", "--format=%cI", revision)).trim(),
    cutoff = new Date(date);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const all = (
      await git(
        root,
        "rev-list",
        "--reverse",
        "--topo-order",
        `--since-as-filter=${cutoff.toISOString()}`,
        revision,
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean),
    units: Unit[] = [],
    errors: string[] = [];
  // A baseline captures pre-window behavior, including code subsequently removed.
  const boundary = (
    await git(
      root,
      "rev-list",
      "-1",
      `--before=${cutoff.toISOString()}`,
      revision,
    )
  ).trim();
  if (boundary) {
    const base = await scan(root, source, { ref: boundary, exclude });
    units.push(
      ...base.units.map((u) => ({
        ...u,
        id: key(u.id, "historical-baseline"),
        kind: "history-baseline",
        metadata: {
          ...u.metadata,
          baseline: true,
          cutoff: cutoff.toISOString(),
        },
      })),
    );
    errors.push(...base.errors);
  }
  for (const commit of all) {
    try {
      const meta = await git(
          root,
          "show",
          "-s",
          "--format=%H%n%P%n%cI%n%B",
          commit,
        ),
        parents = meta.split("\n")[1].split(" ").filter(Boolean);
      const ps = parents.length ? parents : [""];
      for (let order = 0; order < ps.length; order++) {
        const diff = ps[order]
          ? await git(
              root,
              "diff",
              "--no-ext-diff",
              "--no-renames",
              "--unified=8",
              ps[order],
              commit,
              "--",
              ".",
            )
          : await git(
              root,
              "show",
              "--format=",
              "--no-ext-diff",
              "--unified=8",
              commit,
              "--",
              ".",
            );
        // Filter by path before storing or passing patches to a model.
        for (const part of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
          const m = /^diff --git a\/(.+) b\/(.+)$/m.exec(part),
            file = m?.[2] ?? "";
          if (
            !file ||
            blocked.test(file) ||
            !supported.test(file) ||
            exclude.some((p) => file === p || file.startsWith(p + "/"))
          )
            continue;
          units.push(
            ...chunk(source, file, commit, meta + "\n" + part, "git-diff", {
              commit,
              parent: ps[order] || null,
              parentOrder: order + 1,
              commitDate: meta.split("\n")[2],
              patch: true,
            }),
          );
        }
      }
    } catch (e) {
      errors.push(`${commit}: ${errorText(e)}`);
    }
  }
  return {
    units,
    coverage: {
      years,
      cutoff: cutoff.toISOString(),
      asOfCommit: revision,
      baseline: boundary || null,
      commits: all.length,
      units: units.length,
      errors,
      complete: errors.length === 0,
      merges:
        "Each ordered parent is compared separately; commit dates are not deployment dates.",
    },
  };
}
