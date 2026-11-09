import type { PreviewKind } from "./driveFilters";

// I contenuti veri dei file caricati in questa sessione del prototipo (shape
// drive.md §9, A8): il renderer legge il File scelto dal disco e ne tiene un
// object URL (immagine, PDF) o le prime righe (testo), per id del file. Vive
// solo in memoria: dopo un riavvio il caricato resta (nel livello dati) e
// l'anteprima è quella finta, con la nota da prototipo. Nessun lavoro nel
// processo main; gli URL si revocano alla chiusura dell'app.

export interface SessionBlob {
  kind: PreviewKind;
  /** Immagine e PDF. */
  url?: string;
  /** Testo: le prime righe (al massimo `TEXT_LIMIT` caratteri). */
  text?: string;
}

const TEXT_LIMIT = 64 * 1024;
const blobs = new Map<string, SessionBlob>();

export function blobOf(fileId: string): SessionBlob | undefined {
  return blobs.get(fileId);
}

/** Tiene il contenuto di un file appena caricato. Il testo si legge (le prime righe). */
export async function rememberBlob(fileId: string, file: File, kind: PreviewKind): Promise<void> {
  if (kind === "text") {
    let text = "";
    try {
      text = await file.slice(0, TEXT_LIMIT).text();
    } catch {
      return; // illeggibile: resta l'anteprima finta
    }
    blobs.set(fileId, { kind, text });
    return;
  }
  if (typeof URL.createObjectURL !== "function") return;
  blobs.set(fileId, { kind, url: URL.createObjectURL(file) });
}

/** Un file eliminato porta via il suo contenuto. */
export function forgetBlob(fileId: string): void {
  const b = blobs.get(fileId);
  if (b?.url) URL.revokeObjectURL?.(b.url);
  blobs.delete(fileId);
}

/** Tutti via (chiusura dell'app, test). */
export function forgetAllBlobs(): void {
  for (const id of [...blobs.keys()]) forgetBlob(id);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", forgetAllBlobs);
