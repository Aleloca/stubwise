import type { CitationRef, ConversationEvent } from "../../../data/types";

// Dal flusso di eventi alle righe che la conversazione disegna: azioni
// consecutive in un gruppo, la citazione attaccata al messaggio che la
// precede («Used: …»), l'intestazione «Claude · ora» solo a inizio turno,
// le fasi con la loro durata e il numero della correzione. Puro: lo
// stesso flusso dà sempre le stesse righe (e le stesse chiavi).

export type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;

export type FlowItem =
  | { kind: "user"; key: string; event: Ev<"user"> }
  /** L'avatar di Claude con l'ora: solo all'inizio di un suo turno. */
  | { kind: "claude"; key: string; at: string }
  | { kind: "assistant"; key: string; event: Ev<"assistant">; refs: CitationRef[] }
  | { kind: "actions"; key: string; actions: Ev<"action">[] }
  | { kind: "citation"; key: string; refs: CitationRef[] }
  | {
      kind: "phase";
      key: string;
      event: Ev<"phase">;
      /** «Correction 2»: il numero della fase fra quelle con lo stesso nome. */
      ordinal: number;
      /** Quando è cominciata (l'evento d'apertura della stessa fase), per la durata. */
      startedAt: string | null;
    }
  | { kind: "question"; key: string; event: Ev<"question"> }
  | { kind: "plan"; key: string; event: Ev<"plan"> }
  | { kind: "proposal"; key: string; event: Ev<"proposal"> }
  | { kind: "work_result"; key: string; event: Ev<"work_result"> };

/** Gli eventi che scrive Claude (e che quindi aprono il suo turno). */
const CLAUDE_TYPES = new Set<ConversationEvent["type"]>([
  "assistant",
  "action",
  "citation",
  "question",
  "plan",
  "proposal",
  "work_result",
]);

export function flowItems(events: readonly ConversationEvent[]): FlowItem[] {
  const out: FlowItem[] = [];
  let claudeTurn = false;
  const opened = new Map<string, string>();
  const ordinals = new Map<string, number>();

  for (const event of events) {
    if (CLAUDE_TYPES.has(event.type) && !claudeTurn) {
      out.push({ kind: "claude", key: `claude-${event.id}`, at: event.at });
      claudeTurn = true;
    }
    switch (event.type) {
      case "user":
        claudeTurn = false;
        out.push({ kind: "user", key: event.id, event });
        break;
      case "assistant":
        out.push({ kind: "assistant", key: event.id, event, refs: [] });
        break;
      case "citation": {
        const last = out.at(-1);
        if (last?.kind === "assistant") last.refs = [...last.refs, ...event.refs];
        else out.push({ kind: "citation", key: event.id, refs: event.refs });
        break;
      }
      case "action": {
        const last = out.at(-1);
        if (last?.kind === "actions") last.actions = [...last.actions, event];
        else out.push({ kind: "actions", key: event.id, actions: [event] });
        break;
      }
      case "phase": {
        // Una fase senza esito la apre; una con esito la chiude (stesso nome).
        let ordinal = ordinals.get(event.phase) ?? 0;
        if (event.outcome === null || !opened.has(event.phase)) {
          ordinal += 1;
          ordinals.set(event.phase, ordinal);
        }
        const startedAt = event.outcome === null ? null : (opened.get(event.phase) ?? null);
        if (event.outcome === null) opened.set(event.phase, event.at);
        else opened.delete(event.phase);
        out.push({ kind: "phase", key: event.id, event, ordinal, startedAt });
        // Una fase separa: dopo, Claude riapre il suo turno con l'intestazione.
        claudeTurn = false;
        break;
      }
      case "question":
      case "plan":
      case "proposal":
      case "work_result":
        out.push({ kind: event.type, key: event.id, event } as FlowItem);
        break;
    }
  }
  return out;
}

/** Tutti gli oggetti citati nel flusso, una volta ciascuno (per leggerli in una sola volta). */
export function citedRefs(events: readonly ConversationEvent[]): CitationRef[] {
  const seen = new Set<string>();
  const out: CitationRef[] = [];
  for (const e of events) {
    if (e.type !== "citation") continue;
    for (const ref of e.refs) {
      const key = `${ref.kind}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

/** I codici di catalogo in un testo («AUD-12», «STW-R4», la pagina dei Docs «AUD-D3»). */
export const CODE_IN_TEXT = /\b[A-Z]{2,4}-[RD]?\d+\b/g;

/** Durata fra due istanti, in minuti interi (almeno 1). */
export function minutesBetween(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}
