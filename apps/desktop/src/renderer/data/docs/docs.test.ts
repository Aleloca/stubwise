import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_SECTIONS } from "../routes";
import {
  docs,
  failNext,
  listDocPages,
  resetApi,
  resolveCitations,
  resolveCodes,
  setLatency,
} from "../api";
import { DOC_PAGES } from "../seed/docPages";
import { REPOSITORIES } from "../seed/docs/repositories";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { DocTreeNode } from "../types";
import { graphJsonOf, overflowingBarItems } from "../../domain/docs";
import { revokeProjectPermission } from "../viewer";

const as = (personId: string) => setSessionPersonId(personId);
const snapshot = () => JSON.stringify({ pages: state.docPages, spaces: state.docSpaces });

async function rejects(p: Promise<unknown>, message: string): Promise<void> {
  const before = snapshot();
  await expect(p).rejects.toThrow(message);
  expect(snapshot()).toBe(before);
}

/** I titoli delle pagine di un albero, in profondità. */
const titles = (nodes: DocTreeNode[]): string[] =>
  nodes.flatMap((n) => (n.page ? [n.page.title] : titles(n.children)));

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-laura");
});

describe("seme dei Docs", () => {
  it("ogni pagina ha un codice <PRJ>-D<n> unico, del suo progetto, e uno slug unico nello spazio", () => {
    const codes = new Set<string>();
    for (const page of DOC_PAGES) {
      const project = state.projectsById.get(page.projectId)!;
      expect(page.code).toMatch(new RegExp(`^${project.code}-D\\d+$`));
      expect(codes.has(page.code)).toBe(false);
      codes.add(page.code);
      const repo = REPOSITORIES.find((r) => r.id === page.repositoryId)!;
      expect(repo.projectId).toBe(page.projectId);
      const sameSlug = DOC_PAGES.filter(
        (p) => p.repositoryId === page.repositoryId && p.slug === page.slug,
      );
      expect(sameSlug).toHaveLength(1);
    }
  });

  it("le pagine citate dalle conversazioni del seme ci sono ancora, coi codici stabili", () => {
    const byId = new Map(DOC_PAGES.map((p) => [p.id, p.code]));
    expect(byId.get("doc-aud-callbacks")).toBe("AUD-D1");
    expect(byId.get("doc-aud-import")).toBe("AUD-D2");
    expect(byId.get("doc-aud-billing")).toBe("AUD-D3");
    expect(byId.get("doc-stw-stalled")).toBe("STW-D1");
    expect(byId.get("doc-stw-planning")).toBe("STW-D2");
    expect(byId.get("doc-stw-notifications")).toBe("STW-D4");
    expect(byId.get("doc-cbv-shipping")).toBe("CBV-D1");
  });

  it("i collegamenti puntano a pagine dello stesso spazio", () => {
    for (const page of DOC_PAGES) {
      for (const link of page.links) {
        const target = DOC_PAGES.find((p) => p.id === link.pageId)!;
        expect(target.repositoryId).toBe(page.repositoryId);
      }
    }
  });
});

