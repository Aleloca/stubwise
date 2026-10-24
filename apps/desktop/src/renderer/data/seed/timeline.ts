import type { DailyReport, PullRequestEvent } from "../types";
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

export const DAILY_REPORTS: DailyReport[] = REPORTS.map(([code, days, summary]) => ({
  id: `rep-${code.toLowerCase()}-${days}`,
  projectId: `prj-${code.toLowerCase()}`,
  date: daysFromToday(-days),
  summary,
}));

// [codice, numero della task, evento, giorni fa, numero della PR]
type PrRow = [string, number, PullRequestEvent["kind"], number, number];

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
];

export const PULL_REQUEST_EVENTS: PullRequestEvent[] = PRS.map(
  ([code, task, kind, days, number], i) => ({
    id: `pr-${code.toLowerCase()}-${i + 1}`,
    projectId: `prj-${code.toLowerCase()}`,
    taskId: `t-${code.toLowerCase()}-${task}`,
    kind,
    at: `${daysFromToday(-days)}T${String(11 + (i % 5)).padStart(2, "0")}:30:00Z`,
    number,
  }),
);
