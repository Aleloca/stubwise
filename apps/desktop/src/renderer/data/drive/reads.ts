import { fold, highlightParts, MIN_QUERY, searchWords } from "../../pages/chat/search";
import { PEOPLE } from "../seed/people";
import { copy, gate, now, state } from "../store";
import type {
  DriveFile,
  DriveFileDetail,
  DriveFilePermissions,
  DriveFileRow,
  DriveFilters,
  DriveSearchHit,
  DriveSearchResult,
  DriveSearchScope,
  FolderLinkView,
  GoogleAccount,
  GoogleFileChoice,
  GoogleFolderChoice,
  GoogleOutsideFile,
  GoogleOutsideHit,
} from "../types";
import { can, viewerFor } from "../viewer";
import { opens90d, searchableText, summaryLineOf } from "./content";
import {
  canSeeDriveFile,
  canSeeDriveProject,
  driveFileFor,
  googleFileVisible,
  googleFolderVisible,
  isGoogleConnected,
} from "./visibility";
import { startSeedWork } from "./work";

// Le letture del Drive (area 5). Chi vede che cosa lo decide `visibility.ts`.
// Nessuna lettura conta un'apertura: le conta solo `recordOpen` (anteprima,
// «Apri in Google Drive», download), che la superficie chiama apposta. Un
// risultato, un riassunto, il dettaglio e le letture di Claude non contano.

/** Cosa può fare chi guarda su un file che vede. */
export function drivePermissions(me: string, file: DriveFile): DriveFilePermissions {
  const manage = can(viewerFor(me), "drive.manage", file.projectId);
  const mine = file.addedById === me;
  return {
    delete: file.source === "upload" && (mine || manage),
    remove:
      file.source === "google" &&
      (mine || manage) &&
      (file.folderLinkId === null || file.unavailable !== null),
    hide: manage && file.folderLinkId !== null,
    retry: manage && file.content === "error",
  };
}

const opensOfFile = (fileId: string) => state.driveOpens.filter((o) => o.fileId === fileId);

export function driveRow(me: string, file: DriveFile): DriveFileRow {
  // La riga non porta il testo estratto: lo leggono solo ricerca e Claude.
  const rest: Omit<DriveFile, "text"> & { text?: string } = copy(file);
  delete rest.text;
  const link = state.folderLinks.find((l) => l.id === file.folderLinkId);
  const opens = opensOfFile(file.id);
  const hidden = file.hidden ? state.driveHidden.get(file.id) : undefined;
  return {
    ...rest,
    projectCode: state.projectsById.get(file.projectId)!.code,
    opens90d: opens90d(file, now(), opens),
    lastOpenedAt: opens.reduce<string | null>((m, o) => (m === null || o.at > m ? o.at : m), null),
    summaryLine: summaryLineOf(file.summary),
    folder: link ? { id: link.id, name: link.name, status: link.status } : null,
    hiddenBy: hidden ? { ...hidden } : null,
    permissions: drivePermissions(me, file),
  };
}

const byName = (a: DriveFileRow, b: DriveFileRow) =>
  a.name.localeCompare(b.name) || a.code.localeCompare(b.code, undefined, { numeric: true });

/** «Recenti»: l'ultima apertura o modifica. */
const lastActivity = (r: DriveFileRow) =>
  r.lastOpenedAt && r.lastOpenedAt > r.modifiedAt ? r.lastOpenedAt : r.modifiedAt;

const SORTS: Record<DriveFilters["sort"], (a: DriveFileRow, b: DriveFileRow) => number> = {
  most_used: (a, b) =>
    b.opens90d - a.opens90d || lastActivity(b).localeCompare(lastActivity(a)) || byName(a, b),
  recent: (a, b) => lastActivity(b).localeCompare(lastActivity(a)) || byName(a, b),
  name: byName,
};

/**
 * Il Drive: di un progetto o (senza `projectId`) di tutti i progetti che
 * chi guarda vede. `hidden: true` = solo i nascosti, e solo dei progetti in
 * cui chi guarda ha `drive.manage`; altrimenti i nascosti non ci sono.
 */
