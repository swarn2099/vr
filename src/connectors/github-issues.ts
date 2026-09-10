import { z } from "zod";
import { hash } from "../contracts.js";
import type {
  EvidenceConnector,
  ConnectorPage,
  ExternalItem,
} from "./contracts.js";

export const GitHubBinding = z
  .object({
    owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/),
    repo: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .refine((s) => s !== "." && s !== ".."),
    pageSize: z.number().int().min(1).max(100).default(100),
    maxPages: z.number().int().min(1).max(100).default(20),
    includeComments: z.boolean().default(true),
    maxCommentRequests: z.number().int().min(0).max(1000).default(20),
    maxCommentPages: z.number().int().min(1).max(100).default(2),
  })
  .strict();
export type GitHubBinding = z.infer<typeof GitHubBinding>;
const Issue = z
  .object({
    id: z.number().int(),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    state_reason: z.string().nullable().optional(),
    html_url: z.string().url(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullable(),
    comments: z.number().int().nonnegative(),
    user: z.object({ login: z.string() }).nullable(),
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
    pull_request: z.unknown().optional(),
  })
  .passthrough();
const Comment = z.object({
  id: z.number().int(),
  body: z.string().nullable(),
  updated_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  html_url: z.string().url(),
});
type Comment = z.infer<typeof Comment>;

export function normalizeGitHubIssue(
  input: unknown,
  binding: GitHubBinding,
  comments: Comment[] = [],
  commentsComplete = false,
): ExternalItem {
  const issue = Issue.parse(input);
  if (issue.pull_request !== undefined)
    throw Error("Pull requests are outside the GitHub issues source scope");
  const id = `${binding.owner}/${binding.repo}#${issue.number}`;
  const expected = `https://github.com/${binding.owner}/${binding.repo}/issues/${issue.number}`;
  if (issue.html_url.toLowerCase() !== expected.toLowerCase())
    throw Error("GitHub returned an issue outside the configured repository");
  const body = `${id}: ${issue.title}\n\nAuthor: ${issue.user?.login ?? "deleted account"}\nCreated: ${issue.created_at}\nUpdated: ${issue.updated_at}\nStatus: ${issue.state} (${issue.state_reason ?? "reason unspecified"}; workflow state is not proof of implementation or deployment)\nLabels: ${issue.labels.map((l) => (typeof l === "string" ? l : l.name)).join(", ")}\n\nDescription:\n${issue.body ?? ""}\n\nComments (${comments.length}/${issue.comments}; complete: ${commentsComplete}):\n${comments.map((c) => `Comment ${c.id} by ${c.user?.login ?? "deleted account"} (${c.updated_at}) ${c.html_url}:\n${c.body ?? ""}`).join("\n\n")}`;
  return {
    id,
    title: issue.title,
    body,
    revision: hash({ updated: issue.updated_at, body }),
    url: issue.html_url,
    sourceCreatedAt: issue.created_at,
    sourceUpdatedAt: issue.updated_at,
    relationships: [],
    metadata: {
      upstreamId: issue.id,
      number: issue.number,
      repository: `${binding.owner}/${binding.repo}`,
      author: issue.user?.login,
      workflowStatus: issue.state,
      closedAt: issue.closed_at,
      labels: issue.labels,
      commentsComplete,
      commentCount: issue.comments,
      commentsRead: comments.length,
      historyIncluded: false,
      origin: "github-rest",
      synthetic: false,
    },
  };
}

// Only fixed GitHub.com GET endpoints are requested. Tokens stay in memory and never enter evidence/config.
export class GitHubIssuesConnector implements EvidenceConnector {
  kind = "github-issues";
  readonly binding: GitHubBinding;
  private commentRequests = 0;
  constructor(
    binding: z.input<typeof GitHubBinding>,
    private token?: string,
    private transport: typeof fetch = fetch,
  ) {
    this.binding = GitHubBinding.parse(binding);
  }
  async describe() {
    return {
      readOnly: true,
      supportsHistory: false,
      supportsDelta: false,
      supportsDeletion: false,
    };
  }
  private async get(endpoint: string) {
    const response = await this.transport(
      `https://api.github.com/repos/${this.binding.owner}/${this.binding.repo}/${endpoint}`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "VR-Product-Knowledge",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      },
    );
    if (!response.ok)
      throw Error(
        `GitHub read failed (HTTP ${response.status}${response.status === 403 || response.status === 429 ? "; check authorization or rate limits" : ""}); retained evidence is unchanged`,
      );
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024)
      throw Error("GitHub response exceeds the 8 MiB read limit");
    // Follow page numbers in our fixed endpoint, never credential-bearing remote Link URLs.
    return {
      data: JSON.parse(text) as unknown,
      next: /rel="next"/.test(response.headers.get("link") ?? ""),
    };
  }
  async page(cursor?: string): Promise<ConnectorPage> {
    if (cursor !== undefined && !/^[1-9][0-9]*$/.test(cursor))
      throw Error("Invalid GitHub page cursor");
    const page = Number(cursor ?? 1),
      b = this.binding;
    if (page > b.maxPages) throw Error("GitHub issue page budget exceeded");
    const response = await this.get(
      `issues?state=all&sort=created&direction=asc&per_page=${b.pageSize}&page=${page}`,
    );
    const issues = z
      .array(Issue)
      .parse(response.data)
      .filter((i) => i.pull_request === undefined);
    const items: ExternalItem[] = [],
      limitations = new Set<string>([
        "Open and closed issues are reports or intent, not proof that code implements them.",
        "Pull requests and issue edit history are outside this source scope.",
        "Missing issues do not establish deletion or permission revocation.",
        "Pagination is a live read, not an atomic upstream snapshot.",
      ]);
    for (const issue of issues) {
      let comments: Comment[] = [],
        complete = issue.comments === 0;
      if (b.includeComments && issue.comments > 0) {
        try {
          for (
            let p = 1;
            p <= b.maxCommentPages &&
            this.commentRequests < b.maxCommentRequests;
            p++
          ) {
            this.commentRequests++;
            const r = await this.get(
              `issues/${issue.number}/comments?per_page=100&page=${p}`,
            );
            comments.push(...z.array(Comment).parse(r.data));
            if (!r.next) {
              complete = comments.length === issue.comments;
              break;
            }
          }
        } catch (e) {
          limitations.add(
            `Some comment reads failed; item-level completeness is recorded.`,
          );
        }
      }
      if (!complete)
        limitations.add(
          "Some comments were omitted or hit the configured read budget; per-issue completeness is recorded.",
        );
      items.push(normalizeGitHubIssue(issue, b, comments, complete));
    }
    if (response.next && page === b.maxPages)
      limitations.add(
        "Issue listing reached the configured page budget; coverage is partial.",
      );
    return {
      items,
      complete: !response.next,
      nextCursor: response.next ? String(page + 1) : undefined,
      limitations: [...limitations],
    };
  }
}
