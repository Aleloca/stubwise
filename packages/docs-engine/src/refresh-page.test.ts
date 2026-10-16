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

  it("senza i campi del giro notturno il prompt è INVARIATO (byte per byte)", () => {
    const prompt = buildRefreshPagePrompt({
      title: "Auth",
      sourcePath: "src/auth",
      currentBody: "## Login\n\nOTP.",
      changedFiles: ["src/auth/a.ts"],
      commitSubjects: ["feat: a"],
    });
    expect(prompt).toMatchInlineSnapshot(`
      "You are UPDATING ONE existing page of documentation for a software repository after a
      code change. You are running READ-ONLY in the repository working directory, already
      checked out at the UPDATED commit: READ the relevant code to be accurate — ground
      everything in what the code NOW actually does, do not invent.

      Page title: Auth
      Source path documented by this page: src/auth

      CHANGED FILES relevant to this page (read the ones that matter):
      - src/auth/a.ts

      COMMIT SUBJECTS (most recent first), for orientation:
      - feat: a

      CURRENT PAGE BODY (markdown) — delimited below by the CURRENT BODY markers; this is
      what you are updating, it is NOT part of your output:
      ===CURRENT BODY===
      ## Login

      OTP.
      ===END CURRENT BODY===

      YOUR TASK:
      - READ the current code under the source path above (and the relevant changed files)
        to see what the code does NOW.
      - Then UPDATE the page body so it matches the current behaviour, KEEPING the existing
        structure, style, headings and register. Change ONLY what the code change actually
        affected: do NOT rewrite the page wholesale, do NOT change the page title, do NOT
        add or remove sections that the change does not touch.
      - If the existing page is STILL correct (the change did not affect anything this page
        documents), make NO change and emit the no-op marker.

      OUTPUT CONTRACT — obey this EXACTLY. Emit ONE of the two forms below and NOTHING that
      matters outside the markers (any other text is ignored). Each marker stands ALONE on
      its own line.

      1) If the page is still correct and needs no substantive change, emit ONLY this single
         marker line, by itself:
      ===NO CHANGE===

      2) Otherwise, emit the FULL updated markdown body BETWEEN these two markers:
      ===UPDATED PAGE===
      <the full updated markdown body of the page>
      ===END UPDATED PAGE===

      ANTI-META RULES: write ONLY the documentation body. Do NOT save anything to any file,
      do NOT add meta-commentary, preamble or closing remarks such as "here is the updated
      page", "I now have…" or "let me know if…". Do not wrap the body in a code fence and do
      NOT begin the body with a top-level \`#\`/\`##\` page title (the title is rendered
      separately by the UI and would be duplicated)."
    `);
  });

  describe("giro notturno: commitSummaries + readableFiles", () => {
    const nightly = {
      title: "Auth",
      sourcePath: "src/auth",
      currentBody: "## Login\n\nOTP.",
      changedFiles: ["src/auth/a.ts"],
      commitSubjects: ["feat: a"],
      commitSummaries: [
        { sha: "a".repeat(40), subject: "feat: a", summary: "Aggiunge il login.\nSeconda riga." },
      ],
      readableFiles: ["/wt/src/auth/a.ts", "/wt/src/auth/b.ts"],
    };

    it("elenca SOLO i file leggibili e non dice più di leggere tutto sotto il sourcePath", () => {
      const prompt = buildRefreshPagePrompt(nightly);
      expect(prompt).toContain("READ ONLY these files");
      expect(prompt).toContain("- /wt/src/auth/a.ts\n- /wt/src/auth/b.ts");
      expect(prompt).not.toContain("READ the current code under the source path");
      expect(prompt).not.toContain("read the ones that matter");
      expect(prompt).not.toContain("READ the relevant code to be accurate");
      expect(prompt).toContain("at the commit being documented");
    });

    it("riassunti dei commit come fonte, dati non fidati", () => {
      const prompt = buildRefreshPagePrompt(nightly);
      expect(prompt).toContain("COMMIT SUMMARIES");
      expect(prompt).toContain("- aaaaaaa feat: a\n    Aggiunge il login.\n    Seconda riga.");
      expect(prompt).toContain("UNTRUSTED");
    });

    it("la lingua resta quella della pagina, non quella dei riassunti", () => {
      const prompt = buildRefreshPagePrompt(nightly);
      expect(prompt).toContain("SAME language as the CURRENT PAGE BODY");
      expect(prompt).toContain("do NOT switch to their language");
    });

    it("oltre 200 riassunti il prompt dichiara quanti non sono elencati", () => {
      const commitSummaries = Array.from({ length: 203 }, (_, i) => ({
        sha: String(i).padStart(40, "0"),
        subject: `c${i}`,
        summary: `s${i}`,
      }));
      const prompt = buildRefreshPagePrompt({ ...nightly, commitSummaries });
      expect(prompt).toContain("c199");
      expect(prompt).not.toContain("c200\n");
      expect(prompt).toContain("and 3 more commits not listed");
    });

    it("nessun file leggibile: lo dice, e chiede di lavorare dai riassunti", () => {
      const prompt = buildRefreshPagePrompt({ ...nightly, readableFiles: [] });
      expect(prompt).toContain("(no files to read)");
    });
  });
});

