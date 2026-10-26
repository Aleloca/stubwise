import type {
  ClaudeWorkState,
  ManualStall,
  Project,
  StatusFamily,
  Task,
  TaskPriority,
  TaskSize,
  TaskSource,
  TaskType,
} from "../types";
import { daysFromToday } from "./dates";
import { DEPARTMENTS } from "./departments";
import { MILESTONES } from "./milestones";
import { PEOPLE } from "./people";
import { PROJECTS } from "./projects";
import { statusIdOf } from "./statuses";

// Titoli per reparto (chiave = id reparto). Generati in modo deterministico
// ciclando su queste liste: nessuna casualità.
const TITLES: Record<string, string[]> = {
  "dep-marketing": [
    "Draft the spring campaign brief",
    "Refresh landing page hero copy",
    "Schedule newsletter for the autumn launch",
    "Review social media calendar",
    "Collect testimonials for the case study",
    "Update brand guidelines PDF",
  ],
  "dep-sales": [
    "Prepare the renewal proposal",
    "Follow up on the quote sent last week",
    "Update pricing sheet for resellers",
    "Qualify inbound leads from the trade fair",
    "Plan the demo call with the buyer",
    "Negotiate payment terms",
  ],
  "dep-support": [
    "Reply to the delivery delay complaint",
    "Write the FAQ for the new checkout",
    "Triage the backlog of open tickets",
    "Call back the customer about the invoice",
    "Document the password reset procedure",
    "Collect feedback after the onboarding call",
  ],
  "dep-development": [
    "Fix the pagination bug in the order list",
    "Add CSV export to the reports page",
    "Upgrade the payment gateway SDK",
    "Improve the loading time of the catalog",
    "Write integration tests for the booking flow",
    "Migrate the media uploads to object storage",
  ],
  "dep-administration": [
    "Issue the quarterly invoices",
    "Reconcile the supplier statements",
    "Renew the hosting contract",
    "Collect signed privacy agreements",
    "Prepare the budget summary for the board",
    "Archive the closed project folders",
  ],
};

const SIZES: TaskSize[] = ["XS", "S", "M", "L", "XL"];
const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];
/** Le settimane del seed: due passate, la corrente (W43), tre future. */
const WEEKS = ["2026-W41", "2026-W42", "2026-W43", "2026-W44", "2026-W45", "2026-W46"];
const CURRENT_WEEK = "2026-W43";

/** Data-ora ISO a `days` giorni da oggi (negativi = passato), a un'ora del mattino/pomeriggio. */
function at(days: number, hour = 9): string {
  return `${daysFromToday(days)}T${String(hour).padStart(2, "0")}:00:00Z`;
}

const firstHuman = (project: Project) =>
  project.memberIds.find((id) => !PEOPLE.find((p) => p.id === id)!.isClaude)!;

// --- progetti di riferimento: task scritte a mano ----------------------------

const M = "dep-marketing";
const S = "dep-sales";
const C = "dep-support";
const D = "dep-development";
const A = "dep-administration";

interface Spec {
  title: string;
  dept: string;
  family: StatusFamily;
  /** Quale stato della famiglia (0 = il primo). */
  nth?: number;
  assignee: string | null;
  size: TaskSize | null;
  week: string | null;
  slip?: number;
  due?: number;
  /** Numero del traguardo nel progetto (1, 2, 3). */
  ms?: number;
  type?: TaskType;
  priority?: TaskPriority;
  claude?: ClaudeWorkState;
  manual?: Omit<ManualStall, "since"> & { sinceDays: number };
  /** Numero della task (nello stesso progetto) che la blocca. */
  blockedBy?: number;
  requestId?: string;
  labels?: string[];
  /** Ultima attività, in giorni fa (per le chiuse: la chiusura). */
  lastDays: number;
  /** Creazione, in giorni fa. */
  createdDays: number;
  /** L'ora della creazione (di base le 8): una task nata da una decisione nasce alla sua ora. */
  createdHour?: number;
  createdBy?: string;
  followers?: string[];
  source?: TaskSource;
  occurrences?: number;
  technical?: Record<string, string>;
}

