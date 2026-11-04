import type { ClaudeBusyReason, ProposalNote, ProposedAction } from "../../../data/types";
import { labelled, resulted, summarized, utterance, type Answer } from "../answers";
import type { IntentContext, T } from "../context";
import { isHowToQuestion, normalize, QUESTION, stripCourtesy } from "../parse";

// S4 (area 10b, Task 7): «archivia i progetti senza attività da 3 mesi». I
// candidati li calcola il livello dati (`listArchiveCandidates`, con le
// letture di chi chiede); qui solo la forma: la prima riga col numero, una
// scheda B con un `archiveProject` per progetto e il suo perché in un fatto
// (`why`), le righe a parte per i progetti occupati e per quelli che chi
// chiede vede ma non gestisce. L'invisibile non esiste: nessuna frase lo
// nomina o lo conta. Confermare è tutto o niente (`executeGroup`).

const ARCHIVE = /^(archive|archivia)\b/;
const ARCHIVE_INF = /^(archiviare)\b/;
const PROJECTS = /\b(projects?|progett[oi])\b/;
const INACTIVE =
  /\b(no activity|without activity|inactive|idle|quiet|dormant|stalled|stuck|senza attivita|inattiv[oi]|fermi|dormienti)\b/;
const TASK_CODE = /\b[a-z]{2,4}-\d+\b/i;

type Period = { count: number; unit: "days" | "weeks" | "months" };

/** Senza un periodo, «3 mesi»: `INACTIVE_DAYS` del livello dati. */
const DEFAULT_PERIOD: Period = { count: 3, unit: "months" };
const DAYS: Record<Period["unit"], number> = { days: 1, weeks: 7, months: 30 };

/** «archive projects with no activity for 90 days», «archivia i progetti fermi». */
export function isArchiveRequest(text: string): boolean {
  // «Come si archivia un progetto?» resta a `howto` (ruling T6 I1).
  if (isHowToQuestion(text) || TASK_CODE.test(text)) return false;
  const { polite, command } = stripCourtesy(normalize(text));
  if (!polite && QUESTION.test(command)) return false;
  const verb = ARCHIVE.test(command) || (polite && ARCHIVE_INF.test(command));
  return verb && PROJECTS.test(command) && (INACTIVE.test(command) || periodOf(command) !== null);
}

/** Il periodo chiesto («90 days», «3 mesi», «a month»), come chiesto: la risposta lo ripete. */
function periodOf(plain: string): Period | null {
  const m = /\b(\d{1,4}|a|an|one|un|uno|una)\s*(days?|giorn[oi]|weeks?|settiman[ae]|months?|mes[ei])\b/.exec(
    plain,
  );
  if (!m) return null;
  const count = /^\d+$/.test(m[1]!) ? Number(m[1]) : 1;
  const unit = /^(days?|giorn)/.test(m[2]!)
    ? "days"
    : /^(weeks?|settiman)/.test(m[2]!)
      ? "weeks"
      : "months";
  return count > 0 ? { count, unit } : null;
}

export async function archive(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  const period = periodOf(normalize(text)) ?? DEFAULT_PERIOD;
  const said = t(`claude.answers.archive.period.${period.unit}`, { count: period.count });
  const view = await read.listArchiveCandidates(period.count * DAYS[period.unit]);
  const found = view.candidates.length + view.busy.length + view.notManageable;
  const actions = [
    {
      tool: "list_projects",
      ...labelled(t, "claude.answers.actions.readInactive"),
      ...resulted(t, "claude.answers.actions.projects", { count: found }),
    },
  ];
  const notes: ProposalNote[] = [
    ...(view.notManageable > 0
      ? [
          {
            kind: "not_manageable" as const,
            count: view.notManageable,
            whoAction: "manageProjectSettings",
            codes: [...view.notManageableCodes],
          },
        ]
      : []),
    ...view.busy.map((b) => ({ kind: "busy" as const, code: b.code, reasons: b.reasons })),
  ];

  if (view.candidates.length === 0) {
    // Senza scheda le righe a parte le dice il testo (ruling del controller,
    // Q1), e i codici che nominano sono riferimenti apribili (fix round 1).
    const lines = notes.map((n) => noteLine(t, n));
    const named = new Set([...view.notManageableCodes, ...view.busy.map((b) => b.code)]);
    const refs = (await read.listProjects())
      .filter((p) => named.has(p.code))
      .map((p) => ({ kind: "project" as const, id: p.id }));
    return {
      actions,
      text: [t("claude.answers.archive.none", { period: said }), ...lines].join("\n\n"),
      ...(refs.length > 0 ? { refs } : {}),
    };
  }

  const proposal: ProposedAction[] = view.candidates.map((c) => ({
    fn: "archiveProject",
    args: { projectId: c.projectId },
    ...summarized(t, "claude.answers.archive.summary", { code: c.code, name: c.name }),
    // Il perché in un fatto: la data dell'ultima attività, letta nella lingua di chi guarda.
    ...(c.lastActivity ? { why: utterance("claude.answers.archive.why", { date: c.lastActivity }) } : {}),
  }));
  const first =
    view.candidates.length === 1
      ? t("claude.answers.archive.one", { code: view.candidates[0]!.code, period: said })
      : t("claude.answers.archive.many", { count: view.candidates.length, period: said });
  return {
    actions,
    text: first,
    proposal,
    ...(notes.length > 0 ? { notes } : {}),
    refs: view.candidates.map((c) => ({ kind: "project" as const, id: c.projectId })),
  };
}

/** Una riga a parte come testo di Claude (solo senza scheda): il «Who?» per progetto, le ragioni di `busy`. */
function noteLine(t: T, note: ProposalNote): string {
  if (note.kind === "not_manageable") {
    const head = t("claude.answers.archive.notManageable", { count: note.count });
    const codes = note.codes ?? [];
    const who = (code: string) => `[${t("claude.answers.refused.who")}](who:${note.whoAction}/${code})`;
    // Ogni progetto col suo codice e il suo «Who?», anche uno solo ([SC 11], fix round 1).
    if (codes.length === 0) return head;
    return `${head}: ${codes.map((code) => `${code} · ${who(code)}`).join(", ")}`;
  }
  return note.reasons.map((r) => busyLine(t, note.code, r)).join("\n\n");
}

/** «**BSC** has Claude working on **BSC-3**: it can be archived when that ends». */
function busyLine(t: T, code: string, r: ClaudeBusyReason): string {
  const K = "claude.answers.archive.busy";
  switch (r.kind) {
    case "claude_session": {
      const key = r.waiting ? "claude_sessionWaiting" : "claude_session";
      return r.code
        ? t(`${K}.${key}`, { code, task: r.code })
        : t(`${K}.${key}NoCode`, { code });
    }
    case "open_pr":
      return r.repo && r.number !== null
        ? t(`${K}.open_pr`, { code, pr: `${r.repo}#${r.number}` })
        : t(`${K}.open_prNoCode`, { code });
    case "server_fix":
      return t(`${K}.server_fix`, { code, server: r.serverCode });
    case "release_fix":
      return t(`${K}.release`, { code, release: r.releaseCode });
    case "release":
      return t(`${K}.release`, { code, release: r.code });
  }
}
