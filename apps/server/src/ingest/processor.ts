import { randomUUID } from "node:crypto";
import type { ErrorEvent, FeedbackEvent, IngestEvent, TicketCreateEvent } from "@stubwise/shared";
import { dispatchNotification, type NotificationEvent } from "@stubwise/notifications";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { aiJobs, attachments, errorGroups, tickets } from "@stubwise/db";
import { createTicket, type Ticket } from "../db/tickets.js";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
} from "../routes/attachments.js";
import type { ObjectStorage } from "../storage/index.js";
import { fingerprint } from "./fingerprint.js";

/** Lunghezza massima del titolo di un ticket (allineata alla validazione API). */
const TITLE_MAX = 300;

/** Tentativi massimi per evento errore: ogni retry segue un conflitto
 * sull'unique, cioè un concorrente ha appena creato il gruppo — al giro
 * successivo la SELECT lo trova. Più di un retry è già anomalo. */
const MAX_ATTEMPTS = 3;

export interface ProcessResult {
  /** Ticket nuovi creati (errori nuovi + feedback + eventi ticket). */
  created: number;
  /** Eventi errore collassati su un ErrorGroup esistente. */
  deduped: number;
}

/** Firma del dispatch di notifica iniettabile (default: dispatchNotification). */
export type DispatchFn = (db: Db, event: NotificationEvent) => Promise<void>;

/**
 * Resolver dello storage attivo, iniettato dal chiamante (in produzione
 * `app.storage()`, che incapsula db+encryptionKey; nei test un fake). Ritorna
 * `null` se lo storage non è configurato. Assente = lo screenshot non viene mai
 * salvato (il ticket si crea comunque).
 */
export type StorageResolver = () => Promise<ObjectStorage | null>;

/** MIME immagine ammessi per lo screenshot (sottoinsieme dell'allowlist allegati). */
const ALLOWED_IMAGE_MIME_TYPES = new Set<string>(
  ALLOWED_ATTACHMENT_MIME_TYPES.filter((m) => m.startsWith("image/")),
);

/** Estensione di file dal MIME immagine (per filename e storage key). */
const IMAGE_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

interface DecodedScreenshot {
  mimeType: string;
  buffer: Buffer;
  extension: string;
}

/**
 * Decodifica un dataURL screenshot. Ritorna `null` (silenziosamente) se il
 * formato non è un dataURL immagine valido, se il MIME non è in allowlist o se
 * i byte superano MAX_ATTACHMENT_BYTES. Best-effort: nessun lancio.
 */
function decodeScreenshot(dataUrl: string): DecodedScreenshot | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mimeType = match[1]!.toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) return null;
  const extension = IMAGE_EXTENSION[mimeType];
  if (!extension) return null;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(match[2]!, "base64");
  } catch {
    return null;
  }
  if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) return null;
  return { mimeType, buffer, extension };
}

/**
 * Salva lo screenshot di un feedback come allegato del ticket appena creato.
 * Best-effort totale: qualunque problema (storage assente, decode, put o
 * insert) viene loggato e ignorato — il ticket resta creato e l'ingest 202.
 */
async function saveScreenshotAttachment(
  db: Db,
  ticketId: string,
  dataUrl: string,
  resolveStorage: StorageResolver | undefined,
): Promise<void> {
  if (!resolveStorage) return;
  try {
    const storage = await resolveStorage();
    if (!storage) {
      console.warn("[ingest] storage non attivo: screenshot del feedback ignorato");
      return;
    }
    const decoded = decodeScreenshot(dataUrl);
    if (!decoded) {
      console.warn("[ingest] screenshot del feedback non valido (tipo/dimensione): ignorato");
      return;
    }
    const filename = `feedback-screenshot.${decoded.extension}`;
    const storageKey = `tickets/${ticketId}/${randomUUID()}/${filename}`;
    await storage.putObject(storageKey, decoded.buffer, decoded.mimeType);
    await db.insert(attachments).values({
      ticketId,
      commentId: null,
      uploaderId: null,
      filename,
      mimeType: decoded.mimeType,
      sizeBytes: decoded.buffer.length,
      storageKey,
    });
  } catch (error) {
    // Best-effort: lo screenshot non deve mai disfare l'ingestion del ticket.
    console.warn("[ingest] salvataggio screenshot del feedback fallito (ignorato):", error);
  }
}

/**
 * Opzioni di processEvents. Oltre agli hook di test, trasportano il contesto
 * necessario alla notifica `ticket.created`: l'URL pubblico per comporre il
 * link al ticket e il nome del progetto da mostrare nel messaggio. `dispatch`
 * è iniettabile nei test (default: la dispatchNotification reale, best-effort).
 */
