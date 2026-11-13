import { randomUUID } from "node:crypto";
import { pipeline, Transform, type Readable } from "node:stream";
import { chatChannels, driveContentJobs, driveFileChunks, driveFiles, driveFolderLinks, driveOpens, projects, type Db } from "@stubwise/db";
import { DRIVE_READONLY_SCOPE, folderLinkExpiredSql } from "@stubwise/notifications";
import type { EmbeddingClient } from "@stubwise/embeddings";
import {
  chatAttachmentAllowed,
  DRIVE_CLAUDE_TEXT_MAX,
  DRIVE_CODE_RE,
  DRIVE_FILE_MAX_BYTES,
  driveCode,
  driveContentKindOf,
  driveFileTypeOf,
  type DriveCodeResolution,
  type DriveFileContent,
  type DriveFileDetail,
  type DriveFileRow,
  type driveListQuerySchema,
  type DriveUploadResult,
} from "@stubwise/shared";
import type { z } from "zod";
import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { projectPermissionsFor, projectPermissionsMap, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { StorageObjectNotFound, type ObjectStorage } from "../storage/index.js";
import { clip, displayFileName } from "../storage/filenames.js";
import { removeOrRecordOrphan } from "../storage/orphans.js";
import type { ChatViewer } from "../chat/access.js";
import { downloadableAttachment } from "../chat/attachments.js";

/**
 * Il Drive dei progetti, i file CARICATI (area 5, fetta 2; invariante
 * `docs/invariants/drive.md`).
 * - Chi vede: i MEMBRI del progetto (Viewer compreso; i full admin sono membri
 *   impliciti). Un file di un progetto che non si vede è come uno che non
 *   esiste (404), anche nei codici e nell'elenco globale.
 * - Chi carica: `drive.upload`. Chi toglie: chi l'ha caricato, o `drive.manage`.
 *   La storia delle aperture: `drive.history`.
 * - Il binario va in STREAMING verso lo storage (mai tutto in memoria) e si
 *   scarica con un URL firmato; l'anteprima inline solo per i tipi sicuri.
 * - Eliminare lascia una LAPIDE (il codice non si riusa); l'oggetto si toglie
 *   dopo il commit e, se lo storage è giù, lo ritenta `purgeDeletedDriveObjects`.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type ListQuery = z.infer<typeof driveListQuerySchema>;
/** Una riga SENZA il testo estratto e la sua tsvector: l'elenco non li carica mai (fino a 1.000.000 di caratteri). */
type Row = Omit<typeof driveFiles.$inferSelect, "contentText" | "contentTsv">;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- si tolgono apposta dal select.
const { contentText: _text, contentTsv: _tsv, ...ROW_COLUMNS } = getTableColumns(driveFiles);

export class DriveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const notFound = () => new DriveError(404, "not_found", "Not found");

/** La stessa persona sullo stesso file entro questa finestra conta UNA apertura. */
const OPEN_DEDUP_MINUTES = 30;
const NAME_MAX = 255;
const LIST_DEFAULT = 200;

async function sees(db: Db, viewer: Viewer, projectId: string): Promise<boolean> {
  const visible = await visibleProjectIds(db, viewer);
  return visible === "all" || visible.includes(projectId);
}

/** Chi può caricare nel Drive del progetto, PRIMA di leggere il file: 404 se non lo vede, 403 senza `drive.upload`. */
export async function assertCanUploadDrive(db: Db, viewer: Viewer, projectId: string): Promise<void> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project || !(await sees(db, viewer, projectId))) throw notFound();
  const perms = await projectPermissionsFor(db, viewer, projectId);
  if (!perms?.has("drive.upload")) throw new DriveError(403, "forbidden", "You can't upload to this project's Drive");
}

export { DRIVE_READONLY_SCOPE };

/**
 * Una cartella è SCADUTA (area 6, F5b, B4, e review del server, punto 4):
 * la casella di chi l'ha collegata non c'è più, è disattivata o non ha
 * `drive.readonly`, oppure lui non ha più `drive.manage` nel progetto. Si
 * DERIVA a lettura (la regola sta in `@stubwise/notifications`, la stessa del
 * worker), e ricollegata torna da sola. Vale anche per i suoi file
 * (`access_lost`). Sulla riga di `drive_folder_links` unita alla query.
 */
export const linkExpiredSql = folderLinkExpiredSql(driveFolderLinks);

