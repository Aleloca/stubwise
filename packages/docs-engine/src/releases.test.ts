import { describe, expect, it } from "vitest";
import {
  buildReleasePrompt,
  parseReleaseNotes,
  RELEASE_BODY_END_MARKER,
  RELEASE_BODY_START_MARKER,
  RELEASE_END_MARKER,
  RELEASE_SLUGS_END_MARKER,
  RELEASE_SLUGS_START_MARKER,
  RELEASE_START_MARKER,
} from "./releases.js";

/** Costruisce un output ben formato dell'agente di release. */
function buildOutput(opts: {
  significant: string;
  title: string;
  slugs: string[];
  body: string;
}): string {
  return [
    RELEASE_START_MARKER,
    `SIGNIFICANT: ${opts.significant}`,
    `TITLE: ${opts.title}`,
    RELEASE_SLUGS_START_MARKER,
    ...opts.slugs.map((s) => `- ${s}`),
    RELEASE_SLUGS_END_MARKER,
    RELEASE_BODY_START_MARKER,
    opts.body,
    RELEASE_BODY_END_MARKER,
    RELEASE_END_MARKER,
  ].join("\n");
}

describe("buildReleasePrompt", () => {
  it("include file cambiati, subject dei commit e pagine esistenti", () => {
    const prompt = buildReleasePrompt({
      changedFiles: ["apps/web/src/x.ts"],
      commitSubjects: ["feat: nuova capability"],
      existingPages: [{ slug: "overview", title: "Architecture Overview", sourcePath: "src" }],
    });
    expect(prompt).toContain("apps/web/src/x.ts");
    expect(prompt).toContain("feat: nuova capability");
    expect(prompt).toContain("overview :: Architecture Overview :: src");
    expect(prompt).toContain(RELEASE_START_MARKER);
  });

  it("gestisce liste vuote senza rompersi", () => {
    const prompt = buildReleasePrompt({ changedFiles: [], commitSubjects: [], existingPages: [] });
    expect(prompt).toContain("(nessun file)");
    expect(prompt).toContain("(nessun commit)");
    expect(prompt).toContain("(nessuna pagina di documentazione esistente)");
  });
});

describe("parseReleaseNotes", () => {
  it("parsa un output ben formato (significant true)", () => {
    const out = buildOutput({
      significant: "true",
      title: "Nuova ricerca",
      slugs: ["overview", "search"],
      body: "## Aggiunto\n- ricerca full-text",
    });
    const notes = parseReleaseNotes(out);
    expect(notes).not.toBeNull();
    expect(notes?.significant).toBe(true);
    expect(notes?.title).toBe("Nuova ricerca");
    expect(notes?.affectedSlugs).toEqual(["overview", "search"]);
    expect(notes?.body).toContain("ricerca full-text");
  });

  it("significant false è rispettato", () => {
    const out = buildOutput({
      significant: "false",
      title: "Refactor interno",
      slugs: [],
      body: "Refactor senza impatto utente.",
    });
    const notes = parseReleaseNotes(out);
    expect(notes?.significant).toBe(false);
    expect(notes?.affectedSlugs).toEqual([]);
  });

  it("SIGNIFICANT assente → default false (prudente)", () => {
    const out = [
      RELEASE_START_MARKER,
      "TITLE: Senza flag",
      RELEASE_BODY_START_MARKER,
      "Un corpo qualsiasi.",
      RELEASE_BODY_END_MARKER,
      RELEASE_END_MARKER,
    ].join("\n");
    const notes = parseReleaseNotes(out);
    expect(notes?.significant).toBe(false);
    expect(notes?.title).toBe("Senza flag");
  });

  it("TITLE assente → titolo neutro 'Changes'", () => {
    const out = [
      RELEASE_START_MARKER,
      "SIGNIFICANT: true",
      RELEASE_BODY_START_MARKER,
      "Un corpo qualsiasi.",
      RELEASE_BODY_END_MARKER,
      RELEASE_END_MARKER,
    ].join("\n");
    expect(parseReleaseNotes(out)?.title).toBe("Changes");
  });

  it("marcatori mancanti → null", () => {
    expect(parseReleaseNotes("prosa libera senza marcatori")).toBeNull();
  });

  it("body vuoto → null (output non valido)", () => {
    const out = [
      RELEASE_START_MARKER,
      "SIGNIFICANT: true",
      "TITLE: X",
      RELEASE_BODY_START_MARKER,
      RELEASE_BODY_END_MARKER,
      RELEASE_END_MARKER,
    ].join("\n");
    expect(parseReleaseNotes(out)).toBeNull();
  });
});
