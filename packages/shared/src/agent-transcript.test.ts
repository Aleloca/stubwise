import { describe, expect, it } from "vitest";
import type { Reader } from "./reader.js";
import type {
  AgentSessionEvent,
  AgentSessionInput,
  AgentSessionQuestion,
} from "./schemas/agent-session.js";
import {
  applyPartial,
  buildTranscript,
  clearPartialsFor,
  mergeEvents,
  type TranscriptItem,
} from "./agent-transcript.js";

/**
 * La trascrizione di una sessione (piano B, Task 4): funzione pura, eventi
 * costruiti a mano. Gli `at` sono ISO in ordine crescente coi minuti.
 */

type Ev = Reader<AgentSessionEvent>;

function at(minute: number): string {
  return `2026-10-09T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function ev(
  id: string,
  type: string,
  data: Record<string, unknown>,
  atIso: string = at(Number(id) % 60),
  segmentId = "seg-1",
): Ev {
  return { id, type: type as Ev["type"], segmentId, at: atIso, data };
}

function input(over: Partial<Reader<AgentSessionInput>> = {}): Reader<AgentSessionInput> {
  return {
    id: "7f1c2a1e-0000-4000-8000-0000000000a1",
    text: "guarda anche il logout",
    status: "pending",
    reason: null,
    authorUserId: "7f1c2a1e-0000-4000-8000-0000000000u1",
    authorName: "admin@example.com",
    interrupt: false,
    createdAt: at(30),
    ...over,
  };
}

function question(over: Partial<Reader<AgentSessionQuestion>> = {}): Reader<AgentSessionQuestion> {
  return {
    id: "7f1c2a1e-0000-4000-8000-0000000000q1",
    source: "agent",
    question: "Quale libreria?",
    askedAt: at(5),
    answered: false,
    options: [],
    allowFreeText: false,
    canAnswer: true,
    ticketId: null,
    backlogItemId: null,
    ...over,
  };
}

function build(over: {
  events?: Ev[];
  partials?: Record<string, string>;
  inputs?: Reader<AgentSessionInput>[];
  questions?: Reader<AgentSessionQuestion>[];
  live?: boolean;
}): TranscriptItem[] {
  return buildTranscript({
    events: over.events ?? [],
    partials: over.partials ?? {},
    inputs: over.inputs ?? [],
    questions: over.questions ?? [],
    ...(over.live !== undefined ? { live: over.live } : {}),
  });
}

const kinds = (items: TranscriptItem[]) => items.map((i) => i.kind);

describe("buildTranscript — confini dei segmenti", () => {
  it("segment_start e segment_end diventano confini, con l'etichetta del segmento", () => {
    const items = build({
      events: [
        ev("1", "segment_start", { label: "plan", interactive: true }),
        ev("2", "segment_end", { exitCode: 0, timedOut: false }),
      ],
    });
    expect(items).toEqual([
      { kind: "segment", id: "1", label: "plan", at: at(1) },
      { kind: "segment_end", id: "2", exitCode: 0, timedOut: false, at: at(2) },
    ]);
  });

  it("un'etichetta che il client non conosce diventa `unknown`", () => {
    const items = build({ events: [ev("1", "segment_start", { label: "teleport" })] });
    expect(items[0]).toMatchObject({ kind: "segment", label: "unknown" });
  });

  it("segment_end senza campi: exitCode null e timedOut false", () => {
    const items = build({ events: [ev("1", "segment_end", {})] });
    expect(items[0]).toMatchObject({ kind: "segment_end", exitCode: null, timedOut: false });
  });
});

describe("regola 1 — tool_use e tool_result diventano UNA card", () => {
  it("stesso toolUseId: una card sola col risultato, nel punto del tool_use", () => {
    const items = build({
      events: [
        ev("1", "tool_use", { toolUseId: "t1", name: "Read", input: { file_path: "a.ts" } }),
        ev("2", "assistant_text", { text: "letto" }),
        ev("3", "tool_result", { toolUseId: "t1", isError: false, content: "file", truncated: true }),
      ],
    });
    expect(items).toEqual([
      {
        kind: "tool",
        id: "1",
        name: "Read",
        input: { file_path: "a.ts" },
        result: { isError: false, content: "file", truncated: true },
        at: at(1),
      },
      { kind: "text", id: "2", text: "letto", at: at(2), live: false },
    ]);
  });

  it("un tool_use senza risultato è in corso (result null); truncated assente → false", () => {
    const items = build({
      events: [
        ev("1", "tool_use", { toolUseId: "t1", name: "Bash", input: { command: "ls" } }),
        ev("2", "tool_use", { toolUseId: "t2", name: "Read", input: {} }),
        ev("3", "tool_result", { toolUseId: "t2", isError: true, content: "ENOENT" }),
      ],
    });
    expect(items[0]).toMatchObject({ kind: "tool", id: "1", result: null });
    expect(items[1]).toMatchObject({
      kind: "tool",
      id: "2",
      result: { isError: true, content: "ENOENT", truncated: false },
    });
    expect(items).toHaveLength(2);
  });

  it("un tool_result senza il suo tool_use (pagina più vecchia non caricata) non produce una card", () => {
    const items = build({
      events: [ev("5", "tool_result", { toolUseId: "perso", isError: false, content: "x" })],
    });
    expect(items).toEqual([]);
  });

  it("il tool ask_user collassa nella card della domanda: nessuna card del tool", () => {
    const items = build({
      events: [
        ev("1", "assistant_text", { text: "devo chiedere" }, at(1)),
        ev("2", "tool_use", { toolUseId: "q", name: "mcp__stubwise_ask__ask_user", input: {} }, at(2)),
        ev("3", "tool_result", { toolUseId: "q", isError: false, content: "risposta" }, at(4)),
        ev("4", "assistant_text", { text: "grazie" }, at(6)),
      ],
      questions: [question({ askedAt: at(3) })],
    });
    expect(kinds(items)).toEqual(["text", "question", "text"]);
  });

  it("senza domande nel dettaglio (server vecchio) il tool ask_user resta una card", () => {
    const items = build({
      events: [ev("2", "tool_use", { toolUseId: "q", name: "mcp__stubwise_ask__ask_user", input: {} })],
    });
    expect(items[0]).toMatchObject({ kind: "tool", name: "mcp__stubwise_ask__ask_user" });
  });
});

describe("regola 2 — interventi", () => {
  it("un evento input consegnato è una bolla col nome, delivered e senza doppione della riga", () => {
    const delivered = input({
      id: "7f1c2a1e-0000-4000-8000-0000000000a1",
      status: "delivered",
      text: "testo in chiaro",
    });
    const items = build({
      events: [
        ev("1", "input", {
          text: "testo [oscurato]",
          interrupt: true,
          inputId: delivered.id,
          authorUserId: delivered.authorUserId,
          authorName: "admin@example.com",
        }),
      ],
      inputs: [delivered],
    });
    expect(items).toEqual([
      {
        kind: "input",
        id: "1",
        // vince l'evento: il suo testo è quello oscurato dal worker
        text: "testo [oscurato]",
        interrupt: true,
        authorName: "admin@example.com",
        status: "delivered",
        reason: null,
        at: at(1),
        queued: false,
        stop: false,
      },
    ]);
  });

  it("un evento input è SEMPRE delivered, anche se la riga in cache dice ancora pending", () => {
    const stale = input({ status: "pending" });
    const items = build({
      events: [ev("1", "input", { text: "x", interrupt: false, inputId: stale.id, authorName: null })],
      inputs: [stale],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "input", id: "1", status: "delivered", reason: null });
  });

  it("riga delivered con l'evento su una pagina non caricata: una bolla sola, prima dalla riga poi dall'evento", () => {
    const row = input({ status: "delivered", createdAt: at(3) });
    const newer = [ev("50", "assistant_text", { text: "dopo" }, at(10))];
    const before = build({ events: newer, inputs: [row] });
    expect(before.filter((i) => i.kind === "input").map((i) => i.id)).toEqual([`input:${row.id}`]);

    const older = [ev("40", "input", { text: "x", interrupt: false, inputId: row.id, authorName: null }, at(3))];
    const after = build({ events: mergeEvents(newer, older), inputs: [row] });
    expect(after.filter((i) => i.kind === "input").map((i) => i.id)).toEqual(["40"]);
  });

  it("un evento input senza riga in inputs (oltre gli ultimi 100) è delivered", () => {
    const items = build({
      events: [ev("1", "input", { text: "vecchio", interrupt: false, inputId: "altro", authorName: null })],
    });
    expect(items[0]).toMatchObject({ kind: "input", status: "delivered", reason: null, authorName: null });
  });

  it("pending e undelivered senza evento si inseriscono per createdAt, con stato e motivo", () => {
    const items = build({
      events: [
        ev("1", "assistant_text", { text: "prima" }, at(1)),
        ev("2", "assistant_text", { text: "dopo" }, at(10)),
      ],
      inputs: [
        input({
          id: "7f1c2a1e-0000-4000-8000-0000000000b1",
          status: "undelivered",
          reason: "stdin_closed",
          interrupt: true,
          createdAt: at(5),
        }),
        input({ id: "7f1c2a1e-0000-4000-8000-0000000000b2", status: "pending", createdAt: at(20) }),
      ],
    });
    expect(kinds(items)).toEqual(["text", "input", "text", "input"]);
    expect(items[1]).toMatchObject({
      kind: "input",
      id: "input:7f1c2a1e-0000-4000-8000-0000000000b1",
      status: "undelivered",
      reason: "stdin_closed",
      interrupt: true,
      authorName: "admin@example.com",
      at: at(5),
    });
    expect(items[3]).toMatchObject({ status: "pending", reason: null });
  });

  it("un intervento senza interrupt né authorName (server più vecchio) li legge false e null", () => {
    const old = input();
    delete (old as Partial<typeof old>).interrupt;
    delete (old as Partial<typeof old>).authorName;
    const items = build({ inputs: [old] });
    expect(items[0]).toMatchObject({ kind: "input", interrupt: false, authorName: null });
  });

  it("uno stato ignoto (segnaposto del reader) passa così com'è", () => {
    const items = build({ inputs: [input({ status: "__unknown__", reason: "__unknown__" })] });
    expect(items[0]).toMatchObject({ status: "__unknown__", reason: "__unknown__" });
  });
});

describe("regola 8 — «In coda»: consegnato e non ancora preso dal CLI", () => {
  const ROW = "7f1c2a1e-0000-4000-8000-0000000000c1";
  const STOP = "7f1c2a1e-0000-4000-8000-0000000000c0";

  it("una riga delivered senza evento, a sessione viva, va in FONDO dopo il testo dal vivo, queued", () => {
    const items = build({
      live: true,
      events: [ev("1", "assistant_text", { text: "prima" }, at(1)), ev("2", "tool_use", { toolUseId: "t", name: "Read", input: {} }, at(5))],
      partials: { "seg-1": "sto scriv" },
      // più vecchia del parziale nel tempo: per tempo starebbe PRIMA
      inputs: [input({ id: ROW, status: "delivered", createdAt: at(2) })],
    });
    expect(kinds(items)).toEqual(["text", "tool", "text", "input"]);
    expect(items[3]).toMatchObject({ kind: "input", id: `input:${ROW}`, queued: true, stop: false, status: "delivered" });
  });

  it("quando arriva l'evento con quell'inputId la bolla torna al suo punto e non è più in coda", () => {
    const row = input({ id: ROW, status: "delivered", createdAt: at(2) });
    const items = build({
      live: true,
      events: [
        ev("1", "assistant_text", { text: "prima" }, at(1)),
        ev("2", "input", { text: row.text, interrupt: false, inputId: ROW, authorName: null }, at(3)),
        ev("3", "assistant_text", { text: "dopo" }, at(4)),
      ],
      partials: { "seg-1": "sto scriv" },
      inputs: [row],
    });
    expect(kinds(items)).toEqual(["text", "input", "text", "text"]);
    expect(items[1]).toMatchObject({ id: "2", queued: false });
    expect(items.filter((i) => i.kind === "input")).toHaveLength(1);
  });

  it("a sessione conclusa (o senza `live`) un delivered senza evento resta nel suo punto, non in coda", () => {
    const opts = {
      events: [ev("1", "assistant_text", { text: "prima" }, at(1)), ev("2", "assistant_text", { text: "dopo" }, at(10))],
      inputs: [input({ id: ROW, status: "delivered", createdAt: at(5) })],
    };
    for (const items of [build({ ...opts, live: false }), build(opts)]) {
      expect(kinds(items)).toEqual(["text", "input", "text"]);
      expect(items[1]).toMatchObject({ queued: false });
    }
  });

  it("più vecchio del primo evento caricato: il suo evento può stare su una pagina vecchia, non è in coda", () => {
    const items = build({
      live: true,
      events: [ev("50", "assistant_text", { text: "pagina recente" }, at(10))],
      inputs: [input({ id: ROW, status: "delivered", createdAt: at(3) })],
    });
    expect(kinds(items)).toEqual(["input", "text"]);
    expect(items[0]).toMatchObject({ queued: false });
  });

  it("pending e undelivered non sono mai in coda", () => {
    const items = build({
      live: true,
      events: [ev("1", "assistant_text", { text: "prima" }, at(1))],
      inputs: [
        input({ id: ROW, status: "pending", createdAt: at(2) }),
        input({ id: STOP, status: "undelivered", reason: "stdin_closed", createdAt: at(3) }),
      ],
    });
    expect(items.filter((i) => i.kind === "input" && i.queued)).toEqual([]);
  });

  it("più interventi in coda restano in fondo nell'ordine in cui sono stati scritti", () => {
    const items = build({
      live: true,
      events: [ev("1", "assistant_text", { text: "prima" }, at(1))],
      inputs: [
        input({ id: "7f1c2a1e-0000-4000-8000-0000000000d2", status: "delivered", createdAt: at(4) }),
        input({ id: "7f1c2a1e-0000-4000-8000-0000000000d1", status: "delivered", createdAt: at(3) }),
      ],
    });
    expect(items.slice(1).map((i) => i.id)).toEqual([
      "input:7f1c2a1e-0000-4000-8000-0000000000d1",
      "input:7f1c2a1e-0000-4000-8000-0000000000d2",
    ]);
  });

  it("un messaggio che RIPRENDE una pausa (dopo uno stop, nessun turno nuovo) non è mai in coda: niente lampo", () => {
    const stop = input({ id: STOP, status: "delivered", interrupt: true, text: "", createdAt: at(2) });
    const resume = input({ id: ROW, status: "delivered", text: "ora fai così", createdAt: at(5) });
    const events = [
      ev("1", "tool_use", { toolUseId: "t", name: "Read", input: {} }, at(1)),
      // coda del turno interrotto, poi il suo turn_end
      ev("2", "assistant_text", { text: "coda" }, at(3)),
      ev("3", "turn_end", { subtype: "error_during_execution" }, at(3)),
    ];
    const items = build({ live: true, events, inputs: [stop, resume] });
    const bubble = items.find((i) => i.id === `input:${ROW}`);
    expect(bubble).toMatchObject({ queued: false });
    // ...e sta nel suo punto per tempo, cioè in fondo perché è il più recente
    expect(items[items.length - 1]).toBe(bubble);
    // anche prima del turn_end del turno interrotto
    const early = build({ live: true, events: events.slice(0, 2), inputs: [stop, resume] });
    expect(early.find((i) => i.id === `input:${ROW}`)).toMatchObject({ queued: false });
  });

  it("dopo un turno NUOVO successivo allo stop, un messaggio scritto a metà turno torna «In coda»", () => {
    const stop = input({ id: STOP, status: "delivered", interrupt: true, text: "", createdAt: at(2) });
    const next = input({ id: ROW, status: "delivered", text: "anche questo", createdAt: at(8) });
    const items = build({
      live: true,
      events: [
        ev("1", "turn_end", { subtype: "error_during_execution" }, at(3)),
        ev("2", "assistant_text", { text: "riparto" }, at(6)),
      ],
      inputs: [stop, next],
    });
    expect(items[items.length - 1]).toMatchObject({ id: `input:${ROW}`, queued: true });
  });

  it("se fra lo stop e il messaggio ce n'è un altro consegnato, non è una ripresa della pausa", () => {
    const stop = input({ id: STOP, status: "delivered", interrupt: true, text: "", createdAt: at(2) });
    const resume = input({ id: "7f1c2a1e-0000-4000-8000-0000000000e1", status: "delivered", text: "riprendi", createdAt: at(4) });
    const another = input({ id: ROW, status: "delivered", text: "e poi", createdAt: at(6) });
    const items = build({
      live: true,
      events: [
        ev("1", "turn_end", { subtype: "error_during_execution" }, at(3)),
        ev("2", "input", { text: "riprendi", interrupt: false, inputId: resume.id, authorName: null }, at(5)),
      ],
      inputs: [stop, resume, another],
    });
    expect(items[items.length - 1]).toMatchObject({ id: `input:${ROW}`, queued: true });
  });
});

describe("regola 9 — «Ferma» senza testo", () => {
  it("è stop: true, mai in coda, nel suo punto per tempo", () => {
    const items = build({
      live: true,
      events: [ev("1", "assistant_text", { text: "prima" }, at(1)), ev("2", "assistant_text", { text: "dopo" }, at(10))],
      inputs: [input({ status: "delivered", interrupt: true, text: "", createdAt: at(5) })],
    });
    expect(kinds(items)).toEqual(["text", "input", "text"]);
    expect(items[1]).toMatchObject({ stop: true, queued: false, interrupt: true, text: "" });
  });

  it("lo stop sostituisce la riga generica del turno interrotto: solo la riga dello stop", () => {
    const stop = input({ status: "delivered", interrupt: true, text: "", createdAt: at(5) });
    const items = build({
      live: true,
      events: [
        ev("1", "assistant_text", { text: "prima" }, at(1)),
        ev("2", "turn_end", { subtype: "error_during_execution" }, at(6)),
      ],
      inputs: [stop],
    });
    expect(kinds(items)).toEqual(["text", "input"]);
    expect(items[1]).toMatchObject({ stop: true });
  });

  it("l'ancora è il PRIMO turn_end dopo lo stop: un «Ferma e scrivi» successivo tiene la sua riga", () => {
    const stop = input({ status: "delivered", interrupt: true, text: "", createdAt: at(5) });
    const items = build({
      live: true,
      events: [
        ev("1", "turn_end", { subtype: "error_during_execution" }, at(6)),
        ev("2", "input", { text: "fai X", interrupt: true, inputId: "altro", authorName: null }, at(8)),
        ev("3", "turn_end", { subtype: "error_during_execution" }, at(9)),
      ],
      inputs: [stop],
    });
    expect(kinds(items)).toEqual(["input", "input", "interrupted"]);
  });

  it("se il primo turn_end dopo lo stop è riuscito (il CLI aveva già chiuso), lo stop lo consuma e non tocca le interruzioni dopo", () => {
    const stop = input({ status: "delivered", interrupt: true, text: "", createdAt: at(5) });
    const items = build({
      events: [
        ev("1", "turn_end", { subtype: "success" }, at(6)),
        ev("2", "turn_end", { subtype: "error_during_execution" }, at(9)),
      ],
      inputs: [stop],
    });
    expect(kinds(items)).toEqual(["input", "interrupted"]);
  });

  it("senza stop (o con uno stop non consegnato) la riga del turno interrotto resta", () => {
    const events = [ev("1", "turn_end", { subtype: "error_during_execution" }, at(6))];
    expect(kinds(build({ events }))).toEqual(["interrupted"]);
    const pending = input({ status: "pending", interrupt: true, text: "", createdAt: at(5) });
    expect(kinds(build({ events, inputs: [pending] }))).toEqual(["input", "interrupted"]);
  });

  it("un intervento col testo, o senza interrupt, non è uno stop", () => {
    const items = build({
      inputs: [
        input({ id: "7f1c2a1e-0000-4000-8000-0000000000f1", interrupt: true, text: "ferma e fai X", createdAt: at(1) }),
        input({ id: "7f1c2a1e-0000-4000-8000-0000000000f2", interrupt: false, text: "", createdAt: at(2) }),
      ],
    });
    expect(items.map((i) => i.kind === "input" && i.stop)).toEqual([false, false]);
  });
});

describe("regola 3 — il parziale dal vivo", () => {
  it("senza parziale nessun elemento live", () => {
    const items = build({ events: [ev("1", "assistant_text", { text: "fatto" })] });
    expect(items.some((i) => i.kind === "text" && i.live)).toBe(false);
  });

  it("col parziale: un text live in coda, per segmento; un parziale vuoto non compare", () => {
    const items = build({
      events: [ev("1", "assistant_text", { text: "fatto" }, at(1))],
      partials: { "seg-1": "sto scriv", "seg-2": "" },
    });
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ kind: "text", id: "partial:seg-1", text: "sto scriv", at: at(1), live: true });
  });

  it("un intervento pending più recente dell'ultimo evento sta DOPO il parziale dal vivo", () => {
    const items = build({
      events: [ev("1", "assistant_text", { text: "fatto" }, at(1))],
      partials: { "seg-1": "sto scriv" },
      inputs: [input({ status: "pending", createdAt: at(2) })],
    });
    expect(items.map((i) => i.id)).toEqual(["1", "partial:seg-1", `input:${input().id}`]);
  });

  it("applyPartial ACCODA i delta del segmento", () => {
    let p: Record<string, string> = {};
    p = applyPartial(p, "seg-1", "Sto ");
    p = applyPartial(p, "seg-1", "leggendo");
    p = applyPartial(p, "seg-2", "altro");
    expect(p).toEqual({ "seg-1": "Sto leggendo", "seg-2": "altro" });
  });

  it("clearPartialsFor azzera il segmento su assistant_text e turn_end, non sugli altri tipi", () => {
    const p = { "seg-1": "a", "seg-2": "b", "seg-3": "c" };
    const next = clearPartialsFor(p, [
      ev("1", "assistant_text", { text: "x" }, at(1), "seg-1"),
      ev("2", "turn_end", { subtype: "success" }, at(2), "seg-2"),
      ev("3", "tool_use", { toolUseId: "t", name: "Read", input: {} }, at(3), "seg-3"),
    ]);
    expect(next).toEqual({ "seg-3": "c" });
    expect(p).toEqual({ "seg-1": "a", "seg-2": "b", "seg-3": "c" });
  });

  it("clearPartialsFor restituisce lo stesso oggetto se non c'è niente da azzerare", () => {
    const p = { "seg-1": "a" };
    expect(clearPartialsFor(p, [ev("1", "tool_use", { toolUseId: "t", name: "R", input: {} })])).toBe(p);
  });
});

describe("regola 4 — turn_end", () => {
  it("error_during_execution diventa interrupted, gli altri turn_end niente", () => {
    const items = build({
      events: [
        ev("1", "turn_end", { subtype: "success", isError: false, costUsd: 0.1 }),
        ev("2", "turn_end", { subtype: "error_during_execution", isError: true, costUsd: null }),
        ev("3", "turn_end", { subtype: "error_max_turns", isError: true }),
      ],
    });
    expect(items).toEqual([{ kind: "interrupted", id: "2", at: at(2) }]);
  });
});

describe("regola 5 — le domande nel punto in cui sono state fatte", () => {
  it("dopo l'ultimo elemento con at <= askedAt, non in testa", () => {
    const q = question({ askedAt: at(5) });
    const items = build({
      events: [
        ev("1", "assistant_text", { text: "uno" }, at(1)),
        ev("2", "assistant_text", { text: "due" }, at(5)),
        ev("3", "assistant_text", { text: "tre" }, at(9)),
      ],
      questions: [q],
    });
    expect(kinds(items)).toEqual(["text", "text", "question", "text"]);
    expect(items[2]).toEqual({ kind: "question", id: `question:${q.id}`, question: q, at: at(5) });
  });

  it("una domanda più recente di tutto va in coda; più domande restano in ordine di askedAt", () => {
    const items = build({
      events: [ev("1", "assistant_text", { text: "uno" }, at(1))],
      questions: [
        question({ id: "7f1c2a1e-0000-4000-8000-0000000000q2", askedAt: at(20) }),
        question({ id: "7f1c2a1e-0000-4000-8000-0000000000q1", askedAt: at(10) }),
      ],
    });
    expect(items.map((i) => i.id)).toEqual([
      "1",
      "question:7f1c2a1e-0000-4000-8000-0000000000q1",
      "question:7f1c2a1e-0000-4000-8000-0000000000q2",
    ]);
  });

  it("una domanda più vecchia di ogni evento caricato sta in testa (il tempo lo dice)", () => {
    const items = build({
      events: [ev("1", "assistant_text", { text: "uno" }, at(30))],
      questions: [question({ askedAt: at(2) })],
    });
    expect(kinds(items)).toEqual(["question", "text"]);
  });
});

describe("regola 6 — tipi d'evento sconosciuti", () => {
  it("il segnaposto del reader e un nome grezzo nuovo si saltano senza lanciare", () => {
    const items = build({
      events: [
        ev("1", "__unknown__", { text: "?" }),
        ev("2", "thinking", { text: "?" }),
        ev("3", "assistant_text", { text: "ok" }),
      ],
    });
    expect(items).toEqual([{ kind: "text", id: "3", text: "ok", at: at(3), live: false }]);
  });

  it("dati malformati non lanciano: un assistant_text senza testo non produce niente", () => {
    expect(() => build({ events: [ev("1", "assistant_text", {}), ev("2", "tool_use", {})] })).not.toThrow();
    expect(build({ events: [ev("1", "assistant_text", {})] })).toEqual([]);
  });
});

describe("regola 7 — mergeEvents", () => {
  it("confronta gli id come numeri: \"10\" viene dopo \"9\"", () => {
    const merged = mergeEvents([ev("9", "assistant_text", { text: "a" })], [ev("10", "assistant_text", { text: "b" })]);
    expect(merged.map((e) => e.id)).toEqual(["9", "10"]);
  });

  it("toglie i doppi (prima pagina REST ∪ stream) e riordina in ascendente", () => {
    const merged = mergeEvents(
      [ev("8", "x", {}), ev("9", "x", {}), ev("10", "x", {})],
      [ev("100", "x", {}), ev("9", "x", {}), ev("11", "x", {}), ev("10", "x", {})],
    );
    expect(merged.map((e) => e.id)).toEqual(["8", "9", "10", "11", "100"]);
  });

  it("una pagina più vecchia caricata dopo finisce in testa", () => {
    const merged = mergeEvents([ev("100", "x", {}), ev("101", "x", {})], [ev("98", "x", {}), ev("99", "x", {})]);
    expect(merged.map((e) => e.id)).toEqual(["98", "99", "100", "101"]);
  });

  it("id grandi oltre Number.MAX_SAFE_INTEGER restano ordinati", () => {
    const merged = mergeEvents([ev("9007199254740993", "x", {})], [ev("9007199254740992", "x", {})]);
    expect(merged.map((e) => e.id)).toEqual(["9007199254740992", "9007199254740993"]);
  });

  it("niente di nuovo: restituisce lo stesso array", () => {
    const current = [ev("1", "x", {}), ev("2", "x", {})];
    expect(mergeEvents(current, [])).toBe(current);
    expect(mergeEvents(current, [ev("2", "x", {})])).toBe(current);
  });
});
