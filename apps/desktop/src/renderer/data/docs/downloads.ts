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

export async function exportCategory(_repositoryId: string, _kind: DocKind): Promise<DocDownloadResult> {
  await gate("docs.exportCategory");
  return { ok: true, prototype: true };
}

export async function downloadGraphJson(_repositoryId: string): Promise<DocDownloadResult> {
  await gate("docs.downloadGraphJson");
  return { ok: true, prototype: true };
}
