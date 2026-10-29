import type { AppNotification } from "../types";
import { ALERT_NOTIFICATIONS } from "./alerts";
import { daysFromToday } from "./dates";
import { PEOPLE } from "./people";
import { PROJECTS } from "./projects";
import { SERVER_ALERT_NOTIFICATIONS } from "./servers/alerts";
import { TASKS } from "./tasks";

/**
 * Codici degli eventi (proposta del prototipo: la specifica lascia aperti i
 * prefissi). Ogni notifica parte dal codice del suo OGGETTO:
 * - una task → il suo codice (`MKX-2`), con la striscia del suo reparto;
 * - un progetto intero (polso, brief) → il codice del progetto (`LMR`);
 * - tutto il resto → `<FAMIGLIA>-<n>`, numerato per famiglia in tutta
 *   l'istanza, stabile per oggetto (allarme e rientro dello stesso server
 *   sono entrambi `SRV-1`): vedi `EVENT_PREFIXES`.
 */
export const EVENT_PREFIXES = [
  "SEC", // un evento di sicurezza dell'account, senza progetto
  "REQ", // una richiesta (voce di backlog)
  "SRV", // un server monitorato
  "DOC", // una pagina dei Docs
] as const;

export type EventPrefix = (typeof EVENT_PREFIXES)[number];

/**
 * Kind locali del prototipo, non (ancora) in `notificationKindSchema`: li
 * pubblicano le azioni dell'area 2 (pianificazione altrui, risposta a una
 * richiesta di decisione) e gli avvisi dell'area 8a (PR, rilasci, note di
 * rilascio, task nuove, Support) e dell'area 8b (server), che hanno i
 * destinatari calcolati a lettura.
 */
export const LOCAL_NOTIFICATION_KINDS = [
  "planning.changed",
  "decision.answered",
  "pr.opened",
  "pr.analysis_issues",
  "pr.corrected",
  "release.merged",
  "release.succeeded",
  "release.failed",
  "docs.release_note",
  "task.created",
  "support.request",
  "support.customer_replied",
  "server.trouble",
  "server.down",
  "server.recovered",
  "server.diagnosis_ready",
] as const;

// [kind, codice progetto, codice oggetto, titolo, corpo, ore fa, letta, destinatari?]
// Senza destinatari espliciti la notifica va ai membri umani del progetto.
type Row = [string, string | null, string, string, string, number, boolean, string[]?];

