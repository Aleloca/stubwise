import type { ReleasePage } from "../../types";
import { at } from "./helpers";

// Pagine di Release FINTE: le vere arrivano con l'area 8. Servono solo
// perché la scheda dell'evento «nuova pagina di Release» della Chat punti a
// un oggetto che esiste.

// [id, codice progetto, versione, titolo, riassunto, giorni fa, ora, chi]
type Row = [string, string, string, string, string, number, string, string];

// prettier-ignore
const ROWS: Row[] = [
  ["rel-aud-1", "AUD", "0.9.0", "Private beta", "Dialer, contacts and scheduled callbacks for the first beta workspaces.", 9, "16:40", "p-laura"],
  ["rel-aud-2", "AUD", "0.10.0", "Callbacks and import preview", "Callback times follow the workspace timezone; the CSV import shows duplicates before saving.", 2, "17:05", "p-laura"],
  ["rel-stw-1", "STW", "0.4.0", "Desktop preview", "Tasks, planning and requests in the desktop app, with fake data.", 5, "15:20", "p-laura"],
];

export const RELEASE_PAGES: ReleasePage[] = ROWS.map(
  ([id, code, version, title, summary, days, hm, by]) => ({
    id,
    projectId: `prj-${code.toLowerCase()}`,
    version,
    title,
    summary,
    publishedAt: at(days, hm),
    publishedById: by,
  }),
);
