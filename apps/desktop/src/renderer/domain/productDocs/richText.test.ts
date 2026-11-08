import { describe, expect, it } from "vitest";
import type { RichText } from "../../data/model";
import {
  concatRich,
  deleteRange,
  insertText,
  plain,
  richSegments,
  safeLinkHref,
  setLink,
  splitRich,
  toggleMark,
} from "./richText";

const LOGIN = "Login only with Google";

describe("safeLinkHref", () => {
  // La stessa tabella di `src/main/security.test.ts` (`isExternalOpenAllowed`),
  // più i casi del piano: le due regole stanno ai due lati del confine di
  // processo e devono dire la stessa cosa.
  const allowed = ["https://stubwise.dev", "http://example.com", "https://acq.example/bills", "http://x.it"];
  const refused = [
    "file:///etc/passwd",
    "smb://host/share",
    "nonsense",
    "javascript:alert(1)",
    "JavaScript:x",
    "file:///etc",
    "data:text/html,x",
    "/bills",
    "acq.example",
  ];

  it.each(allowed)("%s passa, così com'è", (href) => {
    expect(safeLinkHref(href)).toBe(href);
  });

  it.each(refused)("%s si rifiuta", (href) => {
    expect(safeLinkHref(href)).toBeNull();
  });
});

describe("toggleMark", () => {
  it("mette il grassetto, lo toglie, e lo fonde con uno vicino", () => {
    const once = toggleMark(plain(LOGIN), 11, 22, "bold");
    expect(once.marks).toEqual([{ type: "bold", start: 11, end: 22 }]);
    expect(toggleMark(once, 11, 22, "bold").marks).toEqual([]);
    expect(toggleMark(once, 0, 15, "bold").marks).toEqual([{ type: "bold", start: 0, end: 22 }]);
  });

  it("un intervallo vuoto non cambia niente", () => {
    expect(toggleMark(plain(LOGIN), 4, 4, "italic").marks).toEqual([]);
  });

  it("togliere da una parte sola di un segno lo divide", () => {
    const bold = toggleMark(plain(LOGIN), 0, 22, "bold");
    expect(toggleMark(bold, 6, 10, "bold").marks).toEqual([
      { type: "bold", start: 0, end: 6 },
      { type: "bold", start: 10, end: 22 },
    ]);
  });
});

describe("insertText e deleteRange", () => {
  const bold = toggleMark(plain(LOGIN), 11, 22, "bold");

  it("dentro il grassetto lo allarga, prima lo sposta", () => {
    expect(insertText(bold, 15, "XX").marks).toEqual([{ type: "bold", start: 11, end: 24 }]);
    expect(insertText(bold, 22, "!").marks).toEqual([{ type: "bold", start: 11, end: 23 }]);
    const before = insertText(bold, 0, "Hi ");
    expect(before.text).toBe(`Hi ${LOGIN}`);
    expect(before.marks).toEqual([{ type: "bold", start: 14, end: 25 }]);
  });

  it("alla fine di un link non lo allarga, dentro sì", () => {
    const linked = setLink(plain(LOGIN), 16, 22, "https://accounts.google.com");
    expect(insertText(linked, 22, " now").marks).toEqual([
      { type: "link", start: 16, end: 22, href: "https://accounts.google.com" },
    ]);
    expect(insertText(linked, 18, "o").marks).toEqual([
      { type: "link", start: 16, end: 23, href: "https://accounts.google.com" },
    ]);
  });

  it("su metà di un segno lo accorcia, su tutto lo toglie", () => {
    const half = deleteRange(bold, 15, 22);
    expect(half.text).toBe("Login only with");
    expect(half.marks).toEqual([{ type: "bold", start: 11, end: 15 }]);
    const all = deleteRange(bold, 10, 22);
    expect(all.text).toBe("Login only");
    expect(all.marks).toEqual([]);
  });

  it("i segni dopo la cancellazione si spostano indietro", () => {
    expect(deleteRange(bold, 0, 6).marks).toEqual([{ type: "bold", start: 5, end: 16 }]);
  });
});

describe("setLink", () => {
  it("un indirizzo non http(s) lancia `invalid: href`", () => {
    expect(() => setLink(plain(LOGIN), 0, 5, "javascript:alert(1)")).toThrow("invalid: href");
  });

  it("null toglie il link, un link nuovo sostituisce il vecchio", () => {
    const linked = setLink(plain(LOGIN), 16, 22, "https://a.example");
    expect(setLink(linked, 16, 22, null).marks).toEqual([]);
    expect(setLink(linked, 16, 22, "https://b.example").marks).toEqual([
      { type: "link", start: 16, end: 22, href: "https://b.example" },
    ]);
  });
});

describe("splitRich e concatRich", () => {
  it("a metà di un corsivo il corsivo resta in entrambe le parti", () => {
    const it_ = toggleMark(plain(LOGIN), 6, 15, "italic");
    const [a, b] = splitRich(it_, 10);
    expect(a).toEqual({ text: "Login only", marks: [{ type: "italic", start: 6, end: 10 }] });
    expect(b).toEqual({ text: " with Google", marks: [{ type: "italic", start: 0, end: 5 }] });
  });

  it("concatRich scala i segni del secondo", () => {
    const b = toggleMark(plain("with Google"), 0, 11, "bold");
    expect(concatRich(plain("Login only"), b)).toEqual({
      text: "Login onlywith Google",
      marks: [{ type: "bold", start: 10, end: 21 }],
    });
  });

  it("due grassetti che si toccano al punto d'unione diventano uno", () => {
    const a = toggleMark(plain("ab"), 0, 2, "bold");
    expect(concatRich(a, a).marks).toEqual([{ type: "bold", start: 0, end: 4 }]);
  });
});

describe("richSegments", () => {
  it("un codice è un pezzo a sé coi segni del suo intervallo; il link tiene l'indirizzo", () => {
    let rt: RichText = plain("See ACQ-14 at site");
    rt = toggleMark(rt, 4, 10, "bold");
    rt = setLink(rt, 14, 18, "https://acq.example");
    expect(richSegments(rt)).toEqual([
      { text: "See ", bold: false, italic: false, href: null, code: null },
      { text: "ACQ-14", bold: true, italic: false, href: null, code: "ACQ-14" },
      { text: " at ", bold: false, italic: false, href: null, code: null },
      { text: "site", bold: false, italic: false, href: "https://acq.example", code: null },
    ]);
  });

  it("i codici di pagina e di task in testo semplice", () => {
    expect(richSegments(plain("See ACQ-14 and ACQ-D31.")).map((s) => [s.text, s.code])).toEqual([
      ["See ", null],
      ["ACQ-14", "ACQ-14"],
      [" and ", null],
      ["ACQ-D31", "ACQ-D31"],
      [".", null],
    ]);
  });

  it("una frase vuota non ha pezzi", () => {
    expect(richSegments(plain(""))).toEqual([]);
  });
});
