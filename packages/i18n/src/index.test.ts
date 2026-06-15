import { describe, it as test, expect } from "vitest";
import { t, languageName } from "./index.js";
import { en, it } from "./catalog.js";

describe("t", () => {
  test("interpola i parametri nel template italiano", () => {
    expect(t("it", "comment.prMerged", { url: "https://x/pr/1" })).toBe(
      "PR mergiata: https://x/pr/1 — ticket chiuso automaticamente",
    );
  });

  test("interpola i parametri nel template inglese", () => {
    expect(t("en", "comment.prMerged", { url: "https://x/pr/1" })).toBe(
      "PR merged: https://x/pr/1 — ticket closed automatically",
    );
  });

  test("interpola parametri numerici", () => {
    expect(t("it", "comment.reportFooter", { number: 42 })).toBe(
      "Generato automaticamente da Stubwise AI per il ticket #42.",
    );
  });

  test("ritorna il testo senza modifiche se non ci sono segnaposto", () => {
    expect(t("it", "comment.planApproved")).toBe(
      "Piano approvato — esecuzione in corso",
    );
  });

  test("fa fallback su en se la chiave manca nella lingua richiesta", () => {
    // Simula una chiave presente solo in en: la rimuoviamo temporaneamente da it.
    const key = "comment.fixReady";
    const original = it[key]!;
    delete it[key];
    try {
      expect(t("it", key, { url: "u" })).toBe(t("en", key, { url: "u" }));
    } finally {
      it[key] = original;
    }
  });

  test("ritorna la chiave stessa se manca in entrambe le lingue", () => {
    expect(t("it", "does.not.exist")).toBe("does.not.exist");
  });
});

describe("languageName", () => {
  test('"en" → "English"', () => {
    expect(languageName("en")).toBe("English");
  });
  test('"it" → "Italian"', () => {
    expect(languageName("it")).toBe("Italian");
  });
});

describe("parità delle chiavi", () => {
  test("it ha esattamente le stesse chiavi di en", () => {
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort());
  });

  test("ogni chiave ha gli stessi segnaposto {param} in en e it", () => {
    // Stessa regex usata da `interpolate` in index.ts.
    const placeholders = (text: string): string[] => {
      const tokens = new Set<string>();
      for (const m of text.matchAll(/\{(\w+)\}/g)) tokens.add(m[1]!);
      return [...tokens].sort();
    };
    for (const key of Object.keys(en)) {
      expect(placeholders(it[key] ?? "")).toEqual(placeholders(en[key]!));
    }
  });
});
