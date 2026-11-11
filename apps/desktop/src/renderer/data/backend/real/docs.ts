import { ApiError } from "@stubwise/api-client";
import type {
  DocBriefResponse,
  DocPage as ServerPage,
  DocStatusResponse,
  DocTreeNode as ServerNode,
  ProjectDocsSearchResult,
  Reader,
  RepoHighlights,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
  DocGeneration,
  DocKind,
  DocLink,
  DocPageRef,
  DocPageView,
  DocRelease,
  DocSearchHit,
  DocSpaceView,
  DocTreeCategory,
  GraphState,
  ProjectDocsHome,
  RepoBrief,
  Viewer,
} from "../../types";
import { buildDocTree } from "../../../domain/docs";
import { can } from "../../viewing";
import { rememberDocCitation } from "./chat";
import { appClient } from "./client";
import { notIntegrated, partialNamespace } from "./notIntegrated";
import { listDecisionLog } from "./overview";
import { listProjects } from "./projects";

// I Docs nella build app (integrazione area 5, fetta 1): le rotte di oggi dei
// Docs (`/api/repositories/:id/docs/*`, `/api/projects/:id/docs/*`) nella
// forma del prototipo, «come oggi» (maintainer). Chi legge e chi scrive lo
// dice il SERVER: un 404 è «non c'è per chi guarda», e i permessi di uno
// spazio sono quelli di progetto che il server calcola per chi guarda. Ciò che
// il server non dà resta vuoto, mai inventato (le differenze stanno nella
// parità, `apps/desktop/docs/integration-area5-f1.md`).

type Docs = typeof Fake.docs;
type Node = Reader<ServerNode>;
type Page = Reader<ServerPage>;

/** Le quattro categorie dell'albero, nell'ordine del prototipo (le note di rilascio sono Releases). */
const DOC_KINDS: readonly DocKind[] = ["technical", "functional", "product", "manual"];

// --- memorie della sessione ---------------------------------------------------------

/** Lo spazio di ogni repository letto: il progetto e il nome (lo schema dello spazio non porta il progetto). */
const spaceOf = new Map<string, { projectId: string; name: string; slug: string }>();
/** Dove sta ogni pagina letta (per `recordDocView`, che ha solo l'id). */
const pageWhere = new Map<string, { repositoryId: string; slug: string }>();

export function forgetDocsCaches(): void {
  spaceOf.clear();
  pageWhere.clear();
}

async function read<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Chi guarda, coi permessi di progetto che calcola il server (`/api/auth/me`). */
async function viewer(): Promise<Viewer> {
  const me = await appClient().auth.me();
  return {
    personId: me.user.id,
    instancePermissions: me.instancePermissions,
    projectPermissions: me.projectPermissions,
    departmentPermissions: me.departmentPermissions ?? {},
  } as Viewer;
}

/** Il progetto di un repository: dagli spazi già letti, o dagli spazi dei progetti visibili. */
async function projectOfRepository(repositoryId: string): Promise<string | null> {
  const known = spaceOf.get(repositoryId);
  if (known) return known.projectId;
  for (const project of await listProjects()) {
    if (!project.modules.includes("docs")) continue;
    const spaces = (await read(() => appClient().docs.projectSpaces(project.id))) ?? [];
    for (const s of spaces) spaceOf.set(s.repositoryId, { projectId: project.id, name: s.name, slug: s.slug });
    if (spaceOf.has(repositoryId)) return project.id;
  }
  return null;
}

// --- le forme -----------------------------------------------------------------------

/** La categoria del prototipo; una pagina di un tipo ignoto (o una nota di rilascio) non sta nell'albero. */
function kindOf(kind: string): DocKind | null {
  return (DOC_KINDS as readonly string[]).includes(kind) ? (kind as DocKind) : null;
}

/** Il percorso di una pagina nell'albero: i titoli delle madri («Guide / Dialer»). */
function pathOf(node: { parentId: string | null }, byId: Map<string, Node>): string {
  const titles: string[] = [];
  const seen = new Set<string>();
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    titles.unshift(parent.title);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return titles.join(" / ");
}

