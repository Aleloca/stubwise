import type { CitationRef, DocPage, ProductPage, Project } from "../../../data/types";
import { excerptOfBlocks, plainTextOf } from "../../productDocs/blocks";
import { labelled, resulted, type Answer } from "../answers";
import type { IntentContext, T } from "../context";
import { findProject, HOWTO_STATE_VERBS, HOWTO_VERBS, normalize, topicWords } from "../parse";

const HOWTO_LEAD = new RegExp(`^.*?\\b(?:${HOWTO_VERBS}|${HOWTO_STATE_VERBS})\\b`, "i");

/**
 * «Come funziona <tema> [in <progetto>]»: cerca nei Docs del progetto (o di
 * tutti i progetti visibili con i Docs) e risponde con le pagine, citate per
 * codice (`AUD-D3`) come nella chat dei Docs.
 * Se i Docs non ne parlano lo dice: non inventa.
 */
export async function howto(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  const projects = await read.listProjects();
  const { project, named } = findProject(text, projects, ctx.contextProjectId);
  const topic = howtoTopic(text, project);
  const words = topicWords(topic);
  if (words.length === 0) return { actions: [], text: t("claude.answers.howto.noTopic") };
  if (named && !project) {
    return { actions: [], text: t("claude.answers.status.projectNotFound", { code: named }) };
  }
  if (project && !project.modules.includes("docs")) {
    return { actions: [], text: t("claude.answers.howto.noDocs", { code: project.code }) };
  }

  const scope = project ? [project] : projects.filter((p) => p.modules.includes("docs"));
  const inScope = new Set(scope.map((p) => p.id));
  // 11b (Task 8): anche le pagine di prodotto, prima di quelle dei
  // repository come nella chat dei Docs; le legge `listProductPages` come
  // chi chiede, quindi una pagina che non legge non c'è.
  const product = (await read.listProductPages(project?.id ?? null))
    .filter((p) => inScope.has(p.projectId))
    .map((p) => ({ ...productAnswerPage(p, ""), projectId: p.projectId, product: true }));
  const repo = (await Promise.all(scope.map((p) => read.listDocPages(p.id))))
    .flat()
    .map((p) => ({ ...p, product: false }));
  const pages: { id: string; code: string; title: string; path: string; excerpt: string; projectId: string; product: boolean }[] = [
    ...product,
    ...repo,
  ];
  const found = rank(pages, words).slice(0, 2);
  const action = {
    tool: "search_project_docs",
    ...(project
      ? labelled(t, "claude.answers.actions.searchDocs", { code: project.code, topic })
      : labelled(t, "claude.answers.actions.searchAllDocs", { topic })),
    ...resulted(t, "claude.answers.actions.pages", { count: found.length }),
  };
  if (found.length === 0) {
    return {
      actions: [action],
      text: project
        ? t("claude.answers.howto.nothing", { code: project.code, topic })
        : t("claude.answers.howto.nothingAll", { topic }),
    };
  }
  const codeOf = (page: { projectId: string }) =>
    projects.find((p) => p.id === page.projectId)?.code ?? "";
  const body = found.flatMap((page, i) => [
    ...(i > 0 ? [""] : []),
    page.product
      ? t("claude.answers.howto.foundProduct", {
          code: codeOf(page),
          pageCode: page.code,
          title: page.title,
        })
      : t("claude.answers.howto.found", {
          code: codeOf(page),
          pageCode: page.code,
          title: page.title,
          path: page.path,
        }),
    "",
    `> ${page.excerpt}`,
  ]);
  return {
    actions: [action],
    text: body.join("\n"),
    refs: found.map((page) => ({ kind: "doc" as const, id: page.id })),
  };
}

/**
 * Una pagina come la legge la chat dei Docs: dei repository (`docAnswerPage`)
 * o di prodotto (`productAnswerPage`). `spaceName` è da dove viene — il nome
 * del repository, o quello dello spazio Prodotto —; `path` è il percorso
 * nell'albero della categoria (`""` per una pagina di prodotto); `body` il
 * testo semplice.
 */
