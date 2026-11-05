import { describe, expect, it } from "vitest";
import { plain, toggleMark } from "../../../domain/productDocs/richText";
import { applyInput } from "./input";

// Il testo coi segni sotto i `beforeinput` (Task 8): ogni evento passa da
// qui, il DOM non è mai la fonte.

const LOGIN = plain("Login only with Google");
const ev = (inputType: string, data: string | null = null) => ({ inputType, data });

describe("applyInput", () => {
  it("insertText «x» a 3: il testo e il cursore a 4", () => {
    const out = applyInput(LOGIN, { start: 3, end: 3 }, ev("insertText", "x"));
    expect(out).toEqual({ content: plain("Logxin only with Google"), caret: 4 });
  });

  it("insertText con una selezione 0–5 la sostituisce", () => {
    const out = applyInput(LOGIN, { start: 0, end: 5 }, ev("insertText", "Sign-in"));
    expect(out?.content.text).toBe("Sign-in only with Google");
    expect(out?.caret).toBe(7);
  });

  it("insertReplacementText (il correttore) sostituisce come insertText", () => {
    const out = applyInput(plain("Lgin"), { start: 0, end: 4 }, ev("insertReplacementText", "Login"));
    expect(out).toEqual({ content: plain("Login"), caret: 5 });
  });

  it("deleteContentBackward a 0 → null (lo prende editorKey); altrove toglie una lettera", () => {
    expect(applyInput(LOGIN, { start: 0, end: 0 }, ev("deleteContentBackward"))).toBeNull();
    const out = applyInput(LOGIN, { start: 5, end: 5 }, ev("deleteContentBackward"));
    expect(out).toEqual({ content: plain("Logi only with Google"), caret: 4 });
  });

  it("deleteContentBackward non spezza una coppia surrogata", () => {
    const out = applyInput(plain("a😀"), { start: 3, end: 3 }, ev("deleteContentBackward"));
    expect(out).toEqual({ content: plain("a"), caret: 1 });
  });

  it("deleteContentForward: alla fine null, altrove la lettera dopo; una selezione si toglie", () => {
    expect(applyInput(LOGIN, { start: 22, end: 22 }, ev("deleteContentForward"))).toBeNull();
    expect(applyInput(LOGIN, { start: 0, end: 0 }, ev("deleteContentForward"))?.content.text).toBe(
      "ogin only with Google",
    );
    expect(applyInput(LOGIN, { start: 5, end: 10 }, ev("deleteContentForward"))).toEqual({
      content: plain("Login with Google"),
      caret: 5,
    });
  });

  it("deleteWordBackward toglie la parola prima del cursore (e gli spazi in mezzo)", () => {
    expect(applyInput(LOGIN, { start: 11, end: 11 }, ev("deleteWordBackward"))).toEqual({
      content: plain("Login with Google"),
      caret: 6,
    });
    expect(applyInput(LOGIN, { start: 0, end: 0 }, ev("deleteWordBackward"))).toBeNull();
  });

  it("formatBold su 0–5 → bold 0–5, il testo invariato; formatItalic lo stesso", () => {
    const bold = applyInput(LOGIN, { start: 0, end: 5 }, ev("formatBold"));
    expect(bold?.content).toEqual({ text: LOGIN.text, marks: [{ type: "bold", start: 0, end: 5 }] });
    const italic = applyInput(LOGIN, { start: 0, end: 5 }, ev("formatItalic"));
    expect(italic?.content.marks).toEqual([{ type: "italic", start: 0, end: 5 }]);
  });

  it("insertParagraph e insertLineBreak → null (Invio e ⇧Invio li prende editorKey)", () => {
    expect(applyInput(LOGIN, { start: 3, end: 3 }, ev("insertParagraph"))).toBeNull();
    expect(applyInput(LOGIN, { start: 3, end: 3 }, ev("insertLineBreak"))).toBeNull();
  });

  it("un tipo che non è nostro → null", () => {
    expect(applyInput(LOGIN, { start: 3, end: 3 }, ev("insertFromDrop", "x"))).toBeNull();
    expect(applyInput(LOGIN, { start: 3, end: 3 }, ev("historyUndo"))).toBeNull();
  });

  it("scrivere alla fine di un grassetto continua il grassetto", () => {
    const rt = toggleMark(plain("Login"), 0, 5, "bold");
    const out = applyInput(rt, { start: 5, end: 5 }, ev("insertText", "!"));
    expect(out?.content.marks).toEqual([{ type: "bold", start: 0, end: 6 }]);
  });
});