/**
 * Il file NON si legge (review del server, punto 3, decisione «O»): sparito da
 * Google (`deleted`, scritto) o di una cartella scaduta (`access_lost`,
 * derivato). Il suo testo, il riassunto e i frammenti restano nel DB per
 * quando la cartella torna, ma nessuna lettura li dà: né la ricerca (testo e
 * semantica), né gli snippet, né il riassunto, né Claude, né un allegato.
 * Funziona su ogni query con `drive_files` nel FROM, anche senza join.
 */
export const driveFileUnreadableSql = sql<boolean>`(${driveFiles.unavailable} is not null or exists (
  select 1 from ${driveFolderLinks} fu_l
  where fu_l.id = ${driveFiles.folderLinkId}
    and ${folderLinkExpiredSql({ accountId: sql`fu_l.account_id`, linkedBy: sql`fu_l.linked_by`, projectId: sql`fu_l.project_id` })}
))`;

/** Le righe con le aperture (90 giorni, l'ultima) in UNA query, sui file vivi. */
function selectRows(db: Db) {
  return db
    .select({
      file: ROW_COLUMNS,
      projectCode: projects.code,
      opens90d: sql<number>`(select count(*)::int from ${driveOpens} o where o.file_id = ${driveFiles.id} and o.at > now() - interval '90 days')`,
      lastOpenedAt: sql<string | null>`(select to_char(max(o.at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from ${driveOpens} o where o.file_id = ${driveFiles.id})`,
      // F5b: la cartella da cui viene il file, e se è scaduta (derivato).
      folderId: driveFolderLinks.id,
      folderName: driveFolderLinks.name,
      folderExpired: sql<boolean | null>`case when ${driveFolderLinks.id} is null then null else ${linkExpiredSql} end`,
    })
    .from(driveFiles)
    .innerJoin(projects, eq(projects.id, driveFiles.projectId))
    .leftJoin(driveFolderLinks, eq(driveFolderLinks.id, driveFiles.folderLinkId));
}
type Selected = { file: Row; projectCode: string; opens90d: number; lastOpenedAt: string | null; folderId: string | null; folderName: string | null; folderExpired: boolean | null };

/** Il file non si apre: sparito da Google (scritto) o la cartella non legge più (derivato). */
function unavailableOf(r: Selected): "deleted" | "access_lost" | null {
  if (r.file.unavailable === "deleted") return "deleted";
  return r.folderExpired === true ? "access_lost" : null;
}

function toRow(r: Selected, viewer: Viewer, permsOf: (projectId: string) => readonly string[]): DriveFileRow {
  const f = r.file;
  const manage = permsOf(f.projectId).includes("drive.manage");
  const mine = f.addedBy === viewer.id;
  const unavailable = unavailableOf(r);
  return {
    id: f.id,
    code: driveCode(r.projectCode, f.number),
    projectId: f.projectId,
    projectCode: r.projectCode,
    source: f.source,
    name: f.name,
    mime: f.mime,
    type: f.type,
    sizeBytes: f.sizeBytes,
    addedById: f.addedBy,
    addedAt: f.addedAt.toISOString(),
    opens90d: r.opens90d,
    lastOpenedAt: r.lastOpenedAt,
    // Un file che non si legge non dà nemmeno il riassunto (review, punto 3).
    summaryLine: unavailable ? null : firstSentence(f.summary),
    contentStatus: f.contentStatus,
    contentReason: f.contentReason,
    contentOcr: f.contentOcr,
    snippet: null,
    // Le regole del prototipo (`data/drive/reads.ts`, `drivePermissions`).
    permissions: {
      delete: f.source === "upload" && (mine || manage),
      // «Togli» un riferimento: chi l'ha aggiunto o `drive.manage`; un file di cartella disponibile si nasconde (`use_hide`).
      remove: f.source === "google" && (mine || manage) && (f.folderLinkId === null || unavailable !== null),
      hide: manage && f.folderLinkId !== null,
      // «Riprova» (F3.4): con `drive.manage`, su un file senza testo o in errore.
      retry: manage && (f.contentStatus === "no_text" || f.contentStatus === "error"),
    },
    googleFileId: f.googleFileId,
    googleOwner: f.googleOwner,
    modifiedAt: (f.modifiedAt ?? f.addedAt).toISOString(),
    folder: r.folderId ? { id: r.folderId, name: r.folderName ?? "", status: r.folderExpired ? "expired" : "ok" } : null,
    hidden: f.hidden,
    hiddenBy: f.hidden && f.hiddenAt ? { personId: f.hiddenBy, at: f.hiddenAt.toISOString() } : null,
    unavailable,
  };
}

