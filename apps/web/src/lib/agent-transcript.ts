/**
 * La trascrizione di una sessione dell'agente come funzione PURA (piano B,
 * Task 4): eventi salvati + parziali dal vivo + interventi + domande →
 * elementi di chat, che la pagina della sessione (Task 6/7) disegna e basta.
 *
 * Le regole, ognuna coperta da un test in `agent-transcript.test.ts`:
 * 1. `tool_use` e `tool_result` con lo stesso `toolUseId` sono UNA card, nel
 *    punto del `tool_use`; senza risultato la card è in corso (`result:
 *    null`). Un `tool_result` il cui `tool_use` sta su una pagina più vecchia
 *    non ancora caricata non produce niente: comparirà quando la pagina arriva.
 *    Il `tool_use` di `ask_user` (nome `ask_user` o `…__ask_user`) collassa
 *    nella card della DOMANDA quando il dettaglio ne porta: due card per lo
 *    stesso fatto, nello stesso punto, direbbero due cose. Senza domande
 *    (server più vecchio) resta una card del tool, o non si vedrebbe niente.
 * 2. Un evento `input` è un intervento CONSEGNATO: vince il suo testo (il
 *    worker lo oscura con `redact`, la riga di `inputs` no), lo stato viene
 *    dalla riga di `inputs` con lo stesso `inputId` se c'è (sono gli ultimi
 *    100), altrimenti `delivered`. Gli interventi di `inputs` SENZA evento
 *    (`pending`, `undelivered`) si inseriscono per `createdAt`: un intervento
 *    non consegnato resta visibile col suo motivo, mai sparito.
 * 3. Il parziale di un segmento è un `text` `live: true` in coda agli eventi.
 *    I parziali sono DELTA (il worker manda il pezzo accumulato dall'ultimo
 *    flush e azzera): il chiamante li accumula con {@link applyPartial} e li
 *    azzera con {@link clearPartialsFor} all'arrivo di un `assistant_text` o
 *    `turn_end` dello stesso segmento. Un client che si collega a metà
 *    messaggio vede solo la coda finché arriva l'`assistant_text` (accettato).
 * 4. `turn_end` con `subtype: "error_during_execution"` (un «Ferma e scrivi»)
 *    è `interrupted`; gli altri `turn_end` non producono elementi.
 * 5. Domande e interventi senza evento si inseriscono DOPO l'ultimo elemento
 *    con `at <=` del loro istante: nel punto in cui sono successi, non in testa
 *    per caso (in testa solo se sono davvero più vecchi di tutto il caricato).
 * 6. Un tipo d'evento che il client non conosce — il segnaposto `__unknown__`
 *    del reader o un nome grezzo nuovo — si salta (ramo `default`), come un
 *    `data` malformato: niente lancia.
 * 7. {@link mergeEvents} confronta gli id come `BigInt` (bigserial in stringa:
 *    "10" > "9") e toglie i doppi fra prima pagina REST e stream.
 */

import {
  agentSegmentLabelSchema,
  type AgentInputReason,
  type AgentInputStatus,
  type AgentSessionEvent,
  type AgentSessionInput,
  type AgentSessionQuestion,
  type Reader,
} from "@stubwise/shared";

type SessionEvent = Reader<AgentSessionEvent>;
type SessionInput = Reader<AgentSessionInput>;
type SessionQuestion = Reader<AgentSessionQuestion>;

export type TranscriptItem =
  /** segment_start: `label` è una voce di `agents:segment.*`, `unknown` se ignota. */
  | { kind: "segment"; id: string; label: string; at: string }
  | { kind: "segment_end"; id: string; exitCode: number | null; timedOut: boolean; at: string }
  /** assistant_text, o il parziale dal vivo (`live: true`). */
  | { kind: "text"; id: string; text: string; at: string; live: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result: { isError: boolean; content: string; truncated: boolean } | null;
      at: string;
    }
  | {
      kind: "input";
      id: string;
      text: string;
      interrupt: boolean;
      authorName: string | null;
      status: Reader<AgentInputStatus>;
      reason: Reader<AgentInputReason> | null;
      at: string;
    }
  /** turn_end con subtype error_during_execution. */
  | { kind: "interrupted"; id: string; at: string }
  | { kind: "question"; id: string; question: SessionQuestion; at: string };

export interface TranscriptInput {
  /** Ascendenti per id, senza doppi (vedi {@link mergeEvents}). */
  events: SessionEvent[];
  /** segmentId → testo parziale accumulato (vedi {@link applyPartial}). */
  partials: Record<string, string>;
  /** `detail.inputs ?? []`. */
  inputs: SessionInput[];
  /** `detail.questions ?? []`. */
  questions: SessionQuestion[];
}

const KNOWN_SEGMENT_LABELS: ReadonlySet<string> = new Set(agentSegmentLabelSchema.options);

