/**
 * Unit del parser della sentinel `ticket_proposal` del widget (nessun
 * testcontainer): pura logica di stringa su `safeForwardLength` e `extractProposal`.
 * L'integrazione (route SSE, persistenza, cap) vive in widget.test.ts.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@stubwise/db";
import type { ChatLlm } from "./chat-llm.js";
import {
  buildWidgetSystemPrompt,
  extractProposal,
  safeForwardLength,
  streamWidgetChatResponse,
} from "./widget-chat.js";

const START = "<<<TICKET_PROPOSAL";
const END = "TICKET_PROPOSAL>>>";

/** Proposta ben formata da appendere in coda a una risposta. */
function proposalBlock(json: string): string {
  return `${START}\n${json}\n${END}`;
}

describe("safeForwardLength", () => {
  it("nessun marker: inoltra tutta la stringa", () => {
    const s = "Ciao, ecco la risposta completa.";
    expect(safeForwardLength(s)).toBe(s.length);
  });

  it("marker completo presente: inoltra solo il testo che lo precede", () => {
    const visible = "Ecco la risposta.\n";
    const full = visible + proposalBlock('{"a":1}');
    expect(safeForwardLength(full)).toBe(visible.length);
  });

  it("suffisso che è un PREFISSO parziale del marker: trattiene il pezzo ambiguo", () => {
    // Ogni prefisso non vuoto del marker deve essere trattenuto (potrebbe
    // completarsi in un marker nel delta successivo).
    for (let k = 1; k < START.length; k++) {
      const visible = "Testo prima. ";
      const full = visible + START.slice(0, k);
      expect(safeForwardLength(full)).toBe(visible.length);
    }
  });

  it('suffisso "<" (un solo carattere): trattenuto', () => {
    const full = "Risposta<";
    expect(safeForwardLength(full)).toBe("Risposta".length);
  });

  it('suffisso "<<<TIC" (prefisso medio): trattenuto', () => {
    const visible = "Risposta ";
    const full = visible + "<<<TIC";
    expect(safeForwardLength(full)).toBe(visible.length);
  });

  it("un '<' che NON è prefisso del marker viene inoltrato", () => {
    // "a < b" — il '<' seguito da spazio non è un prefisso di "<<<..."
    const s = "a < b";
    expect(safeForwardLength(s)).toBe(s.length);
  });

  it("stringa vuota → 0", () => {
    expect(safeForwardLength("")).toBe(0);
  });
});

describe("buildWidgetSystemPrompt", () => {
  /** Marcatore usato dal prompt per delimitare le istruzioni dell'admin. */
  const INSTR_HEADING = "Additional instructions from the project team";

  it("con istruzioni: il prompt le contiene nella sezione dedicata, dopo le regole base", () => {
    const instructions = "Sii sintetico e suggerisci il piano Pro quando pertinente.";
    const prompt = buildWidgetSystemPrompt([], { language: "it", instructions });

    // Sezione delimitata presente col testo esatto.
    expect(prompt).toContain(INSTR_HEADING);
    expect(prompt).toContain(instructions);
    // Regole base ancora presenti.
    expect(prompt).toContain("GROUND YOUR ANSWERS ONLY IN THE DOCUMENTATION");
    expect(prompt).toContain("TICKET PROPOSAL");

    // Ordine: le istruzioni cadono DOPO le regole di grounding/sentinel e PRIMA
    // del contesto docs, così l'ordine non indebolisce le regole base.
    const groundingIdx = prompt.indexOf("GROUND YOUR ANSWERS ONLY");
    const sentinelIdx = prompt.indexOf("TICKET PROPOSAL");
    const instrIdx = prompt.indexOf(INSTR_HEADING);
    const contextIdx = prompt.indexOf("--- DOCUMENTATION CONTEXT ---");
    expect(instrIdx).toBeGreaterThan(groundingIdx);
    expect(instrIdx).toBeGreaterThan(sentinelIdx);
    expect(instrIdx).toBeLessThan(contextIdx);
  });

  it("istruzioni vuote o solo spazi: nessuna sezione, regole base intatte", () => {
    for (const instructions of ["", "   \n  \t "]) {
      const prompt = buildWidgetSystemPrompt([], { language: "it", instructions });
      expect(prompt).not.toContain(INSTR_HEADING);
      // Regole base sempre presenti.
      expect(prompt).toContain("GROUND YOUR ANSWERS ONLY IN THE DOCUMENTATION");
      expect(prompt).toContain("TICKET PROPOSAL");
    }
  });

  it("campo instructions assente (retrocompat): nessuna sezione", () => {
    const prompt = buildWidgetSystemPrompt([], { language: "en" });
    expect(prompt).not.toContain(INSTR_HEADING);
    expect(prompt).toContain("GROUND YOUR ANSWERS ONLY IN THE DOCUMENTATION");
  });
});