/** La prima frase del riassunto (la riga sotto il nome), o null. */
function firstSentence(summary: string | null): string | null {
  const text = summary?.trim();
  if (!text) return null;
  const m = /^.+?[.!?](?=\s|$)/s.exec(text);
  return (m ? m[0] : text).trim();
}

async function permsLookup(db: Db, viewer: Viewer): Promise<(projectId: string) => readonly string[]> {
  const map = await projectPermissionsMap(db, viewer);
  return (projectId) => map[projectId] ?? [];
}

/** Un codice F esatto in `q` (la ricerca per codice), come condizione SQL. */
function codeCondition(q: string): SQL | undefined {
  const m = DRIVE_CODE_RE.exec(q.trim().toUpperCase());
  return m ? and(eq(projects.code, m[1]!), eq(driveFiles.number, Number(m[2]))) : undefined;
}

/** La corsia semantica: solo passaggi davvero vicini alla domanda (distanza coseno), al più 20 file. */
const SEMANTIC_MAX_DISTANCE = 0.35;
const SEMANTIC_MAX_FILES = 20;
/** Lo snippet: il passaggio trovato, in testo puro, al più 300 caratteri. */
const SNIPPET_MAX = 300;
/** Le righe restituite che ricevono uno snippet (review della F3): ts_headline costa, e oltre non si legge. */
const SNIPPET_MAX_ROWS = 30;
/** Come la tsvector (0145): i primi 100.000 caratteri del testo. */
const SNIPPET_SOURCE_CHARS = 100_000;

function clipSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  const cut = flat.slice(0, SNIPPET_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > SNIPPET_MAX / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * L'elenco: di un progetto (`projectId`, 404 se non lo si vede) o globale (i
 * progetti di cui si è membri). Filtri e ordinamento del prototipo. `q` cerca
 * nel nome, nel codice e (F3.4) nel CONTENUTO: la tsvector, più la corsia
 * semantica sui chunk se c'è l'embedder (fail-open). Una riga trovata per
 * contenuto porta `snippet`, il passaggio in testo puro; con `q` e l'ordine
 * «Più usati» decide prima la rilevanza, poi le aperture. La visibilità è
 * nella WHERE, prima del limite, anche nella corsia semantica.
 */
