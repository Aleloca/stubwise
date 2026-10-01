import { describe, it as test, expect } from "vitest";
import { t, languageName, catalogs } from "./index.js";
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

describe("correzioni post-PR", () => {
  test("interpola l'URL della PR nel commento della correzione, in entrambe le lingue", () => {
    expect(t("it", "comment.correctionApplied", { url: "https://x/pull/3" })).toBe(
      "Correzioni pushate sulla pull request: https://x/pull/3",
    );
    expect(t("en", "comment.correctionApplied", { url: "https://x/pull/3" })).toBe(
      "Corrections pushed to the pull request: https://x/pull/3",
    );
  });

  test("le descrizioni dello status di commit restano sotto i 140 caratteri (limite GitHub)", () => {
    const keys = [
      "commitStatus.reviewing",
      "commitStatus.correcting",
      "commitStatus.approved",
      "commitStatus.changesRequested",
      "commitStatus.correctionFailed",
      "commitStatus.reviewFailed",
    ];
    for (const lang of ["it", "en"] as const) {
      for (const key of keys) {
        const text = t(lang, key);
        // `t` torna la CHIAVE se manca il testo: senza questa riga una chiave
        // dimenticata passerebbe il controllo di lunghezza.
        expect(text).not.toBe(key);
        expect(text.length).toBeLessThanOrEqual(140);
      }
    }
  });
});

describe("ripiego della review senza verdetto", () => {
  test("una riga per categoria, in entrambe le lingue, senza segnaposto", () => {
    const expected = {
      en: {
        permissions: "Verdict not submitted: the reviewer account does not have the required permissions.",
        network: "Verdict not submitted: the reviewer account could not be reached.",
        other: "Verdict not submitted: provider error.",
      },
      it: {
        permissions: "Verdetto non apposto: l'account revisore non ha i permessi.",
        network: "Verdetto non apposto: l'account revisore non è raggiungibile.",
        other: "Verdetto non apposto: errore del provider.",
      },
    } as const;
    for (const lang of ["en", "it"] as const) {
      for (const reason of ["permissions", "network", "other"] as const) {
        expect(t(lang, `comment.reviewVerdictNotSubmitted.${reason}`)).toBe(expected[lang][reason]);
      }
    }
  });
});

describe("Request changes scartato (identità irrisolvibile)", () => {
  test("il titolo porta il numero della PR, in entrambe le lingue", () => {
    expect(t("en", "comment.changesRequestDropped.title", { prNumber: 42 })).toBe(
      "Changes requested on PR #42: no correction was started",
    );
    expect(t("it", "comment.changesRequestDropped.title", { prNumber: 42 })).toBe(
      "Modifiche richieste sulla PR #42: nessuna correzione avviata",
    );
  });

  test("il titolo non ha ALTRI dati variabili oltre al numero della PR", () => {
    // È la riga con cui il server riconosce l'avviso già scritto
    // (isDroppedRequestNotice): un login o una data qui dentro renderebbero
    // ogni avviso diverso dal precedente, e il dedup non tacerebbe mai.
    for (const lang of ["en", "it"] as const) {
      const template = catalogs[lang]["comment.changesRequestDropped.title"]!;
      expect(template.match(/\{(\w+)\}/g)).toEqual(["{prNumber}"]);
      expect(template).not.toContain("\n");
    }
  });
});

describe("Request changes scartato (account senza permesso)", () => {
  test("il titolo porta il numero della PR ed è DIVERSO da quello dell'identità", () => {
    expect(t("en", "comment.changesRequestUntrusted.title", { prNumber: 42 })).toBe(
      "Changes requested on PR #42 by an account without permission: no correction was started",
    );
    expect(t("it", "comment.changesRequestUntrusted.title", { prNumber: 42 })).toBe(
      "Modifiche richieste sulla PR #42 da un account senza permesso: nessuna correzione avviata",
    );
    for (const lang of ["en", "it"] as const) {
      expect(t(lang, "comment.changesRequestUntrusted.title", { prNumber: 42 })).not.toBe(
        t(lang, "comment.changesRequestDropped.title", { prNumber: 42 }),
      );
    }
  });

  test("il titolo non ha ALTRI dati variabili oltre al numero della PR", () => {
    for (const lang of ["en", "it"] as const) {
      const template = catalogs[lang]["comment.changesRequestUntrusted.title"]!;
      expect(template.match(/\{(\w+)\}/g)).toEqual(["{prNumber}"]);
      expect(template).not.toContain("\n");
    }
  });
});

describe("Request changes scartato (permesso non verificabile)", () => {
  test("il titolo porta il numero della PR ed è DIVERSO dagli altri due motivi", () => {
    expect(t("en", "comment.changesRequestPermissionUnverifiable.title", { prNumber: 42 })).toBe(
      "Changes requested on PR #42, but the author's permission could not be verified: no correction was started",
    );
    expect(t("it", "comment.changesRequestPermissionUnverifiable.title", { prNumber: 42 })).toBe(
      "Modifiche richieste sulla PR #42, ma il permesso dell'autore non è verificabile: nessuna correzione avviata",
    );
    for (const lang of ["en", "it"] as const) {
      const title = t(lang, "comment.changesRequestPermissionUnverifiable.title", { prNumber: 42 });
      expect(title).not.toBe(t(lang, "comment.changesRequestDropped.title", { prNumber: 42 }));
      expect(title).not.toBe(t(lang, "comment.changesRequestUntrusted.title", { prNumber: 42 }));
    }
  });

  test("il titolo non ha ALTRI dati variabili oltre al numero della PR", () => {
    for (const lang of ["en", "it"] as const) {
      const template = catalogs[lang]["comment.changesRequestPermissionUnverifiable.title"]!;
      expect(template.match(/\{(\w+)\}/g)).toEqual(["{prNumber}"]);
      expect(template).not.toContain("\n");
    }
  });
});