export interface ProcessOptions {
  /** Hook di test: chiamato nel percorso errore quando la SELECT non trova il
   * gruppo, prima della creazione del ticket. Nessun uso in produzione. */
  beforeTicketCreate?: () => Promise<void>;
  /** URL pubblico dell'istanza (PUBLIC_URL), per il link al ticket. Se assente
   * il link è il solo path. */
  publicUrl?: string;
  /** Nome del progetto da mostrare nella notifica. */
  projectName?: string;
  /** Dispatch della notifica (iniettabile nei test). Default:
   * dispatchNotification (best-effort, non lancia mai). */
  dispatch?: DispatchFn;
  /** Resolver dello storage attivo per salvare lo screenshot del feedback come
   * allegato (best-effort). Assente = nessuno screenshot salvato. */
  storage?: StorageResolver;
}

function truncate(text: string): string {
  return text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1)}…`;
}

/**
 * Sentinella interna: lanciata dentro la transazione quando l'insert del
 * gruppo trova il vincolo unique già occupato (race persa). Far esplodere
 * la transazione è il modo più pulito di disfare il ticket appena creato:
 * il rollback cancella ticket e incremento del contatore, senza orfani né
 * buchi nella numerazione. Il chiamante ritenta l'evento come update.
 */
class GroupConflictError extends Error {
  constructor() {
    super("Conflitto sul vincolo unique di error_groups: gruppo creato da un concorrente");
    this.name = "GroupConflictError";
  }
}

/**
 * Dedup di un evento errore via ErrorGroup.
 *
 * Strategia sulla race (due ingestion concorrenti dello stesso errore
 * nuovo): non si può inserire il gruppo "in anticipo" perché ha bisogno del
 * ticketId, e creare prima il ticket lascerebbe orfani in caso di
 * conflitto. Quindi:
 *
 * 1. SELECT del gruppo: se esiste → UPDATE occurrences/lastSeenAt (dedup).
 * 2. Altrimenti crea il ticket, poi INSERT del gruppo con
 *    `onConflictDoNothing` + RETURNING.
 * 3. Se l'insert non restituisce righe, un concorrente ha vinto la corsa
 *    tra la SELECT e l'INSERT: si lancia {@link GroupConflictError} per
 *    far fare rollback all'intera transazione (il ticket appena creato
 *    sparisce) e si ritenta l'evento — al giro dopo la SELECT trova il
 *    gruppo del vincitore e si dedupa come update.
 *
 * Sotto READ COMMITTED l'insert in conflitto con una riga non ancora
 * committata attende il commit del concorrente, quindi al retry il gruppo
 * è visibile: il loop converge sempre (cap difensivo a {@link MAX_ATTEMPTS}).
 */
async function processErrorEvent(
  db: Db,
  projectId: string,
  event: ErrorEvent,
  opts?: ProcessOptions,
): Promise<{ outcome: "created"; ticket: Ticket } | { outcome: "deduped" }> {
  const fp = fingerprint({
    errorType: event.errorType,
    message: event.message,
    stack: event.stack,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [group] = await tx
          .select({ ticketId: errorGroups.ticketId })
          .from(errorGroups)
          .where(and(eq(errorGroups.projectId, projectId), eq(errorGroups.fingerprint, fp)))
          .limit(1);

        if (group) {
          await tx
            .update(tickets)
            .set({
              occurrences: sql`${tickets.occurrences} + 1`,
              lastSeenAt: new Date(),
            })
            .where(eq(tickets.id, group.ticketId));
          return { outcome: "deduped" };
        }

        await opts?.beforeTicketCreate?.();

        const ticket = await createTicket(tx, {
          projectId,
          title: truncate(`${event.errorType ?? "Error"}: ${event.message}`),
          type: "bug",
          priority: "medium",
          source: "sdk_error",
          technicalPayload: {
            message: event.message,
            stack: event.stack,
            url: event.url,
            userAgent: event.userAgent,
            release: event.release,
            environment: event.environment,
            breadcrumbs: event.breadcrumbs,
            timestamp: event.timestamp,
          },
        });

        const inserted = await tx
          .insert(errorGroups)
          .values({ projectId, fingerprint: fp, ticketId: ticket.id })
          .onConflictDoNothing()
          .returning({ id: errorGroups.id });
        if (inserted.length === 0) {
          throw new GroupConflictError();
        }

        await tx.insert(aiJobs).values({ ticketId: ticket.id });
        return { outcome: "created", ticket };
      });
    } catch (err) {
      if (err instanceof GroupConflictError) continue;
      throw err;
    }
  }
  throw new Error(
    `Impossibile processare l'evento errore dopo ${MAX_ATTEMPTS} tentativi (fingerprint ${fp})`,
  );
}