export async function listDriveFiles(
  db: Db,
  viewer: Viewer,
  query: ListQuery,
  scope: { projectId?: string },
  opts: { embeddings?: EmbeddingClient | null; log?: (msg: string) => void } = {},
): Promise<DriveFileRow[]> {
  const projectId = scope.projectId ?? query.projectId;
  if (scope.projectId) {
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, scope.projectId));
    if (!project || !(await sees(db, viewer, scope.projectId))) throw notFound();
  }
  const visible = await visibleProjectIds(db, viewer);
  if (visible !== "all" && visible.length === 0) return [];
  const q = query.q?.trim();
  const opens = sql`(select count(*) from ${driveOpens} o where o.file_id = ${driveFiles.id} and o.at > now() - interval '90 days')`;
  const scopeConditions = [
    isNull(driveFiles.deletedAt),
    visible === "all" ? undefined : inArray(driveFiles.projectId, visible),
    projectId ? eq(driveFiles.projectId, projectId) : undefined,
    query.type ? eq(driveFiles.type, query.type) : undefined,
    query.addedById ? eq(driveFiles.addedBy, query.addedById) : undefined,
    query.source ? eq(driveFiles.source, query.source) : undefined,
    // F5b: i nascosti stanno fuori; `hidden=true` li elenca, ma solo nei progetti in cui chi guarda ha `drive.manage`.
    query.hidden ? and(eq(driveFiles.hidden, true), inArray(driveFiles.projectId, await manageableProjects(db, viewer))) : eq(driveFiles.hidden, false),
  ];

  const tsq = q ? sql`plainto_tsquery('simple', ${q})` : null;
  const nameHit = q ? or(ilike(driveFiles.name, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), codeCondition(q)) : undefined;
  // La corsia semantica, fail-open: un embedder giù lascia la ricerca per testo.
  const semantic = new Map<string, string>();
  if (q && opts.embeddings) {
    try {
      const [vector] = await opts.embeddings.embed([q]);
      if (vector) {
        const literal = `[${vector.join(",")}]`;
        // PRIMA il filtro (visibilità, progetto, tipo), POI la distanza, e il
        // passaggio migliore PER FILE (review della F3): un `ORDER BY distanza
        // LIMIT` scenderebbe sull'indice HNSW, che restituisce al più
        // `ef_search` chunk, e i chunk più vicini di un file (o di un progetto)
        // riempirebbero il tetto lasciando fuori il file giusto. Senza
        // `ORDER BY` sulla distanza il planner non usa l'indice: è esatto.
        const distance = sql<number>`(${driveFileChunks.embedding} <=> ${literal}::vector)`;
        const hits = await db
          .selectDistinctOn([driveFileChunks.fileId], { fileId: driveFileChunks.fileId, content: driveFileChunks.content, distance })
          .from(driveFileChunks)
          .innerJoin(driveFiles, eq(driveFiles.id, driveFileChunks.fileId))
          .where(and(...scopeConditions, sql`not ${driveFileUnreadableSql}`, sql`${driveFileChunks.embedding} is not null`, sql`${distance} < ${SEMANTIC_MAX_DISTANCE}`))
          .orderBy(driveFileChunks.fileId, distance);
        for (const h of hits.sort((a, b) => a.distance - b.distance).slice(0, SEMANTIC_MAX_FILES)) semantic.set(h.fileId, h.content);
      }
    } catch (error) {
      opts.log?.(`[drive] ricerca semantica non disponibile, resta il testo: ${String(error)}`);
    }
  }
  const qCondition = q
    ? or(nameHit, sql`(${driveFiles.contentTsv} @@ ${tsq} and not ${driveFileUnreadableSql})`, semantic.size > 0 ? inArray(driveFiles.id, [...semantic.keys()]) : undefined)
    : undefined;

  const rows = await selectRows(db)
    .where(and(...scopeConditions, qCondition))
    .orderBy(
      ...(query.sort === "name"
        ? [asc(sql`lower(${driveFiles.name})`)]
        : query.sort === "recent"
          ? [desc(driveFiles.addedAt)]
          : q
            ? [desc(sql`(${nameHit})`), desc(sql`ts_rank(${driveFiles.contentTsv}, ${tsq})`), desc(opens), desc(driveFiles.addedAt)]
            : [desc(opens), desc(driveFiles.addedAt)]),
      asc(driveFiles.id),
    )
    .limit(query.limit ?? LIST_DEFAULT);
  const permsOf = await permsLookup(db, viewer);
  const out = rows.map((r) => toRow(r, viewer, permsOf));
  if (!q || out.length === 0) return out;

  // Gli snippet, in UNA query sulle sole righe restituite (ts_headline costa):
  // per le righe trovate per contenuto e non per nome.
  const snippets = await db
    .select({
      id: driveFiles.id,
      byName: sql<boolean>`coalesce(${nameHit}, false)`,
      text: sql<string | null>`case when ${driveFiles.contentTsv} @@ ${tsq} and ${driveFiles.contentText} is not null and not ${driveFileUnreadableSql}
        then ts_headline('simple', left(${driveFiles.contentText}, ${SNIPPET_SOURCE_CHARS}), ${tsq}, 'StartSel="", StopSel="", MaxWords=40, MinWords=15, MaxFragments=1')
        else null end`,
    })
    .from(driveFiles)
    .innerJoin(projects, eq(projects.id, driveFiles.projectId))
    .where(inArray(driveFiles.id, out.slice(0, SNIPPET_MAX_ROWS).map((r) => r.id)));
  const byId = new Map(snippets.map((s) => [s.id, s]));
  return out.map((row) => {
    const hit = byId.get(row.id);
    if (!hit || hit.byName) return row;
    const text = hit.text ?? semantic.get(row.id) ?? null;
    return text ? { ...row, snippet: clipSnippet(text) } : row;
  });
}

/** I progetti in cui chi guarda ha `drive.manage` (i nascosti si vedono solo lì). */
async function manageableProjects(db: Db, viewer: Viewer): Promise<string[]> {
  const map = await projectPermissionsMap(db, viewer);
  const ids = Object.entries(map).filter(([, perms]) => perms.includes("drive.manage")).map(([id]) => id);
  return ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"];
}

/** Un file vivo che chi guarda vede, o null. Un NASCOSTO solo con `drive.manage` (F5b). */
async function visibleFile(db: Db, viewer: Viewer, id: string): Promise<Selected | null> {
  const [r] = await selectRows(db).where(and(eq(driveFiles.id, id), isNull(driveFiles.deletedAt)));
  if (!r || !(await sees(db, viewer, r.file.projectId))) return null;
  if (r.file.hidden && !(await projectPermissionsFor(db, viewer, r.file.projectId))?.has("drive.manage")) return null;
  return r;
}

/** Il dettaglio: le aperture totali e la storia, solo con `drive.history`. */
export { visibleFile as visibleDriveFile, toRow as driveRowOf, permsLookup as drivePermsLookup };
export type { Selected as DriveSelected };

