import type { DocPageKind, DocSpace, DocTreeNode, Reader } from "@stubwise/shared";
import { UNKNOWN } from "@stubwise/shared";
import { docsKindLabelKey, groupTreeByKind, mainDocSpace } from "./docs-mutations";

function space(overrides: Partial<Reader<DocSpace>> = {}): Reader<DocSpace> {
  return {
    repositoryId: "repo-1",
    slug: "repo-1",
    name: "Repo 1",
    pageCount: 1,
    lastGenerationAt: null,
    lastCommitSha: null,
    ...overrides,
  };
}

function node(overrides: Partial<Reader<DocTreeNode>> = {}): Reader<DocTreeNode> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "a-page",
    title: "A page",
    kind: "technical" as Reader<DocPageKind>,
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    viewCount: 0,
    significant: null,
    ...overrides,
  };
}

describe("mainDocSpace — spazio doc principale di un progetto (Task 18)", () => {
  test("sceglie lo spazio con più pagine", () => {
    const spaces = [space({ repositoryId: "a", pageCount: 3 }), space({ repositoryId: "b", pageCount: 12 })];
    expect(mainDocSpace(spaces)?.repositoryId).toBe("b");
  });

  test("lista vuota → undefined", () => {
    expect(mainDocSpace([])).toBeUndefined();
  });

  // Mutazione da rompere apposta: se `mainDocSpace` prendesse il PRIMO spazio
  // invece di ordinare per pageCount, questo test morirebbe (lo spazio "a"
  // arriva prima in lista ma ha meno pagine).
  test("l'ordine in ingresso non conta, solo pageCount", () => {
    const spaces = [space({ repositoryId: "a", pageCount: 1 }), space({ repositoryId: "b", pageCount: 2 })];
    expect(mainDocSpace(spaces)?.repositoryId).toBe("b");
  });
});

describe("groupTreeByKind — i tre gruppi di «Oppure sfoglia» (Task 18, canvas 3f)", () => {
  test("conta le pagine functional/technical, ed espone l'ultima release", () => {
    const nodes = [
      node({ id: "1", kind: "functional" as Reader<DocPageKind>, title: "Guida A" }),
      node({ id: "2", kind: "functional" as Reader<DocPageKind>, title: "Guida B" }),
      node({ id: "3", kind: "technical" as Reader<DocPageKind>, title: "Tecnica A" }),
      node({
        id: "4",
        kind: "releases" as Reader<DocPageKind>,
        title: "Vecchia release",
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      node({
        id: "5",
        kind: "releases" as Reader<DocPageKind>,
        title: "Release più recente",
        createdAt: "2026-08-15T00:00:00.000Z",
      }),
      // kind fuori dai tre gruppi mostrati (canvas): non deve comparire da
      // nessuna parte, né contarsi né far fallire il raggruppamento.
      node({ id: "6", kind: "manual" as Reader<DocPageKind> }),
    ];

    const groups = groupTreeByKind(nodes);

    expect(groups.functional.count).toBe(2);
    expect(groups.functional.nodes.map((n) => n.id)).toEqual(["1", "2"]);
    expect(groups.technical.count).toBe(1);
    expect(groups.releases.count).toBe(2);
    // La release più recente (createdAt maggiore), non l'ultima in ordine di lista.
    expect(groups.releases.latest?.title).toBe("Release più recente");
  });

  test("nessuna release → latest è null", () => {
    const groups = groupTreeByKind([node({ kind: "technical" as Reader<DocPageKind> })]);
    expect(groups.releases.count).toBe(0);
    expect(groups.releases.latest).toBeNull();
  });

  // Un kind Unknown (server più nuovo di questa build, vedi
  // packages/shared/src/reader.ts) non deve far esplodere il raggruppamento:
  // semplicemente non entra in nessuno dei tre gruppi mostrati.
  test("un kind Unknown viene ignorato, non fa fallire il raggruppamento", () => {
    const groups = groupTreeByKind([node({ kind: UNKNOWN as Reader<DocPageKind> })]);
    expect(groups.functional.count).toBe(0);
    expect(groups.technical.count).toBe(0);
    expect(groups.releases.count).toBe(0);
  });
});

describe("docsKindLabelKey — etichetta i18n di un kind (Reader-aperto)", () => {
  test.each([
    ["technical", "mobile.docs.kind.technical"],
    ["functional", "mobile.docs.kind.functional"],
    ["product", "mobile.docs.kind.product"],
    ["manual", "mobile.docs.kind.manual"],
    ["releases", "mobile.docs.kind.releases"],
  ] as const)("%s → %s", (kind, key) => {
    expect(docsKindLabelKey(kind as Reader<DocPageKind>)).toBe(key);
  });

  test("un kind Unknown ritorna la chiave di fallback, mai un crash", () => {
    expect(docsKindLabelKey(UNKNOWN as Reader<DocPageKind>)).toBe("mobile.docs.kind.unknown");
  });
});
