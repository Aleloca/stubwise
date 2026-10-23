import type { AppNotification } from "../types";
import { daysFromToday } from "./dates";
import { PROJECTS } from "./projects";

// [kind, codice progetto, titolo, corpo, ore fa, letta]
type Row = [string, string | null, string, string, number, boolean];

const ROWS: Row[] = [
  [
    "job.plan_review",
    "MKX",
    "Plan ready for review",
    "Claude drafted a plan for MKX-2 and is waiting for your approval.",
    1,
    false,
  ],
  [
    "job.awaiting_input",
    "AUD",
    "Claude has a question",
    "Which payment provider should the checkout use?",
    2,
    false,
  ],
  [
    "job.pr_opened",
    "STW",
    "Pull request opened",
    "A pull request for STW-3 is ready to be reviewed.",
    3,
    false,
  ],
  [
    "review.completed",
    "STW",
    "Review completed",
    "The automatic review of STW-1 found 2 minor issues.",
    5,
    true,
  ],
  [
    "ticket.created",
    "CBV",
    "New request from the client",
    "Cantina Bellavista asked for a gift-box option in the store.",
    6,
    false,
  ],
  [
    "request.created",
    "OLV",
    "New request",
    "A teammate opened a request about the homepage banner.",
    8,
    true,
  ],
  [
    "project.pulse",
    "LMR",
    "This project looks quiet",
    "Nothing moved for 9 days. Claude has 2 ideas to restart it.",
    20,
    false,
  ],
  [
    "project.brief",
    "VDM",
    "Weekly brief ready",
    "Where the project stands, what changed and what is blocked.",
    26,
    true,
  ],
  [
    "job.failed",
    "TLM",
    "A run failed",
    "The tests of TLM-4 did not pass after the second attempt.",
    30,
    false,
  ],
  [
    "job.held",
    "CRT",
    "A run is on hold",
    "The run for CRT-2 is waiting for a free slot.",
    33,
    true,
  ],
  [
    "job.pr_closed",
    "AUD",
    "Pull request closed",
    "The pull request for AUD-5 was closed without merging.",
    48,
    true,
  ],
  [
    "monitor.alert",
    "ACQ",
    "Server alert",
    "High memory usage on the production server.",
    52,
    false,
  ],
  ["monitor.recovered", "ACQ", "Server recovered", "Memory usage is back to normal.", 50, true],
  [
    "job.budget_held",
    "ELS",
    "Budget limit reached",
    "ELS-3 is paused until a maintainer raises the budget.",
    60,
    false,
  ],
  [
    "docs.nightly_attention",
    "STW",
    "Docs need attention",
    "Two pages could not be updated overnight.",
    72,
    true,
  ],
  [
    "google.proposal",
    null,
    "A new email may need a task",
    "An email from a client mentions a deadline.",
    4,
    false,
  ],
  ["security.alert", null, "New sign-in", "Your account was used from a new device.", 90, true],
  [
    "ticket.created",
    "FRL",
    "New request from the client",
    "Forneria Rossi & Lari asked to change the delivery slots.",
    100,
    true,
  ],
  [
    "job.plan_review",
    "SAL",
    "Plan ready for review",
    "Claude drafted a plan for SAL-1 and is waiting for your approval.",
    7,
    false,
  ],
  ["project.pulse", "BTG", "This project looks quiet", "Nothing moved for 12 days.", 120, true],
];

function projectlessLink(kind: string): string {
  if (kind === "google.proposal" || kind === "google.proposal_handed") return "#/mail";
  if (kind === "security.alert") return "#/preferences";
  return "#/home";
}

export const NOTIFICATIONS: AppNotification[] = ROWS.map(
  ([kind, code, title, body, hoursAgo, read], i) => {
    const project = code ? PROJECTS.find((p) => p.code === code) : undefined;
    const createdAt = `${daysFromToday(-Math.floor(hoursAgo / 24))}T${String(
      Math.max(0, 22 - (hoursAgo % 24)),
    ).padStart(2, "0")}:00:00Z`;
    return {
      id: `n-${i + 1}`,
      kind,
      projectId: project?.id ?? null,
      title,
      body,
      createdAt,
      read,
      archived: false,
      snoozedUntil: null,
      link: project ? `#/p/${project.code}` : projectlessLink(kind),
    };
  },
);
