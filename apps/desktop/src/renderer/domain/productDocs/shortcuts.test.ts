import { describe, expect, it } from "vitest";
import { filterSlashItems, SLASH_ITEMS, typeShortcut } from "./shortcuts";

describe("typeShortcut", () => {
  it.each([
    ["# Titolo", { type: "heading", level: 1, rest: "Titolo" }],
    ["## Due", { type: "heading", level: 2, rest: "Due" }],
    ["### ", { type: "heading", level: 3, rest: "" }],
    ["- voce", { type: "bullet", rest: "voce" }],
    ["* voce", { type: "bullet", rest: "voce" }],
    ["1. primo", { type: "numbered", rest: "primo" }],
    ["[] fare", { type: "todo", rest: "fare" }],
    ["> detto", { type: "quote", rest: "detto" }],
    ["---", { type: "divider", rest: "" }],
  ])("%s", (text, expected) => {
    expect(typeShortcut(text)).toEqual(expected);
  });

  it.each(["#Titolo", "Totale #1", "", "testo", "-voce", "#### quattro", "--"])("%s → null", (text) => {
    expect(typeShortcut(text)).toBeNull();
  });
});

// Le etichette vere (chiavi `productDocs.editor.slash.*`) arrivano nel Task 8:
// qui una funzione finta con le parole dello shape, en e it.
const WORDS: Record<string, { en: string; it: string }> = {
  heading1: { en: "Heading 1", it: "Titolo 1" },
  heading2: { en: "Heading 2", it: "Titolo 2" },
  heading3: { en: "Heading 3", it: "Titolo 3" },
  paragraph: { en: "Text", it: "Testo" },
  bullet: { en: "Bulleted list", it: "Elenco puntato" },
  numbered: { en: "Numbered list", it: "Elenco numerato" },
  todo: { en: "To-do list", it: "Lista di controllo" },
  quote: { en: "Quote", it: "Citazione" },
  divider: { en: "Divider", it: "Separatore" },
  table: { en: "Table", it: "Tabella" },
  image: { en: "Image", it: "Immagine" },
  drive: { en: "Drive file", it: "File del Drive" },
  link: { en: "Link to…", it: "Collega a…" },
  decision: { en: "Decision", it: "Decisione" },
};
const label = (lang: "en" | "it") => (key: string) => {
  const id = key.split(".").pop() ?? "";
  const w = WORDS[id];
  if (!w) throw new Error(`chiave sconosciuta ${key}`);
  return w[lang];
};

describe("filterSlashItems", () => {
  it("le voci nell'ordine dello shape, con le chiavi dell'editor", () => {
    expect(SLASH_ITEMS.map((i) => i.id)).toEqual([
      "heading1",
      "heading2",
      "heading3",
      "paragraph",
      "bullet",
      "numbered",
      "todo",
      "quote",
      "divider",
      "table",
      "image",
      "drive",
      "link",
      "decision",
    ]);
    expect(SLASH_ITEMS.every((i) => i.labelKey === `productDocs.editor.slash.${i.id}`)).toBe(true);
  });

  it("«tab» trova la tabella, in en e in it", () => {
    expect(filterSlashItems("tab", label("en")).map((i) => i.id)).toEqual(["table"]);
    expect(filterSlashItems("tab", label("it")).map((i) => i.id)).toEqual(["table"]);
  });

  it("«tit» in it trova i tre titoli; maiuscole e spazi non contano", () => {
    expect(filterSlashItems("tit", label("it")).map((i) => i.id)).toEqual(["heading1", "heading2", "heading3"]);
    expect(filterSlashItems("  TIT ", label("it")).map((i) => i.id)).toEqual(["heading1", "heading2", "heading3"]);
  });

  it("«/image», «/drive», «/link», «/decision» (i nomi dello shape) trovano la loro voce anche in it (Task 9)", () => {
    for (const id of ["image", "drive", "link", "decision"] as const)
      for (const lang of ["en", "it"] as const)
        expect(filterSlashItems(id, label(lang)).map((i) => i.id)).toEqual([id]);
  });

  it("le parole chiave: «h2» trova il titolo 2", () => {
    expect(filterSlashItems("h2", label("en")).map((i) => i.id)).toEqual(["heading2"]);
  });

  it("stringa vuota: tutte, nell'ordine; niente che corrisponde: nessuna", () => {
    expect(filterSlashItems("", label("en"))).toEqual([...SLASH_ITEMS]);
    expect(filterSlashItems("xyz", label("en"))).toEqual([]);
  });
});

describe("SLASH_ITEMS: i gruppi dello shape (§3.4)", () => {
  it("TEXT fino al separatore, INSERT da «table»: ogni voce dice il suo gruppo", () => {
    expect(SLASH_ITEMS.map((i) => `${i.group}:${i.id}`)).toEqual([
      "text:heading1",
      "text:heading2",
      "text:heading3",
      "text:paragraph",
      "text:bullet",
      "text:numbered",
      "text:todo",
      "text:quote",
      "text:divider",
      "insert:table",
      "insert:image",
      "insert:drive",
      "insert:link",
      "insert:decision",
    ]);
  });
});
