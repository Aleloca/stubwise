import { describe, expect, it } from "vitest";
import { editorKey, pasteBlocks } from "./keys";

// La tastiera dell'editor e l'incolla in blocchi (Task 8, ruling P18 e P41).

const key = (k: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  ...mods,
});
const ctx = (text: string, caret: number, extra: Partial<Parameters<typeof editorKey>[1]> = {}) => ({
  text,
  caret,
  type: "paragraph" as const,
  slashOpen: false,
  ...extra,
});
const LOGIN = "Login only with Google";

describe("editorKey", () => {
  it("Invio a metà → split con l'offset", () => {
    expect(editorKey(key("Enter"), ctx(LOGIN, 10))).toEqual({ kind: "split", offset: 10 });
  });

  it("Invio con il menu «/» aperto → none (lo prende il menu)", () => {
    expect(editorKey(key("Enter"), ctx("/tab", 4, { slashOpen: true }))).toEqual({ kind: "none" });
  });

  it("P41: Invio su un elemento d'elenco vuoto → toParagraph; non vuoto → split", () => {
    expect(editorKey(key("Enter"), ctx("", 0, { type: "bullet" }))).toEqual({ kind: "toParagraph" });
    expect(editorKey(key("Enter"), ctx("", 0, { type: "numbered" }))).toEqual({ kind: "toParagraph" });
    expect(editorKey(key("Enter"), ctx("", 0, { type: "todo" }))).toEqual({ kind: "toParagraph" });
    expect(editorKey(key("Enter"), ctx("x", 1, { type: "bullet" }))).toEqual({ kind: "split", offset: 1 });
    // Un paragrafo vuoto si divide (una riga nuova sotto).
    expect(editorKey(key("Enter"), ctx("", 0))).toEqual({ kind: "split", offset: 0 });
  });

  it("⇧Invio → a capo nello stesso blocco", () => {
    expect(editorKey(key("Enter", { shiftKey: true }), ctx(LOGIN, 3))).toEqual({ kind: "lineBreak" });
  });

  it("Backspace a 0 → mergeWithPrevious, altrove none; con una selezione none", () => {
    expect(editorKey(key("Backspace"), ctx(LOGIN, 0))).toEqual({ kind: "mergeWithPrevious" });
    expect(editorKey(key("Backspace"), ctx(LOGIN, 4))).toEqual({ kind: "none" });
    expect(editorKey(key("Backspace"), ctx(LOGIN, 0, { collapsed: false }))).toEqual({ kind: "none" });
  });

  it("P41: ↑ solo a 0 e ↓ solo alla fine del testo cambiano blocco", () => {
    expect(editorKey(key("ArrowUp"), ctx(LOGIN, 0))).toEqual({ kind: "focusPrevious" });
    expect(editorKey(key("ArrowUp"), ctx(LOGIN, 4))).toEqual({ kind: "none" });
    expect(editorKey(key("ArrowDown"), ctx(LOGIN, LOGIN.length))).toEqual({ kind: "focusNext" });
    expect(editorKey(key("ArrowDown"), ctx(LOGIN, 4))).toEqual({ kind: "none" });
    // Col menu «/» aperto le frecce sono del menu.
    expect(editorKey(key("ArrowDown"), ctx("/", 1, { slashOpen: true }))).toEqual({ kind: "none" });
  });

  it("Tab / ⇧Tab rientrano un elenco; fuori da un elenco none", () => {
    expect(editorKey(key("Tab"), ctx("x", 0, { type: "bullet" }))).toEqual({ kind: "indent" });
    expect(editorKey(key("Tab", { shiftKey: true }), ctx("x", 0, { type: "numbered" }))).toEqual({
      kind: "outdent",
    });
    expect(editorKey(key("Tab"), ctx("x", 0))).toEqual({ kind: "none" });
  });

  it("⌥⇧↓ → moveBlock down, ⌥⇧↑ → up", () => {
    expect(editorKey(key("ArrowDown", { altKey: true, shiftKey: true }), ctx(LOGIN, 3))).toEqual({
      kind: "moveBlock",
      dir: "down",
    });
    expect(editorKey(key("ArrowUp", { altKey: true, shiftKey: true }), ctx(LOGIN, 0))).toEqual({
      kind: "moveBlock",
      dir: "up",
    });
  });

  it("⌘B → toggleMark bold, ⌘I → italic (anche Ctrl, e con la maiuscola)", () => {
    expect(editorKey(key("b", { metaKey: true }), ctx(LOGIN, 3))).toEqual({ kind: "toggleMark", mark: "bold" });
    expect(editorKey(key("I", { ctrlKey: true }), ctx(LOGIN, 3))).toEqual({ kind: "toggleMark", mark: "italic" });
  });

  it("⌘K → none: resta la palette", () => {
    expect(editorKey(key("k", { metaKey: true }), ctx(LOGIN, 3))).toEqual({ kind: "none" });
  });

  it("⌘Z → undo, ⇧⌘Z → redo", () => {
    expect(editorKey(key("z", { metaKey: true }), ctx(LOGIN, 3))).toEqual({ kind: "undo" });
    expect(editorKey(key("z", { metaKey: true, shiftKey: true }), ctx(LOGIN, 3))).toEqual({ kind: "redo" });
    expect(editorKey(key("Z", { metaKey: true, shiftKey: true }), ctx(LOGIN, 3))).toEqual({ kind: "redo" });
  });

  it("«/» in un blocco vuoto → openSlash; in un blocco con testo none", () => {
    expect(editorKey(key("/"), ctx("", 0))).toEqual({ kind: "openSlash" });
    expect(editorKey(key("/"), ctx(LOGIN, 3))).toEqual({ kind: "none" });
  });

  it("le lettere → none", () => {
    expect(editorKey(key("a"), ctx(LOGIN, 3))).toEqual({ kind: "none" });
  });
});

