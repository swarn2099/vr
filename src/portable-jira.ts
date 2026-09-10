import { normalizeIssue, decodeJiraPayload } from "./connectors/jira.js";
export interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema?: any;
}
export function jiraSearchTools(tools: readonly AdvertisedTool[]) {
  return tools.filter(
    (t) => /search/i.test(t.name) && t.inputSchema?.properties?.jql,
  );
}
export async function readJiraProject(
  tool: AdvertisedTool,
  binding: { site: string; project: string; cloudId?: string },
  invoke: (name: string, input: any) => Promise<any>,
  maxPages = 40,
) {
  if (!jiraSearchTools([tool]).length)
    throw Error("Choose an advertised JQL search operation.");
  if (!/^[A-Z][A-Z0-9_]*$/.test(binding.project))
    throw Error("Invalid Jira project key.");
  const url = new URL(binding.site);
  if (url.username || url.password)
    throw Error(
      "Put Jira credentials in VS Code MCP authorization, not the site URL.",
    );
  if (url.protocol !== "https:") throw Error("Jira URL must use HTTPS.");
  const p = tool.inputSchema.properties;
  const fields = [
    "summary",
    "description",
    "created",
    "updated",
    "status",
    "comment",
    "issuelinks",
  ];
  const items: any[] = [];
  let offset = 0,
    cursor: string | undefined,
    complete = false;
  const seen = new Set<string>();
  const limits: string[] = [
    "Issue change histories are not collected.",
    "Comment completeness is recorded per issue.",
    "Absent results do not establish deletion.",
  ];
  for (let page = 0; page < maxPages; page++) {
    const input: any = {
      jql: `project = "${binding.project}" ORDER BY key ASC`,
    };
    if (p.cloudId) {
      if (!binding.cloudId)
        throw Error(
          "This Jira tool requires a Cloud site ID; complete site discovery in VS Code.",
        );
      input.cloudId = binding.cloudId;
    }
    const size = ["maxResults", "limit", "page_size", "pageSize"].find(
      (k) => p[k],
    );
    if (size) input[size] = 50;
    const start = ["startAt", "start_at", "start", "offset"].find((k) => p[k]);
    if (start) input[start] = offset;
    if (cursor && p.nextPageToken) input.nextPageToken = cursor;
    if (p.fields)
      input.fields = p.fields.type === "string" ? fields.join(",") : fields;
    if (p.view?.enum?.includes("full")) input.view = "full";
    const missing = (tool.inputSchema.required ?? []).filter(
      (k: string) => input[k] === undefined && p[k]?.default === undefined,
    );
    if (missing.length)
      throw Error(
        "Jira tool needs unsupported required inputs: " +
          missing.join(", ") +
          ". Existing authorization is retained.",
      );
    let payload = await invoke(tool.name, input);
    if (typeof payload === "string") payload = decodeJiraPayload(payload);
    if (payload?.error || payload?.isError)
      throw Error("Jira search returned an upstream error.");
    if (payload?.data && !payload.issues) payload = payload.data;
    const records = Array.isArray(payload)
      ? payload
      : (payload.issues ?? payload.results);
    if (!Array.isArray(records))
      throw Error(
        "Unsupported Jira search response; expected issues or results.",
      );
    for (const raw of records) {
      const issue = raw.fields
        ? raw
        : {
            ...raw,
            id: String(raw.id ?? raw.key),
            fields: {
              summary: raw.summary ?? raw.title,
              description: raw.description,
              created: raw.created,
              updated: raw.updated,
              status:
                typeof raw.status === "string"
                  ? { name: raw.status }
                  : raw.status,
              comment:
                raw.comment ??
                (raw.comments
                  ? { comments: raw.comments, total: raw.comments_total }
                  : undefined),
              issuelinks: raw.issuelinks,
            },
          };
      if (!new RegExp("^" + binding.project + "-[1-9][0-9]*$").test(issue.key))
        throw Error("Jira returned a record outside the selected project.");
      const item = normalizeIssue(issue, binding.site);
      if (!seen.has(item.id)) {
        items.push(item);
        seen.add(item.id);
      }
    }
    const nextOffset =
      (payload.startAt ?? payload.start_at ?? offset) + records.length;
    if (
      payload.isLast === true ||
      (typeof payload.total === "number" && nextOffset >= payload.total)
    ) {
      complete = true;
      break;
    }
    if (payload.nextPageToken && p.nextPageToken) {
      if (payload.nextPageToken === cursor)
        throw Error("Jira repeated a pagination cursor.");
      cursor = payload.nextPageToken;
    } else if (start && typeof payload.total === "number" && records.length) {
      offset = nextOffset;
    } else {
      limits.push(
        "Provider did not establish complete pagination; collected evidence is partial.",
      );
      break;
    }
    if (page === maxPages - 1)
      limits.push("Jira page budget reached; collection remains partial.");
  }
  return {
    items,
    options: { complete, limitations: limits },
    partial: !complete,
  };
}
