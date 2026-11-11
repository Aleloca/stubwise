import { randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { driveFiles, driveOpens, projects, type Db } from "@stubwise/db";
import {
  chatAttachmentAllowed,
  DRIVE_CODE_RE,
  DRIVE_FILE_MAX_BYTES,
  driveCode,
  driveFileTypeOf,
  type DriveCodeResolution,
  type DriveFileDetail,
  type DriveFileRow,
  type driveListQuerySchema,
  type DriveUploadResult,
} from "@stubwise/shared";
import type { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { projectPermissionsFor, projectPermissionsMap, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import type { ObjectStorage } from "../storage/index.js";

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
type Row = typeof driveFiles.$inferSelect;

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

/** Le righe con le aperture (90 giorni, l'ultima) in UNA query, sui file vivi. */
function selectRows(db: Db) {
  return db
    .select({
      file: driveFiles,
      projectCode: projects.code,
      opens90d: sql<number>`(select count(*)::int from ${driveOpens} o where o.file_id = ${driveFiles.id} and o.at > now() - interval '90 days')`,
      lastOpenedAt: sql<string | null>`(select to_char(max(o.at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from ${driveOpens} o where o.file_id = ${driveFiles.id})`,
    })
    .from(driveFiles)
    .innerJoin(projects, eq(projects.id, driveFiles.projectId));
}
type Selected = { file: Row; projectCode: string; opens90d: number; lastOpenedAt: string | null };

function toRow(r: Selected, viewer: Viewer, permsOf: (projectId: string) => readonly string[]): DriveFileRow {
  const f = r.file;
  return {
    id: f.id,
    code: driveCode(r.projectCode, f.number),
    projectId: f.projectId,
    projectCode: r.projectCode,
    source: "upload",
    name: f.name,
    mime: f.mime,
    type: f.type,
    sizeBytes: f.sizeBytes,
    addedById: f.addedBy,
    addedAt: f.addedAt.toISOString(),
    opens90d: r.opens90d,
    lastOpenedAt: r.lastOpenedAt,
    summaryLine: null,
    permissions: {
      delete: f.addedBy === viewer.id || permsOf(f.projectId).includes("drive.manage"),
      remove: false,
      hide: false,
      retry: false,
    },
  };
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

/**
 * L'elenco: di un progetto (`projectId`, 404 se non lo si vede) o globale (i
 * progetti di cui si è membri). Filtri e ordinamento del prototipo; `q` cerca
 * nel nome e nel codice, mai nel contenuto (F3).
 */
export async function listDriveFiles(db: Db, viewer: Viewer, query: ListQuery, scope: { projectId?: string }): Promise<DriveFileRow[]> {
  const projectId = scope.projectId ?? query.projectId;
  if (scope.projectId) {
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, scope.projectId));
    if (!project || !(await sees(db, viewer, scope.projectId))) throw notFound();
  }
  const visible = await visibleProjectIds(db, viewer);
  if (visible !== "all" && visible.length === 0) return [];
  const q = query.q?.trim();
  const opens = sql`(select count(*) from ${driveOpens} o where o.file_id = ${driveFiles.id} and o.at > now() - interval '90 days')`;
  const rows = await selectRows(db)
    .where(
      and(
        isNull(driveFiles.deletedAt),
        visible === "all" ? undefined : inArray(driveFiles.projectId, visible),
        projectId ? eq(driveFiles.projectId, projectId) : undefined,
        query.type ? eq(driveFiles.type, query.type) : undefined,
        query.addedById ? eq(driveFiles.addedBy, query.addedById) : undefined,
        q ? or(ilike(driveFiles.name, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), codeCondition(q)) : undefined,
      ),
    )
    .orderBy(
      ...(query.sort === "name"
        ? [asc(sql`lower(${driveFiles.name})`)]
        : query.sort === "recent"
          ? [desc(driveFiles.addedAt)]
          : [desc(opens), desc(driveFiles.addedAt)]),
      asc(driveFiles.id),
    )
    .limit(query.limit ?? LIST_DEFAULT);
  const permsOf = await permsLookup(db, viewer);
  return rows.map((r) => toRow(r, viewer, permsOf));
}

/** Un file vivo che chi guarda vede, o null. */
async function visibleFile(db: Db, viewer: Viewer, id: string): Promise<Selected | null> {
  const [r] = await selectRows(db).where(and(eq(driveFiles.id, id), isNull(driveFiles.deletedAt)));
  if (!r || !(await sees(db, viewer, r.file.projectId))) return null;
  return r;
}

/** Il dettaglio: le aperture totali e la storia, solo con `drive.history`. */
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
  return { ...toRow(r, viewer, permsOf), opensTotal: total?.n ?? 0, history };
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
const displayName = (filename: string): string => (filename.split(/[/\\]/).pop() ?? "").trim() || "file";

/** «Nome (2).ext», «Nome (3).ext»… il primo libero fra i nomi vivi (senza maiuscole). */
function freeName(requested: string, taken: ReadonlySet<string>): string {
  if (!taken.has(requested.toLowerCase())) return requested;
  const dot = requested.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [requested.slice(0, dot), requested.slice(dot)] : [requested, ""];
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
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
  file.stream.on("error", (error) => counter.destroy(error));
  const tooLarge = () => new DriveError(413, "file_too_large", "File exceeds the 100 MB limit");
  try {
    await storage.putObjectStream(storageKey, file.stream.pipe(counter), file.mime);
  } catch (error) {
    await storage.deleteObject(storageKey).catch(() => undefined);
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
    throw error;
  }
  if (file.truncated() || bytes > DRIVE_FILE_MAX_BYTES) {
    await storage.deleteObject(storageKey).catch(() => undefined);
    throw tooLarge();
  }
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
      const name = freeName(requestedName, taken);
      await tx.insert(driveFiles).values({
        id,
        projectId,
        number: (max?.n ?? 0) + 1,
        name,
        mime: file.mime,
        type: driveFileTypeOf(file.mime),
        sizeBytes: bytes,
        storageKey,
        addedBy: viewer.id,
      });
      return { keptBoth: name !== requestedName };
    });
    const r = (await visibleFile(db, viewer, id))!;
    return { file: toRow(r, viewer, await permsLookup(db, viewer)), keptBoth: result.keptBoth, requestedName };
  } catch (error) {
    await storage.deleteObject(storageKey).catch(() => undefined);
    throw error;
  }
}