function refOf(node: Node, projectId: string, repositoryId: string, byId: Map<string, Node>): DocPageRef | null {
  const kind = kindOf(node.kind);
  if (!kind) return null;
  pageWhere.set(node.id, { repositoryId, slug: node.slug });
  return {
    id: node.id,
    code: node.code ?? "",
    projectId,
    repositoryId,
    kind,
    title: node.title,
    slug: node.slug,
    path: pathOf(node, byId),
    // L'albero del server non porta estratto, data di modifica né commit successivi.
    excerpt: "",
    updatedAt: node.createdAt,
    views: node.viewCount,
    stale: false,
  };
}

/** La prima riga di testo del corpo (senza titoli e segni del Markdown): l'estratto di una pagina aperta. */
function excerptOf(body: string): string {
  for (const line of body.split("\n")) {
    const text = line.replace(/^[#>\-*\d.\s]+/, "").replace(/[*_`]/g, "").trim();
    if (text && !line.trimStart().startsWith("#")) return text;
  }
  return "";
}

/**
 * Lo stato della generazione dallo stato del server: il job più nuovo se è
 * ancora in coda, in corso o trattenuto, altrimenti l'ultima generazione. Il
 * motivo (un codice) il server non lo dà ancora: la UI dice la frase generica.
 */
function generationOf(status: Reader<DocStatusResponse> | null): DocGeneration {
  const g = status?.generation ?? null;
  const job = status?.latestJob ?? null;
  const provider = status?.pinnedProvider?.label ?? null;
  const base = {
    lastAt: g ? (g.finishedAt ?? g.startedAt ?? g.createdAt) : null,
    commit: g?.commitSha ?? null,
    costUsd: g?.cost != null && Number.isFinite(Number(g.cost)) ? Number(g.cost) : null,
    provider,
    reason: null,
  };
  const jobNewer = job && (!g || job.createdAt >= g.createdAt);
  if (job && jobNewer && (job.status === "queued" || job.status === "running" || job.status === "held")) {
    return { ...base, status: job.status };
  }
  if (!g) return { ...base, status: job?.status === "failed" ? "failed" : "never" };
  const status_: DocGeneration["status"] =
    g.status === "pending" ? "queued" : g.status === "__unknown__" ? "never" : g.status;
  return { ...base, status: status_ };
}

function briefOf(b: Reader<DocBriefResponse> | null): RepoBrief | null {
  if (!b) return null;
  const s = b.brief;
  return {
    identity: s.identity,
    actors: s.actors.map((a) => ({ name: a.name, description: a.description })),
    surfaces: s.surfaces.map((x) => ({ name: x.name, audience: x.audience })),
    glossary: s.glossary.map((g) => ({ term: g.term, definition: g.definition })),
    invariants: [...s.invariants],
    // Un percorso del server è un titolo e un riassunto: è il suo unico passo.
    journeys: s.journeys.map((j) => ({ name: j.title, steps: j.summary ? [j.summary] : [] })),
    sources: s.existingSources.map((path) => ({ label: path, path })),
    confidentialFacts: s.confidentialFacts.map((f) => ({ fact: f.fact, reason: f.reason, where: f.source, mustNotAppearAs: f.avoid })),
    excludedPages: b.productExclusions.map((e) => ({ title: e.title, reason: e.fact })),
  };
}

/** Le note di rilascio dello spazio, dalla più recente; il testo solo quando si legge (`withText`). */
async function releasesOf(repositoryId: string, nodes: readonly Node[], withText: boolean): Promise<DocRelease[]> {
  const rows = nodes
    .filter((n) => n.kind === "releases")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const texts = withText
    ? await Promise.all(
        rows.slice(0, RELEASE_TEXTS).map(async (n) => (await read(() => appClient().docs.page(repositoryId, n.slug)))?.body ?? ""),
      )
    : [];
  return rows.map((n, i) => ({
    id: n.id,
    version: n.title,
    date: n.createdAt,
    text: texts[i] ?? "",
    minor: n.significant === false,
    // Le pagine toccate da una nota il server non le dice (differenza dichiarata).
    pageIds: [],
  }));
}
/** Quante note di rilascio si leggono per intero aprendo uno spazio. */
const RELEASE_TEXTS = 30;

/** Il grafo: fino al passo 2d dell'integrazione, nessuno stato (la vista lo dice «in arrivo»). */
const NO_GRAPH: GraphState = { status: "disabled" };

/** L'ordine delle categorie per le domande suggerite, come il prototipo. */
const SUGGEST_ORDER: readonly DocKind[] = ["functional", "product", "technical"];
function chatSuggestions(refs: readonly DocPageRef[]): DocPageRef[] {
  return refs
    .filter((p) => SUGGEST_ORDER.includes(p.kind))
    .sort(
      (a, b) =>
        SUGGEST_ORDER.indexOf(a.kind) - SUGGEST_ORDER.indexOf(b.kind) ||
        b.views - a.views ||
        a.code.localeCompare(b.code, undefined, { numeric: true }),
    )
    .slice(0, 4);
}

/** L'albero letto e le sue pagine come riferimenti del prototipo. */
async function treeOf(repositoryId: string, projectId: string) {
  const nodes = (await read(() => appClient().docs.tree(repositoryId))) ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const refs = nodes.flatMap((n) => refOf(n, projectId, repositoryId, byId) ?? []);
  return { nodes, byId, refs };
}

async function spaceView(
  s: { repositoryId: string; name: string },
  projectId: string,
  me: Viewer,
  { withReleaseTexts = false } = {},
): Promise<DocSpaceView> {
  const [{ nodes, refs }, highlights, status, brief] = await Promise.all([
    treeOf(s.repositoryId, projectId),
    read(() => appClient().docs.repoHighlights(s.repositoryId)),
    read(() => appClient().docs.status(s.repositoryId)),
    read(() => appClient().docs.brief(s.repositoryId)),
  ]);
  const bySlug = new Map(refs.map((r) => [r.slug, r] as const));
  const refsFrom = (list: readonly { slug: string }[] | undefined) =>
    (list ?? []).flatMap((h) => bySlug.get(h.slug) ?? []).slice(0, 5);
  return {
    repositoryId: s.repositoryId,
    projectId,
    name: s.name,
    generation: generationOf(status),
    brief: briefOf(brief),
    releases: await releasesOf(s.repositoryId, nodes, withReleaseTexts),
    graph: NO_GRAPH,
    pageCount: refs.length,
    manualOnly: refs.length > 0 && refs.every((r) => r.kind === "manual"),
    recent: refsFrom((highlights as Reader<RepoHighlights> | null)?.recentlyUpdated),
    mostRead: refsFrom(highlights?.topViewed.filter((h) => h.viewCount > 0)),
    permissions: {
      edit: can(me, "docs.edit", projectId),
      generate: can(me, "docs.generate", projectId),
      manageRepository: can(me, "repos.manage", projectId),
    },
    // Il server non lo dice prima di una domanda (decisione dell'orchestratrice):
    // si assume disponibile, e un 503 alla domanda lo dice.
    chatAvailable: true,
    chatSuggestions: chatSuggestions(refs),
  };
}

// --- letture -------------------------------------------------------------------------

/** Gli spazi (uno per repository) dei Docs di un progetto; nessuno se il progetto non ha Docs per chi guarda. */
const listDocSpaces: Docs["listDocSpaces"] = async (projectId) => {
  const spaces = await read(() => appClient().docs.projectSpaces(projectId));
  if (!spaces) return [];
  const me = await viewer();
  return Promise.all(
    spaces.map((s) => {
      spaceOf.set(s.repositoryId, { projectId, name: s.name, slug: s.slug });
      return spaceView(s, projectId, me);
    }),
  );
};

const getDocSpace: Docs["getDocSpace"] = async (repositoryId) => {
  const projectId = await projectOfRepository(repositoryId);
  const s = spaceOf.get(repositoryId);
  if (!projectId || !s) return null;
  return spaceView({ repositoryId, name: s.name }, projectId, await viewer(), { withReleaseTexts: true });
};

/** L'albero di uno spazio: le quattro categorie, sempre tutte e nell'ordine. */
const listDocTree: Docs["listDocTree"] = async (repositoryId) => {
  const projectId = await projectOfRepository(repositoryId);
  if (!projectId) return [];
  const { refs } = await treeOf(repositoryId, projectId);
  return DOC_KINDS.map((kind): DocTreeCategory => {
    const ofKind = refs.filter((r) => r.kind === kind);
    return { kind, count: ofKind.length, nodes: buildDocTree(ofKind) };
  });
};

/** Una pagina per slug; `null` se non c'è (o non c'è per chi guarda). */
const getDocPage: Docs["getDocPage"] = async (repositoryId, slug) => {
  const projectId = await projectOfRepository(repositoryId);
  if (!projectId) return null;
  const [page, { byId, refs }, me] = await Promise.all([
    read(() => appClient().docs.page(repositoryId, slug)),
    treeOf(repositoryId, projectId),
    viewer(),
  ]);
  if (!page) return null;
  const kind = kindOf(page.kind) ?? "manual";
  pageWhere.set(page.id, { repositoryId, slug: page.slug });
  const bySlug = new Map(refs.map((r) => [r.slug, r] as const));
  const links: { type: DocLink["type"]; page: DocPageRef }[] = ((page as Page).links ?? []).flatMap((l) => {
    const target = bySlug.get(l.slug);
    return target && (l.type === "implements" || l.type === "implemented_by" || l.type === "related")
      ? [{ type: l.type, page: target }]
      : [];
  });
  const manual = page.isManual && can(me, "docs.edit", projectId);
  const view: DocPageView = {
    id: page.id,
    code: page.code ?? "",
    projectId,
    repositoryId,
    kind,
    title: page.title,
    slug: page.slug,
    path: pathOf(page, byId),
    excerpt: excerptOf(page.body),
    body: page.body,
    documentsPath: page.sourcePath,
    generatedAtCommit: page.commitSha,
    updatedAt: page.updatedAt,
    staleCommits: (page.staleSince ?? []).map((c) => ({ sha: c.sha, message: c.subject, at: c.committedAt })),
    links: links.map((l) => ({ type: l.type, pageId: l.page.id })),
    views: page.viewCount,
    repositoryName: spaceOf.get(repositoryId)?.name ?? "",
    resolvedLinks: links,
    permissions: { edit: manual, delete: manual },
  };
  return view;
};

/** Una visita alla pagina (le «più lette»): fire-and-forget, un errore non si vede. */
const recordDocView: Docs["recordDocView"] = async (pageId) => {
  const where = pageWhere.get(pageId);
  if (!where) return;
  await appClient()
    .docs.viewPage(where.repositoryId, where.slug)
    .catch(() => undefined);
};

/** Il brief di un repository; `null` se non c'è ancora (o lo spazio non c'è per chi guarda). */
const getRepoBrief: Docs["getRepoBrief"] = async (repositoryId) =>
  briefOf(await read(() => appClient().docs.brief(repositoryId)));

function hitOf(h: Reader<ProjectDocsSearchResult>, projectId: string, projectCode: string): DocSearchHit | null {
  const kind = kindOf(h.kind);
  if (!kind) return null;
  return {
    page: {
      // La ricerca non porta l'id della pagina: il codice (o il percorso) la distingue.
      id: h.code ?? `${h.repositoryId}/${h.slug}`,
      code: h.code ?? "",
      projectId,
      repositoryId: h.repositoryId,
      kind,
      title: h.title,
      slug: h.slug,
      path: "",
      excerpt: h.snippet,
      updatedAt: "",
      views: 0,
      stale: false,
    },
    repositoryName: h.repositoryName,
    projectCode,
    passage: h.snippet,
  };
}

/** Cerca nelle pagine che chi guarda legge; con `repositoryId` solo in quello spazio. */
const searchDocs: Docs["searchDocs"] = async (q, { repositoryId } = {}) => {
  if (q.trim().length === 0) return [];
  const projects = (await listProjects()).filter((p) => p.modules.includes("docs"));
  const scoped = repositoryId ? await projectOfRepository(repositoryId) : null;
  const targets = repositoryId ? projects.filter((p) => p.id === scoped) : projects;
  const results = await Promise.all(
    targets.map(async (p) => {
      const hits = (await read(() => appClient().docs.projectSearch(p.id, q))) ?? [];
      return hits
        .filter((h) => !repositoryId || h.repositoryId === repositoryId)
        .flatMap((h) => hitOf(h, p.id, p.code) ?? []);
    }),
  );
  return results.flat();
};

/** La pagina iniziale dei Docs di un progetto; `null` dove i Docs non ci sono per chi guarda. */
const getProjectDocsHome: Docs["getProjectDocsHome"] = async (projectId) => {
  const spaces = await read(() => appClient().docs.projectSpaces(projectId));
  if (!spaces) return null;
  const me = await viewer();
  const views = await Promise.all(
    spaces.map((s) => {
      spaceOf.set(s.repositoryId, { projectId, name: s.name, slug: s.slug });
      return spaceView(s, projectId, me);
    }),
  );
  const main = views[0] ?? null;
  // Il registro del progetto: le recenti e il totale vero (fino al tetto della lettura).
  const decisions = await listDecisionLog(projectId).catch(() => []);
  const sorted = [...decisions].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  const home: ProjectDocsHome = {
    projectId,
    identity: main?.brief?.identity ?? null,
    startHere: main ? { repositoryId: main.repositoryId, name: main.name, hasBrief: main.brief !== null } : null,
    spaces: views,
    decisions: { total: decisions.length, recent: sorted.slice(0, 3) },
    whatsNew: views
      .flatMap((s) => s.releases.map((r) => ({ ...r, repositoryId: s.repositoryId, repositoryName: s.name })))
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
      .slice(0, 5),
    chatAvailable: true,
    chatSuggestions: chatSuggestions(views.flatMap((s) => s.chatSuggestions)),
    // Lo spazio Prodotto è dell'area 11a, non integrata.
    product: null,
  };
  return home;
};

// --- scritture: pagine manuali e generazione (passo 2b) ------------------------------

/** I rifiuti del server negli errori del prototipo, che il form e il pannello sanno dire. */
async function write<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "doc_page_slug_conflict") throw new Error("slug_conflict");
      if (error.code === "generation_not_paused") throw new Error("invalid: generation not paused");
      if (error.status === 409) throw new Error("generation_in_progress");
      if (error.status === 404) throw new Error("not_found");
      if (error.status === 403) throw new Error("forbidden");
      if (error.status === 400) throw new Error("invalid: input");
    }
    throw error;
  }
}

