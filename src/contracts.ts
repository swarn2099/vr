import { createHash } from "node:crypto";
import { z } from "zod";
export const hash = (x: unknown) =>
  createHash("sha256")
    .update(typeof x === "string" ? x : JSON.stringify(x))
    .digest("hex");
export const key = (...x: unknown[]) => hash(x);
export const json = (x: unknown) => JSON.stringify(x);
export const Actor = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["human", "agent", "service"]),
    identityBasis: z.enum(["host-account", "configured", "self-reported"]),
    executorId: z.string().optional(),
  })
  .strict();
export const Finding = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,159}$/),
    title: z.string().min(1).max(180),
    statement: z.string().min(1).max(2000),
    conditions: z.array(z.string().max(400)).max(12),
    exceptions: z.array(z.string().max(400)).max(12),
    basis: z.enum(["observation", "inference", "intent", "test-expectation"]),
    temporal: z.enum(["current", "historical", "proposed"]),
    evidence: z.array(z.string()).min(1).max(20),
    contradicts: z.array(z.string()).max(20),
    paths: z.array(z.string()).max(30),
    checks: z.array(z.string().max(400)).max(10),
    extensions: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const Proposal = z
  .object({
    analyses: z
      .array(
        z
          .object({
            evidence: z.string(),
            summary: z.string().min(1).max(1600),
            symbols: z
              .array(
                z
                  .object({
                    name: z.string(),
                    start: z.number().int().positive(),
                    summary: z.string().min(1).max(800),
                  })
                  .strict(),
              )
              .max(300),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    findings: z.array(Finding).max(80),
    relationships: z
      .array(
        z
          .object({
            from: z.string(),
            to: z.string(),
            kind: z.enum([
              "depends_on",
              "conflicts_with",
              "related_to",
              "supersedes",
            ]),
            basis: z.string().min(1).max(1000),
            evidence: z.array(z.string()).min(1).max(12),
          })
          .strict(),
      )
      .max(30),
    questions: z
      .array(
        z
          .object({
            question: z.string().min(1).max(1000),
            reason: z.string().max(1000),
            paths: z.array(z.string()).max(20),
            evidence: z.array(z.string()).max(12),
          })
          .strict(),
      )
      .max(15),
  })
  .strict();
export type Stage =
  | "current"
  | "connections"
  | "estate-connections"
  | "history"
  | "jira"
  | "github-issues"
  | "investigation";
export interface Unit {
  id: string;
  path: string;
  revision: string;
  contentHash: string;
  kind: string;
  label: string;
  start: number;
  end: number;
  text: string;
  metadata: Record<string, any>;
}
export interface FileRecord {
  path: string;
  hash: string;
  status: "included" | "excluded" | "error";
  reason?: string;
  functions: number;
  units: number;
}
export interface Link {
  from: string;
  to: string;
  kind: string;
  basis: string;
  resolved: boolean;
}
export interface Snapshot {
  revision: string;
  branch: string | null;
  files: FileRecord[];
  units: Unit[];
  links: Link[];
  errors: string[];
  overlay: boolean;
  fingerprint: string;
}
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
