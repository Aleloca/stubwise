import type { DailyReport, PrFact, PullRequestEvent } from "../types";
import { daysFromToday } from "./dates";

// Le voci della cronologia che non nascono da task, traguardi, decisioni o
// brief: i report giornalieri (narrativa generata dai commit della
// giornata, solo per i progetti con un repository: AUD e STW) e gli eventi
// delle pull request.

// [codice, giorni fa, sintesi (null = la sintesi non è riuscita)]
type ReportRow = [string, number, string | null];

// prettier-ignore
const REPORTS: ReportRow[] = [
  ["AUD", 1, "Work on the call history export: the spreadsheet columns and the download button."],
  ["AUD", 2, "Small fixes to the onboarding checklist and a new test for the import preview."],
  ["AUD", 3, "The timezone fix for scheduled callbacks was merged."],
  ["AUD", 6, null],
  ["AUD", 7, "Billing email templates moved to the new invoice layout."],
  ["AUD", 8, "Profiling of the dashboard for large accounts; no changes merged."],
  ["AUD", 15, "The legacy SMS module was removed with its settings page."],
  ["STW", 0, "The minimum window size crash was reproduced; a fix is waiting for approval."],
  ["STW", 1, "Board view: keyboard moves between columns and the drop announcement."],
  ["STW", 2, "The fake data layer now knows who is looking; every query key carries the person."],
  ["STW", 3, "Department homes: the first blocks and the editor."],
  ["STW", 6, "Focus ring fix in the notifications panel."],
  ["STW", 9, "First version of the board view, closed in favour of a smaller change."],
  ["STW", 13, "Icons for the rail and the project tiles."],
];

/**
 * Quando è stato scritto un report: dal giro notturno, alle 02:00 (UTC) del
 * giorno dopo. Quello di oggi di STW è stato generato a mano a metà mattina,
 * e due commit sono arrivati dopo: la rassegna lo dice («2 new commits not
 * included»).
 */
function generatedAtOf(code: string, days: number): string {
  if (code === "STW" && days === 0) return `${daysFromToday(0)}T10:00:00Z`;
  return `${daysFromToday(-days + 1)}T02:00:00Z`;
}

export const DAILY_REPORTS: DailyReport[] = REPORTS.map(([code, days, summary]) => ({
  id: `rep-${code.toLowerCase()}-${days}`,
  projectId: `prj-${code.toLowerCase()}`,
  date: daysFromToday(-days),
  summary,
  generatedAt: generatedAtOf(code, days),
}));

/** Il repository principale di ogni progetto con un repository. */
const MAIN_REPO: Record<string, string> = { AUD: "audin/audin-app", STW: "stubwise/stubwise" };

// [codice, numero della task, evento, giorni fa, numero della PR, repository (assente = il principale)]
type PrRow = [string, number, PullRequestEvent["kind"], number, number, string?];

// STW-3 tocca due repository: la PR #411 sull'app e la #58 sulla guida.
// prettier-ignore
const PRS: PrRow[] = [
  ["AUD", 12, "pr_opened", 17, 214],
  ["AUD", 12, "pr_merged", 15, 214],
  ["AUD", 8, "pr_opened", 5, 231],
  ["AUD", 8, "pr_merged", 3, 231],
  ["STW", 9, "pr_opened", 8, 402],
  ["STW", 9, "pr_merged", 6, 402],
  ["STW", 3, "pr_opened", 11, 398],
  ["STW", 3, "pr_closed", 9, 398],
  ["STW", 1, "pr_opened", 4, 405],
  ["STW", 1, "pr_merged", 2, 405],
  ["STW", 3, "pr_opened", 1, 411],
  ["STW", 3, "pr_opened", 3, 58, "stubwise/guide"],
  // La PR di AUD-2 pronta per il rilascio (area 8a, `OPEN_PRS`).
  ["AUD", 2, "pr_opened", 1, 244],
];

export const PULL_REQUEST_EVENTS: PullRequestEvent[] = PRS.map(
  ([code, task, kind, days, number, repo], i) => ({
    id: `pr-${code.toLowerCase()}-${i + 1}`,
    projectId: `prj-${code.toLowerCase()}`,
    taskId: `t-${code.toLowerCase()}-${task}`,
    kind,
    at: `${daysFromToday(-days)}T${String(11 + (i % 5)).padStart(2, "0")}:30:00Z`,
    number,
    repo: repo ?? MAIN_REPO[code]!,
  }),
);

/**
 * I fatti esterni delle PR aperte (il ciclo NON si salva: lo deriva
 * `prCycles` dalle sessioni). La #411 di STW-3: la review ha chiesto
 * modifiche ieri, e la correzione è in corso. La #58 sulla guida: dopo la
 * terza correzione automatica la review chiede ancora modifiche (con il
 * tetto di STW a tre, il ciclo è fermo).
 */
export const PR_FACTS: PrFact[] = [
  {
    taskId: "t-stw-3",
    repo: "stubwise/stubwise",
    number: 411,
    review: {
      verdict: "changes_requested",
      at: `${daysFromToday(-1)}T12:10:00Z`,
      byId: null,
      on: null,
    },
    branchProtected: false,
    queued: false,
  },
  {
    taskId: "t-stw-3",
    repo: "stubwise/guide",
    number: 58,
    review: {
      verdict: "changes_requested",
      at: `${daysFromToday(-3)}T17:40:00Z`,
      byId: null,
      on: null,
    },
    branchProtected: false,
    queued: false,
  },
];
