import i18n from "i18next";
import { describe, expect, it } from "vitest";
import "../i18n";
import { spoken } from "./claude/answers";
import { nameList } from "./names";

// Un elenco di nomi, una funzione sola (area 10b, Task 7; minore T5 e M6 del
// 10a): la frase sopra la scheda e la riga «Notifies» dicono le stesse
// persone nello stesso modo.

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");
const NAMES = ["Marco Bellini", "Laura Costa", "Giulia Ferri", "Sara Montanari", "Luca Bianchi"];

describe("nameList", () => {
  it("in en: uno, due, tre e oltre il tetto", () => {
    expect(nameList(en, [])).toBe("");
    expect(nameList(en, NAMES.slice(0, 1))).toBe("Marco Bellini");
    expect(nameList(en, NAMES.slice(0, 2))).toBe("Marco Bellini and Laura Costa");
    expect(nameList(en, NAMES.slice(0, 3))).toBe("Marco Bellini, Laura Costa and Giulia Ferri");
    expect(nameList(en, NAMES)).toBe("Marco Bellini, Laura Costa, Giulia Ferri and 2 more");
    expect(nameList(en, NAMES.slice(0, 4))).toBe(
      "Marco Bellini, Laura Costa, Giulia Ferri and 1 more",
    );
  });

  it("in it, e con un tetto diverso", () => {
    expect(nameList(it_, NAMES.slice(0, 2))).toBe("Marco Bellini e Laura Costa");
    expect(nameList(it_, NAMES.slice(0, 3))).toBe("Marco Bellini, Laura Costa e Giulia Ferri");
    expect(nameList(it_, NAMES)).toBe("Marco Bellini, Laura Costa, Giulia Ferri e altre 2");
    expect(nameList(it_, NAMES.slice(0, 4))).toBe(
      "Marco Bellini, Laura Costa, Giulia Ferri e un'altra persona",
    );
    expect(nameList(en, NAMES, 2)).toBe("Marco Bellini, Laura Costa and 3 more");
  });
});

describe("spoken: una data ISO nei parametri si legge nella lingua di chi guarda", () => {
  it("«last activity: Aug 4» / «ultima attività: 4 ago», mai la stringa grezza", () => {
    const why = { key: "claude.answers.archive.why", params: { date: "2026-08-04T09:30:00Z" } };
    expect(spoken(en, why, "")).toBe("last activity: Aug 4");
    expect(spoken(it_, why, "")).toBe("ultima attività: 4 ago");
    expect(spoken(en, why, "")).not.toContain("2026");
    // Anche una data senza ora.
    expect(spoken(en, { ...why, params: { date: "2026-08-04" } }, "")).toBe(
      "last activity: Aug 4",
    );
  });
});
