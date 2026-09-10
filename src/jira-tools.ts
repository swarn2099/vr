import type { McpReader } from "./connectors/contracts.js";

export interface HostTool {
  name: string;
  description: string;
  inputSchema: object | undefined;
  tags: readonly string[];
}
export function isJiraSearchTool(tool: HostTool) {
  const schema = tool.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  return (
    /(?:^|_)searchJiraIssuesUsingJql$/.test(tool.name) &&
    !!schema?.properties?.jql &&
    !!schema?.properties?.cloudId
  );
}
// VS Code's public tool API does not expose MCP annotations. An explicit binding
// to the documented read operation is recorded separately from server annotations.
export function jiraToolReader(
  tools: readonly HostTool[],
  toolName: string,
  invoke: (name: string, input: Record<string, unknown>) => Promise<string>,
): McpReader {
  const selected = tools.find((t) => t.name === toolName);
  if (!selected || !isJiraSearchTool(selected))
    throw new Error(
      "Select the advertised Atlassian searchJiraIssuesUsingJql tool",
    );
  return {
    listTools: async () => ({
      tools: [
        {
          name: toolName,
          description: selected.description,
          readOnlyBinding: "atlassian-jql-v1",
        },
      ],
    }),
    callTool: async (call) => {
      if (call.name !== toolName)
        throw new Error("Jira bridge refuses tools outside its read binding");
      const properties = (
        selected.inputSchema as {
          properties?: Record<string, { enum?: unknown[] }>;
        }
      )?.properties;
      const input = properties?.view?.enum?.includes("full")
        ? { ...call.arguments, view: "full" }
        : call.arguments;
      const text = await invoke(toolName, input);
      if (text.length > 1500000)
        throw new Error(
          "Jira tool response exceeded the page limit; use a smaller page size",
        );
      return { content: [{ type: "text", text }] };
    },
  };
}
