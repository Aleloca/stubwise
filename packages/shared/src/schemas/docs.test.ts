import { describe, expect, it } from "vitest";
import { docPageKindSchema } from "./docs.js";

describe("docPageKindSchema", () => {
  it("accetta i kind autogenerati e curati esistenti", () => {
    for (const kind of ["technical", "functional", "manual", "releases"] as const) {
      expect(docPageKindSchema.parse(kind)).toBe(kind);
    }
  });

  it("accetta il kind 'product' (verticali pubbliche per superficie)", () => {
    expect(docPageKindSchema.parse("product")).toBe("product");
  });

  it("rifiuta un kind sconosciuto", () => {
    expect(() => docPageKindSchema.parse("marketing")).toThrow();
  });
});

import {
  docBriefResponseSchema,
  projectDocsSearchResultSchema,
  projectHighlightsSchema,
  repoHighlightsSchema,
} from "./docs.js";
import { readerSchema, UNKNOWN } from "../reader.js";

/**
 * Gli schemi delle risposte che l'app legge per la documentazione («la
 * documentazione nell'app, come sul web», 25 set 2026). Erano scritti solo nel
 * server (`docs-highlights.ts`, dentro la rotta del brief, `project-docs.ts`):
 * spostati qui SENZA cambiarne la forma — i test del server passano intatti.
 */
const REPO_ID = "11111111-1111-4111-8111-111111111111";

describe("repoHighlightsSchema", () => {
  const response = {
    countsByKind: { technical: 3, functional: 2, product: 0, manual: 1, releases: 4 },
    topViewed: [{ slug: "api", title: "API", kind: "technical", viewCount: 12 }],
    recentlyUpdated: [{ slug: "guida", title: "Guida", kind: "functional", viewCount: 0 }],
    latestReleases: [
      { slug: "release-20260925-1030-abc1234", title: "Rilascio", createdAt: "2026-09-25T10:30:00.000Z", significant: null, commitSha: null },
    ],
  };

  it("parsa una risposta completa", () => {
    expect(repoHighlightsSchema.parse(response)).toEqual(response);
  });

  it("un kind nuovo arriva all'app come UNKNOWN, non fa fallire la risposta", () => {
    const parsed = readerSchema(repoHighlightsSchema).parse({
      ...response,
      topViewed: [{ slug: "x", title: "X", kind: "diagrams", viewCount: 1 }],
    });
    expect(parsed.topViewed[0]?.kind).toBe(UNKNOWN);
  });
});

describe("projectHighlightsSchema", () => {
  const base = {
    countsByKind: { technical: 0, functional: 0, product: 0, manual: 0, releases: 1 },
    topViewed: [
      { slug: "api", title: "API", kind: "technical", viewCount: 3, repositoryId: REPO_ID, repositorySlug: "web", repositoryName: "Web" },
    ],
    latestReleases: [
      {
        slug: "release-20260925-1030-abc1234",
        title: "Rilascio",
        createdAt: "2026-09-25T10:30:00.000Z",
        significant: true,
        commitSha: null,
        repositoryId: REPO_ID,
        repositorySlug: "web",
        repositoryName: "Web",
      },
    ],
  };

  it("latestDecisions è opzionale: un server più vecchio non la manda", () => {
    expect(projectHighlightsSchema.parse(base)).toEqual(base);
  });
});

describe("docBriefResponseSchema", () => {
  it("parsa il brief con la generazione e le esclusioni", () => {
    const response = {
      brief: {
        identity: "Un gestionale.",
        actors: [],
        surfaces: [],
        glossary: [],
        invariants: [],
        confidentialFacts: [],
        journeys: [],
        existingSources: [],
      },
      generation: { createdAt: "2026-09-25T10:30:00.000Z", commitSha: null },
      productExclusions: [],
    };
    expect(docBriefResponseSchema.parse(response).generation.commitSha).toBeNull();
  });
});

describe("projectDocsSearchResultSchema", () => {
  it("un risultato porta il repository d'origine", () => {
    const hit = {
      slug: "api",
      title: "API",
      kind: "technical",
      snippet: "…",
      score: 0.8,
      source: "hybrid",
      repositoryId: REPO_ID,
      repositorySlug: "web",
      repositoryName: "Web",
    };
    expect(projectDocsSearchResultSchema.parse(hit)).toEqual(hit);
  });
});
