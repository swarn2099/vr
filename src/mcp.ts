import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { rpc } from "./client.js";
const state = process.env.VR_STATE_DIRECTORY!,
  productId = process.env.VR_PRODUCT_ID!,
  workspaceRoot = process.env.VR_WORKSPACE_ROOT;
if (!state || !productId)
  throw Error("VR state and product must be configured by the host");
const initiator = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .optional();
const server = new McpServer({
  name: "vr-product-knowledge",
  version: "0.1.0",
});
const call = async (method: string, p: object) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(
        await rpc(state, method, { ...p, productId, workspaceRoot }),
      ),
    },
  ],
});
server.registerTool(
  "vr_context",
  {
    description:
      "Get compact product behavior, relevant exceptions, historical changes, Jira intent, business impact, exact evidence references and current workspace freshness for this task. Use before consequential edits or when assessing effects on other flows. This is evidence-backed context, not proof of implementation safety.",
    inputSchema: {
      task: z.string().min(1).max(12000),
      focusPaths: z.array(z.string()).max(30).optional(),
      charBudget: z.number().int().min(3000).max(40000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (p) => call("vr_context", p),
);
server.registerTool(
  "vr_evidence",
  {
    description:
      "Read exact immutable source excerpts or patches cited by VR, in one batch. Review these and current code before acting on a finding.",
    inputSchema: {
      ids: z.array(z.string()).min(1).max(20),
      charBudget: z.number().int().min(1000).max(50000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (p) => call("vr_evidence", p),
);
server.registerTool(
  "vr_status",
  {
    description:
      "Read learning stages, processed coverage and unresolved investigations; completed processing is not proof every behavior was discovered.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () => call("status", {}),
);
server.registerTool(
  "vr_investigate_start",
  {
    description:
      "Queue a bounded investigation of a recorded unresolved question. Model work runs in a user-started VR learning session; this call does not assert an answer or launch unlimited work.",
    inputSchema: {
      questionId: z.string(),
      budget: z.number().int().min(1).max(8).default(4),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  (p) => call("investigate", p),
);
server.registerTool(
  "vr_investigate_status",
  {
    description:
      "Read the state and spent call budget of a queued investigation.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (p) => call("investigation.status", p),
);
server.registerTool(
  "vr_record_clarification",
  {
    description:
      "Record an explicit user clarification to a known unresolved question with a required reason and expected revision. It is attributed to the reporting agent, remains unverified, and never becomes verified implementation or an authoritative requirement automatically.",
    inputSchema: {
      initiator,
      questionId: z.string(),
      expectedRevision: z.number().int().min(0),
      answer: z.string().min(1).max(12000),
      reason: z.string().min(1).max(4000),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  (p) => call("clarification.record", p),
);
server.registerTool(
  "vr_correct_behavior",
  {
    description:
      "Record a user correction to a retrieved behavior with version checks and audit history, and queue bounded source reconciliation. Supply initiator identity only if the person provided it; otherwise attribution remains the reporting agent. This does not turn the correction into verified truth.",
    inputSchema: {
      behaviorId: z.string(),
      behaviorVersion: z.number().int().positive(),
      expectedReviewRevision: z.number().int().min(0).default(0),
      initiator,
      answer: z.string().min(1).max(12000),
      reason: z.string().min(1).max(4000),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  (p) => call("behavior.correct", p),
);
await server.connect(new StdioServerTransport());
