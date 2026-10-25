import { RESERVED_SLUGS, SLUG_RE, slugify } from "../../domain/docs";
import { COMMITS } from "../seed/commits";
import { copy, gate, newId, now, state, storeGeneration } from "../store";
import type {
  DocGeneration,
  DocPage,
  DocSpace,
  GraphActionKind,
  GraphState,
  ManualPageInput,
} from "../types";
import { can, viewerFor, type Permission } from "../viewer";
import { docsAccess, docPageById, docSpaceOf } from "./reads";

// Le scritture dei Docs (area 5). Come le altre: `gate()` prima di tutto,
// permesso verificato come sul server, ogni controllo prima di ogni
// scrittura (dopo un rifiuto lo stato è intatto). Uno spazio o una pagina
// che chi agisce non vede è `not_found`.
//
// La generazione e il grafo avanzano da soli col ritardo simulato: ogni passo
// passa da `gate()` (`docs.advanceGeneration`, `docs.advanceGraph`), quindi
// segue `setLatency` e `failNext` lo fa fallire. Nessun timer sull'orologio.

const forbidden = () => new Error("forbidden");
const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);

function need(me: string, perm: Permission, projectId: string): void {
  if (!can(viewerFor(me), perm, projectId)) throw forbidden();
}

/** Lo spazio su cui si agisce: deve leggerne i Docs (altrimenti non esiste). */
function spaceFor(me: string, repositoryId: string): DocSpace {
  const space = docSpaceOf(repositoryId);
  if (!space) throw notFound();
  const access = docsAccess(me, space.projectId);
  if (access === "none") throw notFound();
  if (access === "forbidden") throw forbidden();
  return space;
}

function manualPageFor(me: string, id: string): DocPage {
  const page = docPageById(id);
  if (!page) throw notFound();
  const access = docsAccess(me, page.projectId);
  if (access === "none") throw notFound();
  if (access === "forbidden") throw forbidden();
  need(me, "docs.edit", page.projectId);
  if (page.kind !== "manual") throw invalid("generated page");
  return page;
}

function checkSlug(repositoryId: string, slug: string, exceptId?: string): void {
  if (!SLUG_RE.test(slug)) throw invalid("slug");
  if (RESERVED_SLUGS.has(slug)) throw new Error("slug_conflict");
  const taken = state.docPages.some(
    (p) => p.repositoryId === repositoryId && p.slug === slug && p.id !== exceptId,
  );
  if (taken) throw new Error("slug_conflict");
}

const cleanPath = (path: string | undefined) =>
  (path ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" / ");

const excerptOf = (body: string) => {
  const line = body
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\d.\s]+/, "").trim())
    .find(Boolean);
  return (line ?? "").slice(0, 200);
};

// --- pagine manuali ----------------------------------------------------------

/** «+ Nuova pagina manuale»: lo slug, se manca, viene dal titolo. */
export async function createManualPage(
  repositoryId: string,
  input: ManualPageInput,
): Promise<DocPage> {
  const me = await gate("docs.createManualPage");
  const space = spaceFor(me, repositoryId);
  need(me, "docs.edit", space.projectId);
  const title = input.title.trim();
  if (!title) throw invalid("title");
  const slug = input.slug?.trim() || slugify(title);
  checkSlug(repositoryId, slug);
  const project = state.projectsById.get(space.projectId)!;
  const n = (state.docCodeSeq.get(project.id) ?? 0) + 1;
  state.docCodeSeq.set(project.id, n);
  const page: DocPage = {
    id: newId("doc"),
    code: `${project.code}-D${n}`,
    projectId: project.id,
    repositoryId,
    kind: "manual",
    title,
    slug,
    path: cleanPath(input.path),
    excerpt: excerptOf(input.body),
    body: input.body,
    documentsPath: null,
    generatedAtCommit: null,
    updatedAt: now(),
    staleCommits: [],
    links: [],
    views: 0,
  };
  state.docPages.push(page);
  return copy(page);
}

