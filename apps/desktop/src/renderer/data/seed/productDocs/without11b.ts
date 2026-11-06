import { state } from "../../store";
import { PRODUCT_PAGES as PAGES_11A } from "./acq";
import {
  ACQ_11B_BLOCKS,
  PRODUCT_COMMENTS_11B,
  PRODUCT_MARKS_11B,
  PRODUCT_NOTIFICATIONS_11B,
  PRODUCT_REVISIONS_11B,
  PRODUCT_SOURCES_SEEN_11B,
} from "./acq11b";

/**
 * SOLO TEST: toglie dallo stato quello che il seme del 11b aggiunge alla doc
 * di prodotto di ACQ (revisioni, segni, domande, card, fonti viste, e i
 * blocchi scritti da Claude), e rimette le pagine come le lascia il 11a.
 * Serve ai test del motore, del segno e delle domande (Task 2–4), scritti
 * su una Sign-in senza storia di Claude: contano le righe che nascono nel
 * test, e il seme del 11b le confonderebbe. Il seme stesso lo prova
 * `seed.11b.test.ts`. Da chiamare dopo `resetApi()`.
 */
export function withoutSeed11b(): void {
  const ids = (rows: readonly { id: string }[]) => new Set(rows.map((r) => r.id));
  const revisions = ids(PRODUCT_REVISIONS_11B);
  const marks = ids(PRODUCT_MARKS_11B);
  const comments = ids(PRODUCT_COMMENTS_11B);
  const cards = ids(PRODUCT_NOTIFICATIONS_11B);
  state.productRevisions = state.productRevisions.filter((r) => !revisions.has(r.id));
  state.productMarks = state.productMarks.filter((m) => !marks.has(m.id));
  state.productComments = state.productComments.filter((c) => !comments.has(c.id));
  state.notifications = state.notifications.filter((n) => !cards.has(n.id));
  for (const key of PRODUCT_SOURCES_SEEN_11B) state.productSourcesSeen.delete(key);
  for (const id of Object.values(ACQ_11B_BLOCKS)) state.productBlockIds.delete(id);
  for (const page of PAGES_11A) {
    const live = state.productPages.find((p) => p.id === page.id);
    if (!live) continue;
    live.blocks = structuredClone(page.blocks);
    live.updatedAt = page.updatedAt;
    live.updatedById = page.updatedById;
  }
}
