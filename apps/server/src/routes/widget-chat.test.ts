/**
 * Unit del parser della sentinel `ticket_proposal` del widget (nessun
 * testcontainer): pura logica di stringa su `safeForwardLength` e `extractProposal`.
 * L'integrazione (route SSE, persistenza, cap) vive in widget.test.ts.
 */

import { describe, expect, it } from "vitest";
import { extractProposal, safeForwardLength } from "./widget-chat.js";

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