/** Modifica una pagina manuale (stesso form): il codice non cambia mai. */
export async function updateManualPage(
  id: string,
  patch: Partial<ManualPageInput>,
): Promise<DocPage> {
  const me = await gate("docs.updateManualPage");
  const page = manualPageFor(me, id);
  const title = patch.title === undefined ? page.title : patch.title.trim();
  if (!title) throw invalid("title");
  const slug = patch.slug === undefined ? page.slug : patch.slug.trim();
  checkSlug(page.repositoryId, slug, page.id);
  page.title = title;
  page.slug = slug;
  if (patch.body !== undefined) {
    page.body = patch.body;
    page.excerpt = excerptOf(patch.body);
  }
  if (patch.path !== undefined) page.path = cleanPath(patch.path);
  page.updatedAt = now();
  return copy(page);
}

/** Elimina una pagina manuale; i collegamenti verso di lei spariscono, il codice non si riusa. */
export async function deleteManualPage(id: string): Promise<void> {
  const me = await gate("docs.deleteManualPage");
  const page = manualPageFor(me, id);
  state.docPages = state.docPages.filter((p) => p.id !== page.id);
  for (const p of state.docPages) p.links = p.links.filter((l) => l.pageId !== page.id);
  for (const s of state.docSpaces) {
    for (const r of s.releases) r.pageIds = r.pageIds.filter((pid) => pid !== page.id);
  }
}

/** Una visita alla pagina («più lette»): nessun legame col Drive. */
export async function recordDocView(pageId: string): Promise<void> {
  const me = await gate("docs.recordDocView");
  const page = docPageById(pageId);
  if (!page || docsAccess(me, page.projectId) !== "read") throw notFound();
  page.views += 1;
}

// --- lavoro simulato ---------------------------------------------------------

const pending = new Set<Promise<void>>();

