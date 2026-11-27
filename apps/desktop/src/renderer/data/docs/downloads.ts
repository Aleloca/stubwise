import type { DocKind } from "../model";
import { gate } from "../store";

// Scaricare una categoria come .zip e il `graph.json` di uno spazio (ritiro
// del web vecchio, inventario 1.5). Nel prototipo non c'è un server che li
// produca: rispondono `prototype: true`, e la pagina fa lo zip finto e il
// JSON composto dallo stato, come prima. Nella build app li scarica il
// server (`backend/real/docs.ts`).

export type DocDownloadResult =
  | { ok: true; prototype?: true }
  | { ok: false; reason: "not_found" | "unauthenticated" | "failed" };

/** La firma è quella della build app: il prototipo non usa il repository né il tipo. */
export async function exportCategory(repositoryId: string, kind: DocKind): Promise<DocDownloadResult> {
  void repositoryId;
  void kind;
  await gate("docs.exportCategory");
  return { ok: true, prototype: true };
}

export async function downloadGraphJson(repositoryId: string): Promise<DocDownloadResult> {
  void repositoryId;
  await gate("docs.downloadGraphJson");
  return { ok: true, prototype: true };
}