export async function listDriveFiles(filters: DriveFilters): Promise<DriveFileRow[]> {
  const me = await gate("drive.listDriveFiles");
  startSeedWork();
  const hidden = filters.hidden === true;
  return state.driveFiles
    .filter(
      (f) =>
        f.hidden === hidden &&
        canSeeDriveFile(me, f, { includeHidden: hidden }) &&
        (filters.projectId === undefined || f.projectId === filters.projectId) &&
        (filters.type === undefined || f.type === filters.type) &&
        (filters.source === undefined || f.source === filters.source) &&
        (filters.addedById === undefined || f.addedById === filters.addedById),
    )
    .map((f) => driveRow(me, f))
    .sort(SORTS[filters.sort]);
}

/**
 * Il dettaglio di un file, per id o per codice (`?file=AUD-F7`): il totale
 * da sempre e lo storico (più recenti in alto) solo con `drive.history`,
 * altrimenti `null`. Non conta un'apertura. Per codice vale la stessa regola
 * dell'id: un file che chi guarda non vede non ha codice (R-G5).
 */
export async function getDriveFile(ref: string): Promise<DriveFileDetail | null> {
  const me = await gate("drive.getDriveFile");
  startSeedWork();
  const id = state.driveFiles.find((f) => f.code === ref)?.id ?? ref;
  const file = driveFileFor(me, id);
  if (!file) return null;
  const opens = opensOfFile(file.id);
  return {
    ...driveRow(me, file),
    opensTotal: opens.length,
    history: can(viewerFor(me), "drive.history", file.projectId)
      ? [...opens].reverse().map(copy)
      : null,
  };
}

/** Le cartelle collegate a un progetto, coi file (non nascosti) che portano. */
export async function listFolderLinks(projectId: string): Promise<FolderLinkView[]> {
  const me = await gate("drive.listFolderLinks");
  if (!canSeeDriveProject(me, projectId)) return [];
  return state.folderLinks
    .filter((l) => l.projectId === projectId)
    .map((l) => ({
      ...copy(l),
      fileCount: state.driveFiles.filter((f) => f.folderLinkId === l.id && !f.hidden).length,
      accessLost: state.driveFiles.some(
        (f) => f.folderLinkId === l.id && f.unavailable === "access_lost",
      ),
    }));
}

/**
 * Le cartelle collegate da chi guarda, nei progetti che vede: quelle che
 * smettono di aggiornarsi se scollega il suo account Google.
 */
export async function listMyFolderLinks(): Promise<FolderLinkView[]> {
  const me = await gate("drive.listMyFolderLinks");
  return state.folderLinks
    .filter((l) => l.linkedById === me && canSeeDriveProject(me, l.projectId))
    .map((l) => ({
      ...copy(l),
      fileCount: state.driveFiles.filter((f) => f.folderLinkId === l.id && !f.hidden).length,
      accessLost: state.driveFiles.some(
        (f) => f.folderLinkId === l.id && f.unavailable === "access_lost",
      ),
    }));
}

/**
 * Quante persone leggono il Drive del progetto: la stessa regola di
 * `canSeeDriveProject` (i membri e i full admin, impliciti ovunque), senza
 * Claude. È il numero della frase di «Link a Google folder». Un progetto che
 * chi guarda non vede: 0.
 */
export async function countDriveReaders(projectId: string): Promise<number> {
  const me = await gate("drive.countDriveReaders");
  if (!canSeeDriveProject(me, projectId)) return 0;
  return PEOPLE.filter((p) => !p.isClaude && canSeeDriveProject(p.id, projectId)).length;
}

/** L'account Google personale di chi guarda (collegato o scaduto), o `null`. */
export async function getGoogleAccount(): Promise<GoogleAccount | null> {
  const me = await gate("drive.getGoogleAccount");
  const account = state.googleAccounts.find((a) => a.personId === me);
  return account ? copy(account) : null;
}

/**
 * Il file Google ha già un riferimento: in un progetto dato o, senza, in
 * uno che chi guarda vede (R-G5: un progetto invisibile non deve togliere un
 * file da «fuori dai progetti», o direbbe che esiste).
 */
const referenced = (me: string, googleFileId: string, projectId?: string) =>
  state.driveFiles.some(
    (f) =>
      f.googleFileId === googleFileId &&
      (projectId === undefined ? canSeeDriveFile(me, f) : f.projectId === projectId),
  );

/**
 * I file Google in nessun progetto che chi guarda vede su Google, per nome o
 * contenuto: solo con l'account collegato (scaduto o assente → vuoto).
 */
