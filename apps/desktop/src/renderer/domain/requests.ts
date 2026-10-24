import type { ProjectRequest, RequestStatus } from "../data/types";

// Le richieste di un progetto: quali sono aperte e quali si somigliano. La
// somiglianza è deterministica e semplice (parole del titolo in comune), al
// posto dell'intake vero che propone le fusioni: basta a far vedere dove
// compare «Similar to …» e chi va fuso con chi.

/** Le richieste su cui si lavora ancora: nuova, in rifinitura, pronta. */
export const OPEN_REQUEST_STATUSES: readonly RequestStatus[] = ["new", "refining", "ready"];

export function isRequestOpen(request: Pick<ProjectRequest, "status">): boolean {
  return OPEN_REQUEST_STATUSES.includes(request.status);
}

// Parole che non dicono di cosa parla una richiesta, in inglese e in italiano.
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "our", "new", "on", "of",
  "una", "uno", "per", "con", "del", "della", "dello", "dei", "delle", "degli", "nel",
  "nella", "che", "alla", "allo", "agli", "alle", "gli", "nuova", "nuovo",
]);

/** Le parole di un titolo che contano: minuscole, da 3 lettere, senza parole vuote. */
export function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/** Almeno due parole in comune, e almeno metà di quelle del titolo più corto. */
function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const shorter = Math.min(a.size, b.size);
  return shared >= 2 && shared * 2 >= shorter ? shared : 0;
}

/**
 * La richiesta aperta (non fusa) dello stesso progetto più simile a un
 * titolo, o `null`. A parità di parole in comune vince la più recente.
 * `excludeId` toglie la richiesta stessa dai candidati.
 */
export function findSimilarRequest(
  title: string,
  projectId: string,
  candidates: readonly ProjectRequest[],
  excludeId?: string,
): ProjectRequest | null {
  const words = titleWords(title);
  let best: { request: ProjectRequest; score: number } | null = null;
  for (const r of candidates) {
    if (r.id === excludeId || r.projectId !== projectId) continue;
    if (r.mergedIntoId !== null || r.status === "archived") continue;
    const score = overlap(words, titleWords(r.title));
    if (score === 0) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && r.createdAt > best.request.createdAt)
    ) {
      best = { request: r, score };
    }
  }
  return best?.request ?? null;
}

/**
 * Le richieste legate a questa: quella a cui somiglia, quelle che somigliano
 * a lei, quelle fuse in lei. Nell'ordine dell'elenco ricevuto, senza doppioni.
 */
export function relatedRequests(
  request: ProjectRequest,
  all: readonly ProjectRequest[],
): ProjectRequest[] {
  return all.filter(
    (r) =>
      r.id !== request.id &&
      (r.id === request.similarToId ||
        r.similarToId === request.id ||
        r.mergedIntoId === request.id),
  );
}