// Una riga per task: la tabella si legge meglio di oggetti a capo.
// prettier-ignore
const REFERENCE: Record<string, Spec[]> = {
  AUD: [
    { title: "Decide the pricing tiers for the launch", dept: S, family: "closed", assignee: "p-matteo", size: "M", week: "2026-W41", ms: 1, lastDays: 12, createdDays: 30, type: "activity", priority: "high" },
    { title: "Onboarding checklist for new workspaces", dept: D, family: "active", assignee: "p-laura", size: "L", week: "2026-W43", ms: 2, lastDays: 1, createdDays: 21, labels: ["onboarding"] },
    { title: "Import contacts from CSV with duplicates check", dept: D, family: "active", nth: 1, assignee: "p-marco", size: "M", week: "2026-W43", ms: 2, claude: "awaiting_answer", lastDays: 3, createdDays: 18, priority: "high" },
    { title: "Billing emails with the new invoice layout", dept: D, family: "todo", assignee: "p-marco", size: "S", week: "2026-W44", ms: 2, lastDays: 2, createdDays: 14, claude: "stopped" },
    { title: "Export the call history as a spreadsheet", dept: D, family: "active", assignee: "p-stefano", size: "M", week: "2026-W43", ms: 2, requestId: "req-aud-1", lastDays: 0, createdDays: 9, claude: "working" },
    { title: "Speed up the dashboard of large accounts", dept: D, family: "active", assignee: "p-alessia", size: "XL", week: "2026-W42", slip: 1, ms: 2, lastDays: 13, createdDays: 25, type: "bug", source: "widget", occurrences: 3, technical: { widget: "Audin help (fake)", page: "/dashboard?account=large", browser: "Chrome 130 on Windows 11", "load time": "14.2 s" } },
    { title: "Write the help pages for the dialer", dept: C, family: "todo", assignee: "p-alessia", size: "S", week: "2026-W43", ms: 3, due: -2, lastDays: 4, createdDays: 8, createdHour: 17, type: "activity" },
    { title: "Launch announcement for existing customers", dept: M, family: "todo", assignee: "p-elena", size: null, week: "2026-W46", ms: 2, due: 20, lastDays: 5, createdDays: 8, createdHour: 17, type: "activity" },
    { title: "Fix the timezone of scheduled callbacks", dept: D, family: "closed", assignee: "p-marco", size: "S", week: "2026-W42", ms: 1, lastDays: 3, createdDays: 16, type: "bug", priority: "urgent", claude: "done" },
    { title: "Store review notes for the mobile app", dept: D, family: "todo", assignee: null, size: null, week: null, ms: 3, lastDays: 8, createdDays: 8 },
    { title: "Renew the telephony provider contract", dept: A, family: "todo", assignee: "p-matteo", size: "XS", week: "2026-W44", due: 9, lastDays: 2, createdDays: 12, type: "activity" },
    { title: "Drop the legacy SMS module", dept: D, family: "closed", nth: 1, assignee: "p-laura", size: "M", week: "2026-W41", lastDays: 15, createdDays: 40 },
  ],
  STW: [
    { title: "Fake data layer aware of the viewer", dept: D, family: "closed", assignee: "p-marco", size: "L", week: "2026-W42", ms: 1, lastDays: 2, createdDays: 14, claude: "done" },
    { title: "Choose the icon set for the rail", dept: M, family: "closed", nth: 1, assignee: "p-giulia", size: "XS", week: "2026-W41", ms: 1, lastDays: 11, createdDays: 20, type: "activity" },
    { title: "Board view with keyboard drag and drop", dept: D, family: "active", nth: 1, assignee: "p-simone", size: "XL", week: "2026-W43", ms: 1, requestId: "req-stw-2", lastDays: 1, createdDays: 12, claude: "working" },
    { title: "Wording of the stalled reasons", dept: M, family: "active", assignee: "p-elena", size: "S", week: "2026-W43", ms: 1, lastDays: 2, createdDays: 9, type: "activity" },
    { title: "Weekly planning across projects", dept: D, family: "todo", assignee: "p-laura", size: "L", week: "2026-W44", ms: 2, lastDays: 3, createdDays: 7 },
    { title: "Help article: how stalled tasks work", dept: C, family: "active", assignee: "p-sara", size: "S", week: "2026-W43", ms: 1, lastDays: 1, createdDays: 6, type: "activity" },
    { title: "Saved filters shared with the team", dept: D, family: "todo", assignee: "p-federico", size: "M", week: "2026-W45", ms: 2, lastDays: 2, createdDays: 8, claude: "stopped" },
    { title: "Upgrade guide for self-hosted instances", dept: C, family: "todo", assignee: "p-davide", size: "M", week: "2026-W42", slip: 2, ms: 2, lastDays: 16, createdDays: 30, type: "activity" },
    { title: "Fix the focus ring in the notifications panel", dept: D, family: "closed", assignee: "p-federico", size: "XS", week: "2026-W42", lastDays: 6, createdDays: 10, type: "bug", source: "slack" },
    { title: "Department homes: what each team sees first", dept: M, family: "active", assignee: "p-giulia", size: "M", week: "2026-W43", ms: 2, lastDays: 0, createdDays: 5, type: "activity" },
    { title: "Release notes for the desktop preview", dept: M, family: "todo", assignee: null, size: "S", week: "2026-W43", slip: 1, lastDays: 5, createdDays: 11, type: "activity" },
    { title: "Timeline view of planned weeks", dept: D, family: "todo", assignee: "p-simone", size: null, week: "2026-W46", ms: 2, lastDays: 3, createdDays: 3 },
    { title: "Crash when the window is resized to the minimum", dept: D, family: "active", assignee: "p-marco", size: "S", week: "2026-W43", lastDays: 0, createdDays: 2, type: "bug", priority: "high", claude: "awaiting_approval", source: "sdk", occurrences: 12, technical: { error: "RangeError: Invalid array length", where: "layout/useFitSlots.ts:42", release: "desktop 0.4.2 (fake)", os: "macOS 15.1", window: "1024 × 680", "first seen": "2026-10-21 08:14 UTC" } },
  ],
  MKX: [
    { title: "Spring campaign brief", dept: M, family: "closed", assignee: "p-giulia", size: "M", week: "2026-W41", ms: 1, requestId: "req-mkx-1", lastDays: 9, createdDays: 28, type: "activity" },
    { title: "Pick the hero photo for the kitchens line", dept: M, family: "active", nth: 1, assignee: "p-chiara", size: "S", week: "2026-W43", ms: 1, lastDays: 1, createdDays: 12, type: "activity" },
    { title: "Media plan for April", dept: M, family: "active", assignee: "p-paolo", size: "L", week: "2026-W43", ms: 1, due: 6, lastDays: 2, createdDays: 15, type: "activity", priority: "high" },
    { title: "Social posts for the showroom week", dept: M, family: "todo", assignee: "p-tommaso", size: "M", week: "2026-W45", ms: 2, lastDays: 3, createdDays: 7, type: "activity" },
    { title: "Price list for the dealers' leaflet", dept: S, family: "active", nth: 1, assignee: "p-matteo", size: "S", week: "2026-W42", slip: 1, ms: 1, manual: { reason: "Waiting on the client", note: "Mix Cucine has to confirm the spring discounts.", byId: "p-giulia", sinceDays: 6 }, lastDays: 6, createdDays: 18, type: "activity", source: "email" },
    { title: "Landing page copy for the campaign", dept: M, family: "active", assignee: "p-elena", size: "M", week: "2026-W43", ms: 1, lastDays: 1, createdDays: 10, type: "activity" },
    { title: "Translate the landing page into German", dept: M, family: "todo", assignee: "p-chiara", size: "S", week: "2026-W44", ms: 1, blockedBy: 6, lastDays: 4, createdDays: 9, type: "activity" },
    { title: "Book the photographer for the showroom", dept: M, family: "active", assignee: null, size: "XS", week: "2026-W43", ms: 2, lastDays: 3, createdDays: 8, type: "activity" },
    { title: "Newsletter for the showroom invitations", dept: M, family: "todo", assignee: "p-paolo", size: null, week: "2026-W46", ms: 2, lastDays: 2, createdDays: 4, type: "activity" },
    { title: "Leads report for the dealers", dept: S, family: "closed", assignee: "p-francesca", size: "S", week: "2026-W42", lastDays: 4, createdDays: 14, type: "activity" },
    { title: "Banner sizes for the trade press", dept: M, family: "todo", assignee: "p-tommaso", size: "XS", week: "2026-W44", lastDays: 1, createdDays: 3, type: "activity", claude: "working" },
    { title: "Old autumn creatives", dept: M, family: "closed", nth: 1, assignee: "p-paolo", size: null, week: "2026-W41", lastDays: 13, createdDays: 35, type: "activity" },
  ],
};

