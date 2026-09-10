import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
export async function acquireServiceLock(directory: string) {
  const file = path.join(directory, "service.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(
        file,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      return async () => {
        try {
          if (JSON.parse(await readFile(file, "utf8")).pid === process.pid)
            await unlink(file);
        } catch {}
      };
    } catch (error) {
      if ((error as any).code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(file, "utf8"));
      } catch {
        throw Error("VR service lock is being initialized; retry shortly");
      }
      if (!Number.isInteger(owner.pid) || owner.pid < 1)
        throw Error("Invalid VR service lock; inspect it before recovery");
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if ((e as any).code === "ESRCH") alive = false;
      }
      if (alive) throw Error("A VR service already owns this state directory");
      await unlink(file).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
  throw Error("Could not acquire the VR service lock");
}
