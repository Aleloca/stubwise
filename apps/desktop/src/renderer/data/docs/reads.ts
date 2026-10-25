import { buildDocTree } from "../../domain/docs";
import { REPOSITORIES } from "../seed/docs/repositories";
import { copy, gate, state, visibleProjectIds } from "../store";
import type {
  DocKind,
  DocPage,
  DocPageRef,
  DocPageView,
  DocSearchHit,
  DocSpace,
  DocSpaceView,
  DocTreeCategory,
  ProjectDocsHome,
  Repository,
} from "../types";
import { can, viewerFor } from "../viewer";

// Le letture dei Docs (area 5). Chi vede che cosa lo decide UNA funzione,
// `docsAccess`: un progetto invisibile, inesistente o senza il modulo Docs
// risponde come uno che non esiste (elenchi vuoti, `null`); un progetto
// visibile senza `docs.view` risponde `forbidden` alle letture dello spazio,
// e nelle letture trasversali (citazioni, ricerca, «#», Claude) le sue
// pagine semplicemente non ci sono — nascosto e inesistente identici (R-G5).

/** Le categorie nell'ordine dell'albero. */
export const DOC_KINDS: readonly DocKind[] = ["technical", "functional", "product", "manual"];

const forbidden = () => new Error("forbidden");

/** `none` = come se non esistesse; `forbidden` = lo vede ma non i Docs; `read` = li legge. */
export type DocsAccess = "none" | "forbidden" | "read";

export function docsAccess(me: string, projectId: string): DocsAccess {
  const project = state.projectsById.get(projectId);
  if (!project || !visibleProjectIds(me).has(projectId) || !project.modules.includes("docs")) {
    return "none";
  }
  return can(viewerFor(me), "docs.view", projectId) ? "read" : "forbidden";
}

/** Una pagina che chi guarda legge: il suo progetto gli dà i Docs. */
export const canReadDocPage = (me: string, page: DocPage): boolean =>
  docsAccess(me, page.projectId) === "read";

/** Le pagine che chi guarda legge, in ogni progetto. */
export const readableDocPages = (me: string): DocPage[] =>
  state.docPages.filter((p) => canReadDocPage(me, p));

export const repositoryById = (id: string): Repository | undefined =>
  REPOSITORIES.find((r) => r.id === id);

export const docPageById = (id: string): DocPage | undefined =>
  state.docPages.find((p) => p.id === id);

export const docPageByCode = (code: string): DocPage | undefined =>
  state.docPages.find((p) => p.code === code);

export const docSpaceOf = (repositoryId: string): DocSpace | undefined =>
  state.docSpaces.find((s) => s.repositoryId === repositoryId);

/**
 * Lo spazio di un repository per chi guarda, o `null` se non esiste per lui;
 * `forbidden` se vede il progetto ma non i Docs.
 */
function spaceFor(me: string, repositoryId: string): DocSpace | null {
  const space = docSpaceOf(repositoryId);
  if (!space) return null;
  const access = docsAccess(me, space.projectId);
  if (access === "forbidden") throw forbidden();
  return access === "read" ? space : null;
}

export function pageRef(page: DocPage): DocPageRef {
  return {
    id: page.id,
    code: page.code,
    projectId: page.projectId,
    repositoryId: page.repositoryId,
    kind: page.kind,
    title: page.title,
    slug: page.slug,
    path: page.path,
    excerpt: page.excerpt,
    updatedAt: page.updatedAt,
    views: page.views,
    stale: page.staleCommits.length > 0,
  };
}

const pagesOf = (repositoryId: string) =>
  state.docPages.filter((p) => p.repositoryId === repositoryId);

function spaceView(me: string, space: DocSpace): DocSpaceView {
  const pages = pagesOf(space.repositoryId);
  const viewer = viewerFor(me);
  return {
    ...copy(space),
    pageCount: pages.length,
    manualOnly: pages.length > 0 && pages.every((p) => p.kind === "manual"),
    recent: [...pages]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.code.localeCompare(b.code))
      .slice(0, 5)
      .map(pageRef),
    mostRead: pages
      .filter((p) => p.views > 0)
      .sort((a, b) => b.views - a.views || a.code.localeCompare(b.code))
      .slice(0, 5)
      .map(pageRef),
    permissions: {
      edit: can(viewer, "docs.edit", space.projectId),
      generate: can(viewer, "docs.generate", space.projectId),
      manageRepository: can(viewer, "repos.manage", space.projectId),
    },
  };
}