function track(work: Promise<void>): void {
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** Si risolve quando generazioni e grafi simulati non hanno più passi in corso. */
export async function whenDocsIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/** Gli stati attraversati dall'ultimo avvio della generazione di un repository. */
export function generationHistory(repositoryId: string): DocGeneration["status"][] {
  return [...(state.docGenerationLog.get(repositoryId) ?? [])];
}

function setGeneration(space: DocSpace, patch: Partial<DocGeneration>): void {
  space.generation = { ...space.generation, ...patch };
  const log = state.docGenerationLog.get(space.repositoryId) ?? [];
  log.push(space.generation.status);
  state.docGenerationLog.set(space.repositoryId, log);
}

/** L'ultimo commit del repository nel seme, o quello già generato. */
function headCommit(space: DocSpace): string | null {
  const latest = COMMITS.filter((c) => c.projectId === space.projectId).sort((a, b) =>
    b.at.localeCompare(a.at),
  )[0];
  return latest?.sha ?? space.generation.commit;
}

async function advanceGeneration(repositoryId: string, from: "queued" | "running"): Promise<void> {
  const generation = storeGeneration();
  // Lo stato è stato ripristinato nel frattempo: questo lavoro non è più suo.
  const space = () => (storeGeneration() === generation ? docSpaceOf(repositoryId) : undefined);
  try {
    if (from === "queued") {
      await gate("docs.advanceGeneration");
      const s = space();
      if (!s) return;
      setGeneration(s, { status: "running" });
    }
    await gate("docs.advanceGeneration");
    const s = space();
    if (!s) return;
    const commit = headCommit(s);
    for (const page of state.docPages) {
      if (page.repositoryId !== repositoryId || page.kind === "manual") continue;
      page.generatedAtCommit = commit;
      page.staleCommits = [];
      page.updatedAt = now();
    }
    setGeneration(s, {
      status: "succeeded",
      lastAt: now(),
      commit,
      costUsd: 1.86,
      provider: s.generation.provider ?? "Team account",
      reason: null,
    });
  } catch {
    const s = space();
    if (s) {
      setGeneration(s, {
        status: "failed",
        reason: "The provider returned an error while writing the pages.",
      });
    }
  }
}

const IN_FLIGHT: ReadonlySet<DocGeneration["status"]> = new Set(["queued", "running", "paused"]);

/** «Genera la documentazione»: in coda, poi in corso, poi riuscita (o fallita). */
export async function startGeneration(repositoryId: string): Promise<DocGeneration> {
  const me = await gate("docs.startGeneration");
  const space = spaceFor(me, repositoryId);
  need(me, "docs.generate", space.projectId);
  if (IN_FLIGHT.has(space.generation.status)) throw new Error("generation_in_progress");
  state.docGenerationLog.set(repositoryId, []);
  setGeneration(space, { status: "queued", reason: null });
  track(advanceGeneration(repositoryId, "queued"));
  return copy(space.generation);
}

/** «Riprendi ora»: una generazione in pausa (o trattenuta) riparte da dove era. */
export async function resumeGeneration(repositoryId: string): Promise<DocGeneration> {
  const me = await gate("docs.resumeGeneration");
  const space = spaceFor(me, repositoryId);
  need(me, "docs.generate", space.projectId);
  if (space.generation.status !== "paused" && space.generation.status !== "held") {
    throw invalid("generation not paused");
  }
  state.docGenerationLog.set(repositoryId, []);
  setGeneration(space, { status: "running", reason: null });
  track(advanceGeneration(repositoryId, "running"));
  return copy(space.generation);
}

// --- grafo -------------------------------------------------------------------

/** Da quali stati parte ogni azione del grafo. */
const GRAPH_FROM: Record<Exclude<GraphActionKind, "setup_pr">, GraphState["status"][]> = {
  // «Genera» accende anche un grafo spento (nel web: «Abilitalo nel repository»).
  generate: ["disabled", "never", "failed"],
  regenerate: ["ready", "failed"],
  rebuild: ["ready", "failed"],
};

async function advanceGraph(repositoryId: string): Promise<void> {
  const generation = storeGeneration();
  const space = () => (storeGeneration() === generation ? docSpaceOf(repositoryId) : undefined);
  try {
    await gate("docs.advanceGraph");
    const running = space();
    if (!running) return;
    running.graph = { ...running.graph, status: "running" };
    await gate("docs.advanceGraph");
    const done = space();
    if (!done) return;
    done.graph = {
      ...done.graph,
      status: "ready",
      reason: undefined,
      nodes: done.graph.nodes ?? 2310,
      edges: done.graph.edges ?? 5874,
      communities: done.graph.communities ?? 21,
    };
  } catch {
    const failed = space();
    if (failed) {
      failed.graph = {
        ...failed.graph,
        status: "failed",
        reason: "graphify exited with an error.",
      };
    }
  }
}

/**
 * Le azioni del grafo (`repos.manage`): genera, rigenera, ricostruisci da zero
 * (in coda → in corso → pronto), o apri la PR di setup (una sola: se c'è già
 * torna quella).
 */
export async function graphAction(
  repositoryId: string,
  kind: GraphActionKind,
): Promise<GraphState> {
  const me = await gate("docs.graphAction");
  const space = spaceFor(me, repositoryId);
  need(me, "repos.manage", space.projectId);
  if (kind === "setup_pr") {
    if (!space.graph.setupPr) {
      space.graph = {
        ...space.graph,
        setupPr: { url: `https://github.com/stubwise-demo/${space.name}/pull/1`, open: true },
      };
    }
    return copy(space.graph);
  }
  if (!GRAPH_FROM[kind].includes(space.graph.status)) throw invalid("graph state");
  space.graph = {
    ...space.graph,
    status: "queued",
    reason: undefined,
    // «Ricostruisci da zero» butta i conteggi di prima.
    ...(kind === "rebuild" ? { nodes: undefined, edges: undefined, communities: undefined } : {}),
  };
  track(advanceGraph(repositoryId));
  return copy(space.graph);
}
