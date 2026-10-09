import { splitQuestionText } from "./question-text";

describe("splitQuestionText", () => {
  test("il titolo del ticket UGUALE alla domanda resta nel prefisso: si prende l'ULTIMA occorrenza", () => {
    const text = "L'AI ha una domanda su #3 — Tengo `x`?: Tengo `x`? https://x.test/t/3";
    expect(splitQuestionText(text, "Tengo `x`?")).toEqual({
      before: "L'AI ha una domanda su #3 — Tengo `x`?: ",
      question: "Tengo `x`?",
      after: " https://x.test/t/3",
    });
  });

  test("una domanda con spazi o a-capo ai bordi si trova lo stesso", () => {
    const text = "L'AI ha una domanda su #3 — Titolo: Tengo `x`? https://x.test/t/3";
    expect(splitQuestionText(text, "  Tengo `x`?\n")).toEqual({
      before: "L'AI ha una domanda su #3 — Titolo: ",
      question: "Tengo `x`?",
      after: " https://x.test/t/3",
    });
  });

  test("domanda assente dal testo, o vuota: null", () => {
    expect(splitQuestionText("Testo", "Altro?")).toBeNull();
    expect(splitQuestionText("Testo", "  ")).toBeNull();
    expect(splitQuestionText("Testo", undefined)).toBeNull();
  });
});