function referenceTasks(project: Project, specs: Spec[]): Task[] {
  const code = project.code.toLowerCase();
  const idOf = (n: number) => `t-${code}-${n}`;
  return specs.map((s, i) => {
    const n = i + 1;
    const closed = s.family === "closed";
    const lastActivityAt = at(-s.lastDays, 10 + (n % 7));
    const links: Task["links"] = [];
    // Una riga sola, sulla bloccante (`blockedBy` della task bloccata): «bloccata da» si ricava.
    specs.forEach((other, j) => {
      if (other.blockedBy === n) links.push({ kind: "blocks", taskId: idOf(j + 1) });
    });
    const createdById =
      s.createdBy ?? (s.assignee && s.assignee !== "p-claude" ? s.assignee : firstHuman(project));
    return {
      id: idOf(n),
      code: `${project.code}-${n}`,
      projectId: project.id,
      title: s.title,
      description: `${s.title}. Notes and acceptance criteria are in the thread below.`,
      statusId: statusIdOf(project, s.family, s.nth ?? 0),
      departmentId: s.dept,
      assigneeId: s.assignee,
      createdById,
      followerIds: s.followers ?? [...new Set([createdById, ...(s.assignee ? [s.assignee] : [])])],
      size: s.size,
      dueDate: s.due === undefined ? null : daysFromToday(s.due),
      plannedWeek: s.week,
      slipCount: s.slip ?? 0,
      milestoneId: s.ms ? `ms-${code}-${s.ms}` : null,
      labels: s.labels ?? [],
      type: s.type ?? "feature",
      priority: s.priority ?? "medium",
      requestId: s.requestId ?? null,
      links,
      attachments: n === 1 ? [{ id: `att-${code}-1`, name: "brief.pdf", sizeBytes: 482_113 }] : [],
      manualStall: s.manual
        ? {
            reason: s.manual.reason,
            note: s.manual.note,
            byId: s.manual.byId,
            since: at(-s.manual.sinceDays),
          }
        : null,
      claude: s.claude ?? "none",
      createdAt: at(-s.createdDays, s.createdHour ?? 8),
      closedAt: closed ? lastActivityAt : null,
      lastActivityAt,
      source: s.source ?? "manual",
      occurrences: s.occurrences ?? 1,
      technical: s.technical ?? null,
    } satisfies Task;
  });
}