/** Una pagina scritta dal server nella forma del prototipo (senza l'albero: in cima alle manuali). */
function pageOf(p: Page, projectId: string, repositoryId: string): DocPageView {
  pageWhere.set(p.id, { repositoryId, slug: p.slug });
  return {
    id: p.id,
    code: p.code ?? "",
    projectId,
    repositoryId,
    kind: kindOf(p.kind) ?? "manual",
    title: p.title,
    slug: p.slug,
    path: "",
    excerpt: excerptOf(p.body),
    body: p.body,
    documentsPath: p.sourcePath,
    generatedAtCommit: p.commitSha,
    updatedAt: p.updatedAt,
    staleCommits: [],
    links: [],
    views: p.viewCount,
    repositoryName: spaceOf.get(repositoryId)?.name ?? "",
    resolvedLinks: [],
    permissions: { edit: p.isManual, delete: p.isManual },
  };
}

/** «+ Nuova pagina manuale»: lo slug, se manca, lo ricava il server dal titolo. */
const createManualPage: Docs["createManualPage"] = async (repositoryId, input) => {
  const projectId = await projectOfRepository(repositoryId);
  if (!projectId) throw new Error("not_found");
  const created = await write(() =>
    appClient().docs.createManualPage(repositoryId, {
      title: input.title.trim(),
      ...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
      body: input.body,
    }),
  );
  return pageOf(created, projectId, repositoryId);
};

