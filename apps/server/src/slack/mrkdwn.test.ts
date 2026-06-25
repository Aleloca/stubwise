import { describe, expect, it } from "vitest";
import { markdownToMrkdwn, mrkdwnSections } from "./mrkdwn.js";

describe("markdownToMrkdwn", () => {
  it("converte i heading in righe grassetto", () => {
    expect(markdownToMrkdwn("## Come lavorano")).toBe("*Come lavorano*");
    expect(markdownToMrkdwn("# Titolo")).toBe("*Titolo*");
  });

  it("converte il grassetto ** ** e __ __ in *", () => {
    expect(markdownToMrkdwn("testo **importante** qui")).toBe("testo *importante* qui");
    expect(markdownToMrkdwn("__forte__")).toBe("*forte*");
  });

  it("converte i bullet in •", () => {
    expect(markdownToMrkdwn("- primo\n- secondo")).toBe("• primo\n• secondo");
    expect(markdownToMrkdwn("* item")).toBe("• item");
  });

  it("converte i link markdown in <url|testo>", () => {
    expect(markdownToMrkdwn("vedi [la pagina](https://x.test/a)")).toBe(
      "vedi <https://x.test/a|la pagina>",
    );
  });

  it("rimuove le righe orizzontali", () => {
    expect(markdownToMrkdwn("uno\n\n---\n\ndue")).toBe("uno\n\ndue");
  });

  it("preserva il codice inline e i blocchi di codice", () => {
    expect(markdownToMrkdwn("lo strumento `run_sql` gira")).toBe("lo strumento `run_sql` gira");
    expect(markdownToMrkdwn("```\ncode **non** convertito\n```")).toContain(
      "code **non** convertito",
    );
  });

  it("converte il barrato", () => {
    expect(markdownToMrkdwn("~~vecchio~~")).toBe("~vecchio~");
  });

  it("esempio realistico (heading + bold + bullet + hr)", () => {
    const md = "## Cosa fanno\n- Leggono i **dati**\n- Producono `grafici`\n\n---\n\nFine.";
    expect(markdownToMrkdwn(md)).toBe(
      "*Cosa fanno*\n• Leggono i *dati*\n• Producono `grafici`\n\nFine.",
    );
  });
});

describe("mrkdwnSections", () => {
  it("ritorna [] per testo vuoto", () => {
    expect(mrkdwnSections("")).toEqual([]);
    expect(mrkdwnSections("   ")).toEqual([]);
  });

  it("un solo blocco se sotto il limite", () => {
    expect(mrkdwnSections("**ciao**")).toEqual(["*ciao*"]);
  });

  it("spezza in più blocchi sopra i 3000 char, su confine di riga", () => {
    const line = "x".repeat(1000);
    const md = Array.from({ length: 5 }, () => line).join("\n"); // ~5000 char
    const sections = mrkdwnSections(md);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(2900);
    // Nessuna perdita di contenuto (a meno dei newline tra i chunk).
    expect(sections.join("\n").replace(/\n/g, "")).toBe(md.replace(/\n/g, ""));
  });
});