/** I feedback non si dedupano: ogni segnalazione utente è un ticket. */
async function processFeedbackEvent(
  db: Db,
  projectId: string,
  event: FeedbackEvent,
): Promise<Ticket> {
  const bodyLines = [
    event.message,
    ...(event.email !== undefined ? [`Email: ${event.email}`] : []),
    ...(event.url !== undefined ? [`URL: ${event.url}`] : []),
    ...(event.release !== undefined ? [`Release: ${event.release}`] : []),
  ];
  return db.transaction(async (tx) => {
    const ticket = await createTicket(tx, {
      projectId,
      title: truncate(event.message),
      body: bodyLines.join("\n"),
      type: "feedback",
      priority: "medium",
      source: "sdk_feedback",
    });
    await tx.insert(aiJobs).values({ ticketId: ticket.id });
    return ticket;
  });
}

/** Creazione ticket esplicita via SDK/API: type e priority li sceglie il client. */
async function processTicketEvent(
  db: Db,
  projectId: string,
  event: TicketCreateEvent,
): Promise<Ticket> {
  return db.transaction(async (tx) => {
    const ticket = await createTicket(tx, {
      projectId,
      title: truncate(event.title),
      body: event.body,
      type: event.type,
      priority: event.priority,
      source: "api",
    });
    await tx.insert(aiJobs).values({ ticketId: ticket.id });
    return ticket;
  });
}

/**
 * Compone l'URL del ticket: assoluto se `publicUrl` è valorizzato, altrimenti
 * solo il path. publicUrl viene normalizzato togliendo gli slash finali.
 */
function ticketUrl(publicUrl: string | undefined, ticketId: string): string {
  const base = (publicUrl ?? "").replace(/\/+$/, "");
  return `${base}/tickets/${ticketId}`;
}

/**
 * Notifica `ticket.created` per un ticket SDK appena creato (best-effort, DOPO
 * il commit della transazione). Solo per le sorgenti SDK (sdk_error /
 * sdk_feedback): i ticket api/manuali non generano notifica per evitare rumore.
 * Il dispatch reale non lancia mai; il try/catch difende comunque da un
 * dispatch iniettato che lancia, così una notifica non rompe l'ingestion.
 */
async function notifyTicketCreated(
  db: Db,
  ticket: Ticket,
  opts: ProcessOptions | undefined,
): Promise<void> {
  if (ticket.source !== "sdk_error" && ticket.source !== "sdk_feedback") return;
  const dispatch = opts?.dispatch ?? dispatchNotification;
  try {
    await dispatch(db, {
      kind: "ticket.created",
      ticketNumber: ticket.number,
      ticketTitle: ticket.title,
      projectName: opts?.projectName ?? "",
      source: ticket.source,
      ticketUrl: ticketUrl(opts?.publicUrl, ticket.id),
    });
  } catch {
    // Best-effort: una notifica fallita non deve mai disfare l'ingestion.
  }
}

/**
 * Processa un batch di eventi di ingestion per un progetto. Gli eventi
 * errore collassano per fingerprint in un ErrorGroup (un solo ticket e un
 * solo job AI per errore unico); feedback ed eventi ticket creano sempre un
 * ticket. Per ogni ticket nuovo viene accodato un aiJob `queued` nella
 * stessa transazione.
 *
 * Gli eventi sono processati in sequenza: ognuno nella propria transazione,
 * così un evento malformato a metà batch non disfa i precedenti.
 */
export async function processEvents(
  db: Db,
  project: { id: string },
  events: IngestEvent[],
  opts?: ProcessOptions,
): Promise<ProcessResult> {
  const result: ProcessResult = { created: 0, deduped: 0 };
  for (const event of events) {
    switch (event.kind) {
      case "error": {
        const res = await processErrorEvent(db, project.id, event, opts);
        result[res.outcome] += 1;
        // Notifica solo sui ticket genuinamente nuovi (mai sul dedup), DOPO il
        // commit della transazione: la notifica riflette così realtà committata.
        if (res.outcome === "created") await notifyTicketCreated(db, res.ticket, opts);
        break;
      }
      case "feedback": {
        const ticket = await processFeedbackEvent(db, project.id, event);
        result.created += 1;
        // Screenshot come allegato DOPO il commit del ticket: best-effort, non
        // disfa mai l'ingestion (vedi saveScreenshotAttachment).
        if (event.screenshot !== undefined) {
          await saveScreenshotAttachment(db, ticket.id, event.screenshot, opts?.storage);
        }
        await notifyTicketCreated(db, ticket, opts);
        break;
      }
      case "ticket":
        // I ticket api/manuali non generano notifica (rumore): notifyTicketCreated
        // ignora le sorgenti non-SDK, ma non lo chiamiamo nemmeno qui.
        await processTicketEvent(db, project.id, event);
        result.created += 1;
        break;
    }
  }
  return result;
}
