import type { EvidenceConnector, ExternalItem } from "./contracts.js";
import { errorText } from "../contracts.js";

// Source failures are data about coverage, not failures of the code scan.
export async function collectIssues(
  connector: EvidenceConnector,
  maxPages = 100,
) {
  const items = new Map<string, ExternalItem>(),
    limitations = new Set<string>();
  let cursor: string | undefined,
    complete = false,
    error: string | undefined;
  const seen = new Set<string>();
  try {
    await connector.describe();
    for (let p = 0; p < maxPages; p++) {
      const page = await connector.page(cursor);
      for (const item of page.items) items.set(item.id, item);
      page.limitations.forEach((l) => limitations.add(l));
      if (page.complete) {
        complete = true;
        break;
      }
      if (!page.nextCursor || seen.has(page.nextCursor))
        throw Error("Source pagination is incomplete or repeated its cursor");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (!complete)
      limitations.add(
        "Configured page budget reached; additional issues may exist.",
      );
  } catch (e) {
    error = errorText(e);
    limitations.add(error);
  }
  return {
    items: [...items.values()],
    options: { complete, limitations: [...limitations], error },
    state: error
      ? items.size
        ? "partial"
        : "failed"
      : complete
        ? items.size
          ? "ready"
          : "empty"
        : "partial",
  };
}
