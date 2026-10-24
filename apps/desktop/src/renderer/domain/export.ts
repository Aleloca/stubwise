import type { ActivityEntry, DecisionRequest, ProjectRequest, Task } from "../data/model";
import { weekLabel } from "./weeks";

// L'esportazione in Markdown di una task e di una richiesta («Copy as
// Markdown», «Download .md»), e il testo semplice del brief («Copy as
// text»). Funzioni pure: chi chiama passa i nomi già risolti e la `t` della
// lingua di chi esporta — le etichette escono nella SUA lingua, i contenuti
// (titolo, descrizione, commenti) come li hanno scritti.

type T = (key: string, options?: Record<string, unknown>) => string;

/** Ciò che serve a dire una task a parole: i nomi, le decisioni, l'attività. */
export interface TaskExportContext {
  language: string;
  projectCode: string;
  projectName: string;
  statusName: string | null;
  departmentName: string | null;
  milestoneName: string | null;
  personName: (id: string | null) => string | null;
  decisions: DecisionRequest[];
  activity: ActivityEntry[];
}

export interface RequestExportContext {
  language: string;
  projectCode: string;
  projectName: string;
  personName: (id: string | null) => string | null;
  /** Le task nate dalla richiesta, con lo stato a cui sono. */
  tasks: { code: string; title: string; statusName: string | null }[];
}

