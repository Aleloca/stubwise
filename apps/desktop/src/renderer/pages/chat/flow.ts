import type { ChatEventKind, ChatMessageView } from "../../data/types";

// Il flusso di un canale come si disegna: i messaggi letti (pagina + stream)
// diventano giorni, gruppi per autore, schede di sistema e la riga «New».
// Puro: niente React, niente orologio (il giorno di oggi arriva da fuori).

/** Stesso autore entro questi minuti, senza separatori = un gruppo (una sola testata). */
export const GROUP_MINUTES = 5;
/** Eventi consecutivi dello stesso tipo entro questi minuti = una sola scheda. */
export const SYSTEM_GROUP_MINUTES = 10;

export type FlowRow =
  /** La riga «New»: prima del primo messaggio arrivato dopo la lettura di chi guarda. */
  | { kind: "new" }
  /** Un messaggio di una persona; `head` = il primo del gruppo (avatar, nome, ora). */
  | { kind: "message"; message: ChatMessageView; head: boolean }
  /** Uno o più eventi di progetto dello stesso tipo, entro 10 minuti l'uno dall'altro. */
  | { kind: "system"; eventKind: ChatEventKind | null; messages: ChatMessageView[] };

export interface FlowDay {
  /** YYYY-MM-DD (UTC, come il resto del prototipo). */
  day: string;
  rows: FlowRow[];
}

const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

/**
 * Unisce la pagina letta con i messaggi arrivati dal vivo: un id già letto
 * si sostituisce, uno nuovo entra al suo posto nel tempo; quelli più vecchi
 * dell'inizio della pagina (una modifica a un messaggio fuori finestra) no.
 */
export function mergeFlow(
  page: readonly ChatMessageView[],
  live: readonly ChatMessageView[],
  hasMore: boolean,
): ChatMessageView[] {
  const byId = new Map(page.map((m) => [m.id, m]));
  const start = hasMore ? page[0]?.createdAt : undefined;
  for (const m of live) {
    // Solo ciò che sta nel flusso del canale: una risposta nel thread no.
    if (m.threadOf !== null && !m.alsoInChannel) continue;
    if (byId.has(m.id) || start === undefined || m.createdAt >= start) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * I giorni del flusso. `lastReadAt` = fin dove chi guarda aveva letto
 * entrando (la riga «New» va prima del primo messaggio dopo, non suo);
 * `peopleOnly` toglie i messaggi di sistema.
 */
export function flowDays(
  messages: readonly ChatMessageView[],
  {
    viewerId,
    lastReadAt,
    peopleOnly = false,
  }: { viewerId: string; lastReadAt: string | null; peopleOnly?: boolean },
): FlowDay[] {
  const days: FlowDay[] = [];
  let newPlaced = lastReadAt === null;
  let previous: ChatMessageView | null = null;
  for (const m of messages) {
    if (peopleOnly && m.kind === "system") continue;
    const day = m.createdAt.slice(0, 10);
    let current = days.at(-1);
    let separated = false;
    if (!current || current.day !== day) {
      current = { day, rows: [] };
      days.push(current);
      separated = true;
    }
    if (!newPlaced && m.createdAt > lastReadAt! && m.authorId !== viewerId) {
      current.rows.push({ kind: "new" });
      newPlaced = true;
      separated = true;
    }
    const last = current.rows.at(-1);
    if (m.kind === "system") {
      const kind = m.event?.kind ?? null;
      if (
        !separated &&
        last?.kind === "system" &&
        last.eventKind === kind &&
        previous !== null &&
        minutes(previous.createdAt, m.createdAt) <= SYSTEM_GROUP_MINUTES
      ) {
        last.messages.push(m);
      } else {
        current.rows.push({ kind: "system", eventKind: kind, messages: [m] });
      }
    } else {
      const continues =
        !separated &&
        last?.kind === "message" &&
        previous !== null &&
        previous.authorId === m.authorId &&
        previous.deletedAt === null &&
        m.deletedAt === null &&
        // Una risposta «anche nel canale» porta la sua riga: apre sempre un gruppo.
        !m.alsoInChannel &&
        minutes(previous.createdAt, m.createdAt) <= GROUP_MINUTES;
      current.rows.push({ kind: "message", message: m, head: !continues });
    }
    previous = m;
  }
  return days;
}

/** «16:02»: l'ora di un messaggio (il giorno lo dice il separatore). */
export function hm(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** Il giorno come lo dice il separatore: «Today», «Yesterday», «Thursday, Oct 22», «Oct 2, 2025». */
export function dayLabel(
  day: string,
  today: string,
  language: string,
  words: { today: string; yesterday: string },
): string {
  const diff = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000,
  );
  if (diff === 0) return words.today;
  if (diff === 1) return words.yesterday;
  const date = new Date(`${day}T12:00:00Z`);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(language, {
    ...(sameYear ? { weekday: "long" } : {}),
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}
