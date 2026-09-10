import test from "node:test";
import assert from "node:assert/strict";
import {
  codexArguments,
  inspectCodexEvents,
  proposalOutputSchema,
} from "../src/codex-provider.js";
test("Codex worker fixes the requested model/effort and rejects tool use or an incomplete turn", () => {
  const args = codexArguments("/estate", "/out", "/schema");
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes("--ignore-user-config"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  const done = {
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 20 },
  };
  assert.throws(
    () =>
      inspectCodexEvents([
        { type: "item.completed", item: { type: "command_execution" } },
        done,
      ]),
    /used a tool/,
  );
  assert.throws(
    () =>
      inspectCodexEvents([
        { type: "turn.failed", error: { message: "quota" } },
      ]),
    /quota/,
  );
  assert.throws(
    () => inspectCodexEvents([{ type: "thread.started" }]),
    /completed turn/,
  );
  assert.deepEqual(inspectCodexEvents([done]).usage, done.usage);
  const schema = proposalOutputSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "analyses",
    "findings",
    "relationships",
    "questions",
  ]);
  assert.equal(
    schema.properties.findings.items.properties.extensions.additionalProperties,
    false,
  );
  assert.ok(!JSON.stringify(schema).includes("propertyNames"));
});
