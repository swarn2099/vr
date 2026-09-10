import { serve } from "./service.js";
import { rpc } from "./client.js";
import path from "node:path";
const [command, ...args] = process.argv.slice(2),
  state = path.resolve(
    process.env.VR_STATE_DIRECTORY ?? args[0] ?? ".vr/state",
  );
if (command === "serve") {
  const service = await serve(state);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void service.close().then(() => process.exit(0));
    });
} else if (command === "context") {
  console.log(
    JSON.stringify(
      await rpc(state, "vr_context", {
        productId: process.env.VR_PRODUCT_ID,
        task: args.slice(1).join(" "),
        workspaceRoot: process.env.VR_WORKSPACE_ROOT,
      }),
      null,
      2,
    ),
  );
} else if (command === "rpc") {
  console.log(
    JSON.stringify(
      await rpc(state, args[1], JSON.parse(args[2] ?? "{}"), true),
      null,
      2,
    ),
  );
} else {
  console.error(
    "Usage: vr serve STATE | vr context STATE TASK | vr rpc STATE METHOD JSON",
  );
  process.exitCode = 1;
}