/** «Oct 30, 2026»: con l'anno, perché un file esportato si rilegge fra mesi. */
function longDate(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

const field = (label: string, value: string) => `- **${label}:** ${value}`;

function sections(parts: (string | null)[]): string {
  return `${parts.filter((p): p is string => p !== null).join("\n\n")}\n`;
}

function decisionLine(d: DecisionRequest, ctx: TaskExportContext, t: T): string {
  const someone = t("taskUi.stall.someone");
  const name = (id: string | null) => ctx.personName(id) ?? someone;
  const head = `- **${d.question}** — `;
  if (d.answer) {
    const picked = d.answer.optionIndex !== null ? d.options[d.answer.optionIndex] : undefined;
    return (
      head +
      (picked !== undefined
        ? t("taskDetail.decisions.chose", { name: name(d.answer.byId), answer: picked })
        : t("taskDetail.decisions.answered", {
            name: name(d.answer.byId),
            answer: d.answer.text ?? "",
          }))
    );
  }
  if (d.withdrawnAt)
    return head + t("taskDetail.decisions.withdrawnBy", { name: name(d.askedById) });
  const line =
    head +
    [
      t("taskDetail.decisions.decides", { name: name(d.askedOfId) }),
      t("taskDetail.decisions.askedBy", {
        name: name(d.askedById),
        when: longDate(d.createdAt, ctx.language),
      }),
    ].join(" · ");
  return d.options.length
    ? `${line}\n  - ${t("export.options", { options: d.options.join(" · ") })}`
    : line;
}

/** Le decisioni chieste sulla task: prima le aperte, poi le chiuse (risposte o ritirate). */
function decisionsSection(ctx: TaskExportContext, t: T): string | null {
  if (ctx.decisions.length === 0) return null;
  const isOpen = (d: DecisionRequest) => d.answer === null && d.withdrawnAt === null;
  const byDate = [...ctx.decisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const open = byDate.filter(isOpen);
  const closed = byDate.filter((d) => !isOpen(d));
  const parts = [`## ${t("export.decisions")}`];
  if (open.length)
    parts.push(`### ${t("export.open")}\n\n${open.map((d) => decisionLine(d, ctx, t)).join("\n")}`);
  if (closed.length) {
    parts.push(
      `### ${t("export.closed")}\n\n${closed.map((d) => decisionLine(d, ctx, t)).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

/** I commenti, dal più vecchio; un eliminato resta al suo posto, senza testo. Niente cambi di campo. */
function commentsSection(activity: ActivityEntry[], ctx: TaskExportContext, t: T): string | null {
  const comments = activity
    .filter((a) => a.kind === "comment")
    .sort((a, b) => a.at.localeCompare(b.at));
  if (comments.length === 0) return null;
  const someone = t("taskUi.stall.someone");
  const one = (c: ActivityEntry) => {
    if (c.deletedAt) {
      return `_${t("taskDetail.activity.deleted", { name: ctx.personName(c.deletedById ?? null) ?? someone })}_`;
    }
    const author = c.authorId
      ? (ctx.personName(c.authorId) ?? someone)
      : t("taskDetail.activity.system");
    return `**${author}** · ${longDate(c.at, ctx.language)}\n\n${c.body ?? ""}`;
  };
  return [`## ${t("export.comments")}`, ...comments.map(one)].join("\n\n");
}

/** Una task in Markdown: titolo col codice, i campi, descrizione, decisioni, commenti. */
export function taskToMarkdown(task: Task, ctx: TaskExportContext, t: T): string {
  const f = (key: string) => t(`taskDetail.fields.${key}`);
  const week = task.plannedWeek
    ? `${task.plannedWeek.slice(task.plannedWeek.indexOf("-") + 1)} · ${weekLabel(task.plannedWeek, ctx.language)}`
    : t("tasks.groups.noWeek");
  const fields = [
    field(t("export.project"), `${ctx.projectCode} · ${ctx.projectName}`),
    field(f("status"), ctx.statusName ?? "—"),
    field(f("assignee"), ctx.personName(task.assigneeId) ?? t("taskUi.unassigned")),
    field(f("department"), ctx.departmentName ?? "—"),
    field(f("size"), task.size ?? t("taskUi.size.none")),
    field(f("due"), task.dueDate ? longDate(task.dueDate, ctx.language) : f("noDue")),
    field(f("week"), week),
    field(f("milestone"), ctx.milestoneName ?? t("tasks.groups.noMilestone")),
    field(f("type"), t(`taskDetail.types.${task.type}`)),
    field(f("priority"), t(`taskDetail.priorities.${task.priority}`)),
    field(f("labels"), task.labels.length ? task.labels.join(", ") : f("noLabels")),
  ];
  if (task.source && task.source !== "manual") {
    const occurrences = task.occurrences > 1 ? ` · ×${task.occurrences}` : "";
    fields.push(
      field(
        t("taskDetail.source.label"),
        t(`taskDetail.source.kinds.${task.source}`) + occurrences,
      ),
    );
  }
  const description = task.description.trim()
    ? task.description.trim()
    : `_${t("taskDetail.description.none")}_`;
  return sections([
    `# ${task.code} · ${task.title}`,
    fields.join("\n"),
    `## ${t("taskDetail.description.title")}\n\n${description}`,
    decisionsSection(ctx, t),
    commentsSection(ctx.activity, ctx, t),
  ]);
}

/** Una richiesta in Markdown: titolo, metadati, chi l'ha chiesta, descrizione, task nate. */
export function requestToMarkdown(
  request: ProjectRequest,
  ctx: RequestExportContext,
  t: T,
): string {
  const f = (key: string) => t(`requests.detail.fields.${key}`);
  const risk = request.risk
    ? t(`requests.risk.${request.risk}`) +
      (request.riskNote?.trim() ? ` — ${request.riskNote.trim()}` : "")
    : t("requests.risk.none");
  const who = request.requesterIds
    .map((id) => ctx.personName(id) ?? t("taskUi.stall.someone"))
    .join(", ");
  const description = request.description.trim()
    ? request.description.trim()
    : `_${t("requests.detail.noDescription")}_`;
  const tasks = ctx.tasks.length
    ? `## ${t("requests.detail.tasks")}\n\n${ctx.tasks
        .map((x) => `- ${x.code} · ${x.title}${x.statusName ? ` (${x.statusName})` : ""}`)
        .join("\n")}`
    : null;
  return sections([
    `# ${request.title}`,
    [
      field(t("export.project"), `${ctx.projectCode} · ${ctx.projectName}`),
      field(f("status"), t(`requests.status.${request.status}`)),
      field(f("urgency"), t(`requests.urgency.${request.urgency}`)),
      field(f("size"), request.size ?? t("taskUi.size.none")),
      field(f("risk"), risk),
      field(f("sent"), longDate(request.createdAt, ctx.language)),
      field(t("requests.detail.requesters"), who),
    ].join("\n"),
    `## ${t("requests.detail.description")}\n\n${description}`,
    tasks,
  ]);
}

export const taskFileName = (task: Pick<Task, "code">) => `${task.code}.md`;

/** «request-callback-reminders-by-email.md»: il titolo senza accenti né segni. */
export function requestFileName(request: Pick<ProjectRequest, "title">): string {
  const slug = request.title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug ? `request-${slug}.md` : "request.md";
}

/**
 * Il testo semplice di un markdown (il sottoinsieme di `Markdown.tsx`):
 * titoletti senza cancelletti, niente grassetto/corsivo/codice, i link
 * diventano il loro testo, i punti elenco restano «- ».
 */
export function markdownToText(source: string): string {
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^(\s*)[-*]\s+/, "$1- ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?![*\w])/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1"),
    )
    .join("\n")
    .trim();
}
