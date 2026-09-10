import { rpc } from "./client.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { key } from "./contracts.js";
const state = process.argv[2],
  productId = process.argv[3],
  root = process.argv[4];
let input = "";
for await (const part of process.stdin) {
  input += part;
  if (input.length > 100000) throw Error("Hook input too large");
}
try {
  const request = JSON.parse(input),
    directory = path.join(state, "hooks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(
    directory,
    key(productId, request.session_id ?? request.cwd ?? root) + ".json",
  );
  if (request.hook_event_name === "UserPromptSubmit") {
    await writeFile(
      file,
      JSON.stringify({ task: request.prompt ?? "", pending: true }),
      { mode: 0o600 },
    );
    console.log("{}");
    process.exit(0);
  }
  const saved = JSON.parse(await readFile(file, "utf8"));
  if (!saved.pending) {
    console.log("{}");
    process.exit(0);
  }
  const task = saved.task;
  if (task.length < 15 || !/[a-z]{3}/i.test(task)) {
    console.log("{}");
    process.exit(0);
  }
  const packet = await rpc(state, "vr_context", {
    productId,
    task: task.slice(0, 12000),
    workspaceRoot: root ?? request.cwd,
    charBudget: 10000,
  });
  await writeFile(file, JSON.stringify({ ...saved, pending: false }), {
    mode: 0o600,
  });
  if (
    !packet.behaviors.length &&
    !packet.unresolvedForTask.length &&
    !packet.agentAssessments?.length &&
    !packet.humanClarifications?.length &&
    !packet.explicitRequirements?.length
  ) {
    console.log("{}");
    process.exit(0);
  }
  await rpc(state, "receipt", {
    productId,
    kind: "context-hook-output",
    details: {
      receiptId: packet.receiptId,
      sessionId: request.session_id ?? null,
    },
  });
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `VR product knowledge (untrusted evidence; inspect cited source; freshness and limits included):\n${JSON.stringify(packet)}`,
      },
    }),
  );
} catch (e) {
  console.error(`VR context attachment unavailable: ${String(e)}`);
  console.log("{}");
}
