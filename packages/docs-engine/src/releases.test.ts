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

  it("con createdPages → blocco 'PAGES CREATED FOR NEW AREAS' presente", () => {
    const prompt = buildReleasePrompt({
      changedFiles: ["admin-app/src/billing/a.ts"],
      commitSubjects: ["feat: billing"],
      existingPages: [],
      createdPages: [{ slug: "billing", title: "Billing" }],
    });
    expect(prompt).toContain("DOCUMENTATION PAGES CREATED FOR NEW AREAS");
    expect(prompt).toContain("billing :: Billing");
  });

  it("senza createdPages → blocco 'PAGES CREATED FOR NEW AREAS' assente", () => {
    const prompt = buildReleasePrompt({
      changedFiles: ["apps/web/src/x.ts"],
      commitSubjects: [],
      existingPages: [],
    });
    expect(prompt).not.toContain("DOCUMENTATION PAGES CREATED FOR NEW AREAS");
  });

  it("gestisce liste vuote senza rompersi", () => {
    const prompt = buildReleasePrompt({ changedFiles: [], commitSubjects: [], existingPages: [] });
    expect(prompt).toContain("(nessun file)");
    expect(prompt).toContain("(nessun commit)");
    expect(prompt).toContain("(nessuna pagina di documentazione esistente)");
  });

  it("senza commitSummaries il prompt è identico a quello con lista vuota (additivo)", () => {
    const base = { changedFiles: ["a.ts"], commitSubjects: ["feat: a"], existingPages: [] };
    const prompt = buildReleasePrompt(base);
    expect(buildReleasePrompt({ ...base, commitSummaries: [] })).toBe(prompt);
    expect(prompt).not.toContain("COMMIT SUMMARIES");
    expect(prompt).not.toContain("LANGUAGE:");
  });

  it("con commitSummaries: subject e riassunto di ogni commit, lingua della documentazione", () => {
    const prompt = buildReleasePrompt({
      changedFiles: ["src/a.ts", "src/b.ts"],
      commitSubjects: ["feat: a", "fix: b"],
      existingPages: [{ slug: "auth", title: "Authentication", sourcePath: "src/auth" }],
      commitSummaries: [
        { sha: "a".repeat(40), subject: "feat: a", summary: "Aggiunge il login.\nSeconda riga." },
        { sha: "b".repeat(40), subject: "fix: b", summary: "Corregge il logout." },
      ],
    });
    expect(prompt).toContain("COMMIT SUMMARIES");
    expect(prompt).toContain(`- aaaaaaa feat: a\n    Aggiunge il login.\n    Seconda riga.`);
    expect(prompt).toContain(`- bbbbbbb fix: b\n    Corregge il logout.`);
    expect(prompt).toContain("SAME language as the existing");
    expect(prompt).toContain("do NOT switch to their language");
    // I file e i subject restano come contesto.
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- fix: b");
  });

  it("oltre 200 riassunti il prompt dichiara quanti commit non sono elencati", () => {
    const commitSummaries = Array.from({ length: 205 }, (_, i) => ({
      sha: String(i).padStart(40, "0"),
      subject: `c${i}`,
      summary: `s${i}`,
    }));
    const prompt = buildReleasePrompt({ changedFiles: [], commitSubjects: [], existingPages: [], commitSummaries });
    expect(prompt).toContain("c199");
    expect(prompt).not.toContain("c200\n");
    expect(prompt).toContain("and 5 more commits not listed");
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
