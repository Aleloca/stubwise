// Salvare un'esportazione (area 11a, Task 12). Nell'app la richiesta passa
// dal solo canale `file:save` (`window.stubwise.saveFile`): il processo
// principale stampa il PDF, apre la finestra di salvataggio e risponde con
// l'esito, mai col percorso. Senza preload (`preview:web`, test) si fa come
// in un browser: il PDF apre la stampa del browser, il Word si scarica.

export type SaveFileRequest = StubwiseSaveFileRequest;
export type SaveFileResult = StubwiseSaveFileResult;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Il tetto del processo principale sul nome (`MAX_NAME` in `src/main/security.ts`, che qui non si importa). */
const MAX_NAME = 120;

/**
 * Il tetto del processo principale sui byte di un Word (`MAX_SAVE_BYTES` in
 * `src/main/security.ts`, che qui non si importa; un test controlla che
 * coincidano). Oltre, il main lo rifiuterebbe sempre: l'esportazione lo dice
 * prima, senza un «Retry» che fallirebbe uguale.
 */
export const MAX_SAVE_BYTES = 25 * 1024 * 1024;

/**
 * Il nome proposto, accorciato perché il processo principale lo accetti
 * (fix round 1, I1): un titolo di pagina non ha tetto. Con «.<formato>» in
 * coda resta entro 120. Si taglia davanti a uno spazio (una parola intera);
 * se l'ultima parola occupa più di metà del posto, fra due caratteri — mai a
 * metà di una coppia surrogata. Spazi, punti e trattini lasciati in coda dal
 * taglio si tolgono.
 */
export function fitFileName(name: string, format: "pdf" | "docx"): string {
  const limit = MAX_NAME - format.length - 1;
  if (name.length <= limit) return name;
  let prefix = "";
  for (const ch of name) {
    if (prefix.length + ch.length > limit) break;
    prefix += ch;
  }
  const atSpace = /\s/.test(name[prefix.length] ?? "");
  const lastSpace = prefix.search(/\s\S*$/);
  const cut = atSpace ? prefix : lastSpace >= limit / 2 ? prefix.slice(0, lastSpace) : prefix;
  return cut.replace(/[\s.\-–—_,;:]+$/u, "") || prefix.trim() || "Stubwise export";
}

/** Il nome di un file scaricato: niente separatori né caratteri riservati (il browser ripulisce comunque). */
const downloadName = (name: string) =>
  `${fitFileName(name.replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, "-").trim(), "docx") || "Stubwise export"}.docx`;

/** Con `window.stubwise.saveFile` il canale; senza (preview:web, test) PDF = `window.print()`, Word = un `Blob` coi byte e `a[download]`, come `downloadText`. */
export async function saveExport(req: SaveFileRequest): Promise<SaveFileResult> {
  const bridge = window.stubwise?.saveFile;
  if (bridge) return bridge(req);
  if (req.format === "pdf") {
    window.print();
    // La stampa del browser dice da sé com'è andata: qui non lo sappiamo, e
    // l'app non afferma un «PDF salvato» che non può dimostrare.
    return { saved: false, reason: "canceled" };
  }
  const bytes = new Uint8Array(req.data);
  const url = URL.createObjectURL(new Blob([bytes], { type: DOCX_MIME }));
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName(req.name);
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { saved: true };
}
