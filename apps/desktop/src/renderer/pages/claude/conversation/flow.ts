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
  | {
      kind: "citation";
      key: string;
      refs: CitationRef[];
      /**
       * Il testo della risposta di Claude dello stesso turno a cui le fonti
       * appartengono, quando la riga sta da sola (dopo «Hypothesis»/«Details»
       * o dopo una scheda): «Used» non ripete i progetti delle sue righe di
       * catalogo (Impeccable 5).
       */
      answer?: string;
    }
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
  /** Area 10a: azioni di Claude eseguite (o «Didn't run»); una `pending` non si disegna mai. */
  | { kind: "executed"; key: string; event: Ev<"executed"> }
  /** Area 10b (Task 9): un'azione della pagina; una `pending` non si disegna (non è ancora vera). */
  | { kind: "pageAction"; key: string; event: Ev<"pageAction"> }
  /** Area 10b (Task 10): una bozza per un campo; anche `pending` («Writing a draft…», o la domanda). */
  | { kind: "draft"; key: string; event: Ev<"draft"> }
  /** Area 10b (S1): la prova di Claude; una `skipped` non si disegna (shape [AU 4]). */
  | { kind: "trial"; key: string; event: Ev<"trial"> }
  /** Area 10b (S2): «Hypothesis» o «Details», sotto la risposta. */
  | { kind: "aside"; key: string; event: Ev<"aside"> }
  /** Area 10b (S0): la risposta onesta, le voci che scrivono nella casella. */
  | { kind: "capabilities"; key: string; event: Ev<"capabilities"> }
  | { kind: "work_result"; key: string; event: Ev<"work_result"> };

/** Gli eventi che scrive Claude (e che quindi aprono il suo turno). */
const CLAUDE_TYPES = new Set<ConversationEvent["type"]>([
  "assistant",
  "action",
  "citation",
  "question",
  "plan",
  "proposal",
  "executed",
  "pageAction",
  "draft",
  "trial",
  "aside",
  "capabilities",
  "work_result",
]);

export function flowItems(events: readonly ConversationEvent[]): FlowItem[] {
  const out: FlowItem[] = [];
  let claudeTurn = false;
  // Il testo dell'ultima risposta di Claude del turno, per le fonti a parte.
  let answer: string | null = null;
  const opened = new Map<string, string>();
  const ordinals = new Map<string, number>();

  for (const event of events) {
    // Fra il motore e l'esecuzione: non arriva a chi legge, e non si disegna.
    if (event.type === "executed" && event.status === "pending") continue;
    // Un'azione della pagina non ancora eseguita dal riquadro: la riga direbbe il falso.
    if (event.type === "pageAction" && event.status === "pending") continue;
    // Una prova saltata (creazione non partita o salita a scheda): nessuna riga.
    if (event.type === "trial" && event.status === "skipped") continue;
    if (CLAUDE_TYPES.has(event.type) && !claudeTurn) {
      out.push({ kind: "claude", key: `claude-${event.id}`, at: event.at });
      claudeTurn = true;
    }
    switch (event.type) {
      case "user":
        claudeTurn = false;
        answer = null;
        out.push({ kind: "user", key: event.id, event });
        break;
      case "assistant":
        answer = event.text;
        out.push({ kind: "assistant", key: event.id, event, refs: [] });
        break;
      case "citation": {
        const last = out.at(-1);
        if (last?.kind === "assistant") last.refs = [...last.refs, ...event.refs];
        else
          out.push({
            kind: "citation",
            key: event.id,
            refs: event.refs,
            ...(answer !== null ? { answer } : {}),
          });
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
      case "executed":
      case "pageAction":
      case "draft":
      case "trial":
      case "aside":
      case "capabilities":
      case "work_result":
        out.push({ kind: event.type, key: event.id, event } as FlowItem);
        break;
    }
  }
  return usedAfterCards(executedBelowText(out));
}

/**
 * «Used: …» con una scheda (proposta o domanda) nello stesso turno: l'ordine
 * fisso del turno è testo → elenco → Hypothesis → Details → rifiuto →
 * scheda → righe a lato (shape `claude-scenarios.md` §3), quindi la riga
 * delle fonti non si mette fra la risposta e la sua scheda ma chiude il
 * turno (Impeccable 5). Senza scheda resta sotto il messaggio.
 */
function usedAfterCards(items: FlowItem[]): FlowItem[] {
  const out: FlowItem[] = [];
  let turn: FlowItem[] = [];
  const flush = () => {
    if (turn.some((i) => i.kind === "proposal" || i.kind === "question")) {
      const tail: FlowItem[] = [];
      turn = turn.map((i) => {
        if (i.kind !== "assistant" || i.refs.length === 0) return i;
        tail.push({ kind: "citation", key: `used-${i.key}`, refs: i.refs, answer: i.event.text });
        return { ...i, refs: [] };
      });
      turn.push(...tail);
    }
    out.push(...turn);
    turn = [];
  };
  for (const item of items) {
    if (item.kind === "user" || item.kind === "phase") {
      flush();
      out.push(item);
    } else turn.push(item);
  }
  flush();
  return out;
}

/**
 * La riga di ciò che Claude ha fatto si legge sotto il suo testo (shape
 * `claude-actions.md` §3): nel flusso entra all'esecuzione, prima della
 * frase «Done…» (ruling T5: «Ferma» non la taglia mai), e qui scende dopo
 * il primo messaggio di Claude dello stesso turno. Solo l'ordine di
 * presentazione: senza un messaggio dopo (fermato prima del testo) resta dov'è.
 */
function executedBelowText(items: FlowItem[]): FlowItem[] {
  const out: FlowItem[] = [];
  let held: FlowItem[] = [];
  for (const item of items) {
    if (item.kind === "executed") {
      held.push(item);
      continue;
    }
    // Scende solo oltre le letture e le citazioni che precedono il testo:
    // qualunque altra riga (una persona, una scheda, una fase) chiude l'attesa.
    if (item.kind !== "assistant" && item.kind !== "actions" && item.kind !== "citation") {
      out.push(...held);
      held = [];
    }
    out.push(item);
    if (item.kind === "assistant") {
      out.push(...held);
      held = [];
    }
  }
  return [...out, ...held];
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

/**
 * I codici di catalogo in un testo («AUD-12», «STW-R4», la pagina dei Docs
 * «AUD-D3», il file del Drive «AUD-F7»).
 */
export const CODE_IN_TEXT = /\b[A-Z]{2,4}-[RDF]?\d+\b/g;

/** Durata fra due istanti, in minuti interi (almeno 1). */
export function minutesBetween(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}