function isAskUserTool(name: string): boolean {
  return name === "ask_user" || name.endsWith("__ask_user");
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function buildTranscript(input: TranscriptInput): TranscriptItem[] {
  const { events, partials } = input;
  const inputs = input.inputs ?? [];
  const questions = input.questions ?? [];
  const collapseAskUser = questions.length > 0;

  const inputsById = new Map(inputs.map((i) => [i.id, i]));
  const eventInputIds = new Set<string>();
  const items: TranscriptItem[] = [];
  /** toolUseId → indice della card in `items`, per attaccarle il risultato. */
  const toolCards = new Map<string, number>();
  /** toolUseId del tool ask_user collassato: il suo risultato si scarta. */
  const collapsedTools = new Set<string>();
  /** Ultimo `at` visto per segmento: il punto del parziale. */
  const lastAtBySegment = new Map<string, string>();

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "segment_start": {
        const label = str(d["label"]);
        items.push({
          kind: "segment",
          id: e.id,
          label: label !== null && KNOWN_SEGMENT_LABELS.has(label) ? label : "unknown",
          at: e.at,
        });
        break;
      }
      case "segment_end": {
        const exitCode = d["exitCode"];
        items.push({
          kind: "segment_end",
          id: e.id,
          exitCode: typeof exitCode === "number" ? exitCode : null,
          timedOut: d["timedOut"] === true,
          at: e.at,
        });
        break;
      }
      case "assistant_text": {
        const text = str(d["text"]);
        if (text !== null) items.push({ kind: "text", id: e.id, text, at: e.at, live: false });
        break;
      }
      case "tool_use": {
        const toolUseId = str(d["toolUseId"]);
        const name = str(d["name"]);
        if (toolUseId === null || name === null) break;
        if (collapseAskUser && isAskUserTool(name)) {
          collapsedTools.add(toolUseId);
          break;
        }
        toolCards.set(toolUseId, items.length);
        items.push({ kind: "tool", id: e.id, name, input: d["input"], result: null, at: e.at });
        break;
      }
      case "tool_result": {
        const toolUseId = str(d["toolUseId"]);
        if (toolUseId === null || collapsedTools.has(toolUseId)) break;
        const index = toolCards.get(toolUseId);
        const card = index !== undefined ? items[index] : undefined;
        if (card === undefined || card.kind !== "tool") break;
        items[index!] = {
          ...card,
          result: {
            isError: d["isError"] === true,
            content: str(d["content"]) ?? "",
            truncated: d["truncated"] === true,
          },
        };
        break;
      }
      case "input": {
        const text = str(d["text"]);
        if (text === null) break;
        const inputId = str(d["inputId"]);
        if (inputId !== null) eventInputIds.add(inputId);
        const row = inputId !== null ? inputsById.get(inputId) : undefined;
        items.push({
          kind: "input",
          id: e.id,
          text,
          interrupt: d["interrupt"] === true,
          authorName: str(d["authorName"]) ?? row?.authorName ?? null,
          status: row?.status ?? "delivered",
          reason: row?.reason ?? null,
          at: e.at,
        });
        break;
      }
      case "turn_end": {
        if (d["subtype"] === "error_during_execution") {
          items.push({ kind: "interrupted", id: e.id, at: e.at });
        }
        break;
      }
      default:
        // Tipo sconosciuto (segnaposto del reader o nome grezzo nuovo): si salta.
        break;
    }
    lastAtBySegment.set(e.segmentId, e.at);
  }

  // Regola 3: i parziali in coda agli eventi.
  const lastAt = events.length > 0 ? events[events.length - 1]!.at : "";
  for (const [segmentId, text] of Object.entries(partials)) {
    if (text === "") continue;
    items.push({
      kind: "text",
      id: `partial:${segmentId}`,
      text,
      at: lastAtBySegment.get(segmentId) ?? lastAt,
      live: true,
    });
  }

  // Regole 2 e 5: interventi senza evento e domande, nel loro punto nel tempo.
  const timed: TranscriptItem[] = [
    ...inputs
      .filter((i) => !eventInputIds.has(i.id))
      .map(
        (i): TranscriptItem => ({
          kind: "input",
          id: `input:${i.id}`,
          text: i.text,
          interrupt: i.interrupt ?? false,
          authorName: i.authorName ?? null,
          status: i.status,
          reason: i.reason ?? null,
          at: i.createdAt,
        }),
      ),
    ...questions.map(
      (q): TranscriptItem => ({ kind: "question", id: `question:${q.id}`, question: q, at: q.askedAt }),
    ),
  ];
  // Ordinati per istante (stabile): ognuno va dopo l'ultimo elemento con at <=
  // del suo, compresi quelli appena inseriti.
  timed.sort((a, b) => time(a.at) - time(b.at));
  for (const item of timed) {
    const t = time(item.at);
    let index = items.length;
    while (index > 0 && time(items[index - 1]!.at) > t) index--;
    items.splice(index, 0, item);
  }
  return items;
}

/** Accoda il delta di un parziale al testo già accumulato del suo segmento. */
export function applyPartial(
  partials: Record<string, string>,
  segmentId: string,
  text: string,
): Record<string, string> {
  return { ...partials, [segmentId]: (partials[segmentId] ?? "") + text };
}

/**
 * Azzera il parziale dei segmenti che hanno ricevuto un `assistant_text` o un
 * `turn_end`: il testo completo (o la fine del turno) lo sostituisce. Lo
 * stesso oggetto se non cambia niente, così lo stato React non si rinnova.
 */
export function clearPartialsFor(
  partials: Record<string, string>,
  events: readonly SessionEvent[],
): Record<string, string> {
  let next: Record<string, string> | null = null;
  for (const e of events) {
    if (e.type !== "assistant_text" && e.type !== "turn_end") continue;
    const current: Record<string, string> = next ?? partials;
    if (!(e.segmentId in current)) continue;
    next ??= { ...partials };
    delete next[e.segmentId];
  }
  return next ?? partials;
}

const NUMERIC_ID = /^\d+$/;

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Unisce due elenchi di eventi per id: ascendente (confronto numerico, `BigInt`),
 * senza doppi. Un id non numerico (mai visto: è un bigserial) si scarta invece
 * di far lanciare `BigInt`. Restituisce `current` se non c'è niente di nuovo.
 */
export function mergeEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((e) => e.id));
  const fresh = incoming.filter((e) => {
    if (seen.has(e.id) || !NUMERIC_ID.test(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort((a, b) => compareIds(a.id, b.id));
}