const ROWS: Row[] = [
  [
    "job.pr_opened",
    "MKX",
    "MKX-2",
    "Pull request opened",
    "Claude opened a pull request for MKX-2.",
    1,
    false,
  ],
  [
    "review.completed",
    "AUD",
    "AUD-3",
    "Review completed",
    "The automatic review of AUD-3 found no issues.",
    2,
    false,
  ],
  [
    "job.pr_opened",
    "STW",
    "STW-3",
    "Pull request opened",
    "A pull request for STW-3 is ready to be reviewed.",
    3,
    false,
  ],
  [
    "review.completed",
    "STW",
    "STW-1",
    "Review completed",
    "The automatic review of STW-1 found 2 minor issues.",
    5,
    true,
  ],
  [
    "ticket.created",
    "CBV",
    "CBV-3",
    "New request from the client",
    "Cantina Bellavista asked for a gift-box option in the store, to be shown on the landing page before the holidays.",
    6,
    false,
  ],
  [
    "request.created",
    "OLV",
    "REQ-1",
    "New request",
    "A teammate opened a request about the homepage banner.",
    8,
    true,
  ],
  [
    "project.brief",
    "LMR",
    "LMR",
    "Weekly brief ready",
    "Where the project stands, what changed and what is blocked.",
    20,
    false,
  ],
  [
    "project.brief",
    "VDM",
    "VDM",
    "Weekly brief ready",
    "Where the project stands, what changed and what is blocked.",
    26,
    true,
  ],
  [
    "job.failed",
    "TLM",
    "TLM-4",
    "A run failed",
    "The tests of TLM-4 did not pass after the second attempt.",
    30,
    false,
  ],
  [
    "job.held",
    "CRT",
    "CRT-2",
    "A run is on hold",
    "The run for CRT-2 is waiting for a free slot.",
    33,
    true,
  ],
  [
    "job.pr_closed",
    "AUD",
    "AUD-5",
    "Pull request closed",
    "The pull request for AUD-5 was closed without merging.",
    48,
    true,
  ],
  [
    "monitor.alert",
    "ACQ",
    "SRV-1",
    "Server alert",
    "High memory usage on the production server.",
    52,
    false,
  ],
  [
    "monitor.recovered",
    "ACQ",
    "SRV-1",
    "Server recovered",
    "Memory usage is back to normal.",
    50,
    true,
  ],
  [
    "job.budget_held",
    "ELS",
    "ELS-3",
    "Budget limit reached",
    "ELS-3 is paused until a maintainer raises the budget.",
    60,
    false,
  ],
  [
    "docs.nightly_attention",
    "STW",
    "DOC-1",
    "Docs need attention",
    "Two pages could not be updated overnight.",
    72,
    true,
  ],
  [
    "security.alert",
    null,
    "SEC-2",
    "Password changed",
    "The password of your account was changed.",
    4,
    false,
    ["p-giulia"],
  ],
  [
    "security.alert",
    null,
    "SEC-1",
    "New sign-in",
    "Your account was used from a new device.",
    90,
    true,
    ["p-giulia"],
  ],
  [
    "security.alert",
    null,
    "SEC-3",
    "New sign-in",
    "Your account was used from a new device.",
    10,
    false,
    ["p-sara"],
  ],
  [
    "security.alert",
    null,
    "SEC-4",
    "Two-step verification turned on",
    "Your account now asks for a code at sign-in.",
    28,
    true,
    ["p-roberta"],
  ],
  [
    "planning.changed",
    "STW",
    "STW-10",
    "Your week changed",
    "Laura Costa planned STW-10 for this week.",
    9,
    false,
    ["p-giulia"],
  ],
  [
    "decision.answered",
    "AUD",
    "AUD-1",
    "Decision answered",
    "Laura Costa chose “Three” for the launch tiers.",
    110,
    true,
    ["p-matteo"],
  ],
  [
    "ticket.created",
    "FRL",
    "FRL-4",
    "New request from the client",
    "Forneria Rossi & Lari asked to change the delivery slots.",
    100,
    true,
  ],
  [
    "ticket.created",
    "SAL",
    "SAL-1",
    "New request from the client",
    "A new request about the product sheets was added to SAL-1.",
    7,
    false,
  ],
  [
    "project.brief",
    "BTG",
    "BTG",
    "Weekly brief ready",
    "A quiet week: nothing blocked.",
    120,
    true,
  ],
];

/**
 * Kind che CHIEDONO una decisione o una risposta: nel pannello notifiche
 * (solo informazioni) non compaiono mai. Le decisioni vivono in Home, le
 * proposte della posta in Mail.
 */
export const DECISION_NOTIFICATION_KINDS = [
  "job.plan_review",
  "job.awaiting_input",
  "project.pulse",
  "google.proposal",
  "google.proposal_handed",
] as const;

function projectlessLink(kind: string): string {
  if (kind === "security.alert") return "#/preferences";
  return "#/home";
}

const isHuman = (id: string) => PEOPLE.some((p) => p.id === id && !p.isClaude);

const FIXED_NOTIFICATIONS: AppNotification[] = ROWS.map(
  ([kind, code, objectCode, title, body, hoursAgo, read, recipients], i) => {
    const project = code ? PROJECTS.find((p) => p.code === code) : undefined;
    const task = TASKS.find((t) => t.code === objectCode);
    const createdAt = `${daysFromToday(-Math.floor(hoursAgo / 24))}T${String(
      Math.max(0, 22 - (hoursAgo % 24)),
    ).padStart(2, "0")}:00:00Z`;
    return {
      id: `n-${i + 1}`,
      kind,
      projectId: project?.id ?? null,
      objectCode,
      departmentId: task?.departmentId ?? null,
      recipientIds: recipients ?? project?.memberIds.filter(isHuman) ?? [],
      title,
      body,
      createdAt,
      read,
      archived: false,
      snoozedUntil: null,
      link: task ? `#/p/${code}/tasks` : project ? `#/p/${project.code}` : projectlessLink(kind),
    };
  },
);

/** Le notifiche del seme: quelle coi destinatari fissi, poi gli avvisi delle aree 8a e 8b. */
export const NOTIFICATIONS: AppNotification[] = [
  ...FIXED_NOTIFICATIONS,
  ...ALERT_NOTIFICATIONS,
  ...SERVER_ALERT_NOTIFICATIONS,
];