export async function getDriveFile(db: Db, viewer: Viewer, id: string): Promise<DriveFileDetail> {
  const r = await visibleFile(db, viewer, id);
  if (!r) throw notFound();
  const permsOf = await permsLookup(db, viewer);
  const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(driveOpens).where(eq(driveOpens.fileId, id));
  const history = permsOf(r.file.projectId).includes("drive.history")
    ? (
        await db
          .select({ personId: driveOpens.personId, at: driveOpens.at, via: driveOpens.via })
          .from(driveOpens)
          .where(eq(driveOpens.fileId, id))
          .orderBy(desc(driveOpens.at))
          .limit(200)
      ).map((h) => ({ personId: h.personId, at: h.at.toISOString(), via: h.via }))
    : null;
  const row = toRow(r, viewer, permsOf);
  return { ...row, opensTotal: total?.n ?? 0, summary: row.unavailable ? null : r.file.summary, history };
}

/**
 * Ciò che Claude legge di un file (F3.5), per codice, coi permessi di chi
 * parla: null (404) se non lo vede o non c'è. Il testo fino a 30.000
 * caratteri; NON conta un'apertura (le aperture sono gesti delle persone).
 */
export async function getDriveFileContent(db: Db, viewer: Viewer, code: string): Promise<DriveFileContent | null> {
  const condition = codeCondition(code);
  if (!condition) return null;
  const [r] = await db
    .select({ id: driveFiles.id, projectId: driveFiles.projectId, number: driveFiles.number, projectCode: projects.code, name: driveFiles.name, type: driveFiles.type, contentStatus: driveFiles.contentStatus, contentReason: driveFiles.contentReason, summary: driveFiles.summary, truncated: driveFiles.contentTruncated, hidden: driveFiles.hidden, unavailable: driveFiles.unavailable, unreadable: driveFileUnreadableSql, text: sql<string | null>`left(${driveFiles.contentText}, ${DRIVE_CLAUDE_TEXT_MAX + 1})` })
    .from(driveFiles)
    .innerJoin(projects, eq(projects.id, driveFiles.projectId))
    .where(and(condition, isNull(driveFiles.deletedAt)));
  if (!r || !(await sees(db, viewer, r.projectId))) return null;
  if (r.hidden && !(await projectPermissionsFor(db, viewer, r.projectId))?.has("drive.manage")) return null;
  // Non si legge (review, punto 3): il file c'è, ma senza testo né riassunto, e lo dice.
  if (r.unreadable) {
    return {
      id: r.id,
      code: driveCode(r.projectCode, r.number),
      projectId: r.projectId,
      name: r.name,
      type: r.type,
      contentStatus: r.contentStatus,
      contentReason: r.contentReason,
      summary: null,
      text: "",
      truncated: false,
      unavailable: r.unavailable === "deleted" ? "deleted" : "access_lost",
    };
  }
  const text = r.text ?? "";
  return {
    id: r.id,
    code: driveCode(r.projectCode, r.number),
    projectId: r.projectId,
    name: r.name,
    type: r.type,
    contentStatus: r.contentStatus,
    contentReason: r.contentReason,
    summary: r.summary,
    text: text.slice(0, DRIVE_CLAUDE_TEXT_MAX),
    truncated: r.truncated || text.length > DRIVE_CLAUDE_TEXT_MAX,
    unavailable: null,
  };
}

/** Dove sta il file di un codice `<PRJ>-F<n>`, per chi lo vede; null altrimenti (404, R-G5). */
export async function resolveDriveCode(db: Db, viewer: Viewer, code: string): Promise<DriveCodeResolution | null> {
  const condition = codeCondition(code);
  if (!condition) return null;
  const [r] = await selectRows(db).where(and(condition, isNull(driveFiles.deletedAt)));
  if (!r || !(await sees(db, viewer, r.file.projectId))) return null;
  return { code: driveCode(r.projectCode, r.file.number), projectId: r.file.projectId, fileId: r.file.id };
}

/** L'ultimo segmento del nome, solo caratteri sicuri: per la chiave dello storage, non per il nome mostrato. */
function sanitizeForKey(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}
const displayName = displayFileName;

/**
 * «Nome (2).ext», «Nome (3).ext»… il primo libero fra i nomi vivi (senza
 * maiuscole), sempre entro i 255 caratteri: si accorcia il nome, non l'estensione.
 */
