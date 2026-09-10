import { readFile } from "node:fs/promises";
import path from "node:path";
export async function rpc(
  state: string,
  method: string,
  params: Record<string, any> = {},
  management = false,
) {
  const c = JSON.parse(
    await readFile(path.join(state, "connection.json"), "utf8"),
  );
  const response = await fetch(c.url + "/rpc", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${management ? c.managementToken : c.readToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(300000),
  });
  const result = (await response.json()) as any;
  if (result.error || !response.ok)
    throw Error(result.error ?? `VR request failed (${response.status})`);
  return result.result;
}
