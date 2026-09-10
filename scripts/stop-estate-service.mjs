import { readFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

if (!process.argv[2])
  throw Error("Usage: node scripts/stop-estate-service.mjs /path/to/estate");
const root = await realpath(path.resolve(process.argv[2]));
const meta = path.join(root, ".vr-estate");
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
let manifest;
try {
  manifest = await read(path.join(meta, "estate.json"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const state = manifest?.state ?? path.join(meta, "state");
for (const lock of [
  path.join(meta, "setup.lock"),
  path.join(state, "understanding.lock"),
]) {
  let owner;
  try {
    owner = await read(lock);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (Number.isInteger(owner?.pid) && owner.pid > 1 && alive(owner.pid))
    throw Error(
      "VR is still setting up or learning. Cancel that run before restarting its service.",
    );
}
let connection;
try {
  connection = await read(path.join(state, "connection.json"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log("No VR service connection exists for this estate.");
  process.exit(0);
}
const { pid } = connection;
if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid)
  throw Error("Invalid VR service PID.");
if (!alive(pid)) {
  console.log("The estate's previous VR service is already stopped.");
  process.exit(0);
}
const url = new URL(connection.url);
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.username ||
  url.password
)
  throw Error("Expected a local VR service URL.");
const response = await fetch(new URL("/health", url), {
  headers: { Authorization: "Bearer " + connection.readToken },
  signal: AbortSignal.timeout(3000),
});
if (!response.ok)
  throw Error("Could not authenticate this estate's VR service.");
const health = await response.json();
const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
  encoding: "utf8",
});
if (
  health.pid !== pid ||
  !String(health.version).startsWith("vr-portable-") ||
  !command.includes("cli.js serve") ||
  !command.includes(state)
)
  throw Error(
    "Service identity does not match this estate; no process was stopped.",
  );
process.kill(pid, "SIGTERM");
for (let attempt = 0; attempt < 50; attempt++) {
  if (!alive(pid)) {
    console.log(
      "Stopped this estate's VR service cleanly. Its database is retained; setup will start the rebuilt service.",
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
throw Error(
  "The service is still shutting down. Wait before running setup; no force termination was attempted.",
);
