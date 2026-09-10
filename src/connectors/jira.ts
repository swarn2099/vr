import { z } from "zod";
import { hash as digest } from "../contracts.js";
import type {
  ConnectorPage,
  EvidenceConnector,
  ExternalItem,
  McpReader,
} from "./contracts.js";

const Issue = z
  .object({
    id: z.string(),
    key: z.string(),
    fields: z
      .object({
        summary: z.string(),
        description: z.unknown().optional(),
        updated: z.string().optional(),
        created: z.string().optional(),
        status: z.object({ name: z.string() }).optional(),
        comment: z
          .object({
            comments: z.array(
              z.object({
                id: z.string(),
                body: z.unknown(),
                updated: z.string().optional(),
              }),
            ),
            total: z.number().optional(),
          })
          .optional(),
        issuelinks: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
function prose(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const obj = value as { text?: unknown; content?: unknown[]; type?: string };
  const own = typeof obj.text === "string" ? obj.text : "";
  return (
    own +
    (obj.content
      ?.map(prose)
      .join(
        ["doc", "bulletList", "orderedList", "listItem"].includes(
          obj.type ?? "",
        )
          ? "\n"
          : "",
      ) ?? "") +
    (obj.type === "hardBreak" ? "\n" : "")
  );
}
export function normalizeIssue(input: unknown, site: string): ExternalItem {
  const issue = Issue.parse(input),
    fields = issue.fields;
  const commentText =
    fields.comment?.comments
      .map(
        (c) =>
          `Comment ${c.id} (${c.updated ?? "time unavailable"}):\n${prose(c.body)}`,
      )
      .join("\n\n") ?? "";
  const body = `${issue.key}: ${fields.summary}\n\nDescription:\n${prose(fields.description)}\n\nStatus: ${fields.status?.name ?? "unknown"} (workflow state; not proof of implementation or deployment)\n\n${commentText}`;
  return {
    id: issue.key,
    title: fields.summary,
    body,
    revision: fields.updated ?? digest(JSON.stringify(issue)),
    url: new URL(`/browse/${encodeURIComponent(issue.key)}`, site).href,
    sourceCreatedAt: fields.created,
    sourceUpdatedAt: fields.updated,
    relationships: [],
    metadata: {
      upstreamId: issue.id,
      workflowStatus: fields.status?.name,
      commentsComplete:
        fields.comment?.total === undefined
          ? false
          : fields.comment.total === fields.comment.comments.length,
      historyIncluded: false,
    },
  };
}
export interface JiraBinding {
  site: string;
  projectKey: string;
  searchTool: string;
  cloudId?: string;
  pageSize?: number;
}
export function decodeJiraPayload(text: string): unknown {
  const payload = JSON.parse(text);
  if (
    payload &&
    typeof payload === "object" &&
    (payload.error || payload.isError)
  )
    throw new Error(
      `Atlassian could not complete the read: ${typeof payload.message === "string" ? payload.message : "upstream error"}`,
    );
  return payload;
}
export class JiraMcpConnector implements EvidenceConnector {
  kind = "jira";
  private discovered = false;
  constructor(
    readonly reader: McpReader,
    readonly binding: JiraBinding,
  ) {
    const url = new URL(binding.site);
    if (url.protocol !== "https:") throw new Error("Jira site must use HTTPS");
    if (!/^[A-Z][A-Z0-9_]*$/.test(binding.projectKey))
      throw new Error("Invalid Jira project key");
  }
  async describe() {
    const advertised = await this.reader.listTools();
    const tool = advertised.tools.find(
      (t) => t.name === this.binding.searchTool,
    );
    if (!tool)
      throw new Error(
        "Configured Jira search tool is not advertised by the connected MCP server",
      );
    if (
      tool.annotations?.readOnlyHint !== true &&
      tool.readOnlyBinding !== "atlassian-jql-v1"
    )
      throw new Error(
        "The configured Jira search tool must explicitly advertise read-only behavior or use the pinned Atlassian JQL binding",
      );
    this.discovered = true;
    return {
      readOnly: true,
      supportsHistory: false,
      supportsDelta: false,
      supportsDeletion: false,
    };
  }
  async page(cursor?: string): Promise<ConnectorPage> {
    if (!this.discovered) await this.describe();
    const maxResults = this.binding.pageSize ?? 50;
    const args: Record<string, unknown> = {
      jql: `project = "${this.binding.projectKey}" ORDER BY key ASC`,
      maxResults,
      fields: [
        "summary",
        "description",
        "updated",
        "created",
        "status",
        "comment",
        "issuelinks",
      ],
    };
    if (this.binding.cloudId) args.cloudId = this.binding.cloudId;
    if (cursor) args.nextPageToken = cursor;
    const response = await this.reader.callTool({
      name: this.binding.searchTool,
      arguments: args,
    });
    if (response.isError)
      throw new Error(
        "Jira MCP search failed; prior evidence remains retained",
      );
    let payload = response.structuredContent;
    if (!payload) {
      const text = response.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (!text) throw new Error("Jira MCP returned no data");
      payload = decodeJiraPayload(text);
    }
    const page = z
      .object({
        issues: z.array(Issue),
        nextPageToken: z.string().optional(),
        isLast: z.boolean().optional(),
        total: z.number().optional(),
        startAt: z.number().optional(),
      })
      .passthrough()
      .parse(payload);
    if (
      page.issues.some(
        (issue) =>
          !new RegExp(`^${this.binding.projectKey}-[1-9][0-9]*$`).test(
            issue.key,
          ),
      )
    )
      throw new Error("Jira returned an issue outside the configured project");
    const items = page.issues.map((issue) =>
      normalizeIssue(issue, this.binding.site),
    );
    if (page.nextPageToken === cursor && cursor)
      throw new Error("Jira pagination repeated its cursor");
    // Never infer completeness from one short page if the provider did not attest it.
    const complete =
      page.isLast === true ||
      (page.total !== undefined &&
        (page.startAt ?? 0) + items.length >= page.total);
    if (!complete && !page.nextPageToken)
      throw new Error(
        "Jira pagination is incomplete or unsupported; configure the provider adapter before continuing",
      );
    return {
      items,
      nextCursor: complete ? undefined : page.nextPageToken,
      complete,
      limitations: [
        "History is not included by this binding.",
        "Comments can be truncated; per-item completeness is recorded.",
        "This binding requires a paginated Jira search tool accepting JQL and nextPageToken; other advertised tools require an adapter.",
        "Missing items do not establish deletion or permission revocation.",
      ],
    };
  }
}
