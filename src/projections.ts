import type { Engine } from "./engine.js";
export interface ProjectionEvent {
  sequence: number;
  product_id: string;
  kind: string;
  entity_id: string;
  version: number;
  payload: Record<string, unknown>;
}
/** At-least-once outbox delivery. A remote projection must deduplicate sequence IDs
 * and reject older entity versions. Retrieval still hydrates authoritative records. */
export async function project(
  engine: Engine,
  name: string,
  apply: (event: ProjectionEvent) => Promise<void>,
  limit = 100,
) {
  if (!name || limit < 1 || limit > 1000)
    throw Error("Invalid projection name or batch limit");
  await engine.db.query(
    "INSERT INTO vr_projection_cursors(name) VALUES($1) ON CONFLICT DO NOTHING",
    [name],
  );
  const checkpoint = Number(
    (
      await engine.db.query(
        "SELECT sequence FROM vr_projection_cursors WHERE name=$1",
        [name],
      )
    ).rows[0].sequence,
  );
  const events = (
    await engine.db.query(
      "SELECT * FROM vr_outbox WHERE sequence>$1 ORDER BY sequence LIMIT $2",
      [checkpoint, limit],
    )
  ).rows as ProjectionEvent[];
  let cursor = checkpoint;
  for (const event of events) {
    await apply(event);
    const moved = await engine.db.query(
      "UPDATE vr_projection_cursors SET sequence=$2 WHERE name=$1 AND sequence=$3 RETURNING sequence",
      [name, event.sequence, cursor],
    );
    if (!moved.rows.length)
      throw Error(
        "Another projection worker advanced this cursor; retry idempotently",
      );
    cursor = Number(event.sequence);
  }
  return { delivered: events.length, cursor, atLeastOnce: true };
}