export async function listGoogleOutside(q: string): Promise<GoogleOutsideFile[]> {
  const me = await gate("drive.listGoogleOutside");
  const needle = q.trim().toLowerCase();
  return outsideFor(me)
    .filter((f) => !needle || [f.name, f.text].some((s) => s.toLowerCase().includes(needle)))
    .map(copy);
}

/** I file Google fuori dai progetti che chi guarda vede: solo con l'account collegato. */
const outsideFor = (me: string): GoogleOutsideFile[] =>
  isGoogleConnected(me)
    ? state.googleOutside.filter(
        (f) => f.visibleToPersonIds.includes(me) && !referenced(me, f.googleFileId),
      )
    : [];

// --- Ricerca -----------------------------------------------------------------

/** Quanto è lungo, al più, il passaggio di un risultato (più le ellissi). */
const PASSAGE = 180;

/**
 * Il passaggio del testo in cui compaiono le parole: il paragrafo che ne
 * contiene di più, tagliato intorno alla prima. `null` se nessuna compare.
 * Le parole si trovano come le evidenzia la Chat (`highlightParts`), così il
 * passaggio contiene sempre ciò che la superficie marca.
 */
export function drivePassage(text: string, words: readonly string[]): string | null {
  let best: { line: string; hits: number; at: number } | null = null;
  for (const line of text.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    const folded = fold(line);
    const hits = words.filter((w) => folded.includes(w)).length;
    if (hits === 0 || (best && hits <= best.hits)) continue;
    const parts = highlightParts(line, words);
    const first = parts.findIndex((p) => p.hit);
    const at = parts.slice(0, first).reduce((n, p) => n + p.text.length, 0);
    best = { line, hits, at };
  }
  if (!best) return null;
  const { line, at } = best;
  if (line.length <= PASSAGE) return line;
  let start = Math.max(0, Math.min(at - 50, line.length - PASSAGE));
  // Si comincia da una parola intera, mai a metà.
  if (start > 0) {
    const space = line.indexOf(" ", start - 1);
    if (space >= 0 && space < at) start = space + 1;
  }
  const end = Math.min(line.length, start + PASSAGE);
  return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
}

/**
 * Quanto corrisponde un testo: le parole trovate nel nome valgono doppio di
 * quelle nel contenuto; `null` se manca anche una sola parola.
 */
function scoreOf(words: readonly string[], name: string, text: string, code = ""): number | null {
  const [n, t, c] = [fold(name), fold(text), fold(code)];
  let score = 0;
  for (const w of words) {
    const inName = n.includes(w) || c.includes(w);
    const inText = t.includes(w);
    if (!inName && !inText) return null;
    score += (inName ? 2 : 0) + (inText ? 1 : 0);
  }
  return score;
}

/**
 * La ricerca nei file del Drive (shape drive-search.md): per nome, codice e
 * contenuto, nei progetti che chi guarda vede e coi filtri dell'elenco. Il
 * contenuto è `searchableText`: un file non disponibile o non pronto si
 * trova solo per nome. I nascosti non ci sono (nemmeno per chi gestisce): un
 * file che chi cerca non vede è un file che non esiste (R-G5). Ordine:
 * codice esatto in testa, poi pertinenza, a parità le aperture degli ultimi
 * 90 giorni, poi la modifica più recente. In coda i file Google fuori dai
 * progetti (account collegato). **Non conta aperture**: le conta solo
 * `recordOpen`, quando chi cerca apre un risultato.
 */