describe("spazi e albero", () => {
  it("AUD e STW hanno il loro spazio; STW col grafo pronto, AUD spento e in pausa per limite", async () => {
    const [aud] = await docs.listDocSpaces("prj-aud");
    const [stw] = await docs.listDocSpaces("prj-stw");
    expect(aud!.name).toBe("audin-app");
    expect(stw!.name).toBe("stubwise");
    expect(stw!.graph.status).toBe("ready");
    expect(stw!.graph.nodes).toBeGreaterThan(0);
    expect(aud!.graph.status).toBe("disabled");
    expect(aud!.generation.status).toBe("paused");
    expect(aud!.generation.reason).toBe("usage_limit");
    expect(stw!.generation.status).toBe("succeeded");
    expect(stw!.brief?.identity).toBeTruthy();
    expect(aud!.releases.some((r) => r.minor)).toBe(true);
    expect(aud!.permissions).toEqual({ edit: true, generate: true, manageRepository: true });
  });

  it("CBV ha solo pagine manuali, mai generato", async () => {
    as("p-roberta");
    const [cbv] = await docs.listDocSpaces("prj-cbv");
    expect(cbv!.manualOnly).toBe(true);
    expect(cbv!.generation.status).toBe("never");
  });

  it("un progetto senza il modulo Docs non ha spazi né la sezione", async () => {
    const mkx = state.projectsById.get("prj-mkx")!;
    expect(mkx.modules).not.toContain("docs");
    as("p-giulia");
    expect(await docs.listDocSpaces("prj-mkx")).toEqual([]);
    expect(await docs.getProjectDocsHome("prj-mkx")).toBeNull();
    const sections = PROJECT_SECTIONS.filter(
      (s) => !("module" in s) || mkx.modules.includes(s.module),
    ).map((s) => s.id);
    expect(sections).not.toContain("docs");
  });

  it("un progetto invisibile risponde come uno che non esiste", async () => {
    as("p-sara");
    expect(await docs.listDocSpaces("prj-aud")).toEqual([]);
    expect(await docs.getDocSpace("repo-aud")).toBeNull();
    expect(await docs.getDocSpace("repo-nope")).toBeNull();
    expect(await docs.getDocPage("repo-aud", "scheduled-callbacks")).toBeNull();
    expect(await docs.listDocTree("repo-aud")).toEqual([]);
  });

  it("senza docs.view: forbidden", async () => {
    as("p-giulia");
    revokeProjectPermission("p-giulia", "prj-aud", "docs.view" as never);
    await expect(docs.listDocSpaces("prj-aud")).rejects.toThrow("forbidden");
    await expect(docs.getDocSpace("repo-aud")).rejects.toThrow("forbidden");
    await expect(docs.listDocTree("repo-aud")).rejects.toThrow("forbidden");
    await expect(docs.getDocPage("repo-aud", "scheduled-callbacks")).rejects.toThrow("forbidden");
    await expect(docs.getProjectDocsHome("prj-aud")).rejects.toThrow("forbidden");
    // Le letture trasversali non lo dicono: semplicemente non c'è.
    expect(await listDocPages("prj-aud")).toEqual([]);
    expect((await docs.searchDocs("callback")).some((h) => h.projectCode === "AUD")).toBe(false);
  });

  it("l'albero ha le quattro categorie, con cartelle dal percorso", async () => {
    const tree = await docs.listDocTree("repo-aud");
    expect(tree.map((c) => c.kind)).toEqual(["technical", "functional", "product", "manual"]);
    for (const category of tree) expect(category.count).toBeGreaterThan(0);
    const functional = tree.find((c) => c.kind === "functional")!;
    const guide = functional.nodes.find((n) => n.name === "Guide")!;
    expect(guide.page).toBeNull();
    expect(titles(guide.children)).toContain("Scheduled callbacks");
  });

  it("la pagina iniziale del progetto: identità, inizia da qui, spazi, decisioni, novità", async () => {
    const home = (await docs.getProjectDocsHome("prj-aud"))!;
    expect(home.identity).toBeTruthy();
    expect(home.startHere?.repositoryId).toBe("repo-aud");
    expect(home.spaces.map((s) => s.repositoryId)).toEqual(["repo-aud"]);
    expect(home.decisions.total).toBe(
      state.decisionLog.filter((d) => d.projectId === "prj-aud").length,
    );
    expect(home.whatsNew.length).toBeGreaterThan(0);
    const dates = home.whatsNew.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe("pagine", () => {
  it("una pagina vecchia mostra i commit successivi; i collegamenti si risolvono", async () => {
    const stale = DOC_PAGES.find(
      (p) => p.repositoryId === "repo-aud" && p.staleCommits.length > 0,
    )!;
    const page = (await docs.getDocPage("repo-aud", stale.slug))!;
    expect(page.staleCommits.length).toBeGreaterThan(0);
    const linked = DOC_PAGES.find((p) => p.repositoryId === "repo-aud" && p.links.length > 0)!;
    const view = (await docs.getDocPage("repo-aud", linked.slug))!;
    expect(view.resolvedLinks.length).toBe(linked.links.length);
    expect(view.resolvedLinks[0]!.page.title).toBeTruthy();
    expect(view.permissions).toEqual({ edit: false, delete: false });
  });

  it("una pagina manuale si modifica e si elimina con docs.edit", async () => {
    const manual = DOC_PAGES.find((p) => p.repositoryId === "repo-aud" && p.kind === "manual")!;
    const view = (await docs.getDocPage("repo-aud", manual.slug))!;
    expect(view.permissions).toEqual({ edit: true, delete: true });
    as("p-giulia");
    const asGiulia = (await docs.getDocPage("repo-aud", manual.slug))!;
    expect(asGiulia.permissions).toEqual({ edit: false, delete: false });
  });

  it("pagina che non c'è: null", async () => {
    expect(await docs.getDocPage("repo-aud", "nope")).toBeNull();
  });

  it("crea, modifica, elimina una pagina manuale; il codice nuovo non riusa quelli eliminati", async () => {
    const created = await docs.createManualPage("repo-aud", {
      title: "On-call rota",
      body: "# On-call\n\nWho answers at night.",
      path: "Team",
    });
    expect(created.kind).toBe("manual");
    expect(created.slug).toBe("on-call-rota");
    const max = Math.max(
      ...DOC_PAGES.filter((p) => p.projectId === "prj-aud").map((p) =>
        Number(p.code.split("-D")[1]),
      ),
    );
    expect(created.code).toBe(`AUD-D${max + 1}`);
    const tree = await docs.listDocTree("repo-aud");
    expect(titles(tree.find((c) => c.kind === "manual")!.nodes)).toContain("On-call rota");

    const updated = await docs.updateManualPage(created.id, { title: "Night rota", body: "x" });
    expect(updated.title).toBe("Night rota");
    expect(updated.code).toBe(created.code);
    expect(updated.slug).toBe("on-call-rota");

    await docs.deleteManualPage(created.id);
    expect(await docs.getDocPage("repo-aud", "on-call-rota")).toBeNull();
    const again = await docs.createManualPage("repo-aud", { title: "Another", body: "y" });
    expect(again.code).toBe(`AUD-D${max + 2}`);
  });

  it("gli slug delle viste dello spazio (new, brief, releases, graph) sono riservati", async () => {
    for (const slug of ["new", "brief", "releases", "graph"]) {
      await rejects(
        docs.createManualPage("repo-aud", { title: "X", slug, body: "x" }),
        "slug_conflict",
      );
    }
    await rejects(docs.createManualPage("repo-aud", { title: "New", body: "x" }), "slug_conflict");
  });

  it("slug in conflitto: slug_conflict, niente scritto", async () => {
    const taken = DOC_PAGES.find((p) => p.repositoryId === "repo-aud")!.slug;
    await rejects(
      docs.createManualPage("repo-aud", { title: "X", slug: taken, body: "x" }),
      "slug_conflict",
    );
    const manual = DOC_PAGES.find((p) => p.repositoryId === "repo-aud" && p.kind === "manual")!;
    await rejects(docs.updateManualPage(manual.id, { slug: taken }), "slug_conflict");
  });

  it("senza docs.edit: forbidden; una pagina generata non si modifica", async () => {
    const manual = DOC_PAGES.find((p) => p.repositoryId === "repo-aud" && p.kind === "manual")!;
    const generated = DOC_PAGES.find((p) => p.repositoryId === "repo-aud" && p.kind !== "manual")!;
    as("p-giulia");
    await rejects(docs.createManualPage("repo-aud", { title: "X", body: "x" }), "forbidden");
    await rejects(docs.updateManualPage(manual.id, { title: "Y" }), "forbidden");
    await rejects(docs.deleteManualPage(manual.id), "forbidden");
    as("p-laura");
    await rejects(docs.updateManualPage(generated.id, { title: "Y" }), "invalid");
    await rejects(docs.deleteManualPage(generated.id), "invalid");
    as("p-sara");
    await rejects(docs.deleteManualPage(manual.id), "not_found");
  });

  it("recordDocView alimenta «più lette»", async () => {
    const page = DOC_PAGES.find((p) => p.repositoryId === "repo-aud" && p.views === 0)!;
    for (let i = 0; i < 500; i++) await docs.recordDocView(page.id);
    const space = (await docs.getDocSpace("repo-aud"))!;
    expect(space.mostRead[0]!.id).toBe(page.id);
    expect(space.mostRead[0]!.views).toBe(500);
  });
});

describe("generazione e grafo", () => {
  it("genera: in coda, poi in corso, poi riuscita (col ritardo simulato)", async () => {
    const queued = await docs.startGeneration("repo-stw");
    expect(queued.status).toBe("queued");
    await docs.whenDocsIdle();
    const space = (await docs.getDocSpace("repo-stw"))!;
    expect(space.generation.status).toBe("succeeded");
    expect(space.generation.lastAt).toBeTruthy();
    expect(docs.generationHistory("repo-stw")).toEqual(["queued", "running", "succeeded"]);
  });

  it("riprende una generazione in pausa", async () => {
    const resumed = await docs.resumeGeneration("repo-aud");
    expect(resumed.status).toBe("running");
    await docs.whenDocsIdle();
    const space = (await docs.getDocSpace("repo-aud"))!;
    expect(space.generation.status).toBe("succeeded");
    expect(space.generation.reason).toBeNull();
  });

  it("una generazione che fallisce scrive il motivo", async () => {
    failNext("docs.advanceGeneration");
    await docs.startGeneration("repo-stw");
    await docs.whenDocsIdle();
    const space = (await docs.getDocSpace("repo-stw"))!;
    expect(space.generation.status).toBe("failed");
    expect(space.generation.reason).toBeTruthy();
  });

  it("una generazione già in corso non riparte; resume solo da pausa", async () => {
    await rejects(docs.startGeneration("repo-aud"), "generation_in_progress");
    await rejects(docs.resumeGeneration("repo-stw"), "invalid");
  });

  it("senza docs.generate: forbidden", async () => {
    as("p-giulia");
    await rejects(docs.startGeneration("repo-stw"), "forbidden");
    await rejects(docs.resumeGeneration("repo-aud"), "forbidden");
  });

  it("grafo: generare quello spento lo porta a pronto; rifare da pronto; PR di setup", async () => {
    const queued = await docs.graphAction("repo-aud", "generate");
    expect(queued.status).toBe("queued");
    await docs.whenDocsIdle();
    expect((await docs.getDocSpace("repo-aud"))!.graph.status).toBe("ready");
    const again = await docs.graphAction("repo-stw", "rebuild");
    expect(again.status).toBe("queued");
    await docs.whenDocsIdle();
    expect((await docs.getDocSpace("repo-stw"))!.graph.status).toBe("ready");
    const pr = await docs.graphAction("repo-aud", "setup_pr");
    expect(pr.setupPr?.open).toBe(true);
    as("p-roberta");
    await rejects(docs.graphAction("repo-cbv", "regenerate"), "invalid");
  });

  it("grafo senza repos.manage: forbidden", async () => {
    as("p-giulia");
    await rejects(docs.graphAction("repo-stw", "regenerate"), "forbidden");
  });
});

describe("ricerca e codici", () => {
  it("searchDocs cerca nelle pagine visibili, anche in uno spazio solo", async () => {
    const all = await docs.searchDocs("callback");
    expect(all.some((h) => h.page.code === "AUD-D1")).toBe(true);
    const scoped = await docs.searchDocs("stalled", { repositoryId: "repo-aud" });
    expect(scoped.every((h) => h.page.repositoryId === "repo-aud")).toBe(true);
    expect(await docs.searchDocs("AUD-D2")).toHaveLength(1);
    as("p-sara");
    expect((await docs.searchDocs("callback")).some((h) => h.projectCode === "AUD")).toBe(false);
  });

  it("resolveCodes riconosce <PRJ>-D<n>: link per chi vede, niente per gli altri (R-G5)", async () => {
    as("p-giulia");
    const [view] = await resolveCodes(["AUD-D3"]);
    expect(view).toMatchObject({
      kind: "doc",
      id: "doc-aud-billing",
      visible: true,
      code: "AUD-D3",
      // La citazione porta alla pagina, non alla sola sezione.
      route: "#/p/AUD/docs/audin-app/invoices-and-billing-emails",
    });
    as("p-sara");
    const hidden = await resolveCodes(["AUD-D3"]);
    const unknown = await resolveCodes(["AUD-D999"]);
    expect(hidden).toEqual([]);
    expect(hidden).toEqual(unknown);
  });

  it("una pagina eliminata non si cita più", async () => {
    const created = await docs.createManualPage("repo-aud", { title: "Temp", body: "x" });
    await docs.deleteManualPage(created.id);
    const [view] = await resolveCitations([{ kind: "doc", id: created.id }]);
    expect(view!.visible).toBe(false);
    expect(await resolveCodes([created.code])).toEqual([]);
  });
});

describe("generazione, grafo e chat (Task 3)", () => {
  it("i motivi sono codici (la UI li dice nella lingua di chi guarda), con l'ora di ripresa", async () => {
    const [aud] = await docs.listDocSpaces("prj-aud");
    expect(aud!.generation.reason).toBe("usage_limit");
    expect(aud!.generation.resumesAt).toBeTruthy();
    failNext("docs.advanceGeneration");
    await docs.startGeneration("repo-stw");
    await docs.whenDocsIdle();
    expect((await docs.getDocSpace("repo-stw"))!.generation.reason).toBe("provider_error");
    failNext("docs.advanceGraph");
    await docs.graphAction("repo-aud", "generate");
    await docs.whenDocsIdle();
    const graph = (await docs.getDocSpace("repo-aud"))!.graph;
    expect(graph.status).toBe("failed");
    expect(graph.reason).toBe("graphify_error");
  });

  it("in corso: pagine scritte su un totale stimato; finita, niente avanzamento", async () => {
    await docs.startGeneration("repo-stw");
    // Il primo passo (in coda → in corso) e basta: lo stato si legge a metà.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const running = state.docSpaces.find((s) => s.repositoryId === "repo-stw")!.generation;
    if (running.status === "running") expect(running.progress?.total).toBeGreaterThan(0);
    await docs.whenDocsIdle();
    expect((await docs.getDocSpace("repo-stw"))!.generation.progress ?? null).toBeNull();
  });

  it("un grafo pronto ha le comunità (nomi dell'AI) e il suo graph.json", async () => {
    const stw = (await docs.getDocSpace("repo-stw"))!;
    expect(stw.graph.report?.length).toBeGreaterThan(2);
    expect(stw.graph.report![0]!.name).toBeTruthy();
    expect(stw.graph.updatedAt).toBeTruthy();
    await docs.graphAction("repo-aud", "generate");
    await docs.whenDocsIdle();
    const aud = (await docs.getDocSpace("repo-aud"))!;
    expect(aud.graph.report?.length).toBeGreaterThan(0);
    const json = JSON.parse(graphJsonOf(aud.name, aud.graph)) as { nodes: unknown[] };
    expect(json.nodes.length).toBeGreaterThan(0);
  });

  it("la chat del progetto risponde dai Docs citando la pagina per codice", async () => {
    const answer = await docs.askDocs({
      projectId: "prj-aud",
      question: "How do scheduled callbacks work?",
    });
    expect(answer.text).toContain("AUD-D1");
    expect(answer.refs).toContainEqual({ kind: "doc", id: "doc-aud-callbacks" });
    expect(answer.sources[0]).toMatchObject({
      pageId: "doc-aud-callbacks",
      repositoryName: "audin-app",
    });
  });

  it("la chat del repository cerca solo lì; un tema assente lo dice senza inventare", async () => {
    const none = await docs.askDocs({
      projectId: "prj-stw",
      repositoryId: "repo-stw",
      question: "How do scheduled callbacks work?",
    });
    expect(none.refs).toEqual([]);
    expect(none.text).toMatch(/don't cover/);
  });

  it("chi non vede i Docs non riceve pagine; senza provider la chat non è disponibile", async () => {
    as("p-sara");
    await expect(
      docs.askDocs({ projectId: "prj-aud", question: "scheduled callbacks" }),
    ).rejects.toThrow("not_found");
    as("p-laura");
    expect((await docs.getProjectDocsHome("prj-aud"))!.chatAvailable).toBe(true);
    state.docsChatProvider = null;
    expect((await docs.getProjectDocsHome("prj-aud"))!.chatAvailable).toBe(false);
    expect((await docs.getDocSpace("repo-aud"))!.chatAvailable).toBe(false);
    await expect(
      docs.askDocs({ projectId: "prj-aud", question: "scheduled callbacks" }),
    ).rejects.toThrow("chat_unavailable");
  });

  it("domande suggerite: pagine dello spazio (al più 4)", async () => {
    const aud = (await docs.getDocSpace("repo-aud"))!;
    expect(aud.chatSuggestions.length).toBeGreaterThan(1);
    expect(aud.chatSuggestions.length).toBeLessThanOrEqual(4);
    const home = (await docs.getProjectDocsHome("prj-aud"))!;
    expect(home.chatSuggestions.length).toBeGreaterThan(1);
  });

  it("la barra dello spazio: chi non sta finisce in «More», dalla voce meno importante", () => {
    const optional = [
      { id: "brief", width: 50 },
      { id: "graph", width: 50 },
      { id: "search", width: 70 },
    ];
    expect(overflowingBarItems(800, 400, optional, 60)).toEqual([]);
    expect(overflowingBarItems(560, 400, optional, 60)).toEqual(["graph", "search"]);
    expect(overflowingBarItems(420, 400, optional, 60)).toEqual(["brief", "graph", "search"]);
  });

  it("la risposta della chat porta l'ora dell'orologio del prototipo", async () => {
    const answer = await docs.askDocs({ projectId: "prj-aud", question: "scheduled callbacks" });
    expect(answer.answeredAt).toMatch(/T12:00:00Z$/);
  });

  it("searchDocs dà il passaggio che ha corrisposto", async () => {
    const [hit] = await docs.searchDocs("callback", { repositoryId: "repo-aud" });
    expect(hit!.passage.toLowerCase()).toContain("callback");
  });
});

describe("repository del seme", () => {
  it("STW, AUD e CBV hanno un repository", () => {
    expect(REPOSITORIES.map((r) => r.name).sort()).toEqual([
      "audin-app",
      "bellavista-store",
      "stubwise",
    ]);
  });
});
