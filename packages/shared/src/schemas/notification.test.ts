import { describe, expect, it } from "vitest";
import { inboxQuestionSchema, ticketQuestionSchema } from "./notification.js";

/**
 * `round` è l'unico campo della domanda che NON è generalizzabile ai kind con
 * opzioni: nasce dai giri di `ask_user` su uno stesso job, e il pulse proattivo
 * — che di job non ne ha — non ne ha uno. Questi test tengono ferma
 * l'asimmetria voluta: opzionale sulla card d'inbox, obbligatorio sulla pagina
 * ticket (dove la colonna `agent_questions.round` esiste sempre).
 */
describe("inboxQuestionSchema — round opzionale", () => {
  const base = {
    questionId: "1c9e4f70-5555-4666-8777-888899990000",
    question: "Da quale proposta partiamo?",
    options: [{ label: "Export CSV" }],
    allowFreeText: false,
  };

  it("accetta una domanda SENZA round (è la forma del pulse)", () => {
    const parsed = inboxQuestionSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && "round" in parsed.data).toBe(false);
  });

  it("accetta e conserva il round quando c'è (domanda dell'agente)", () => {
    const parsed = inboxQuestionSchema.safeParse({ ...base, round: 2 });
    expect(parsed.success && parsed.data.round).toBe(2);
  });

  it("un round non intero resta un errore: opzionale non vuol dire libero", () => {
    expect(inboxQuestionSchema.safeParse({ ...base, round: 1.5 }).success).toBe(false);
  });
});

describe("ticketQuestionSchema — round di nuovo obbligatorio", () => {
  const domandaDiTicket = {
    questionId: "1c9e4f70-5555-4666-8777-888899990000",
    question: "Quali colonne deve avere il CSV?",
    options: [{ label: "Colonne vecchie" }, { label: "Colonne nuove" }],
    allowFreeText: true,
    jobId: "aa11bb22-1111-4222-8333-444455556666",
    askedAt: "2026-09-01T10:00:00.000Z",
    answer: null,
    answeredAt: null,
    answeredBy: null,
  };

  it("senza round NON passa: sulla pagina ticket la colonna c'è sempre", () => {
    expect(ticketQuestionSchema.safeParse(domandaDiTicket).success).toBe(false);
    expect(ticketQuestionSchema.safeParse({ ...domandaDiTicket, round: 1 }).success).toBe(true);
  });
});