/**
 * Modifica una manuale: titolo e corpo. Lo slug di una pagina sul server non
 * cambia (l'indirizzo e il codice restano): uno slug diverso è `slug_fixed`.
 */
const updateManualPage: Docs["updateManualPage"] = async (id, patch) => {
  const where = pageWhere.get(id);
  if (!where) throw new Error("not_found");
  if (patch.slug !== undefined && patch.slug.trim() !== where.slug) throw new Error("slug_fixed");
  const projectId = await projectOfRepository(where.repositoryId);
  if (!projectId) throw new Error("not_found");
  const updated = await write(() =>
    appClient().docs.updateManualPage(where.repositoryId, id, {
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
    }),
  );
  return pageOf(updated, projectId, where.repositoryId);
};

const deleteManualPage: Docs["deleteManualPage"] = async (id) => {
  const where = pageWhere.get(id);
  if (!where) throw new Error("not_found");
  await write(() => appClient().docs.deleteManualPage(where.repositoryId, id));
  pageWhere.delete(id);
};

/** Lo stato della generazione riletto dopo un avvio o una ripresa. */
async function generationNow(repositoryId: string): Promise<DocGeneration> {
  return generationOf(await read(() => appClient().docs.status(repositoryId)));
}

const startGeneration: Docs["startGeneration"] = async (repositoryId) => {
  await write(() => appClient().docs.generate(repositoryId));
  return generationNow(repositoryId);
};