export interface DocsAnswerPage {
  id: string;
  code: string;
  title: string;
  path: string;
  excerpt: string;
  body: string;
  spaceName: string;
}

/** Una pagina dei Docs di un repository per la chat. */
export function docAnswerPage(page: DocPage, repoName: string): DocsAnswerPage {
  return {
    id: page.id,
    code: page.code,
    title: page.title,
    path: page.path,
    excerpt: page.excerpt,
    body: page.body,
    spaceName: repoName,
  };
}

/** Una pagina di prodotto per la chat: l'estratto e il testo dai blocchi, senza segni. */
export function productAnswerPage(page: ProductPage, spaceName: string): DocsAnswerPage {
  return {
    id: page.id,
    code: page.code,
    title: page.title,
    path: "",
    excerpt: excerptOfBlocks(page.blocks),
    body: plainTextOf(page.blocks),
    spaceName,
  };
}

/**
 * La risposta della chat dei Docs (del progetto o di un repository): ogni
 * domanda è una ricerca nelle pagine che chi chiede legge — `pages` arriva
 * già filtrato —, e la risposta cita le pagine per codice (`AUD-D1`) col
 * loro spazio. Se le pagine non ne parlano lo dice: non inventa.
 * `scope` è come si chiama il perimetro («AUD», «audin-app»).
 */
export function docsAnswer(
  text: string,
  pages: readonly DocsAnswerPage[],
  t: T,
  { scope }: { scope: string },
): { text: string; refs: CitationRef[]; pages: DocsAnswerPage[] } {
  const topic = howtoTopic(text);
  const words = topicWords(topic);
  if (words.length === 0) {
    return { text: t("claude.answers.docs.noTopic"), refs: [], pages: [] };
  }
  const found = rank([...pages], words).slice(0, 2);
  if (found.length === 0) {
    return { text: t("claude.answers.docs.nothing", { scope, topic }), refs: [], pages: [] };
  }
  const body = found.flatMap((page, i) => [
    ...(i > 0 ? [""] : []),
    t("claude.answers.docs.found", {
      code: page.code,
      title: page.title,
      repo: page.spaceName,
    }),
    "",
    `> ${page.excerpt}`,
  ]);
  return {
    text: body.join("\n"),
    refs: found.map((page) => ({ kind: "doc" as const, id: page.id })),
    pages: found,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Il tema detto con le parole di chi chiede, senza la domanda né il
 * progetto (codice, nome, prima parola del nome).
 */
export function howtoTopic(text: string, project: Project | null = null): string {
  let topic = text.replace(HOWTO_LEAD, "");
  if (project) {
    for (const name of [project.code, project.name, project.name.split(" ")[0]!].map(escape)) {
      topic = topic
        .replace(new RegExp(`\\b(in|on|for|di|del|nel|per)\\s+${name}\\b`, "gi"), "")
        .replace(new RegExp(`\\b${name}\\b`, "gi"), "");
    }
  }
  return topic
    .replace(/\b(work|works|funziona|funzionano)\b/gi, "")
    .replace(/[?!.]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Le pagine per pertinenza: ogni parola del tema che compare (per radice,
 * le prime 5 lettere delle parole lunghe) vale 1, 2 se è nel titolo.
 */
function rank<P extends { title: string; path: string; excerpt: string }>(
  pages: P[],
  words: string[],
): P[] {
  const roots = words.map((w) => (w.length > 5 ? w.slice(0, 5) : w));
  return pages
    .map((page) => {
      const title = normalize(page.title);
      const body = normalize(`${page.path} ${page.excerpt}`);
      const score = roots.reduce(
        (s, r) => s + (title.includes(r) ? 2 : body.includes(r) ? 1 : 0),
        0,
      );
      return { page, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.page);
}