/**
 * Elimina un file: il proprio, o con `drive.manage`. Lascia una lapide (il
 * codice non si riusa) e restituisce la chiave dell'oggetto, che chi chiama
 * toglie dopo il commit (`markPurged` se riesce).
 */
export async function deleteDriveFile(db: Db, viewer: Viewer, id: string): Promise<{ id: string; storageKey: string }> {
  const r = await visibleFile(db, viewer, id);
  if (!r) throw notFound();
  const perms = await projectPermissionsFor(db, viewer, r.file.projectId);
  if (r.file.addedBy !== viewer.id && !perms?.has("drive.manage")) throw new DriveError(403, "forbidden", "Only who added it, or who manages the Drive");
  const [gone] = await db
    .update(driveFiles)
    .set({ deletedAt: sql`now()`, deletedBy: viewer.id })
    .where(and(eq(driveFiles.id, id), isNull(driveFiles.deletedAt)))
    .returning({ id: driveFiles.id, storageKey: driveFiles.storageKey });
  if (!gone) throw notFound();
  return gone;
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
    .where(and(isNotNull(driveFiles.deletedAt), eq(driveFiles.storagePurged, false)))
    .limit(limit);
  let purged = 0;
  for (const row of rows) {
    try {
      await storage.deleteObject(row.storageKey);
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
export async function openDriveFile(db: Db, viewer: Viewer, id: string, via: "preview" | "download"): Promise<Row | null> {
  const r = await visibleFile(db, viewer, id);
  if (!r) return null;
  await db.execute(sql`
    insert into drive_opens (file_id, person_id, via)
    select ${id}, ${viewer.id}, ${via}
    where not exists (
      select 1 from drive_opens o
      where o.file_id = ${id} and o.person_id = ${viewer.id} and o.at > now() - make_interval(mins => ${OPEN_DEDUP_MINUTES})
    )`);
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
