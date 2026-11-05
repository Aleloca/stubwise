// Salvare un'esportazione (area 11a, Task 12). Nell'app la richiesta passa
// dal solo canale `file:save` (`window.stubwise.saveFile`): il processo
// principale stampa il PDF, apre la finestra di salvataggio e risponde con
// l'esito, mai col percorso. Senza preload (`preview:web`, test) si fa come
// in un browser: il PDF apre la stampa del browser, il Word si scarica.

export type SaveFileRequest = StubwiseSaveFileRequest;
export type SaveFileResult = StubwiseSaveFileResult;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Il nome di un file scaricato: niente separatori né caratteri riservati (il browser ripulisce comunque). */
const downloadName = (name: string) =>
  `${name.replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, "-").trim() || "Stubwise export"}.docx`;

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
