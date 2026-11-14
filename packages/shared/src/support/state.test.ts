import { describe, expect, it } from "vitest";
import {
  SUPPORT_STATE_ORDER,
  SUPPORT_TRIAGE_IDLE_MINUTES,
  supportMailSlot,
  supportState,
  waitingSince,
  wishTitle,
  type SupportStateInput,
} from "./state.js";

// Area 8, F3: lo stato di una conversazione di Support si DERIVA (era
// `domain/support/state.ts` del prototipo). Ingresso neutro, lo riempiono
// server e prototipo: l'esito (una richiesta legata o un ticket del widget),
// il giudizio sul triage, i messaggi.

const msg = (from: "customer" | "triage" | "team", at: string) => ({ from, at });
const conv = (over: Partial<SupportStateInput> = {}): SupportStateInput => ({
  hasOutcome: false,
  judgment: null,
  messages: [],
  ...over,
});

describe("supportState", () => {
  it("senza esito né giudizio: in triage", () => {
    expect(supportState(conv())).toBe("triage");
    expect(supportState(conv({ messages: [msg("customer", "1")] }))).toBe("triage");
  });

  it("senza esito, il giudizio decide: non conclusa, o risposta bastata (answered)", () => {
    const messages = [msg("customer", "1"), msg("triage", "2")];
    expect(supportState(conv({ messages, judgment: { outcome: "not_concluded", at: "3" } }))).toBe("not_concluded");
    expect(supportState(conv({ messages, judgment: { outcome: "concluded", at: "3" } }))).toBe("answered");
  });

  it("un messaggio del cliente DOPO il giudizio lo rende vecchio: di nuovo in triage", () => {
    const messages = [msg("customer", "1"), msg("triage", "2"), msg("customer", "4")];
    expect(supportState(conv({ messages, judgment: { outcome: "not_concluded", at: "3" } }))).toBe("triage");
    expect(supportState(conv({ messages, judgment: { outcome: "concluded", at: "3" } }))).toBe("triage");
    // Lo stesso istante vale ancora (il giudizio ha letto quel messaggio).
    expect(supportState(conv({ messages, judgment: { outcome: "concluded", at: "4" } }))).toBe("answered");
  });

  it("con un esito l'ultimo messaggio decide (cliente → aspetta noi, team → risposta inviata, altrimenti richiesta aperta)", () => {
    const base = { hasOutcome: true };
    expect(supportState(conv({ ...base, messages: [msg("customer", "1")] }))).toBe("waiting_us");
    expect(supportState(conv({ ...base, messages: [msg("customer", "1"), msg("team", "2")] }))).toBe("reply_sent");
    expect(supportState(conv({ ...base, messages: [msg("customer", "1"), msg("triage", "2")] }))).toBe("request_open");
    expect(supportState(conv(base))).toBe("request_open");
  });

  it("un esito vince sul giudizio", () => {
    expect(
      supportState(conv({ hasOutcome: true, judgment: { outcome: "concluded", at: "9" }, messages: [msg("triage", "1")] })),
    ).toBe("request_open");
  });

  it("l'ordine dei gruppi: chi aspetta noi in cima, le risolte dal widget in fondo; un valore per stato", () => {
    expect(SUPPORT_STATE_ORDER[0]).toBe("waiting_us");
    expect(SUPPORT_STATE_ORDER.at(-1)).toBe("answered");
    expect(new Set(SUPPORT_STATE_ORDER).size).toBe(6);
  });
});

describe("waitingSince", () => {
  it("dal primo dei messaggi del cliente rimasti senza risposta", () => {
    const c = conv({
      hasOutcome: true,
      messages: [msg("customer", "1"), msg("team", "2"), msg("customer", "3"), msg("customer", "4")],
    });
    expect(waitingSince(c)).toBe("3");
  });

  it("null se non aspetta noi", () => {
    expect(waitingSince(conv({ messages: [msg("customer", "1")] }))).toBeNull();
    expect(waitingSince(conv({ hasOutcome: true, messages: [msg("customer", "1"), msg("team", "2")] }))).toBeNull();
  });
});

describe("le costanti e i testi", () => {
  it("l'attesa del controllo è di 15 minuti (decisione di 46)", () => {
    expect(SUPPORT_TRIAGE_IDLE_MINUTES).toBe(15);
  });
  it("lo slot della Posta e il titolo dal desiderio", () => {
    expect(supportMailSlot("ACQ-S2")).toBe("support-ACQ-S2");
    expect(wishTitle("Vorrei esportare i dati. Anche in PDF.")).toBe("Vorrei esportare i dati");
    expect(wishTitle("x".repeat(100))).toHaveLength(80);
  });
});
