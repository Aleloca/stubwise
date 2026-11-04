import type { SeenStallReason, StalledProject } from "../../../data/types";
import { bulleted, labelled, resulted, type Answer } from "../answers";
import type { IntentContext, T } from "../context";
import { findProject, isHowToQuestion, normalize, stripCourtesy } from "../parse";

// S2 (area 10b, Task 6): «quali progetti sono fermi e perché?». La prima
// riga risponde col numero calcolato (`listStalledProjects`, cioè `stallOf`
// come il blocco «Stalled»), poi una riga per progetto, una «Hypothesis» a
// sé quando la deduzione ha le sue condizioni e «Details» con la soglia.
// L'invisibile non esiste: nessuna frase conta o nomina ciò che chi chiede
// non vede, e nessuna dice «solo quelli che vedi».

/** L'elenco dei fermi di All projects (`PortfolioStalled`). */
export const STALLED_LIST_ROUTE = "#/projects?view=stalled";

const STALLED_WORD =
  /\b(stuck|stalled|stalling|blocked|fermi|ferme|ferma|fermo|bloccati|bloccate|impantanati)\b/;
const SUBJECT = /\b(projects?|tasks?|progetti|progetto|task)\b/;
/** «Ferma…», «stop…» in testa sono un comando (fermare Claude o una task), non una domanda. */
const COMMAND = /^(ferma|fermala|fermalo|stop|block|blocca|segna|mark)\b/;
const TASK_CODE = /\b[a-z]{2,4}-\d+\b/i;

/** «which projects are stuck?», «quali task sono ferme in ACQ, e perché?». */
export function isStalledQuestion(text: string): boolean {
  const plain = normalize(text);
  const { command } = stripCourtesy(plain);
  // «Come si segna una task come ferma?» è una domanda per `howto` (ruling T6 I1).
  if (isHowToQuestion(text) || COMMAND.test(command) || TASK_CODE.test(text)) return false;
  return STALLED_WORD.test(plain) && SUBJECT.test(plain);
}

export async function stalled(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  // Col contesto di un progetto (l'Overview, il chip) o un progetto nominato,
  // la risposta è di quel progetto (P16, [SG 3]).
  const { project, named } = findProject(text, await read.listProjects(), ctx.contextProjectId);
  if (named && !project) {
    return { actions: [], text: t("claude.answers.stalled.notFound", { code: named }) };
  }
  const rows = await read.listStalledProjects(project?.id ?? null);
  const actions = [
    {
      tool: "list_tickets",
      ...labelled(
        t,
        project ? "claude.answers.actions.readStalledIn" : "claude.answers.actions.readStalled",
        project ? { code: project.code } : undefined,
      ),
      ...resulted(t, "claude.answers.actions.found", {
        count: rows.reduce((n, r) => n + r.stalled, 0),
      }),
    },
  ];
  if (rows.length === 0) {
    return {
      actions,
      text: project
        ? t("claude.answers.stalled.noneIn", { code: project.code })
        : t("claude.answers.stalled.none"),
    };
  }
  const reasons = await reasonWords(ctx, rows);
  const shown = rows.slice(0, 5);
  const body =
    rows.length === 1
      ? sentence(t, rows[0]!, reasons(rows[0]!.oldest.reason))
      : [
          t("claude.answers.stalled.many", { count: rows.length }),
          "",
          bulleted(
            t,
            rows.map((r) => line(t, r, reasons(r.oldest.reason))),
            5,
            { route: STALLED_LIST_ROUTE },
          ),
        ].join("\n");
  const aside: NonNullable<Answer["aside"]> = [];
  // La deduzione (mai nella prima riga): la più vecchia non cambia e non ha
  // una settimana. Una sola, sul primo progetto mostrato che la permette.
  const outOfPlan = shown.find((r) => r.oldest.reason.kind === "idle" && !r.oldest.plannedWeek);
  if (outOfPlan) {
    aside.push({
      kind: "hypothesis",
      text: t("claude.answers.stalled.hypothesis", { task: outOfPlan.oldest.taskCode }),
    });
  }
  aside.push({ kind: "details", text: details(t, shown) });
  return {
    actions,
    text: body,
    aside,
    refs: shown.map((r) => ({ kind: "project" as const, id: r.projectId })),
  };
}

/** «ACQ has 4 stalled tasks, the oldest for 12 days (…)»: un progetto solo, niente elenco. */
function sentence(t: T, r: StalledProject, reason: string): string {
  const days = t("claude.answers.stalled.days", { count: r.oldest.days });
  return r.stalled === 1
    ? t("claude.answers.stalled.oneTask", { code: r.code, days, reason })
    : t("claude.answers.stalled.one", { code: r.code, count: r.stalled, days, reason });
}

/** «**ACQ** — 4 stalled tasks, the oldest for 12 days (…)». */
function line(t: T, r: StalledProject, reason: string): string {
  const days = t("claude.answers.stalled.days", { count: r.oldest.days });
  return r.stalled === 1
    ? t("claude.answers.stalled.lineOne", { code: r.code, days, reason })
    : t("claude.answers.stalled.line", { code: r.code, count: r.stalled, days, reason });
}

/** Come è contato: la soglia del primo progetto, o che cambiano da progetto a progetto ([SC 3]). */
function details(t: T, shown: StalledProject[]): string {
  const first = shown[0]!;
  const same = shown.every((r) => r.thresholdDays === first.thresholdDays);
  return same
    ? t("claude.answers.stalled.details", {
        code: first.code,
        days: t("claude.answers.stalled.days", { count: first.thresholdDays }),
      })
    : t("claude.answers.stalled.detailsMixed");
}

/**
 * Le parole del motivo, al minuscolo come nel blocco «Stalled» del polso: la
 * persona e la task che blocca le nomina solo se le ha (il livello dati le
 * toglie se chi chiede non le vede).
 */
async function reasonWords(
  ctx: IntentContext,
  rows: StalledProject[],
): Promise<(r: SeenStallReason) => string> {
  const { read, t } = ctx;
  const needsPeople = rows.some((r) => r.oldest.reason.kind === "decision");
  const needsTasks = rows.some((r) => r.oldest.reason.kind === "blocked_by");
  const [people, tasks] = await Promise.all([
    needsPeople ? read.listPeople() : Promise.resolve([]),
    needsTasks ? read.listTasks() : Promise.resolve([]),
  ]);
  const name = (id: string | undefined) => people.find((p) => p.id === id)?.name;
  const code = (id: string | undefined) => tasks.find((x) => x.id === id)?.code;
  return (r) => {
    switch (r.kind) {
      case "manual":
        return t("claude.answers.stalled.reason.manual", { reason: r.reason });
      case "decision": {
        const who = name(r.personId);
        return who
          ? t("claude.answers.stalled.reason.decision", { name: who })
          : t("claude.answers.stalled.reason.decisionAnyone");
      }
      case "blocked_by": {
        const by = code(r.taskId);
        return by
          ? t("claude.answers.stalled.reason.blockedBy", { code: by })
          : t("claude.answers.stalled.reason.blockedByAnother");
      }
      default:
        return t(`claude.answers.stalled.reason.${r.kind}`);
    }
  };
}
