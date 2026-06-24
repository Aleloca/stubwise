import { describe, expect, it } from "vitest";
import {
  buildRefreshPagePrompt,
  parseRefreshedPage,
  REFRESH_NO_CHANGE_MARKER,
  REFRESH_UPDATED_END_MARKER,
  REFRESH_UPDATED_START_MARKER,
} from "./refresh-page.js";

/** Costruisce un output ben formato con un blocco UPDATED PAGE. */
function buildUpdatedOutput(body: string): string {
  return [
    REFRESH_UPDATED_START_MARKER,
    body,
    REFRESH_UPDATED_END_MARKER,
  ].join("\n");
}

describe("parseRefreshedPage", () => {
  it("UPDATED PAGE con body → updated, body trimmato", () => {
    const out = buildUpdatedOutput("\n  ## Nuovo\n\nIl modulo ora fa X.\n  ");
    expect(parseRefreshedPage(out)).toEqual({
      kind: "updated",
      body: "## Nuovo\n\nIl modulo ora fa X.",
    });
  });

  it("ignora prosa fuori dai marcatori", () => {
    const out = [
      "Here is the updated page:",
      REFRESH_UPDATED_START_MARKER,
      "Corpo aggiornato.",
      REFRESH_UPDATED_END_MARKER,
      "Let me know if…",
    ].join("\n");
    expect(parseRefreshedPage(out)).toEqual({
      kind: "updated",
      body: "Corpo aggiornato.",
    });
  });

  it("NO CHANGE → unchanged", () => {
    expect(parseRefreshedPage(REFRESH_NO_CHANGE_MARKER)).toEqual({
      kind: "unchanged",
    });
  });

  it("output malformato (solo testo, niente marcatori) → unchanged (prudente)", () => {
    expect(parseRefreshedPage("La pagina sembra ancora corretta.")).toEqual({
      kind: "unchanged",
    });
  });

  it("output vuoto → unchanged (prudente)", () => {
    expect(parseRefreshedPage("")).toEqual({ kind: "unchanged" });
  });

  it("UPDATED PAGE con body vuoto → unchanged (prudente)", () => {
    const out = buildUpdatedOutput("   \n  \n ");
    expect(parseRefreshedPage(out)).toEqual({ kind: "unchanged" });
  });

  it("solo marcatore di apertura (blocco non chiuso) → unchanged (prudente)", () => {
    const out = [REFRESH_UPDATED_START_MARKER, "Corpo senza chiusura."].join("\n");
    expect(parseRefreshedPage(out)).toEqual({ kind: "unchanged" });
  });
});

describe("buildRefreshPagePrompt", () => {
  it("include titolo, sourcePath, currentBody e i file cambiati", () => {
    const prompt = buildRefreshPagePrompt({
      title: "Modulo di refresh",
      sourcePath: "packages/docs-engine/src/refresh-page.ts",
      currentBody: "## Sezione\n\nDescrizione attuale del modulo.",
      changedFiles: ["packages/docs-engine/src/refresh-page.ts"],
      commitSubjects: ["feat: nuovo agente di refresh"],
    });
    expect(prompt).toContain("Modulo di refresh");
    expect(prompt).toContain("packages/docs-engine/src/refresh-page.ts");
    expect(prompt).toContain("Descrizione attuale del modulo.");
    expect(prompt).toContain("feat: nuovo agente di refresh");
    // Il contratto a marcatori deve comparire nel prompt.
    expect(prompt).toContain(REFRESH_NO_CHANGE_MARKER);
    expect(prompt).toContain(REFRESH_UPDATED_START_MARKER);
  });

  it("sourcePath null → mostra un placeholder, non 'null'", () => {
    const prompt = buildRefreshPagePrompt({
      title: "Overview",
      sourcePath: null,
      currentBody: "Indice dell'area.",
      changedFiles: [],
      commitSubjects: [],
    });
    expect(prompt).toContain("(none)");
    expect(prompt).not.toContain(": null");
  });
});