export async function searchDrive(
  q: string,
  scope: DriveSearchScope = {},
): Promise<DriveSearchResult> {
  const me = await gate("drive.searchDrive");
  const query = q.trim();
  if (query.length < MIN_QUERY) return { files: [], outside: [] };
  const words = searchWords(query);
  const exact = fold(query);
  const files = state.driveFiles
    .filter(
      (f) =>
        canSeeDriveFile(me, f) &&
        (scope.projectId === undefined || f.projectId === scope.projectId) &&
        (scope.type === undefined || f.type === scope.type) &&
        (scope.source === undefined || f.source === scope.source) &&
        (scope.addedById === undefined || f.addedById === scope.addedById),
    )
    .flatMap((f) => {
      const text = searchableText(f);
      const isCode = fold(f.code) === exact;
      const score = isCode ? Number.MAX_SAFE_INTEGER : scoreOf(words, f.name, text, f.code);
      if (score === null) return [];
      const hit: DriveSearchHit = { file: driveRow(me, f), passage: drivePassage(text, words) };
      return [{ hit, score }];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.hit.file.opens90d - a.hit.file.opens90d ||
        b.hit.file.modifiedAt.localeCompare(a.hit.file.modifiedAt) ||
        a.hit.file.name.localeCompare(b.hit.file.name),
    )
    .map((x) => x.hit);
  // Fuori dai progetti non c'è un «caricato» né chi l'ha aggiunto.
  const outsideApplies = scope.source !== "upload" && scope.addedById === undefined;
  const outside = (outsideApplies ? outsideFor(me) : [])
    .filter((f) => scope.type === undefined || f.type === scope.type)
    .flatMap((f) => {
      const score = scoreOf(words, f.name, f.text);
      if (score === null) return [];
      const google = state.googleFiles.find((g) => g.googleFileId === f.googleFileId);
      const hit: GoogleOutsideHit = {
        googleFileId: f.googleFileId,
        name: f.name,
        type: f.type,
        owner: google?.owner ?? "",
        modifiedAt: google?.modifiedAt ?? "",
        summary: f.summary,
        passage: drivePassage(f.text, words),
      };
      return [{ hit, score }];
    })
    .sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name))
    .map((x) => x.hit);
  return { files, outside };
}

/**
 * Il selettore di «Collega una cartella»: le cartelle che l'account di chi
 * guarda vede, con quelle già collegate al progetto segnate. Senza account
 * collegato, o senza il progetto, vuoto.
 */
export async function listGoogleFolders(projectId: string): Promise<GoogleFolderChoice[]> {
  const me = await gate("drive.listGoogleFolders");
  if (!canSeeDriveProject(me, projectId) || !isGoogleConnected(me)) return [];
  return state.googleFolders
    .filter((f) => googleFolderVisible(me, f))
    .map((f) => ({
      googleFolderId: f.googleFolderId,
      name: f.name,
      path: [...f.path],
      fileCount: state.googleFiles.filter(
        (g) => g.googleFolderId === f.googleFolderId && !g.deleted,
      ).length,
      alreadyLinked: state.folderLinks.some(
        (l) => l.projectId === projectId && l.googleFolderId === f.googleFolderId,
      ),
    }));
}

/**
 * Il selettore di «Aggiungi da Google Drive»: i file che l'account di chi
 * guarda vede, per nome, con quelli già nel progetto segnati.
 */
export async function listGoogleFiles(projectId: string, q: string): Promise<GoogleFileChoice[]> {
  const me = await gate("drive.listGoogleFiles");
  if (!canSeeDriveProject(me, projectId) || !isGoogleConnected(me)) return [];
  const needle = q.trim().toLowerCase();
  return state.googleFiles
    .filter((f) => googleFileVisible(me, f) && (!needle || f.name.toLowerCase().includes(needle)))
    .map((f) => ({
      googleFileId: f.googleFileId,
      name: f.name,
      type: f.type,
      owner: f.owner,
      modifiedAt: f.modifiedAt,
      alreadyInProject: referenced(me, f.googleFileId, projectId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Claude ------------------------------------------------------------------

/**
 * I file del Drive che Claude può leggere per chi chiede: visibili, non
 * nascosti, disponibili e pronti. Sincrono e senza `gate()`: lo chiamano le
 * risposte di Claude, che hanno già fatto il loro. **Non conta aperture**:
 * Claude legge da qui, mai da `recordOpen`.
 */
export function driveFilesForClaude(me: string): DriveFile[] {
  return state.driveFiles
    .filter((f) => canSeeDriveFile(me, f) && searchableText(f) !== "")
    .map(copy);
}

/** Un file per Claude (vedi `driveFilesForClaude`), o `null`: nascosto e inesistente identici. */
export function readDriveFileForClaude(me: string, id: string): DriveFile | null {
  const file = state.driveFiles.find((f) => f.id === id);
  return file && canSeeDriveFile(me, file) && searchableText(file) !== "" ? copy(file) : null;
}

/**
 * `driveFilesForClaude` per la persona della sessione: la lettura che il
 * motore di intenti riceve (`readsAs`). Passa da `gate()` come ogni lettura
 * del livello dati e, come lei, **non conta aperture**.
 */
export async function listDriveFilesForClaude(): Promise<DriveFile[]> {
  const me = await gate("drive.listForClaude");
  return driveFilesForClaude(me);
}
