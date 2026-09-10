export interface ExternalItem {
  id: string;
  title: string;
  body: string;
  revision: string;
  url?: string;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  relationships: { kind: string; target: string }[];
  metadata: Record<string, unknown>;
}
export interface ConnectorPage {
  items: ExternalItem[];
  nextCursor?: string;
  complete: boolean;
  limitations: string[];
}
export interface EvidenceConnector {
  kind: string;
  describe(): Promise<{
    readOnly: boolean;
    supportsHistory: boolean;
    supportsDelta: boolean;
    supportsDeletion: boolean;
  }>;
  page(cursor?: string): Promise<ConnectorPage>;
}
export interface McpReader {
  listTools(): Promise<{
    tools: {
      name: string;
      description?: string;
      annotations?: { readOnlyHint?: boolean };
      readOnlyBinding?: "atlassian-jql-v1";
    }[];
  }>;
  callTool(args: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{
    isError?: boolean;
    structuredContent?: unknown;
    content?: { type: string; text?: string }[];
  }>;
}
