import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import pg from "pg";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
export interface Sql {
  query<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}
export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(
  directory: string,
  url?: string,
): Promise<Database> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let db: Database;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    db = {
      query: (s, v) => pool.query(s, v),
      exec: (s) => pool.query(s),
      close: () => pool.end(),
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const result = await fn({
            query: (s, v) => c.query(s, v),
            exec: (s) => c.query(s),
          });
          await c.query("COMMIT");
          return result;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
    };
  } else
    db = (await PGlite.create(path.join(directory, "postgres"), {
      extensions: { vector },
    })) as unknown as Database;
  const schema = await readFile(
    new URL("./schema.sql", import.meta.url),
    "utf8",
  ).catch(() =>
    readFile(new URL("../src/schema.sql", import.meta.url), "utf8"),
  );
  const exists = (await db.query("SELECT to_regclass('vr_migrations') AS name"))
    .rows[0].name;
  if (exists) {
    const version = Number(
      (
        await db.query(
          "SELECT COALESCE(max(version),0) AS version FROM vr_migrations",
        )
      ).rows[0].version,
    );
    if (version > 3) {
      await db.close();
      throw Error(
        "This database uses a newer VR schema; upgrade the application before opening it",
      );
    }
  }
  await db.transaction(async (tx) => {
    await tx.exec(schema);
  });
  return db;
}