describe("extractProposal", () => {
  it("nessun marker: visible = testo (trim), proposal null", () => {
    const { visible, proposal } = extractProposal("  Risposta senza proposta.  ");
    expect(visible).toBe("Risposta senza proposta.");
    expect(proposal).toBeNull();
  });

  it("proposta valida: estrae il JSON, visible senza il blocco", () => {
    const json = '{"title":"Bug nel login","body":"Il pulsante non risponde","type":"bug"}';
    const full = "Mi dispiace per il problema.\n\n" + proposalBlock(json);
    const { visible, proposal } = extractProposal(full);
    expect(visible).toBe("Mi dispiace per il problema.");
    expect(proposal).toEqual({
      title: "Bug nel login",
      body: "Il pulsante non risponde",
      type: "bug",
    });
  });

  it("type feature e feedback sono accettati", () => {
    for (const type of ["feature", "feedback"] as const) {
      const json = `{"title":"T","body":"B","type":"${type}"}`;
      const { proposal } = extractProposal("x\n" + proposalBlock(json));
      expect(proposal?.type).toBe(type);
    }
  });

  it("JSON malformato: proposal null, visible senza il blocco", () => {
    const full = "Testo.\n" + `${START}\n{non valido\n${END}`;
    const { visible, proposal } = extractProposal(full);
    expect(proposal).toBeNull();
    expect(visible).toBe("Testo.");
    expect(visible).not.toContain(START);
  });

  it("type invalido (fuori enum): proposal null (schema safeParse), visible senza blocco", () => {
    const json = '{"title":"T","body":"B","type":"question"}';
    const full = "Testo.\n" + proposalBlock(json);
    const { visible, proposal } = extractProposal(full);
    expect(proposal).toBeNull();
    expect(visible).toBe("Testo.");
  });

  it("title mancante: proposal null (schema)", () => {
    const json = '{"body":"B","type":"bug"}';
    const { proposal } = extractProposal("Testo.\n" + proposalBlock(json));
    expect(proposal).toBeNull();
  });

  it("testo DOPO il marker di chiusura viene scartato", () => {
    const json = '{"title":"T","body":"B","type":"bug"}';
    const full = "Visibile.\n" + proposalBlock(json) + "\nSpazzatura dopo la chiusura.";
    const { visible, proposal } = extractProposal(full);
    expect(proposal).not.toBeNull();
    expect(visible).toBe("Visibile.");
    expect(visible).not.toContain("Spazzatura");
  });

  it("marker di apertura SENZA chiusura (stream troncato): proposal null, visible fino all'apertura", () => {
    const full = "Risposta parziale.\n" + START + '\n{"title":"T"';
    const { visible, proposal } = extractProposal(full);
    expect(proposal).toBeNull();
    // Tutto ciò che segue l'apertura è scartato (era destinato alla proposta).
    expect(visible).toBe("Risposta parziale.");
    expect(visible).not.toContain(START);
  });
});

describe("streamWidgetChatResponse — la persistenza precede la chiusura della risposta", () => {
  // Stessa garanzia di docs-chat-core: il widget fa refetch dello storico dopo
  // il `done`; l'insert dell'assistant deve quindi avvenire PRIMA della chiusura
  // dello stream (race osservata come flake CI sul gemello docs-chat).

  function fakeReply() {
    const raw = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
    return {
      reply: { hijack: vi.fn(), raw } as unknown as FastifyReply,
      endCalled: () => raw.end.mock.calls.length > 0,
      doneWritten: () => raw.write.mock.calls.some((c) => String(c[0]).includes('"done"')),
    };
  }

  it("insert dell'assistant atteso PRIMA di done e di end", async () => {
    const { reply, endCalled, doneWritten } = fakeReply();
    let endAtInsert: boolean | null = null;
    let doneAtInsert: boolean | null = null;
    const values = vi.fn(async () => {
      endAtInsert = endCalled();
      doneAtInsert = doneWritten();
    });
    const where = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn(() => ({ values })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })),
    } as unknown as Db;
    const request = {
      raw: { on: vi.fn() },
      log: { error: vi.fn() },
    } as unknown as FastifyRequest;
    const chatLlm = {
      stream: async function* () {
        yield "risposta widget";
      },
    } as unknown as ChatLlm;

    await streamWidgetChatResponse({
      db,
      chatLlm,
      request,
      reply,
      conversationId: "33333333-3333-4333-8333-333333333333",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: [],
      logContext: { widgetId: "w" },
    });

    expect(values).toHaveBeenCalledTimes(1);
    expect(endAtInsert).toBe(false);
    expect(doneAtInsert).toBe(false);
    expect(doneWritten()).toBe(true);
    expect(endCalled()).toBe(true);
  });
});