function spacesOfProject(me: string, projectId: string): DocSpaceView[] {
  const access = docsAccess(me, projectId);
  if (access === "forbidden") throw forbidden();
  if (access === "none") return [];
  return state.docSpaces.filter((s) => s.projectId === projectId).map((s) => spaceView(me, s));
}

/** Gli spazi (uno per repository) dei Docs di un progetto. */
export async function listDocSpaces(projectId: string): Promise<DocSpaceView[]> {
  const me = await gate("docs.listDocSpaces");
  return spacesOfProject(me, projectId);
}

export async function getDocSpace(repositoryId: string): Promise<DocSpaceView | null> {
  const me = await gate("docs.getDocSpace");
  const space = spaceFor(me, repositoryId);
  return space ? spaceView(me, space) : null;
}

/** L'albero di uno spazio: le quattro categorie, sempre tutte e nell'ordine. */
export async function listDocTree(repositoryId: string): Promise<DocTreeCategory[]> {
  const me = await gate("docs.listDocTree");
  if (!spaceFor(me, repositoryId)) return [];
  const pages = pagesOf(repositoryId).map(pageRef);
  return DOC_KINDS.map((kind) => {
    const ofKind = pages.filter((p) => p.kind === kind);
    return { kind, count: ofKind.length, nodes: buildDocTree(ofKind) };
  });
}

/** Una pagina per slug; `null` se non c'è (o non c'è per chi guarda). */
export async function getDocPage(repositoryId: string, slug: string): Promise<DocPageView | null> {
  const me = await gate("docs.getDocPage");
  const space = spaceFor(me, repositoryId);
  if (!space) return null;
  const page = pagesOf(repositoryId).find((p) => p.slug === slug);
  if (!page) return null;
  const manual = page.kind === "manual" && can(viewerFor(me), "docs.edit", page.projectId);
  return {
    ...copy(page),
    repositoryName: space.name,
    resolvedLinks: page.links.flatMap((link) => {
      const target = docPageById(link.pageId);
      return target && canReadDocPage(me, target)
        ? [{ type: link.type, page: pageRef(target) }]
        : [];
    }),
    permissions: { edit: manual, delete: manual },
  };
}

/** La pagina iniziale dei Docs di un progetto; `null` dove i Docs non ci sono. */
export async function getProjectDocsHome(projectId: string): Promise<ProjectDocsHome | null> {
  const me = await gate("docs.getProjectDocsHome");
  const spaces = spacesOfProject(me, projectId);
  if (docsAccess(me, projectId) === "none") return null;
  const main = spaces[0] ?? null;
  const decisions = state.decisionLog
    .filter((d) => d.projectId === projectId)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return {
    projectId,
    identity: main?.brief?.identity ?? null,
    startHere: main
      ? { repositoryId: main.repositoryId, name: main.name, hasBrief: main.brief !== null }
      : null,
    spaces,
    decisions: { total: decisions.length, recent: decisions.slice(0, 3).map(copy) },
    whatsNew: spaces
      .flatMap((s) =>
        s.releases.map((r) => ({ ...r, repositoryId: s.repositoryId, repositoryName: s.name })),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
      .slice(0, 5),
  };
}

/**
 * Cerca nelle pagine che chi guarda legge (codice, titolo, percorso, estratto,
 * corpo); con `repositoryId` solo in quello spazio (⌘K dentro i Docs).
 */
export async function searchDocs(
  q: string,
  { repositoryId }: { repositoryId?: string } = {},
): Promise<DocSearchHit[]> {
  const me = await gate("docs.searchDocs");
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return readableDocPages(me)
    .filter((p) => repositoryId === undefined || p.repositoryId === repositoryId)
    .filter((p) =>
      [p.code, p.title, p.path, p.excerpt, p.body].some((f) => f.toLowerCase().includes(needle)),
    )
    .map((p) => ({
      page: pageRef(p),
      repositoryName: repositoryById(p.repositoryId)?.name ?? "",
      projectCode: state.projectsById.get(p.projectId)!.code,
    }));
}
