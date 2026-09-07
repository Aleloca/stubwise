import { describe, expect, it } from "vitest";
import { BRIEF_MARKERS, buildBriefPrompt, parseBriefOutput } from "./prompt.js";
import type { BriefInput } from "./input.js";

/**
 * Il prompt del BRIEF SETTIMANALE e il parse del suo output.
 *
 * Due invarianti sole, ma non negoziabili: (1) la lingua non è cablata nel
 * builder — sta nel catalogo, come per i riassunti "in breve" della fase B; (2)
 * il parse non fallisce MAI su una sezione mancante, perché un brief con tre
 * sezioni su quattro è un brief, mentre un'eccezione qui butterebbe via un run
 * dell'agente già pagato.
 */

const INPUT: BriefInput = {
  projectName: "Stubwise",
  periodStart: "2026-08-31",
  periodEnd: "2026-09-06",
  reports: [{ date: "2026-09-01", summary: "Sistemato il login." }],
  timeline: ["[ticket_done] 2026-09-02 #7 Login rotto"],
  blocks: ["Una domanda dell'agente aspetta risposta"],
  decisions: ["2026-09-03 — Piano approvato: si procede col fix"],
  previousBrief: "La settimana scorsa avevamo iniziato il login.",
  truncated: false,
};

describe("buildBriefPrompt", () => {
  it("porta il periodo, il progetto e tutte le sezioni dell'input", () => {
    const prompt = buildBriefPrompt("it", INPUT);
    expect(prompt).toContain("Stubwise");
    expect(prompt).toContain("2026-08-31");
    expect(prompt).toContain("2026-09-06");
    expect(prompt).toContain("Sistemato il login.");
    expect(prompt).toContain("[ticket_done] 2026-09-02 #7 Login rotto");
    expect(prompt).toContain("Una domanda dell'agente aspetta risposta");
    expect(prompt).toContain("Piano approvato");
    expect(prompt).toContain("La settimana scorsa");
  });

  it("chiede i quattro marcatori di sezione, e nessun altro", () => {
    const prompt = buildBriefPrompt("en", INPUT);
    for (const marker of Object.values(BRIEF_MARKERS)) {
      expect(prompt).toContain(marker);
    }
  });

  it("la lingua NON è cablata: cambia col catalogo, non col builder", () => {
    const it = buildBriefPrompt("it", INPUT);
    const en = buildBriefPrompt("en", INPUT);
    expect(it).not.toBe(en);
    expect(it).toContain("ITALIANO");
    expect(en).not.toContain("ITALIANO");
  });

  it("dichiara nel prompt che l'input è stato troncato", () => {
    const prompt = buildBriefPrompt("it", { ...INPUT, truncated: true });
    expect(prompt).toContain("troncata per lunghezza");
  });

  it("una sezione vuota è dichiarata assente, non omessa in silenzio", () => {
    const prompt = buildBriefPrompt("it", { ...INPUT, blocks: [], decisions: [] });
    // Il modello deve poter dire "non ci sono blocchi", non inventarli.
    expect(prompt.match(/nessun dato/gi)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("parseBriefOutput", () => {
  const full = [
    `${BRIEF_MARKERS.whereWeAre}`,
    "Il progetto è a metà del lavoro sul login.",
    `${BRIEF_MARKERS.whatChanged}`,
    "È stato sistemato l'accesso.",
    `${BRIEF_MARKERS.whatBlocks}`,
    "Una domanda aspetta risposta.",
    `${BRIEF_MARKERS.whatWeNeed}`,
    "Rispondere alla domanda.",
  ].join("\n");

  it("estrae le quattro sezioni e compone il markdown completo", () => {
    const parsed = parseBriefOutput("it", full)!;
    expect(parsed.sections.whereWeAre).toBe("Il progetto è a metà del lavoro sul login.");
    expect(parsed.sections.whatChanged).toBe("È stato sistemato l'accesso.");
    expect(parsed.sections.whatBlocks).toBe("Una domanda aspetta risposta.");
    expect(parsed.sections.whatWeNeed).toBe("Rispondere alla domanda.");
    // Il markdown ha un titolo per sezione e nessun marcatore residuo.
    expect(parsed.summary).toContain("## ");
    for (const marker of Object.values(BRIEF_MARKERS)) {
      expect(parsed.summary).not.toContain(marker);
    }
    expect(parsed.summary).toContain("Il progetto è a metà del lavoro sul login.");
  });

  it("sezione mancante → sezione VUOTA, non un errore", () => {
    const parsed = parseBriefOutput("it", [
      BRIEF_MARKERS.whereWeAre,
      "Dove siamo.",
      BRIEF_MARKERS.whatChanged,
      "Cosa è cambiato.",
    ].join("\n"))!;
    expect(parsed.sections.whatBlocks).toBe("");
    expect(parsed.sections.whatWeNeed).toBe("");
    expect(parsed.summary).toContain("Dove siamo.");
    // Le sezioni vuote non finiscono nel markdown come titoli orfani.
    expect(parsed.summary).not.toContain("##  ");
  });

  it("nessun marcatore → tutto il testo diventa 'dove siamo' (mai output perso)", () => {
    const parsed = parseBriefOutput("it", "Una settimana tranquilla.")!;
    expect(parsed.sections.whereWeAre).toBe("Una settimana tranquilla.");
    expect(parsed.summary).toContain("Una settimana tranquilla.");
  });

  it("output vuoto → null: non c'è niente da salvare", () => {
    expect(parseBriefOutput("it", "   \n  ")).toBeNull();
  });

  it("tollera un preambolo prima del primo marcatore", () => {
    const parsed = parseBriefOutput("it", `Ecco il brief:\n${full}`);
    expect(parsed!.sections.whereWeAre).toBe("Il progetto è a metà del lavoro sul login.");
  });
});