describe("pasteBlocks", () => {
  const ids = () => {
    let n = 0;
    return () => `new-${++n}`;
  };

  it("testo: un paragrafo per riga, righe vuote saltate; «- Three» non diventa un elenco", () => {
    const blocks = pasteBlocks({ html: null, text: "One\n\nTwo\n- Three" }, ids());
    expect(blocks).toEqual([
      { id: "new-1", type: "paragraph", content: { text: "One", marks: [] } },
      { id: "new-2", type: "paragraph", content: { text: "Two", marks: [] } },
      { id: "new-3", type: "paragraph", content: { text: "- Three", marks: [] } },
    ]);
  });

  it("testo con a capo di Windows e spazi in coda", () => {
    const blocks = pasteBlocks({ html: null, text: "One\r\n   \r\nTwo  " }, ids());
    expect(blocks.map((b) => ("content" in b ? b.content.text : ""))).toEqual(["One", "Two  "]);
  });

  it("html: «One» grassetto, «Two» senza link (javascript: si scarta); ogni id dal generatore", () => {
    const blocks = pasteBlocks(
      { html: '<p><strong>One</strong></p><p><a href="javascript:x">Two</a></p>', text: "One\nTwo" },
      ids(),
    );
    expect(blocks).toEqual([
      { id: "new-1", type: "paragraph", content: { text: "One", marks: [{ type: "bold", start: 0, end: 3 }] } },
      { id: "new-2", type: "paragraph", content: { text: "Two", marks: [] } },
    ]);
  });

  it("P8: un frammento di Google Docs tiene grassetto e corsivo dallo stile, non l'involucro <b>", () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c4d-7fff-1234-5678-9abcdef01234">' +
      '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-weight:400;font-style:normal;">Login </span>' +
      '<span style="font-size:11pt;font-weight:700;font-style:normal;">only with Google</span></p>' +
      '<p dir="ltr"><span style="font-weight:400;font-style:italic;">no passwords</span></p></b>';
    const blocks = pasteBlocks({ html, text: "Login only with Google\nno passwords" }, ids());
    expect(blocks).toEqual([
      {
        id: "new-1",
        type: "paragraph",
        content: { text: "Login only with Google", marks: [{ type: "bold", start: 6, end: 22 }] },
      },
      { id: "new-2", type: "paragraph", content: { text: "no passwords", marks: [{ type: "italic", start: 0, end: 12 }] } },
    ]);
  });

  it("html vuoto (solo spazi) → si usa il testo", () => {
    const blocks = pasteBlocks({ html: "<p> </p>", text: "Plain" }, ids());
    expect(blocks.map((b) => ("content" in b ? b.content.text : ""))).toEqual(["Plain"]);
  });
});