function freeName(requested: string, taken: ReadonlySet<string>): string {
  if (!taken.has(requested.toLowerCase())) return requested;
  const dot = requested.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [requested.slice(0, dot), requested.slice(dot)] : [requested, ""];
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const room = NAME_MAX - suffix.length - ext.length;
    const candidate = room > 0 ? `${clip(base, room)}${suffix}${ext}` : `${clip(requested, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

class TooLarge extends Error {
  readonly code = "FST_REQ_FILE_TOO_LARGE";
}

/**
 * Carica un file nel Drive: chi chiama ha già controllato l'accesso
 * (`assertCanUploadDrive`) PRIMA di leggere lo stream. Il nome e il tipo si
 * controllano prima di toccare lo storage; il flusso va dritto allo storage
 * contando i byte, e oltre 100 MB si ferma (413) e l'oggetto si toglie. La riga
 * nasce dopo l'oggetto, col numero e il nome liberi sotto un lock del progetto.
 */
export async function uploadDriveFile(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  projectId: string,
  file: { filename: string; mime: string; stream: Readable; truncated: () => boolean },
): Promise<DriveUploadResult> {
  const requestedName = displayName(file.filename);
  if (requestedName.length > NAME_MAX) {
    file.stream.resume();
    throw new DriveError(400, "invalid_filename", `File names are at most ${NAME_MAX} characters`);
  }
  if (!chatAttachmentAllowed(requestedName, file.mime)) {
    file.stream.resume();
    throw new DriveError(400, "unsupported_type", "Unsupported file type");
  }
  const id = randomUUID();
  const storageKey = `drive/${projectId}/${id}/${sanitizeForKey(requestedName)}`;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > DRIVE_FILE_MAX_BYTES) done(new TooLarge("File exceeds the 100 MB limit"));
      else done(null, chunk);
    },
  });
  const tooLarge = () => new DriveError(413, "file_too_large", "File exceeds the 100 MB limit");
  try {
    // `pipeline`, non `.pipe()` (review della fetta 2): un client che si stacca
    // (lo stream distrutto SENZA errore) diventa un errore `ERR_STREAM_PREMATURE_CLOSE`
    // anche per chi legge il contatore, e lo storage annulla il multipart.
    // Con `.pipe()` il contatore non finiva mai e l'handler restava appeso.
    await storage.putObjectStream(storageKey, pipeline(file.stream, counter, () => undefined), file.mime);
  } catch (error) {
    await removeOrRecordOrphan(db, storage, storageKey, "drive_upload_failed");
    const code = (error as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
    if (code === "ERR_STREAM_PREMATURE_CLOSE") throw new DriveError(400, "upload_incomplete", "The upload was interrupted");
    throw error;
  }
  if (file.truncated() || bytes > DRIVE_FILE_MAX_BYTES) {
    await removeOrRecordOrphan(db, storage, storageKey, "drive_upload_too_large");
    throw tooLarge();
  }
  return insertDriveFile(db, storage, viewer, projectId, { id, requestedName, mime: file.mime, sizeBytes: bytes, storageKey });
}

/**
 * La riga di un file il cui oggetto è GIÀ nello storage (caricamento o copia):
 * il numero e il nome liberi sotto un lock del progetto. Se l'insert fallisce
 * l'oggetto si toglie, così non resta un oggetto senza riga.
 */
async function insertDriveFile(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer,
  projectId: string,
  file: { id: string; requestedName: string; mime: string; sizeBytes: number; storageKey: string },
): Promise<DriveUploadResult> {
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stubwise-drive:${projectId}`}))`);
      const [max] = await tx.select({ n: sql<number>`coalesce(max(${driveFiles.number}), 0)::int` }).from(driveFiles).where(eq(driveFiles.projectId, projectId));
      const taken = new Set(
        (
          await tx
            .select({ name: driveFiles.name })
            .from(driveFiles)
            .where(and(eq(driveFiles.projectId, projectId), isNull(driveFiles.deletedAt)))
        ).map((r) => r.name.toLowerCase()),
      );
      const name = freeName(file.requestedName, taken);
      // Il contenuto (F3.1): un tipo che si estrae nasce `pending` col suo job,
      // nella STESSA transazione; uno che non si estrae nasce `unsupported`, senza job.
      const extractable = driveContentKindOf(file.mime) !== null;
      await tx.insert(driveFiles).values({
        id: file.id,
        projectId,
        number: (max?.n ?? 0) + 1,
        name,
        mime: file.mime,
        type: driveFileTypeOf(file.mime),
        sizeBytes: file.sizeBytes,
        storageKey: file.storageKey,
        addedBy: viewer.id,
        contentStatus: extractable ? "pending" : "unsupported",
      });
      if (extractable) await tx.insert(driveContentJobs).values({ fileId: file.id });
      return { keptBoth: name !== file.requestedName };
    });
    const r = (await visibleFile(db, viewer, file.id))!;
    return { file: toRow(r, viewer, await permsLookup(db, viewer)), keptBoth: result.keptBoth, requestedName: file.requestedName };
  } catch (error) {
    await removeOrRecordOrphan(db, storage, file.storageKey, "drive_insert_failed");
    throw error;
  }
}

/**
 * «Save to Drive» da un allegato della Chat (F2.4): una COPIA dell'oggetto
 * sotto una chiave del Drive, mai un riferimento a quello della Chat, che la
 * Chat pota o elimina col messaggio. Solo un allegato di un messaggio vivo che
 * chi chiama LEGGE (un sospeso non si salva). In un canale di progetto il
 * progetto è il suo (un altro è 400 `project_mismatch`); in un DM o in un
 * generale va scelto (`project_required`). Nel progetto serve `drive.upload`.
 */
export async function saveAttachmentToDrive(
  db: Db,
  storage: ObjectStorage,
  viewer: Viewer & ChatViewer,
  attachmentId: string,
  input: { projectId?: string | undefined },
): Promise<DriveUploadResult> {
  const att = await downloadableAttachment(db, viewer, attachmentId);
  if (!att || att.messageId === null) throw notFound();
  const [channel] = await db
    .select({ kind: chatChannels.kind, projectId: chatChannels.projectId })
    .from(chatChannels)
    .where(eq(chatChannels.id, att.channelId));
  if (!channel) throw notFound();
  let projectId: string;
  if (channel.kind === "project" && channel.projectId) {
    if (input.projectId && input.projectId !== channel.projectId) {
      throw new DriveError(400, "project_mismatch", "A file from a project channel goes to that project's Drive");
    }
    projectId = channel.projectId;
  } else {
    if (!input.projectId) throw new DriveError(400, "project_required", "Choose the project whose Drive gets the file");
    projectId = input.projectId;
  }
  await assertCanUploadDrive(db, viewer, projectId);
  const requestedName = displayName(att.filename);
  if (requestedName.length > NAME_MAX) throw new DriveError(400, "invalid_filename", `File names are at most ${NAME_MAX} characters`);
  const id = randomUUID();
  const storageKey = `drive/${projectId}/${id}/${sanitizeForKey(requestedName)}`;
  try {
    await storage.copyObject(att.storageKey, storageKey);
  } catch (error) {
    await removeOrRecordOrphan(db, storage, storageKey, "drive_copy_failed");
    // In gara con l'eliminazione del messaggio: l'allegato non c'è più, 404.
    if (error instanceof StorageObjectNotFound) throw notFound();
    throw error;
  }
  return insertDriveFile(db, storage, viewer, projectId, { id, requestedName, mime: att.mimeType, sizeBytes: att.sizeBytes, storageKey });
}

/**
 * Elimina un file: il proprio, o con `drive.manage`. Lascia una lapide (il
 * codice non si riusa) e restituisce la chiave dell'oggetto, che chi chiama
 * toglie dopo il commit (`markPurged` se riesce).
 */
export async function deleteDriveFile(db: Db, viewer: Viewer, id: string): Promise<{ id: string; storageKey: string }> {
  const r = await visibleFile(db, viewer, id);
  if (!r) throw notFound();
  // F5b: un riferimento Google non si elimina (non è nostro): si toglie (`DELETE` sulla rotta lo smista a `removeGoogleFile`).
  if (r.file.source !== "upload" || !r.file.storageKey) throw new DriveError(400, "not_an_upload", "Only an uploaded file can be deleted");
  const perms = await projectPermissionsFor(db, viewer, r.file.projectId);
  if (r.file.addedBy !== viewer.id && !perms?.has("drive.manage")) throw new DriveError(403, "forbidden", "Only who added it, or who manages the Drive");
  // La lapide porta via il CONTENUTO (F3.1) nella stessa transazione: il
  // testo, il riassunto e i chunk. Un file eliminato non lascia il suo testo nel DB.
  const gone = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(driveFiles)
      .set({ deletedAt: sql`now()`, deletedBy: viewer.id, contentText: null, summary: null })
      .where(and(eq(driveFiles.id, id), isNull(driveFiles.deletedAt)))
      .returning({ id: driveFiles.id, storageKey: driveFiles.storageKey });
    if (row) await tx.delete(driveFileChunks).where(eq(driveFileChunks.fileId, id));
    return row;
  });
  if (!gone || !gone.storageKey) throw notFound();
  return { id: gone.id, storageKey: gone.storageKey };
}

/**
 * «Riprova» (F3.4): con `drive.manage`, su un file `no_text` o `error`. Rimette
 * il file `pending` e in coda (al più un job vivo: l'indice unico parziale), e
 * risponde con la riga.
 */
export async function retryDriveFile(db: Db, viewer: Viewer, id: string): Promise<DriveFileRow> {
  const r = await visibleFile(db, viewer, id);
  if (!r) throw notFound();
  const perms = await projectPermissionsFor(db, viewer, r.file.projectId);
  if (!perms?.has("drive.manage")) throw new DriveError(403, "forbidden", "Only who manages the Drive can retry");
  if (r.file.contentStatus !== "no_text" && r.file.contentStatus !== "error") throw new DriveError(409, "not_retryable", "Only a file without text, or in error, can be retried");
  await db.transaction(async (tx) => {
    await tx
      .update(driveFiles)
      .set({ contentStatus: "pending", contentReason: null })
      .where(and(eq(driveFiles.id, id), isNull(driveFiles.deletedAt)));
    await tx.insert(driveContentJobs).values({ fileId: id }).onConflictDoNothing();
  });
  const again = (await visibleFile(db, viewer, id))!;
  return toRow(again, viewer, await permsLookup(db, viewer));
}

/** L'oggetto di una lapide è stato tolto dallo storage. */
export async function markPurged(db: Db, id: string): Promise<void> {
  await db.update(driveFiles).set({ storagePurged: true }).where(eq(driveFiles.id, id));
}

/**
 * Ritenta gli oggetti delle lapidi rimasti nello storage (il timer orario del
 * server). Senza storage non tocca niente; un rifiuto lascia la riga al giro dopo.
 */
export async function purgeDeletedDriveObjects(db: Db, storage: ObjectStorage | null, log: (msg: string) => void, limit = 200): Promise<number> {
  if (!storage) return 0;
  const rows = await db
    .select({ id: driveFiles.id, storageKey: driveFiles.storageKey })
    .from(driveFiles)
    .where(and(isNotNull(driveFiles.deletedAt), eq(driveFiles.storagePurged, false), isNotNull(driveFiles.storageKey)))
    .orderBy(asc(driveFiles.deletedAt))
    .limit(limit);
  let purged = 0;
  for (const row of rows) {
    try {
      await storage.deleteObject(row.storageKey!);
    } catch (error) {
      log(`[drive] oggetto ${row.storageKey} non tolto dallo storage, riprovo al giro dopo: ${String(error)}`);
      continue;
    }
    await markPurged(db, row.id);
    purged += 1;
  }
  return purged;
}

/**
 * Un'apertura (anteprima o download) di chi guarda: conta UNA volta ogni 30
 * minuti per persona e file. Restituisce il file, o null (404).
 */
export async function openDriveFile(db: Db, viewer: Viewer, id: string, via: "preview" | "download" | "google"): Promise<Row | null> {
  const r = await visibleFile(db, viewer, id);
  if (!r) return null;
  // F5b: un riferimento si apre SU Google (`via: google`), un caricato dallo storage; uno non disponibile non si apre.
  if ((via === "google") !== (r.file.source === "google")) throw new DriveError(400, via === "google" ? "not_a_google_file" : "google_file", "Open this file the way its source allows");
  if (unavailableOf(r)) throw new DriveError(409, "unavailable", "This file is not available");
  // Un advisory lock per (file, persona) (review della fetta 2): due aperture
  // insieme non vedono entrambe «nessuna apertura recente» e ne contano una.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stubwise-drive-open:${id}:${viewer.id}`}))`);
    await tx.execute(sql`
      insert into drive_opens (file_id, person_id, via)
      select ${id}, ${viewer.id}, ${via}
      where not exists (
        select 1 from drive_opens o
        where o.file_id = ${id} and o.person_id = ${viewer.id} and o.at > now() - make_interval(mins => ${OPEN_DEDUP_MINUTES})
      )`);
  });
  return r.file;
}

/**
 * Il Content-Type di un'anteprima INLINE, solo per i tipi sicuri (PDF, immagini
 * raster, testo servito come `text/plain; charset=utf-8`); null = attachment.
 */
export function inlineContentTypeFor(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m === "application/pdf") return "application/pdf";
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(m)) return m;
  if (["text/plain", "text/markdown", "text/csv"].includes(m)) return "text/plain; charset=utf-8";
  return null;
}
