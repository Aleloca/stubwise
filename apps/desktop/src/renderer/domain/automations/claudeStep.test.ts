import { describe, expect, it } from "vitest";
import type { Step } from "../../data/model";
import { checkClaudeResult } from "./claudeStep";

type ClaudeStep = Extract<Step, { kind: "claude" }>;

const step = (over: Partial<ClaudeStep> = {}): ClaudeStep => ({
  id: "c",
  kind: "claude",
  instruction: "Leggi",
  inputs: [],
  outcomes: ["tutto presente", "mancano informazioni"],
  fields: [
    { key: "verifica.mancanti", label: "Cosa manca", type: "text" },
    { key: "verifica.giorni", label: "Giorni", type: "number" },
  ],
  branches: {},
  ...over,
});

const LIST_STEP = step({
  outcomes: [],
  fields: [
    {
      key: "analisi.task",
      label: "Task",
      type: "list",
      of: [
        { key: "titolo", label: "Titolo", type: "text" },
        { key: "reparto", label: "Reparto", type: "text" },
      ],
    },
  ],
});
const tasks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ titolo: `Task ${i}`, reparto: "Support" }));

describe("checkClaudeResult (regola 2)", () => {
  it("accetta un'uscita dichiarata e i campi col loro tipo", () => {
    expect(
      checkClaudeResult(step(), {
        outcome: "mancano informazioni",
        fields: { "verifica.mancanti": "il logo", "verifica.giorni": 3 },
        reason: "Manca il logo.",
      }),
    ).toEqual({ ok: true });
  });

  it("un'uscita non dichiarata, assente o non prevista è unknown_outcome", () => {
    const fields = { "verifica.mancanti": "", "verifica.giorni": 0 };
    expect(checkClaudeResult(step(), { outcome: "crea una task", fields, reason: "" })).toEqual({
      ok: false,
      error: "unknown_outcome",
    });
    expect(checkClaudeResult(step(), { fields, reason: "" })).toEqual({
      ok: false,
      error: "unknown_outcome",
    });
    expect(
      checkClaudeResult(LIST_STEP, {
        outcome: "tutto presente",
        fields: { "analisi.task": [] },
        reason: "",
      }),
    ).toEqual({ ok: false, error: "unknown_outcome" });
  });

  it("un campo non dichiarato, mancante o del tipo sbagliato è bad_field", () => {
    const base = { outcome: "tutto presente", reason: "" };
    const cases: Record<string, unknown>[] = [
      { "verifica.mancanti": "", "verifica.giorni": 0, "azione.esegui": "rm -rf" },
      { "verifica.mancanti": "" },
      { "verifica.mancanti": 3, "verifica.giorni": 0 },
      { "verifica.mancanti": "", "verifica.giorni": "tre" },
      { "verifica.mancanti": "", "verifica.giorni": Number.NaN },
    ];
    for (const fields of cases) {
      expect(checkClaudeResult(step(), { ...base, fields }), JSON.stringify(fields)).toEqual({
        ok: false,
        error: "bad_field",
      });
    }
  });

  it("controlla i tipi di data, email, persona, booleano e gli elementi di un elenco", () => {
    const typed = step({
      outcomes: [],
      fields: [
        { key: "a.data", label: "", type: "date" },
        { key: "a.email", label: "", type: "email" },
        { key: "a.persona", label: "", type: "person" },
        { key: "a.ok", label: "", type: "boolean" },
      ],
    });
    const good = {
      "a.data": "2026-10-30",
      "a.email": "x@y.example",
      "a.persona": "p-laura",
      "a.ok": false,
    };
    expect(checkClaudeResult(typed, { fields: good, reason: "" })).toEqual({ ok: true });
    for (const bad of [
      { "a.data": "domani" },
      { "a.email": "non-una-email" },
      { "a.persona": "" },
      { "a.ok": "sì" },
    ]) {
      expect(checkClaudeResult(typed, { fields: { ...good, ...bad }, reason: "" })).toEqual({
        ok: false,
        error: "bad_field",
      });
    }
    // Un elemento con una chiave in più, o una chiave del tipo sbagliato.
    for (const item of [
      { titolo: "x", reparto: "Sales", esegui: "y" },
      { titolo: 1, reparto: "Sales" },
      { titolo: "x" },
      "solo testo",
    ]) {
      expect(
        checkClaudeResult(LIST_STEP, { fields: { "analisi.task": [item] }, reason: "" }),
      ).toEqual({ ok: false, error: "bad_field" });
    }
    expect(
      checkClaudeResult(LIST_STEP, { fields: { "analisi.task": "a, b" }, reason: "" }),
    ).toEqual({
      ok: false,
      error: "bad_field",
    });
  });

  it("un elenco oltre 50 elementi è too_many; 50 e vuoto vanno bene", () => {
    expect(
      checkClaudeResult(LIST_STEP, { fields: { "analisi.task": tasks(50) }, reason: "" }),
    ).toEqual({ ok: true });
    expect(checkClaudeResult(LIST_STEP, { fields: { "analisi.task": [] }, reason: "" })).toEqual({
      ok: true,
    });
    expect(
      checkClaudeResult(LIST_STEP, { fields: { "analisi.task": tasks(51) }, reason: "" }),
    ).toEqual({ ok: false, error: "too_many" });
  });
});
