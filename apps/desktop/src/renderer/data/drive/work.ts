import { gate, state, storeGeneration } from "../store";
import type { ContentState, DriveFile, GoogleDriveFile } from "../types";
import { uploadedContent } from "./content";

// Il lavoro simulato del Drive (area 5): l'estrazione del contenuto (testo,
// OCR, riassunto) è finta. Un file nuovo o reindicizzato è `processing`, e
// passa allo stato finale con un passo che passa da `gate()`
// (`drive.advanceContent`): segue `setLatency`, e `failNext` lo fa finire in
// `error`. Nessun timer sull'orologio. I file che il seme lascia in
// elaborazione partono alla prima lettura del Drive (`startSeedWork`), una
// volta per stato: nessun elenco resta ad aspettare un passo che non arriva.

export const googleFileById = (googleFileId: string | null): GoogleDriveFile | undefined =>
  state.googleFiles.find((g) => g.googleFileId === googleFileId);

const pending = new Set<Promise<void>>();

export function track(work: Promise<void>): void {
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** Si risolve quando nessuna estrazione simulata è più in corso. */
export async function whenDriveIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/** Gli stati del contenuto attraversati da un file dal seme (o da quando è nato). */
export function driveContentHistory(fileId: string): ContentState[] {
  return [...(state.driveContentLog.get(fileId) ?? [])];
}

function setContent(
  file: DriveFile,
  patch: Pick<DriveFile, "content" | "text" | "summary"> & Partial<DriveFile>,
): void {
  Object.assign(file, patch);
  const log = state.driveContentLog.get(file.id) ?? [];
  log.push(file.content);
  state.driveContentLog.set(file.id, log);
}

/** In elaborazione: testo e riassunto si rifanno (si trova solo per nome). */
export const reading = (file: DriveFile) =>
  setContent(file, { content: "processing", text: "", summary: null });

/** Il contenuto finale di un file: da Google (il file com'è lì) o, per un caricato, finto dal tipo. */
function finalContent(
  file: DriveFile,
): Pick<DriveFile, "content" | "text" | "summary"> & Partial<DriveFile> {
  const side = file.source === "google" ? googleFileById(file.googleFileId) : undefined;
  if (side) {
    return {
      content: side.content,
      text: side.text,
      summary: side.summary,
      ocr: side.ocr,
      name: side.name,
      modifiedAt: side.modifiedAt,
    };
  }
  return uploadedContent(file.name, file.type);
}

export async function advanceContent(fileIds: readonly string[]): Promise<void> {
  const generation = storeGeneration();
  // Lo stato è stato ripristinato nel frattempo: questo lavoro non è più suo.
  const alive = () => storeGeneration() === generation;
  const processing = () =>
    state.driveFiles.filter((f) => fileIds.includes(f.id) && f.content === "processing");
  try {
    await gate("drive.advanceContent");
    if (!alive()) return;
    for (const file of processing()) setContent(file, finalContent(file));
  } catch {
    if (!alive()) return;
    for (const file of processing())
      setContent(file, { content: "error", text: "", summary: null });
  }
}

/**
 * Fa avanzare, una volta per stato, i file che il seme lascia in
 * elaborazione: la prima lettura del Drive li porta allo stato finale col
 * ritardo simulato, come se Stubwise li stesse finendo di leggere.
 */
export function startSeedWork(): void {
  if (state.driveSeedWorkStarted) return;
  state.driveSeedWorkStarted = true;
  const ids = state.driveFiles.filter((f) => f.content === "processing").map((f) => f.id);
  if (ids.length > 0) track(advanceContent(ids));
}
