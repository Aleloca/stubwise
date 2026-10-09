import { describe, expect, it } from "vitest";
import { questionTextLabel, splitQuestionText } from "./question-text";

describe("splitQuestionText", () => {
  it("il titolo del ticket UGUALE alla domanda resta nel prefisso: si prende l'ULTIMA occorrenza", () => {
    const text = "AI has a question on TCK-3 — Keep `x`?: Keep `x`? /tickets/tck-3";
    expect(splitQuestionText(text, "Keep `x`?")).toEqual({
      before: "AI has a question on TCK-3 — Keep `x`?: ",
      question: "Keep `x`?",
      after: " /tickets/tck-3",
    });
  });

  it("una domanda con spazi o a-capo ai bordi si trova lo stesso", () => {
    const text = "AI has a question on TCK-3 — Title: Keep `x`? /tickets/tck-3";
    expect(splitQuestionText(text, "  Keep `x`?\n")).toEqual({
      before: "AI has a question on TCK-3 — Title: ",
      question: "Keep `x`?",
      after: " /tickets/tck-3",
    });
  });

  it("domanda assente dal testo, o vuota: null", () => {
    expect(splitQuestionText("Plain text", "Other?")).toBeNull();
    expect(splitQuestionText("Plain text", "  ")).toBeNull();
    expect(splitQuestionText("Plain text", undefined)).toBeNull();
  });

  it("il nome accessibile toglie i segni solo dalla domanda", () => {
    expect(questionTextLabel("Fix `a`: Keep `x`? link", "Keep `x`?\n")).toBe(
      "Fix `a`: Keep x? link",
    );
  });
});
