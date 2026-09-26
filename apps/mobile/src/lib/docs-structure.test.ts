import type { DocSpace, DocTreeNode, Reader } from "@stubwise/shared";
import { UNKNOWN } from "@stubwise/shared";
import {
  buildDocForest,
  mainDocSpace,
  mergeDocSearchHits,
  releaseCommitFromSlug,
  repoDocTabs,
} from "./docs-structure";

/**
 * La struttura della documentazione nell'app, come sul web («la
 * documentazione nell'app, come sul web», 25 set 2026): funzioni pure, gemelle
 * di quelle del web (`buildForest`, `releaseCommitFromSlug`, `mergeDocs`).
 */
function node(overrides: Partial<Reader<DocTreeNode>> & { id: string }): Reader<DocTreeNode> {
  return {
    slug: overrides.id,
    title: overrides.id,
    kind: "technical",
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    viewCount: 0,
    significant: null,
    ...overrides,
  } as Reader<DocTreeNode>;
}

describe("buildDocForest", () => {
  test("da parentId a una foresta, ordinata per position e poi per titolo, a ogni livello", () => {
    const forest = buildDocForest([
      node({ id: "b", title: "Beta", position: 1 }),
      node({ id: "a", title: "Alfa", position: 1 }),
      node({ id: "z", title: "Zeta", position: 0 }),
      node({ id: "a2", title: "Figlio 2", parentId: "a", position: 2 }),
      node({ id: "a1", title: "Figlio 1", parentId: "a", position: 1 }),
    ]);
    expect(forest.map((n) => n.id)).toEqual(["z", "a", "b"]);
    expect(forest[1]!.children.map((n) => n.id)).toEqual(["a1", "a2"]);
    expect(forest[0]!.children).toEqual([]);
  });

  test("un figlio il cui padre non c'è (fuori categoria) sale alla radice, non sparisce", () => {
    const forest = buildDocForest([node({ id: "orfano", parentId: "altrove" })]);
    expect(forest.map((n) => n.id)).toEqual(["orfano"]);
  });
});

describe("repoDocTabs", () => {
  test("Overview sempre, poi le categorie CON pagine, nell'ordine fisso", () => {
    const tabs = repoDocTabs([
      node({ id: "r", kind: "releases" }),
      node({ id: "f", kind: "functional" }),
      node({ id: "m", kind: "manual" }),
    ]);
    expect(tabs).toEqual(["overview", "functional", "manual", "releases"]);
  });

  test("senza pagine resta solo Overview; un kind sconosciuto non apre una tab", () => {
    expect(repoDocTabs([])).toEqual(["overview"]);
    expect(repoDocTabs([node({ id: "x", kind: UNKNOWN })])).toEqual(["overview"]);
  });

  test("tutte e sei, nell'ordine Overview · Technical · Functional · Product · Manual · Releases", () => {
    const kinds = ["releases", "manual", "product", "functional", "technical"] as const;
    expect(repoDocTabs(kinds.map((kind) => node({ id: kind, kind })))).toEqual([
      "overview",
      "technical",
      "functional",
      "product",
      "manual",
      "releases",
    ]);
  });
});

describe("releaseCommitFromSlug", () => {
  test("il commit breve dallo slug release-YYYYMMDD-HHmm-<sha>", () => {
    expect(releaseCommitFromSlug("release-20260925-1030-abc1234")).toBe("abc1234");
  });

  test("una release di forma diversa (vecchia) non ha commit", () => {
    expect(releaseCommitFromSlug("release-notes-v1")).toBeNull();
    expect(releaseCommitFromSlug("release-20260925-1030-XYZ")).toBeNull();
  });
});

describe("mergeDocSearchHits", () => {
  const hit = (repositoryId: string, slug: string, title = slug) => ({
    slug,
    title,
    kind: "technical" as const,
    snippet: "",
    repositoryId,
    repositorySlug: repositoryId,
    repositoryName: repositoryId,
  });

  test("semantica PRIMA, poi il full-text non già presente; dedup per (repository, slug)", () => {
    const merged = mergeDocSearchHits(
      [hit("r1", "a", "full"), hit("r1", "b"), hit("r2", "a")],
      [{ ...hit("r1", "a", "semantica"), score: 0.9 }, { ...hit("r1", "c"), score: 0.5 }],
    );
    expect(merged.map((m) => `${m.repositoryId}:${m.slug}`)).toEqual(["r1:a", "r1:c", "r1:b", "r2:a"]);
    // A parità di pagina vince la semantica.
    expect(merged[0]!.title).toBe("semantica");
  });
});

describe("mainDocSpace", () => {
  const space = (id: string, pageCount: number) =>
    ({ repositoryId: id, slug: id, name: id, pageCount, lastGenerationAt: null, lastCommitSha: null }) as Reader<DocSpace>;

  test("il repository con più pagine, qualunque sia l'ordine d'ingresso", () => {
    expect(mainDocSpace([space("a", 3), space("b", 12)])?.repositoryId).toBe("b");
    expect(mainDocSpace([space("b", 12), space("a", 3)])?.repositoryId).toBe("b");
  });

  test("nessuno spazio: undefined", () => {
    expect(mainDocSpace([])).toBeUndefined();
  });
});