const resumeGeneration: Docs["resumeGeneration"] = async (repositoryId) => {
  await write(() => appClient().docs.resume(repositoryId));
  return generationNow(repositoryId);
};

/** Gli stati attraversati: è uno strumento del prototipo (lo stato finto); qui nessuna storia. */
const generationHistory: Docs["generationHistory"] = () => [];

/** Nel prototipo aspetta le generazioni finte; qui non c'è niente da aspettare. */
const whenDocsIdle: Docs["whenDocsIdle"] = async () => undefined;

// --- la chat dei Docs (passo 2c) ----------------------------------------------------

/**
 * Una domanda alla chat dei Docs, del progetto o di un repository. Come il
 * prototipo: la risposta intera (`stream=false`), e ogni domanda a sé (nessuna
 * sessione che continua). Le pagine citate diventano citazioni `doc` col
 * codice e il link; 503 `chat_unavailable` se l'istanza non ha un provider.
 */
const askDocs: Docs["askDocs"] = async ({ projectId, repositoryId, question }) => {
  let out;
  try {
    out = repositoryId
      ? await appClient().docs.chat(repositoryId, { message: question })
      : await appClient().docs.projectChat(projectId, { message: question });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 503 || error.code === "chat_unavailable") throw new Error("chat_unavailable");
      if (error.status === 404) throw new Error("not_found");
      if (error.status === 403) throw new Error("forbidden");
    }
    throw error;
  }
  const refs = out.sources.map((s) => {
    const id = s.code ?? `${s.repositoryId}/${s.slug}`;
    rememberDocCitation({ id, label: s.title, projectId, code: s.code, doc: { repositorySlug: s.repositorySlug, slug: s.slug } });
    return { kind: "doc" as const, id };
  });
  return {
    answeredAt: new Date().toISOString(),
    text: out.answer,
    refs,
    sources: out.sources.map((s, i) => ({ pageId: refs[i]!.id, repositoryName: s.repositoryName })),
  };
};

/** Le funzioni dei passi 2a, 2b e 2c; il grafo resta «non integrato» fino al passo 2d. */
export const docsFunctions: Partial<Docs> = {
  DOC_KINDS,
  listDocSpaces,
  getDocSpace,
  listDocTree,
  getDocPage,
  recordDocView,
  getRepoBrief,
  searchDocs,
  getProjectDocsHome,
  createManualPage,
  updateManualPage,
  deleteManualPage,
  startGeneration,
  resumeGeneration,
  generationHistory,
  whenDocsIdle,
  askDocs,
};

void notIntegrated;
export const docs: Docs = partialNamespace<Docs>("docs", docsFunctions);
