import { z } from "zod";
import type { Stage } from "./contracts.js";

// Versioned configuration lives in source attributes; evidence and ACLs remain independent.
export const StageFlags = z
  .object({
    currentCode: z.boolean().default(true),
    historicalCode: z.boolean().default(true),
    jira: z.boolean().default(true),
    githubIssues: z.boolean().default(false),
  })
  .strict();
export const PipelineConfig = z
  .object({
    version: z.literal(1).default(1),
    stages: StageFlags.prefault({}),
  })
  .strict();
export type Flags = z.infer<typeof StageFlags>;
export const stageOrder = [
  "current",
  "connections",
  "estate-connections",
  "history",
  "jira",
  "github-issues",
  "investigation",
];
export const isIssueStage = (stage: string) =>
  ["jira", "github-issues"].includes(stage);
export function flagsFor(source: any): Flags {
  return PipelineConfig.parse(source?.attributes?.pipeline ?? {}).stages;
}
export function stageEnabled(stage: string, flags: Flags) {
  if (
    stage === "current" ||
    stage === "connections" ||
    stage === "estate-connections"
  )
    return flags.currentCode;
  if (stage === "history") return flags.historicalCode;
  if (stage === "jira") return flags.jira;
  if (stage === "github-issues") return flags.githubIssues;
  return true;
}
export function requiredStages(stage: string, flags: Flags): Stage[] {
  const required: Stage[] =
    stage === "connections"
      ? ["current"]
      : stage === "history"
        ? ["current", "connections"]
        : isIssueStage(stage)
          ? ["current", "connections", "history"]
          : [];
  // Jira is enrichment, never a hard prerequisite for GitHub issues.
  return required.filter((s) => stageEnabled(s, flags));
}
