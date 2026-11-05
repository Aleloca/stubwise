import { describe, expect, it } from "vitest";
import type { RichText } from "../../data/model";
import {
  concatRich,
  deleteRange,
  insertText,
  plain,
  richFromHtml,
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

describe("richFromHtml", () => {
  it("tiene grassetto e corsivo, scarta un link non http(s) e ogni tag", () => {
    const out = richFromHtml('<p><b>One</b> <a href="javascript:x">two</a></p><p><i>Three</i></p>');
    expect(out).toEqual([
      { text: "One two", marks: [{ type: "bold", start: 0, end: 3 }] },
      { text: "Three", marks: [{ type: "italic", start: 0, end: 5 }] },
    ]);
    expect(out.map((r) => r.text).join("")).not.toContain("<");
  });

  it("un incolla vero da Google Docs: segni dagli stili, l'involucro <b> ignorato", () => {
    // Frammento copiato da Google Docs (Chrome): il <b font-weight:normal>
    // esterno avvolge tutto, i segni stanno negli `style` degli <span>.
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-6a1f3c2e-7fff-4b1d-91a0-0c9e5d2b8f11">' +
      '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' +
      '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:700;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Login</span>' +
      '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"> only with </span>' +
      '<a href="https://accounts.google.com" style="text-decoration:none;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#1155cc;background-color:transparent;font-weight:400;font-style:italic;font-variant:normal;text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Google</span></a>' +
      "</p><br>" +
      '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' +
      '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Bills&nbsp;by </span>' +
      '<a href="/relative" style="text-decoration:none;"><span style="font-size:11pt;font-weight:700;font-style:normal;">email</span></a>' +
      '</p></b><br class="Apple-interchange-newline">';
    expect(richFromHtml(html)).toEqual([
      {
        text: "Login only with Google",
        marks: [
          { type: "bold", start: 0, end: 5 },
          { type: "italic", start: 16, end: 22 },
          { type: "link", start: 16, end: 22, href: "https://accounts.google.com" },
        ],
      },
      { text: "Bills by email", marks: [{ type: "bold", start: 9, end: 14 }] },
    ]);
  });

  it("righe separate da <br> sono frasi diverse; script e stili non diventano testo", () => {
    expect(richFromHtml("<div>one<br>two<style>p{}</style><script>x()</script></div>")).toEqual([
      plain("one"),
      plain("two"),
    ]);
  });
});
