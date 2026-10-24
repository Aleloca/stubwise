import type { DocPage, Project } from "../../../data/types";
import { labelled, resulted, type Answer } from "../answers";
import type { IntentContext } from "../context";
import { findProject, normalize, topicWords } from "../parse";

const HOWTO_LEAD =
  /^.*?\b(how (?:do|does|can|to|is|are)|come (?:funziona|funzionano|si|faccio|posso|fare))\b/i;

/**
 * «Come funziona <tema> [in <progetto>]»: cerca nei Docs del progetto (o di
 * tutti i progetti visibili con i Docs) e risponde con le pagine, citate.
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
  const pages = (await Promise.all(scope.map((p) => read.listDocPages(p.id)))).flat();
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
  const codeOf = (page: DocPage) => projects.find((p) => p.id === page.projectId)?.code ?? "";
  const body = found.flatMap((page, i) => [
    ...(i > 0 ? [""] : []),
    t("claude.answers.howto.found", { code: codeOf(page), title: page.title, path: page.path }),
    "",
    `> ${page.excerpt}`,
  ]);
  return {
    actions: [action],
    text: body.join("\n"),
    refs: found.map((page) => ({ kind: "doc" as const, id: page.id })),
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
function rank(pages: DocPage[], words: string[]): DocPage[] {
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