// --- tutti gli altri progetti: 5 task generate ------------------------------

const TASKS_PER_PROJECT = 5;
/** Famiglia (e quale stato) per posizione, ruotata per progetto: 2 todo, 2 attive, 1 chiusa. */
const PATTERN: [StatusFamily, number][] = [
  ["todo", 0],
  ["active", 0],
  ["active", 1],
  ["closed", 0],
  ["todo", 0],
];

function generatedTasks(project: Project, pi: number): Task[] {
  const milestone = MILESTONES.find((m) => m.projectId === project.id);
  return Array.from({ length: TASKS_PER_PROJECT }, (_, n) => {
    const seq = pi * TASKS_PER_PROJECT + n;
    const department = DEPARTMENTS[(pi + n) % DEPARTMENTS.length]!;
    const titles = TITLES[department.id]!;
    const [family, nth] = PATTERN[(n + pi) % PATTERN.length]!;
    const closed = family === "closed";
    // Assegnata a un membro del progetto del reparto giusto, se c'è;
    // ogni quarta task resta senza assegnatario.
    const assignee =
      seq % 4 === 3
        ? undefined
        : PEOPLE.find(
            (p) =>
              !p.isClaude &&
              p.departmentIds.includes(department.id) &&
              project.memberIds.includes(p.id),
          );
    const plannedWeek = closed
      ? WEEKS[seq % 2]!
      : seq % 4 === 3
        ? null
        : WEEKS[(seq * 5 + pi) % WEEKS.length]!;
    const pastWeek = plannedWeek !== null && plannedWeek < CURRENT_WEEK;
    const slipCount = !closed && plannedWeek && (pastWeek || seq % 7 === 0) ? 1 + (seq % 3) : 0;
    const lastDays =
      family === "active"
        ? seq % 9 === 0
          ? 9 + (seq % 5)
          : seq % 6
        : family === "todo"
          ? 2 + (seq % 20)
          : 1 + (seq % 35);
    const lastActivityAt = at(-lastDays, 9 + (seq % 8));
    const createdById = firstHuman(project);
    const isDev = department.id === "dep-development";
    return {
      id: `t-${project.code.toLowerCase()}-${n + 1}`,
      code: `${project.code}-${n + 1}`,
      projectId: project.id,
      title: titles[(seq + n) % titles.length]!,
      description: "",
      statusId: statusIdOf(project, family, closed && pi % 4 === 0 ? 1 : nth),
      departmentId: department.id,
      assigneeId: assignee?.id ?? null,
      createdById,
      followerIds: assignee ? [assignee.id] : [],
      size: seq % 5 === 4 ? null : SIZES[(seq * 3) % SIZES.length]!,
      dueDate: !closed && seq % 3 === 0 ? daysFromToday((seq % 21) - 5) : null,
      plannedWeek,
      slipCount,
      milestoneId: milestone && n < 2 ? milestone.id : null,
      labels: [],
      type: isDev ? (seq % 2 === 0 ? "bug" : "feature") : "activity",
      priority: PRIORITIES[seq % PRIORITIES.length]!,
      requestId: null,
      links: [],
      attachments: [],
      manualStall: null,
      claude:
        isDev && project.memberIds.includes("p-claude")
          ? family === "active"
            ? "working"
            : closed
              ? "done"
              : "none"
          : "none",
      createdAt: at(-(lastDays + 5 + (seq % 25)), 8),
      closedAt: closed ? lastActivityAt : null,
      lastActivityAt,
      source: "manual",
      occurrences: 1,
    } satisfies Task;
  });
}

export const TASKS: Task[] = PROJECTS.flatMap((project, pi) => {
  const specs = REFERENCE[project.code];
  return specs ? referenceTasks(project, specs) : generatedTasks(project, pi);
});
