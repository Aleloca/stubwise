import { notificationKindSchema } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import type { StallReason } from "../domain/stalled";
import { stallOf } from "../domain/stalled";
import { TEMPLATE_MODULES } from "../domain/templates";
import { compareWeeks } from "../domain/weeks";
import { chat, resetApi, setLatency } from "./api";
import { setSessionPersonId } from "./session";
import { ACTIVITY } from "./seed/activity";
import { PLUGINS, PROJECT_PLUGINS, STUBWISE_COMMANDS, commandsFor } from "./seed/commands";
import { COMMITS } from "./seed/commits";
import { CONVERSATION_EVENTS, CONVERSATIONS } from "./seed/conversations";
import { DOC_PAGES } from "./seed/docPages";
import { TODAY, daysFromToday } from "./seed/dates";
import { DECISION_REQUESTS } from "./seed/decisions";
import { DEPARTMENT_ROLES } from "./seed/departmentRoles";
import { DEPARTMENTS } from "./seed/departments";
import { INITIAL_PINNED_FILTERS, SAVED_FILTERS } from "./seed/filters";
import { DAY_ARRANGEMENTS, DEPARTMENT_HOMES, PERSONAL_HOMES } from "./seed/homes";
import { MILESTONES } from "./seed/milestones";
import {
  DECISION_NOTIFICATION_KINDS,
  EVENT_PREFIXES,
  LOCAL_NOTIFICATION_KINDS,
  NOTIFICATIONS,
} from "./seed/notifications";
import { PEOPLE } from "./seed/people";
import {
  GIULIA_LEAD_CODES,
  GIULIA_PINNED_CODES,
  INITIAL_PINNED_CODES,
  PROJECTS,
} from "./seed/projects";
import { REQUESTS } from "./seed/requests";
import { PROJECT_STATUSES } from "./seed/statuses";
import { TASKS } from "./seed/tasks";
import { BRIEFS } from "./seed/briefs";
import {
  CHAT_CHANNELS,
  CHAT_MESSAGES,
  CHAT_NOTIFY_PREFS,
  CHAT_READ_STATES,
  RELEASE_PAGES,
} from "./seed/chat";
import { REPO_FILES, projectOfRepo } from "./seed/repoFiles";
import {
  DRIVE_FILES,
  DRIVE_OPENS,
  FOLDER_LINKS,
  GOOGLE_ACCOUNTS,
  GOOGLE_OUTSIDE_FILES,
} from "./seed/drive";
import {
  EV_AUD_REVIEW_YESTERDAY,
  MAILBOXES,
  MAIL_CASES,
  MAIL_DRAFTS,
  MAIL_MESSAGES,
  MAIL_PROPOSALS,
  MEETING_TRANSCRIPTS,
} from "./seed/mail";
import { CALENDAR_EVENTS, CALENDAR_PROPOSALS } from "./seed/calendar";
import {
  AUTOMATIONS,
  AUTOMATION_CASES,
  AUTOMATION_RUNS,
  AUTOMATION_SOURCES,
  CLIENT_PROJECT_LINKS,
} from "./seed/automations";
import { VIEW_AS_PERSONAS, can, viewerFor } from "./viewer";
import type {
  Step,
  Channel,
  ChatEventKind,
  ChatMessage,
  CitationRef,
  ClaudeWorkState,
  Conversation,
  ConversationEvent,
  ConversationKind,
  ConversationState,
  StatusFamily,
  Task,
} from "./types";

const projectsById = new Map(PROJECTS.map((p) => [p.id, p]));
const tasksById = new Map(TASKS.map((t) => [t.id, t]));
const statusById = new Map(PROJECT_STATUSES.map((s) => [s.id, s]));
const familyOf = (t: Task): StatusFamily => statusById.get(t.statusId)!.family;
const tasksOf = (code: string) => TASKS.filter((t) => t.projectId === `prj-${code.toLowerCase()}`);
const openDecisions = DECISION_REQUESTS.filter((d) => d.answer === null && d.withdrawnAt === null);

function stall(t: Task) {
  return stallOf(t, {
    family: familyOf(t),
    openDecisions,
    tasksById,
    familyOf,
    thresholds: projectsById.get(t.projectId)!.stallThresholds,
  });
}

describe("seed: progetti e persone", () => {
  it("ha 50 progetti con codici univoci di 2–4 maiuscole", () => {
    expect(PROJECTS).toHaveLength(50);
    const codes = PROJECTS.map((p) => p.code);
    expect(new Set(codes).size).toBe(50);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{2,4}$/);
  });

  it("ha i progetti interni attesi e almeno 30 clienti", () => {
    const internal = PROJECTS.filter((p) => p.kind === "internal");
    expect(internal.length).toBeGreaterThanOrEqual(2);
    expect(PROJECTS.find((p) => p.code === "STW")).toMatchObject({
      name: "Stubwise",
      kind: "internal",
      template: "software",
    });
    expect(PROJECTS.find((p) => p.code === "AUD")).toMatchObject({
      name: "Audin 2.0",
      kind: "internal",
      template: "software",
    });
    expect(PROJECTS.find((p) => p.code === "MKX")).toMatchObject({
      kind: "client",
      template: "marketing",
    });
    expect(PROJECTS.filter((p) => p.kind === "client").length).toBeGreaterThanOrEqual(30);
  });

  it("i moduli sono coerenti col template", () => {
    for (const p of PROJECTS) expect(p.modules).toEqual(TEMPLATE_MODULES[p.template]);
  });

  it("ogni progetto ha soglie delle ferme e membri esistenti", () => {
    for (const p of PROJECTS) {
      expect(p.stallThresholds.activeDays).toBeGreaterThan(0);
      expect(p.stallThresholds.todoDays).toBeGreaterThan(0);
      for (const m of p.memberIds) expect(PEOPLE.some((x) => x.id === m)).toBe(true);
    }
  });

  it("ha 5 reparti e ~25 persone più Claude", () => {
    expect(DEPARTMENTS).toHaveLength(5);
    const humans = PEOPLE.filter((p) => !p.isClaude);
    expect(humans.length).toBeGreaterThanOrEqual(24);
    expect(humans.length).toBeLessThanOrEqual(26);
    expect(PEOPLE.filter((p) => p.isClaude)).toHaveLength(1);
    expect(PEOPLE.some((p) => p.departmentIds.length >= 2)).toBe(true);
    for (const p of PEOPLE) {
      for (const d of p.departmentIds) expect(DEPARTMENTS.some((x) => x.id === d)).toBe(true);
    }
  });

  it("ha un nome progetto lungo (>= 34) e 12+ progetti fissati per Giulia", () => {
    expect(PROJECTS.some((p) => p.name.length >= 34)).toBe(true);
    expect(GIULIA_PINNED_CODES.length).toBeGreaterThanOrEqual(12);
    for (const c of GIULIA_PINNED_CODES) expect(PROJECTS.some((p) => p.code === c)).toBe(true);
  });

  it("ognuno dei cinque personaggi ha 6–14 fissati fra i progetti che vede", () => {
    expect(Object.keys(INITIAL_PINNED_CODES).sort()).toEqual(
      ["p-giulia", "p-laura", "p-marco", "p-roberta", "p-sara"].sort(),
    );
    expect(INITIAL_PINNED_CODES["p-giulia"]).toEqual(GIULIA_PINNED_CODES);
    for (const [personId, codes] of Object.entries(INITIAL_PINNED_CODES)) {
      expect(codes.length).toBeGreaterThanOrEqual(6);
      expect(codes.length).toBeLessThanOrEqual(14);
      for (const code of codes) {
        const p = PROJECTS.find((x) => x.code === code)!;
        expect(p).toBeDefined();
        if (personId !== "p-roberta") expect(p.memberIds).toContain(personId);
      }
    }
  });

  it("Giulia è membro dei progetti dove è lead; Sara non vede AUD né MKX", () => {
    for (const code of GIULIA_LEAD_CODES) {
      expect(PROJECTS.find((p) => p.code === code)!.memberIds).toContain("p-giulia");
    }
    for (const code of ["AUD", "MKX"]) {
      expect(PROJECTS.find((p) => p.code === code)!.memberIds).not.toContain("p-sara");
    }
    expect(PROJECTS.find((p) => p.code === "STW")!.memberIds).toContain("p-sara");
  });
});

describe("seed: stati e task", () => {
  it("ogni progetto ha almeno uno stato per famiglia, ordinati", () => {
    for (const p of PROJECTS) {
      const statuses = PROJECT_STATUSES.filter((s) => s.projectId === p.id);
      for (const f of ["todo", "active", "closed"] as const) {
        expect(statuses.some((s) => s.family === f)).toBe(true);
      }
      expect(statuses.map((s) => s.order)).toEqual(statuses.map((_, i) => i));
    }
    expect(new Set(PROJECT_STATUSES.map((s) => s.id)).size).toBe(PROJECT_STATUSES.length);
  });

  it("ogni task ha uno statusId del suo progetto", () => {
    for (const t of TASKS) expect(statusById.get(t.statusId)?.projectId).toBe(t.projectId);
  });

  it("le task hanno riferimenti esistenti e codici univoci", () => {
    expect(new Set(TASKS.map((t) => t.code)).size).toBe(TASKS.length);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const t of TASKS) {
      const project = projectsById.get(t.projectId);
      expect(project).toBeDefined();
      expect(t.code).toMatch(new RegExp(`^${project!.code}-\\d+$`));
      expect(DEPARTMENTS.some((d) => d.id === t.departmentId)).toBe(true);
      if (t.assigneeId) expect(project!.memberIds).toContain(t.assigneeId);
      expect(PEOPLE.some((p) => p.id === t.createdById)).toBe(true);
      for (const l of t.links) {
        expect(tasksById.get(l.taskId)?.projectId).toBe(t.projectId);
        // Si salva una riga sola: gli inversi («blocked_by», «child») si ricavano.
        expect(["blocks", "relates", "parent"]).toContain(l.kind);
      }
      if (t.milestoneId) {
        expect(MILESTONES.find((m) => m.id === t.milestoneId)?.projectId).toBe(t.projectId);
      }
    }
  });

  it("8–15 task nei progetti di riferimento, 5 negli altri", () => {
    for (const p of PROJECTS) {
      const n = TASKS.filter((t) => t.projectId === p.id).length;
      if (["AUD", "STW", "MKX"].includes(p.code)) {
        expect(n).toBeGreaterThanOrEqual(8);
        expect(n).toBeLessThanOrEqual(15);
      } else expect(n).toBe(5);
    }
  });

  it("copre ogni famiglia e ogni reparto; taglie su circa l'80% delle task", () => {
    for (const f of ["todo", "active", "closed"] as const) {
      expect(TASKS.some((t) => familyOf(t) === f)).toBe(true);
    }
    for (const d of DEPARTMENTS) expect(TASKS.some((t) => t.departmentId === d.id)).toBe(true);
    const sized = TASKS.filter((t) => t.size !== null).length / TASKS.length;
    expect(sized).toBeGreaterThan(0.7);
    expect(sized).toBeLessThan(0.9);
  });

  it("settimane da 2026-W41 a 2026-W46, con slittamenti da 1 a 3", () => {
    const weeks = new Set(TASKS.flatMap((t) => (t.plannedWeek ? [t.plannedWeek] : [])));
    for (const w of ["2026-W41", "2026-W42", "2026-W43", "2026-W44", "2026-W45", "2026-W46"]) {
      expect(weeks.has(w)).toBe(true);
    }
    for (const w of weeks) {
      expect(compareWeeks(w, "2026-W41")).toBeGreaterThanOrEqual(0);
      expect(compareWeeks(w, "2026-W46")).toBeLessThanOrEqual(0);
    }
    const slipped = TASKS.filter((t) => t.slipCount > 0);
    expect(slipped.length).toBeGreaterThan(0);
    for (const t of slipped) {
      expect(t.slipCount).toBeLessThanOrEqual(3);
      expect(t.plannedWeek).not.toBeNull();
    }
  });

  it("date coerenti con gli stati: closedAt solo se chiusa, niente nel futuro", () => {
    for (const t of TASKS) {
      expect(t.createdAt <= t.lastActivityAt).toBe(true);
      expect(t.lastActivityAt.slice(0, 10) <= TODAY).toBe(true);
      if (familyOf(t) === "closed") {
        expect(t.closedAt).not.toBeNull();
        expect(t.closedAt! >= t.createdAt).toBe(true);
        expect(t.closedAt!.slice(0, 10) <= TODAY).toBe(true);
      } else expect(t.closedAt).toBeNull();
    }
  });

  it("2–3 traguardi in AUD, STW, MKX e uno in circa metà degli altri", () => {
    for (const code of ["AUD", "STW", "MKX"]) {
      const n = MILESTONES.filter((m) => m.projectId === `prj-${code.toLowerCase()}`).length;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3);
    }
    const others = PROJECTS.filter((p) => !["AUD", "STW", "MKX"].includes(p.code));
    const withOne = others.filter((p) => MILESTONES.some((m) => m.projectId === p.id));
    expect(withOne.length).toBeGreaterThanOrEqual(20);
    expect(withOne.length).toBeLessThanOrEqual(27);
  });

  it("c'è almeno una task ferma per ogni motivo nei progetti di Giulia", () => {
    const kinds: StallReason["kind"][] = [
      "manual",
      "decision",
      "claude_question",
      "blocked_by",
      "unassigned",
      "idle",
    ];
    const giulia = TASKS.filter((t) =>
      projectsById.get(t.projectId)!.memberIds.includes("p-giulia"),
    );
    const found = new Set(giulia.flatMap((t) => stall(t)?.reason.kind ?? []));
    for (const k of kinds) expect(found.has(k)).toBe(true);
  });

  it("le task di riferimento hanno attività: commenti e cambi di campo", () => {
    for (const code of ["AUD", "STW", "MKX"]) {
      const ids = new Set(tasksOf(code).map((t) => t.id));
      const entries = ACTIVITY.filter((a) => ids.has(a.taskId));
      expect(entries.some((a) => a.kind === "comment")).toBe(true);
      expect(entries.some((a) => a.kind === "field_change")).toBe(true);
    }
    for (const a of ACTIVITY) {
      expect(tasksById.has(a.taskId)).toBe(true);
      expect(a.at <= `${TODAY}T23:59:59Z`).toBe(true);
    }
  });
});

describe("seed: decisioni, richieste, filtri, Home", () => {
  it("ogni richiesta di decisione punta a una task esistente e a un membro del progetto", () => {
    for (const d of DECISION_REQUESTS) {
      const task = tasksById.get(d.taskId);
      expect(task).toBeDefined();
      const members = projectsById.get(task!.projectId)!.memberIds;
      expect(members).toContain(d.askedOfId);
      expect(members).toContain(d.askedById);
      expect(d.askedById).not.toBe(d.askedOfId);
    }
  });

  it("6+ decisioni aperte (3+ a Giulia, 1+ a Sara), 2 risposte, 1 ritirata", () => {
    expect(openDecisions.length).toBeGreaterThanOrEqual(6);
    expect(openDecisions.filter((d) => d.askedOfId === "p-giulia").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(openDecisions.some((d) => d.askedOfId === "p-sara")).toBe(true);
    expect(DECISION_REQUESTS.filter((d) => d.answer !== null)).toHaveLength(2);
    expect(DECISION_REQUESTS.filter((d) => d.withdrawnAt !== null)).toHaveLength(1);
  });

  it("richieste in ogni stato; le fuse puntano a una richiesta dello stesso progetto", () => {
    for (const s of ["new", "refining", "ready", "converted", "archived"] as const) {
      expect(REQUESTS.some((r) => r.status === s)).toBe(true);
    }
    const merged = REQUESTS.filter((r) => r.mergedIntoId !== null);
    expect(merged).toHaveLength(2);
    for (const r of merged) {
      const into = REQUESTS.find((x) => x.id === r.mergedIntoId);
      expect(into).toBeDefined();
      expect(into!.projectId).toBe(r.projectId);
      expect(into!.id).not.toBe(r.id);
    }
  });

  it("ogni richiesta ha un codice <PROGETTO>-R<n> unico, del suo progetto", () => {
    const codes = REQUESTS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of REQUESTS) {
      const project = PROJECTS.find((p) => p.id === r.projectId)!;
      expect(r.code).toMatch(new RegExp(`^${project.code}-R\\d+$`));
    }
  });

  it("richieste trasformate e task si puntano a vicenda", () => {
    for (const r of REQUESTS) {
      for (const id of r.taskIds) {
        expect(tasksById.get(id)?.requestId).toBe(r.id);
        expect(tasksById.get(id)?.projectId).toBe(r.projectId);
      }
      if (r.status === "converted") expect(r.taskIds.length).toBeGreaterThan(0);
    }
    for (const t of TASKS) {
      if (t.requestId) expect(REQUESTS.find((r) => r.id === t.requestId)?.taskIds).toContain(t.id);
    }
  });

  it("filtri pubblici con nomi inglesi e due privati di Giulia", () => {
    const publicNames = SAVED_FILTERS.filter((f) => f.visibility === "public").map((f) => f.name);
    for (const name of ["Open", "Closed this month", "Stalled", "No estimate", "Unassigned"]) {
      expect(publicNames).toContain(name);
    }
    expect(
      SAVED_FILTERS.filter((f) => f.ownerId === "p-giulia" && f.visibility === "private"),
    ).toHaveLength(2);
    expect(new Set(SAVED_FILTERS.map((f) => f.id)).size).toBe(SAVED_FILTERS.length);
  });

  it("Giulia ha fissato due suoi filtri, uno privato e uno pubblico", () => {
    const pinned = INITIAL_PINNED_FILTERS["p-giulia"]!.map(
      (id) => SAVED_FILTERS.find((f) => f.id === id)!,
    );
    expect(pinned.map((f) => f.ownerId)).toEqual(["p-giulia", "p-giulia"]);
    expect(pinned.map((f) => f.visibility).sort()).toEqual(["private", "public"]);
  });

  it("una Home predefinita per ogni reparto e una personalizzata per Marco", () => {
    for (const d of DEPARTMENTS) {
      const home = DEPARTMENT_HOMES.find((h) => h.departmentId === d.id);
      expect(home).toBeDefined();
      // I blocchi fissi ci sono sempre.
      expect(home!.blocks.map((b) => b.kind)).toEqual(expect.arrayContaining(["decide", "myWeek"]));
    }
    expect(PERSONAL_HOMES.map((h) => h.personId)).toEqual(["p-marco"]);
    for (const h of [...DEPARTMENT_HOMES, ...PERSONAL_HOMES]) {
      for (const b of h.blocks) {
        if (b.kind === "filter") expect(SAVED_FILTERS.some((f) => f.id === b.filterId)).toBe(true);
      }
    }
  });

  it("ruoli di reparto: Giulia gestisce la Home di Marketing, Laura quella di Development", () => {
    const has = (personId: string, departmentId: string) =>
      DEPARTMENT_ROLES.some(
        (r) =>
          r.personId === personId &&
          r.departmentId === departmentId &&
          r.permissions.includes("department.home.manage"),
      );
    expect(has("p-giulia", "dep-marketing")).toBe(true);
    expect(has("p-laura", "dep-development")).toBe(true);
    expect(DEPARTMENT_ROLES.some((r) => r.personId === "p-sara")).toBe(false);
  });

  it("le disposizioni del giorno sono dell'assegnatario, nella settimana della task", () => {
    expect(DAY_ARRANGEMENTS.length).toBeGreaterThan(0);
    for (const a of DAY_ARRANGEMENTS) {
      const t = tasksById.get(a.taskId)!;
      expect(t.assigneeId).toBe(a.personId);
      expect(t.plannedWeek).toBe(a.week);
    }
  });
});

describe("seed: notifiche", () => {
  it("ogni notifica ha il codice del suo oggetto: task, progetto o evento", () => {
    const eventCode = new RegExp("^(" + EVENT_PREFIXES.join("|") + ")-\\d+$");
    for (const n of NOTIFICATIONS) {
      const task = TASKS.find((t) => t.code === n.objectCode);
      const project = PROJECTS.find((p) => p.code === n.objectCode);
      if (task) {
        expect(n.departmentId).toBe(task.departmentId);
        expect(task.projectId).toBe(n.projectId);
      } else {
        expect(n.departmentId).toBeNull();
        if (project) expect(project.id).toBe(n.projectId);
        else expect(n.objectCode).toMatch(eventCode);
      }
      if (n.projectId === null) expect(n.objectCode).toMatch(/^SEC-\d+$/);
    }
    expect(NOTIFICATIONS.some((n) => n.departmentId)).toBe(true);
    expect(NOTIFICATIONS.some((n) => PROJECTS.some((p) => p.code === n.objectCode))).toBe(true);
    expect(NOTIFICATIONS.some((n) => eventCode.test(n.objectCode))).toBe(true);
  });

  it("ogni notifica ha destinatari, membri del suo progetto", () => {
    for (const n of NOTIFICATIONS) {
      expect(n.recipientIds.length).toBeGreaterThan(0);
      for (const r of n.recipientIds) {
        expect(PEOPLE.find((p) => p.id === r)?.isClaude).toBe(false);
        if (n.projectId) expect(projectsById.get(n.projectId)!.memberIds).toContain(r);
      }
    }
    for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-roberta"]) {
      expect(NOTIFICATIONS.some((n) => n.recipientIds.includes(id))).toBe(true);
    }
  });

  it("ha notifiche per almeno 5 kind diversi, tutti validi (condivisi o locali)", () => {
    const kinds = new Set(NOTIFICATIONS.map((n) => n.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(5);
    const valid = new Set<string>([...notificationKindSchema.options, ...LOCAL_NOTIFICATION_KINDS]);
    for (const k of kinds) expect(valid.has(k)).toBe(true);
    for (const k of LOCAL_NOTIFICATION_KINDS) expect(kinds.has(k)).toBe(true);
  });

  it("nessuna notifica chiede una decisione: quelle vivono in Home e in Mail", () => {
    for (const n of NOTIFICATIONS)
      expect(DECISION_NOTIFICATION_KINDS as readonly string[]).not.toContain(n.kind);
  });
});

describe("seed: conversazioni con Claude", () => {
  const peopleIds = new Set(PEOPLE.map((p) => p.id));
  const requestsById = new Map(REQUESTS.map((r) => [r.id, r]));
  const docIds = new Set(DOC_PAGES.map((d) => d.id));
  const conversationsById = new Map(CONVERSATIONS.map((c) => [c.id, c]));
  const eventsOf = (c: Conversation): ConversationEvent[] => CONVERSATION_EVENTS[c.id] ?? [];
  const allEvents = CONVERSATIONS.flatMap((c) => eventsOf(c).map((e) => ({ c, e })));
  const endOfToday = `${TODAY}T23:59:59Z`;

  it("ogni conversazione punta a persone, progetti, task e richieste esistenti", () => {
    expect(new Set(CONVERSATIONS.map((c) => c.id)).size).toBe(CONVERSATIONS.length);
    for (const c of CONVERSATIONS) {
      expect(peopleIds.has(c.ownerId)).toBe(true);
      expect(PEOPLE.find((p) => p.id === c.ownerId)!.isClaude).toBe(false);
      if (c.projectId) expect(projectsById.has(c.projectId)).toBe(true);
      if (c.contextProjectId) expect(projectsById.has(c.contextProjectId)).toBe(true);
      if (c.taskId) expect(tasksById.get(c.taskId)?.projectId).toBe(c.projectId);
      if (c.requestId) expect(requestsById.get(c.requestId)?.projectId).toBe(c.projectId);
      for (const id of c.touchedProjectIds) expect(projectsById.has(id)).toBe(true);
      if (c.continuesFromId) {
        expect(conversationsById.get(c.continuesFromId)?.visibility).toBe("public");
      }
      if (c.publishedById) expect(peopleIds.has(c.publishedById)).toBe(true);
      expect(c.createdAt <= c.updatedAt).toBe(true);
      expect(c.updatedAt <= endOfToday).toBe(true);
    }
    // Ogni conversazione ha un flusso, e ogni flusso ha la sua conversazione.
    for (const c of CONVERSATIONS) expect(eventsOf(c).length).toBeGreaterThan(0);
    for (const id of Object.keys(CONVERSATION_EVENTS)) expect(conversationsById.has(id)).toBe(true);
  });

  it("la forma segue il tipo: libere senza progetto, sessioni legate al loro oggetto", () => {
    for (const c of CONVERSATIONS) {
      if (c.kind === "free") {
        expect(c.projectId).toBeNull();
        expect(c.taskId).toBeNull();
        expect(["private", "public"]).toContain(c.visibility);
        expect(c.publishedAt !== null).toBe(c.visibility === "public");
        expect(c.publishedById !== null).toBe(c.visibility === "public");
        if (c.visibility === "public") expect(c.publishedById).toBe(c.ownerId);
        if (c.contextProjectId) expect(c.touchedProjectIds).toContain(c.contextProjectId);
      } else {
        expect(c.contextProjectId).toBeNull();
        expect(c.continuesFromId).toBeNull();
        expect(c.publishedAt).toBeNull();
        // La posta resta del titolare; le altre sessioni seguono il progetto.
        expect(c.visibility).toBe(c.kind === "mail_classify" ? "private" : "project");
        if (c.kind !== "mail_classify") expect(c.projectId).not.toBeNull();
      }
      if (c.kind === "task_run" || c.kind === "pr_review") expect(c.taskId).not.toBeNull();
      if (c.kind === "refine" || c.kind === "intake") expect(c.requestId).not.toBeNull();
      // L'esito c'è solo a sessione conclusa.
      expect(c.outcome !== null).toBe(c.state === "finished");
    }
  });

  it("almeno una conversazione per tipo e per stato", () => {
    const kinds: ConversationKind[] = [
      "free",
      "task_run",
      "refine",
      "pr_review",
      "docs",
      "brief",
      "daily_report",
      "mail_classify",
      "intake",
    ];
    const states: ConversationState[] = [
      "working",
      "awaiting_answer",
      "awaiting_approval",
      "paused",
      "idle",
      "finished",
    ];
    for (const k of kinds) expect(CONVERSATIONS.some((c) => c.kind === k)).toBe(true);
    for (const s of states) expect(CONVERSATIONS.some((c) => c.state === s)).toBe(true);
    for (const o of ["ok", "failed", "timed_out", "stopped"] as const) {
      expect(CONVERSATIONS.some((c) => c.outcome === o)).toBe(true);
    }
    // Sessioni di task in ogni stato, e un refine dal vivo.
    const runs = CONVERSATIONS.filter((c) => c.kind === "task_run");
    for (const s of ["working", "awaiting_answer", "awaiting_approval", "paused", "finished"]) {
      expect(runs.some((c) => c.state === s)).toBe(true);
    }
    expect(runs.some((c) => c.outcome === "ok")).toBe(true);
    expect(runs.some((c) => c.outcome === "failed")).toBe(true);
    expect(CONVERSATIONS.some((c) => c.kind === "refine" && c.state !== "finished")).toBe(true);
  });

  it("libere di Giulia e Marco; una pubblica di Giulia tocca un progetto che Sara non vede", () => {
    const free = CONVERSATIONS.filter((c) => c.kind === "free");
    expect(free.some((c) => c.ownerId === "p-giulia")).toBe(true);
    expect(free.some((c) => c.ownerId === "p-marco")).toBe(true);
    const giuliaPublic = free.filter((c) => c.ownerId === "p-giulia" && c.visibility === "public");
    expect(
      giuliaPublic.some((c) =>
        c.touchedProjectIds.some((id) => !projectsById.get(id)!.memberIds.includes("p-sara")),
      ),
    ).toBe(true);
    // Le libere private dicono ciò che l'autore può vedere: solo progetti di cui è membro.
    for (const c of free) {
      for (const id of c.touchedProjectIds) {
        expect(projectsById.get(id)!.memberIds).toContain(c.ownerId);
      }
    }
  });

  it("una sola sessione di classificazione della posta, di un titolare", () => {
    const mail = CONVERSATIONS.filter((c) => c.kind === "mail_classify");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.projectId).toBeNull();
    expect(peopleIds.has(mail[0]!.ownerId)).toBe(true);
  });

  it("le sessioni di lavoro sono di membri del progetto; le task hanno lo stato di Claude coerente", () => {
    const expected = (c: Conversation): ClaudeWorkState => {
      if (c.state === "finished") return c.outcome === "ok" ? "done" : "stopped";
      if (c.state === "paused") return "stopped";
      return c.state as ClaudeWorkState;
    };
    const latestByTask = new Map<string, Conversation>();
    for (const c of CONVERSATIONS.filter((x) => x.kind === "task_run")) {
      expect(projectsById.get(c.projectId!)!.memberIds).toContain(c.ownerId);
      expect(projectsById.get(c.projectId!)!.memberIds).toContain("p-claude");
      const prev = latestByTask.get(c.taskId!);
      if (!prev || prev.createdAt < c.createdAt) latestByTask.set(c.taskId!, c);
    }
    for (const [taskId, c] of latestByTask) {
      expect({ taskId, claude: tasksById.get(taskId)!.claude }).toEqual({
        taskId,
        claude: expected(c),
      });
    }
    // Un refine vivo è su una richiesta in rifinitura.
    for (const c of CONVERSATIONS.filter((x) => x.kind === "refine" && x.state !== "finished")) {
      expect(requestsById.get(c.requestId!)!.status).toBe("refining");
    }
  });

  it("ogni evento ha un id unico, è in ordine e non sta nel futuro", () => {
    for (const c of CONVERSATIONS) {
      const events = eventsOf(c);
      expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
      for (let i = 1; i < events.length; i++) {
        expect(events[i - 1]!.at <= events[i]!.at).toBe(true);
      }
      expect(events[0]!.at >= c.createdAt).toBe(true);
      expect(events.at(-1)!.at <= c.updatedAt).toBe(true);
    }
  });

  it("i riferimenti degli eventi esistono", () => {
    for (const { e } of allEvents) {
      if (e.type === "user") expect(peopleIds.has(e.authorId)).toBe(true);
      if (e.type === "phase" && e.stoppedById) expect(peopleIds.has(e.stoppedById)).toBe(true);
      if (e.type === "citation") {
        expect(e.refs.length).toBeGreaterThan(0);
        for (const r of e.refs) {
          if (r.kind === "task") expect(tasksById.has(r.id)).toBe(true);
          if (r.kind === "request") expect(requestsById.has(r.id)).toBe(true);
          if (r.kind === "project") expect(projectsById.has(r.id)).toBe(true);
          if (r.kind === "person") expect(peopleIds.has(r.id)).toBe(true);
          if (r.kind === "doc") expect(docIds.has(r.id)).toBe(true);
          if (r.kind === "file") expect(r.id).toMatch(/^[a-z0-9-]+:[\w./-]+$/);
        }
      }
    }
    for (const d of DOC_PAGES) {
      expect(projectsById.get(d.projectId)!.modules).toContain("docs");
    }
  });

  it("domande, piani e proposte sono ben formati", () => {
    const questionIds = new Set<string>();
    const proposalIds = new Set<string>();
    for (const { c, e } of allEvents) {
      if (e.type === "question") {
        expect(questionIds.has(e.questionId)).toBe(false);
        questionIds.add(e.questionId);
        expect(e.text.length).toBeGreaterThan(0);
        expect(e.options.length).toBeGreaterThanOrEqual(2);
        expect(e.options.filter((o) => o.recommended).length).toBeLessThanOrEqual(1);
        if (e.answer) {
          expect(peopleIds.has(e.answer.byId)).toBe(true);
          expect(e.answer.optionIndex !== null || !!e.answer.text).toBe(true);
          if (e.answer.optionIndex !== null) {
            expect(e.answer.optionIndex).toBeLessThan(e.options.length);
          }
          expect(e.answer.at >= e.at).toBe(true);
        }
      }
      if (e.type === "plan") {
        expect(e.planText.length).toBeGreaterThan(100);
        expect(e.summary.length).toBeGreaterThan(0);
        expect(e.decidedById !== undefined).toBe(e.status !== "pending");
        if (e.decidedById) expect(peopleIds.has(e.decidedById)).toBe(true);
        if (e.instructions !== undefined) expect(e.status).toBe("rejected");
      }
      if (e.type === "proposal") {
        expect(proposalIds.has(e.proposalId)).toBe(false);
        proposalIds.add(e.proposalId);
        // Le proposte stanno nelle libere, e le conferma solo chi le ha chieste.
        expect(c.kind).toBe("free");
        expect(e.requesterId).toBe(c.ownerId);
        expect(e.actions.length).toBeGreaterThan(0);
        for (const a of e.actions) expect(a.summary.length).toBeGreaterThan(0);
        expect(e.resultCodes !== undefined).toBe(e.status === "confirmed");
        expect(e.error !== undefined).toBe(e.status === "failed");
      }
    }
    const proposals = allEvents.flatMap(({ e }) => (e.type === "proposal" ? [e] : []));
    expect(proposals.some((p) => p.status === "confirmed")).toBe(true);
    expect(proposals.some((p) => p.status === "open")).toBe(true);
  });

  it("lo stato dice cosa aspetta: domanda aperta, piano da approvare", () => {
    for (const c of CONVERSATIONS) {
      const events = eventsOf(c);
      const openQuestion = events.some((e) => e.type === "question" && e.answer === null);
      const pendingPlan = events.some((e) => e.type === "plan" && e.status === "pending");
      expect({ id: c.id, openQuestion }).toEqual({
        id: c.id,
        openQuestion: c.state === "awaiting_answer",
      });
      expect({ id: c.id, pendingPlan }).toEqual({
        id: c.id,
        pendingPlan: c.state === "awaiting_approval",
      });
    }
    // Un piano pendente con il riassunto «In breve».
    const pending = allEvents.find(({ e }) => e.type === "plan" && e.status === "pending")!;
    expect(pending.e.type === "plan" && pending.e.summary.length).toBeGreaterThan(20);
  });

  it("i flussi sono ricchi: markdown con elenchi e codice, citazioni, risultati di lavoro", () => {
    const assistant = allEvents.flatMap(({ e }) => (e.type === "assistant" ? [e.text] : []));
    expect(assistant.some((t) => /^- /m.test(t))).toBe(true);
    expect(assistant.some((t) => t.includes("```"))).toBe(true);
    expect(allEvents.some(({ e }) => e.type === "citation")).toBe(true);
    const results = new Set(
      allEvents.flatMap(({ e }) => (e.type === "work_result" ? [e.kind] : [])),
    );
    for (const k of ["pr_opened", "review", "correction", "design_updated", "plan_updated"]) {
      expect(results.has(k as never)).toBe(true);
    }
    expect(allEvents.some(({ e }) => e.type === "user" && e.attachments.length > 0)).toBe(true);
  });
});

describe("seed: comandi «/» e skill dei plugin", () => {
  it("i comandi di Stubwise ci sono sempre, anche senza contesto", () => {
    for (const label of [
      "/status",
      "/today",
      "/explain",
      "/plan",
      "/new-task",
      "/new-request",
      "/run",
    ]) {
      expect(STUBWISE_COMMANDS.some((c) => c.label === label)).toBe(true);
    }
    expect(commandsFor(null)).toEqual(STUBWISE_COMMANDS);
    for (const c of STUBWISE_COMMANDS) {
      expect(c.source).toBe("stubwise");
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it("le skill compaiono solo nei progetti con il plugin abilitato, senza quelle spente", () => {
    for (const [projectId, enabled] of Object.entries(PROJECT_PLUGINS)) {
      expect(projectsById.get(projectId)!.template).toBe("software");
      for (const e of enabled) {
        const plugin = PLUGINS.find((p) => p.id === e.pluginId)!;
        expect(plugin).toBeDefined();
        for (const s of e.disabledSkills) expect(plugin.skills.map((k) => k.name)).toContain(s);
      }
    }
    let someDisabled = false;
    for (const project of PROJECTS) {
      const commands = commandsFor(project.id);
      const skills = commands.flatMap((c) => (c.source === "stubwise" ? [] : [c.source]));
      const enabled = PROJECT_PLUGINS[project.id] ?? [];
      expect(commands.filter((c) => c.source === "stubwise")).toEqual(STUBWISE_COMMANDS);
      if (enabled.length === 0) expect(skills).toEqual([]);
      for (const s of skills) {
        const e = enabled.find((x) => PLUGINS.find((p) => p.id === x.pluginId)!.name === s.plugin);
        expect(e).toBeDefined();
        expect(e!.disabledSkills).not.toContain(s.skill);
      }
      for (const e of enabled) {
        const plugin = PLUGINS.find((p) => p.id === e.pluginId)!;
        expect(skills.filter((s) => s.plugin === plugin.name)).toHaveLength(
          plugin.skills.length - e.disabledSkills.length,
        );
        if (e.disabledSkills.length > 0) someDisabled = true;
      }
    }
    expect(someDisabled).toBe(true);
    expect(Object.keys(PROJECT_PLUGINS)).toContain("prj-stw");
    expect(Object.keys(PROJECT_PLUGINS)).toContain("prj-aud");
    // Un progetto software senza plugin: solo i comandi di Stubwise.
    expect(PROJECTS.some((p) => p.template === "software" && !PROJECT_PLUGINS[p.id])).toBe(true);
    for (const p of PROJECTS) {
      const own = commandsFor(p.id).map((c) => c.id);
      expect(new Set(own).size).toBe(own.length);
    }
  });
});

describe("seed: commit del giorno", () => {
  it("commit di oggi e di ieri per almeno 3 sviluppatori, uno di un autore non collegato", () => {
    const developers = new Set(
      PEOPLE.filter((p) => p.departmentIds.includes("dep-development")).map((p) => p.id),
    );
    for (const day of [TODAY, daysFromToday(-1)]) {
      const authors = new Set(
        COMMITS.filter((c) => c.at.startsWith(day) && c.authorId).map((c) => c.authorId!),
      );
      expect(authors.size).toBeGreaterThanOrEqual(3);
      for (const a of authors) expect(developers.has(a)).toBe(true);
    }
    expect(COMMITS.some((c) => c.authorId === null)).toBe(true);
    expect(new Set(COMMITS.map((c) => c.sha)).size).toBe(COMMITS.length);
    for (const c of COMMITS) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
      const project = projectsById.get(c.projectId)!;
      expect(project.template).toBe("software");
      if (c.authorId) expect(project.memberIds).toContain(c.authorId);
      expect(c.aiSummary.length).toBeGreaterThan(0);
      expect(c.at <= `${TODAY}T23:59:59Z`).toBe(true);
    }
  });
});

describe("seed: Chat (area 4)", () => {
  const NOW = `${TODAY}T12:00:00Z`;
  const channelById = new Map(CHAT_CHANNELS.map((c) => [c.id, c]));
  const messageById = new Map(CHAT_MESSAGES.map((m) => [m.id, m]));
  const humanIds = (ids: string[]) =>
    ids.filter((id) => !PEOPLE.find((p) => p.id === id)!.isClaude);
  const channelOf = (m: ChatMessage) => channelById.get(m.channelId)!;
  const messagesOf = (id: string) => CHAT_MESSAGES.filter((m) => m.channelId === id);
  const named = (projectCode: string, name: string) =>
    CHAT_CHANNELS.find(
      (c) => c.projectId === `prj-${projectCode.toLowerCase()}` && c.name === name,
    );
  const DAY = 86_400_000;

  /** Il progetto di un oggetto citato (`null` = di nessun progetto: una persona). */
  function projectOfRef(ref: CitationRef): string | null {
    switch (ref.kind) {
      case "task":
        return tasksById.get(ref.id)!.projectId;
      case "request":
        return REQUESTS.find((r) => r.id === ref.id)!.projectId;
      case "doc":
        return DOC_PAGES.find((d) => d.id === ref.id)!.projectId;
      case "file":
        return projectOfRepo(ref.id.split(":")[0]!);
      case "drive":
        return DRIVE_FILES.find((f) => f.id === ref.id)!.projectId;
      case "project":
        return ref.id;
      case "milestone":
        return MILESTONES.find((m) => m.id === ref.id)!.projectId;
      case "brief":
        return BRIEFS.find((b) => b.id === ref.id)!.projectId;
      case "release":
        return RELEASE_PAGES.find((r) => r.id === ref.id)!.projectId;
      case "person":
        return null;
    }
  }

  function exists(ref: CitationRef): boolean {
    switch (ref.kind) {
      case "task":
        return tasksById.has(ref.id);
      case "request":
        return REQUESTS.some((r) => r.id === ref.id);
      case "doc":
        return DOC_PAGES.some((d) => d.id === ref.id);
      case "file":
        return REPO_FILES.some((f) => f.id === ref.id);
      case "drive":
        return DRIVE_FILES.some((f) => f.id === ref.id);
      case "project":
        return projectsById.has(ref.id);
      case "person":
        return PEOPLE.some((p) => p.id === ref.id);
      case "milestone":
        return MILESTONES.some((m) => m.id === ref.id);
      case "brief":
        return BRIEFS.some((b) => b.id === ref.id);
      case "release":
        return RELEASE_PAGES.some((r) => r.id === ref.id);
    }
  }

  it("ogni progetto ha un solo «general», aperto, con i membri del progetto (Claude escluso)", () => {
    for (const p of PROJECTS) {
      const generals = CHAT_CHANNELS.filter((c) => c.projectId === p.id && c.isGeneral);
      expect(generals).toHaveLength(1);
      const g = generals[0]!;
      expect(g).toMatchObject({ kind: "project", name: "general", visibility: "open" });
      expect([...g.memberIds].sort()).toEqual(humanIds(p.memberIds).sort());
      expect(g.memberIds).toContain(g.createdById);
    }
    expect(CHAT_CHANNELS.filter((c) => c.isGeneral).every((c) => c.kind === "project")).toBe(true);
  });

  it("canali tematici, generali dell'azienda e messaggi diretti", () => {
    expect(named("AUD", "releases")).toMatchObject({ visibility: "open", isGeneral: false });
    expect(named("MKX", "grafica")).toMatchObject({ visibility: "open", isGeneral: false });
    expect(CHAT_CHANNELS.some((c) => c.kind === "project" && c.visibility === "private")).toBe(
      true,
    );
    expect(CHAT_CHANNELS.some((c) => c.kind === "project" && c.archived)).toBe(true);
    for (const name of ["announcements", "marketing", "chit-chat"]) {
      expect(CHAT_CHANNELS.find((c) => c.kind === "general" && c.name === name)).toMatchObject({
        projectId: null,
      });
    }
    const dms = CHAT_CHANNELS.filter((c) => c.kind === "dm");
    for (const d of dms) {
      expect(d).toMatchObject({ visibility: "private", projectId: null, name: "" });
      expect(d.memberIds.length).toBeGreaterThanOrEqual(2);
      expect(d.memberIds.length).toBeLessThanOrEqual(8);
      expect(new Set(d.memberIds).size).toBe(d.memberIds.length);
    }
    expect(
      dms.some(
        (d) =>
          d.memberIds.length === 2 &&
          ["p-giulia", "p-marco"].every((id) => d.memberIds.includes(id)),
      ),
    ).toBe(true);
    expect(dms.some((d) => d.memberIds.length > 2)).toBe(true);
    // Fuori dai canali di progetto non si pubblicano eventi.
    for (const c of CHAT_CHANNELS.filter((x) => x.kind !== "project")) {
      expect(c.publishedEvents).toEqual([]);
    }
  });

  it("Roberta (full admin) non è in un privato di progetto né in un DM di gruppo", () => {
    expect(
      CHAT_CHANNELS.some(
        (c) =>
          c.kind === "project" && c.visibility === "private" && !c.memberIds.includes("p-roberta"),
      ),
    ).toBe(true);
    expect(
      CHAT_CHANNELS.some(
        (c) => c.kind === "dm" && c.memberIds.length > 2 && !c.memberIds.includes("p-roberta"),
      ),
    ).toBe(true);
    // …e i loro messaggi esistono (c'è qualcosa che non deve vedere).
    for (const c of CHAT_CHANNELS.filter(
      (x) =>
        x.visibility === "private" && x.kind === "project" && !x.memberIds.includes("p-roberta"),
    )) {
      expect(messagesOf(c.id).length).toBeGreaterThan(0);
    }
  });

  it("i membri di un canale di progetto sono membri del progetto; id univoci", () => {
    expect(new Set(CHAT_CHANNELS.map((c) => c.id)).size).toBe(CHAT_CHANNELS.length);
    expect(new Set(CHAT_MESSAGES.map((m) => m.id)).size).toBe(CHAT_MESSAGES.length);
    for (const c of CHAT_CHANNELS) {
      expect(new Set(c.memberIds).size).toBe(c.memberIds.length);
      for (const id of c.memberIds) expect(PEOPLE.find((p) => p.id === id)?.isClaude).toBe(false);
      if (c.kind === "project") {
        const project = projectsById.get(c.projectId!)!;
        for (const id of c.memberIds) expect(project.memberIds).toContain(id);
      }
    }
  });

  it("i messaggi sono coerenti: autore membro, thread sulla radice, ordine, eliminati senza testo", () => {
    for (const m of CHAT_MESSAGES) {
      const c = channelOf(m);
      expect(c).toBeDefined();
      expect(m.createdAt < NOW).toBe(true);
      expect(m.createdAt >= c.createdAt).toBe(true);
      if (m.kind === "person") expect(c.memberIds).toContain(m.authorId);
      if (m.kind === "system") {
        expect(m.authorId).toBeNull();
        expect(m.event).toBeDefined();
        expect(m.threadOf).toBeNull();
      } else {
        expect(m.event).toBeUndefined();
      }
      if (m.kind === "claude") {
        expect(PEOPLE.find((p) => p.id === m.authorId)?.isClaude).toBe(true);
        expect(c.memberIds).toContain(m.calledById);
        // Sempre nel thread.
        expect(m.threadOf).not.toBeNull();
      }
      for (const r of m.reactions) {
        expect(r.personIds.length).toBeGreaterThan(0);
        for (const id of r.personIds) expect(c.memberIds).toContain(id);
      }
      for (const id of m.asksReplyOf) expect(c.memberIds).toContain(id);
      if (m.threadOf) {
        const root = messageById.get(m.threadOf)!;
        expect(root.threadOf).toBeNull();
        expect(root.channelId).toBe(m.channelId);
        expect(m.createdAt > root.createdAt).toBe(true);
      } else {
        expect(m.alsoInChannel).toBeUndefined();
      }
      if (m.editedAt) expect(m.editedAt > m.createdAt).toBe(true);
      if (m.deletedAt) {
        expect(m).toMatchObject({ text: "", attachments: [], citations: [], asksReplyOf: [] });
        expect(m.deletedById).toBe(m.authorId);
      } else if (m.kind !== "system") {
        expect(m.text.length).toBeGreaterThan(0);
      }
    }
    // Radici e risposte di ogni thread in ordine di tempo.
    for (const c of CHAT_CHANNELS) {
      const roots = messagesOf(c.id).filter((m) => m.threadOf === null);
      expect(roots.map((m) => m.createdAt)).toEqual(roots.map((m) => m.createdAt).sort());
      for (const root of roots) {
        const replies = messagesOf(c.id).filter((m) => m.threadOf === root.id);
        expect(replies.map((m) => m.createdAt)).toEqual(replies.map((m) => m.createdAt).sort());
      }
    }
  });

  it("le menzioni nel testo nominano persone del canale", () => {
    const names = new Map(PEOPLE.map((p) => [p.name, p.id]));
    const groups = new Set(["channel", "Claude", ...DEPARTMENTS.map((d) => d.name)]);
    for (const m of CHAT_MESSAGES) {
      for (const [, mention] of m.text.matchAll(/@([A-Z][a-z]+(?: [A-Z][a-z]+)?|channel)/g)) {
        if (groups.has(mention!) || groups.has(mention!.split(" ")[0]!)) continue;
        const id = names.get(mention!);
        expect(id, mention).toBeDefined();
        expect(channelOf(m).memberIds).toContain(id);
      }
    }
  });

  it("citazioni ed eventi puntano a oggetti che esistono, del progetto del canale", () => {
    const refKindOf: Record<ChatEventKind, CitationRef["kind"]> = {
      release_page: "release",
      pr_opened: "task",
      pr_merged: "task",
      milestone_reached: "milestone",
      brief_ready: "brief",
      request_new: "request",
      task_closed: "task",
    };
    for (const m of CHAT_MESSAGES) {
      for (const ref of m.citations)
        expect(exists(ref), `${m.id} ${ref.kind}:${ref.id}`).toBe(true);
      for (const code of m.linkedCodes) expect(TASKS.some((t) => t.code === code)).toBe(true);
      if (m.event) {
        const c = channelOf(m);
        expect(c.kind).toBe("project");
        expect(c.publishedEvents).toContain(m.event.kind);
        expect(m.event.ref.kind).toBe(refKindOf[m.event.kind]);
        expect(exists(m.event.ref)).toBe(true);
        expect(projectOfRef(m.event.ref)).toBe(c.projectId);
      }
    }
    // L'evento arriva dopo il fatto: traguardo chiuso, task chiusa, richiesta creata.
    for (const m of CHAT_MESSAGES.filter((x) => x.event)) {
      const ref = m.event!.ref;
      if (m.event!.kind === "milestone_reached") {
        expect(MILESTONES.find((x) => x.id === ref.id)!.closed).toBe(true);
      }
      if (m.event!.kind === "task_closed") {
        expect(familyOf(tasksById.get(ref.id)!)).toBe("closed");
      }
      if (m.event!.kind === "request_new") {
        expect(m.createdAt >= REQUESTS.find((r) => r.id === ref.id)!.createdAt).toBe(true);
      }
      if (m.event!.kind === "brief_ready") {
        expect(m.createdAt >= BRIEFS.find((b) => b.id === ref.id)!.createdAt).toBe(true);
      }
    }
    // Ogni pagina di Release finta è citata da una scheda.
    for (const r of RELEASE_PAGES) {
      expect(
        CHAT_MESSAGES.some((m) => m.event?.ref.kind === "release" && m.event.ref.id === r.id),
      ).toBe(true);
    }
  });

  it("igiene: un canale di progetto cita solo oggetti del suo progetto", () => {
    for (const m of CHAT_MESSAGES.filter((x) => channelOf(x).kind === "project")) {
      const c = channelOf(m);
      for (const ref of m.citations) {
        const projectId = projectOfRef(ref);
        if (projectId === null) continue;
        expect(projectId, `${m.id} cita ${ref.kind}:${ref.id}`).toBe(c.projectId);
      }
    }
  });

  it("settimane di storico con thread, reazioni, citazioni, allegati ed eventi", () => {
    const span = (ids: string[]) => {
      const times = CHAT_MESSAGES.filter((m) => ids.includes(m.channelId)).map((m) =>
        Date.parse(m.createdAt),
      );
      return (Math.max(...times) - Math.min(...times)) / DAY;
    };
    for (const code of ["AUD", "STW", "MKX"]) {
      expect(span([`ch-${code.toLowerCase()}-general`])).toBeGreaterThanOrEqual(21);
    }
    for (const id of ["ch-aud-releases", "ch-mkx-grafica", "ch-announcements", "ch-chit-chat"]) {
      expect(span([id])).toBeGreaterThanOrEqual(14);
    }
    // Thread di lunghezze diverse.
    const lengths = new Set(
      CHAT_MESSAGES.filter((m) => m.threadOf === null)
        .map((root) => CHAT_MESSAGES.filter((m) => m.threadOf === root.id).length)
        .filter((n) => n > 0),
    );
    expect(lengths.size).toBeGreaterThanOrEqual(3);
    const cited = new Set(CHAT_MESSAGES.flatMap((m) => m.citations.map((r) => r.kind)));
    for (const kind of ["task", "request", "doc", "file", "project"] as const) {
      expect(cited.has(kind)).toBe(true);
    }
    expect(CHAT_MESSAGES.filter((m) => m.reactions.length > 0).length).toBeGreaterThanOrEqual(10);
    expect(CHAT_MESSAGES.some((m) => m.attachments.some((a) => a.kind === "image"))).toBe(true);
    expect(CHAT_MESSAGES.some((m) => m.attachments.some((a) => a.kind === "file"))).toBe(true);
    expect(CHAT_MESSAGES.some((m) => m.editedAt)).toBe(true);
    expect(CHAT_MESSAGES.some((m) => m.deletedAt)).toBe(true);
    expect(CHAT_MESSAGES.some((m) => m.linkedCodes.length > 0)).toBe(true);
    expect(CHAT_MESSAGES.some((m) => m.alsoInChannel)).toBe(true);
    expect(CHAT_MESSAGES.some((m) => m.asksReplyOf.length > 0)).toBe(true);
    const events = new Set(CHAT_MESSAGES.flatMap((m) => (m.event ? [m.event.kind] : [])));
    expect(events.size).toBe(7);
  });

  it("una risposta di @Claude con una proposta ancora aperta, di chi l'ha chiamato", () => {
    const withProposal = CHAT_MESSAGES.filter(
      (m) => m.kind === "claude" && m.claudeEvents?.some((e) => e.type === "proposal"),
    );
    expect(withProposal).toHaveLength(1);
    const reply = withProposal[0]!;
    const proposal = reply.claudeEvents!.find((e) => e.type === "proposal")!;
    if (proposal.type !== "proposal") throw new Error("unreachable");
    expect(proposal).toMatchObject({ status: "open", requesterId: reply.calledById });
    // Chiamato da un messaggio di chi l'ha chiamato, poco prima, nello stesso thread.
    const thread = CHAT_MESSAGES.filter(
      (m) => m.threadOf === reply.threadOf || m.id === reply.threadOf,
    );
    const call = thread.filter((m) => m.createdAt < reply.createdAt).at(-1)!;
    expect(call.authorId).toBe(reply.calledById);
    expect(call.text).toContain("@Claude");
    // Non ancora scaduta (area 3: 20 messaggi del thread o 24 ore).
    expect(thread.length).toBeLessThanOrEqual(20);
    expect(Date.parse(NOW) - Date.parse(reply.createdAt)).toBeLessThan(DAY);
    // Ogni risposta di Claude segue una chiamata «@Claude» di chi la firma.
    for (const m of CHAT_MESSAGES.filter((x) => x.kind === "claude")) {
      const before = CHAT_MESSAGES.filter(
        (x) =>
          (x.threadOf === m.threadOf || x.id === m.threadOf) &&
          x.createdAt < m.createdAt &&
          x.authorId === m.calledById,
      );
      expect(before.some((x) => x.text.includes("@Claude"))).toBe(true);
    }
  });

  it("una lettura per membro e canale; nessuna per chi non è membro", () => {
    const key = (personId: string, channelId: string) => `${personId}|${channelId}`;
    const keys = new Set(CHAT_READ_STATES.map((r) => key(r.personId, r.channelId)));
    expect(keys.size).toBe(CHAT_READ_STATES.length);
    for (const c of CHAT_CHANNELS) {
      for (const id of c.memberIds) expect(keys.has(key(id, c.id))).toBe(true);
    }
    for (const r of CHAT_READ_STATES) {
      expect(channelById.get(r.channelId)!.memberIds).toContain(r.personId);
      for (const rootId of Object.keys(r.threadReads)) {
        expect(messageById.get(rootId)?.channelId).toBe(r.channelId);
      }
    }
    for (const p of CHAT_NOTIFY_PREFS) {
      expect(channelById.get(p.channelId)!.memberIds).toContain(p.personId);
    }
  });

  it("le cinque persone hanno non letti, menzioni e thread con novità diversi", async () => {
    // Contati dal livello dati (una sola regola: silenziati, menzioni, DM, sistema).
    setLatency(0);
    resetApi();
    const countsOf = async (id: string) => {
      setSessionPersonId(id);
      const rows = await chat.listChannels();
      return {
        unread: rows.reduce((n, r) => n + r.unread, 0),
        mentioned: rows.reduce((n, r) => n + r.mentions, 0),
        threads: (await chat.listThreadsWithNews()).length,
      };
    };
    const personas = ["p-giulia", "p-marco", "p-laura", "p-sara", "p-roberta"];
    const counts = [];
    for (const id of personas) counts.push(await countsOf(id));
    resetApi();
    for (const c of counts) {
      expect(c.unread).toBeGreaterThan(0);
      expect(c.mentioned).toBeGreaterThan(0);
    }
    expect(new Set(counts.map((c) => `${c.unread}/${c.mentioned}`)).size).toBe(personas.length);
    expect(counts.filter((c) => c.threads > 0).length).toBeGreaterThanOrEqual(2);
  });

  it("ogni canale ha un tipo coerente coi suoi campi", () => {
    const check: Record<Channel["kind"], (c: Channel) => boolean> = {
      project: (c) => c.projectId !== null && projectsById.has(c.projectId),
      general: (c) => c.projectId === null && !c.isGeneral,
      dm: (c) => c.projectId === null && !c.isGeneral && c.visibility === "private",
    };
    for (const c of CHAT_CHANNELS) expect(check[c.kind](c), c.id).toBe(true);
  });
});

describe("seed: Drive (area 5)", () => {
  const NOW = `${TODAY}T12:00:00Z`;
  const DAY = 86_400_000;
  const ms = (iso: string) => new Date(iso).getTime();
  const project = (code: string) => PROJECTS.find((p) => p.code === code)!;
  const filesOf = (code: string) => DRIVE_FILES.filter((f) => f.projectId === project(code).id);
  const fileById = new Map(DRIVE_FILES.map((f) => [f.id, f]));
  const opensOf = (fileId: string) => DRIVE_OPENS.filter((o) => o.fileId === fileId);
  const opens90d = (fileId: string) =>
    opensOf(fileId).filter((o) => ms(NOW) - ms(o.at) <= 90 * DAY).length;
  const accountOf = (personId: string) => GOOGLE_ACCOUNTS.find((a) => a.personId === personId);

  it("id unici e codici <PRJ>-F<n> unici per progetto, col prefisso del progetto", () => {
    expect(new Set(DRIVE_FILES.map((f) => f.id)).size).toBe(DRIVE_FILES.length);
    const seen = new Set<string>();
    for (const f of DRIVE_FILES) {
      const m = /^([A-Z]{3})-F([1-9]\d*)$/.exec(f.code);
      expect(m, f.code).not.toBeNull();
      expect(projectsById.get(f.projectId)!.code).toBe(m![1]);
      expect(seen.has(f.code), f.code).toBe(false);
      seen.add(f.code);
    }
  });

  it("chi aggiunge un file è membro del progetto, e ogni data sta prima di adesso", () => {
    for (const f of DRIVE_FILES) {
      expect(projectsById.get(f.projectId)!.memberIds, f.code).toContain(f.addedById);
      expect(ms(f.addedAt) <= ms(f.modifiedAt) || f.source === "google", f.code).toBe(true);
      expect(ms(f.addedAt)).toBeLessThanOrEqual(ms(NOW));
      expect(ms(f.modifiedAt)).toBeLessThanOrEqual(ms(NOW));
    }
  });

  it("caricati e Google hanno i campi della loro provenienza", () => {
    for (const f of DRIVE_FILES) {
      if (f.source === "upload") {
        expect(f.googleFileId, f.code).toBeNull();
        expect(f.googleOwner, f.code).toBeNull();
        expect(f.folderLinkId, f.code).toBeNull();
        expect(f.unavailable, f.code).toBeNull();
        expect(f.hidden, f.code).toBe(false);
        expect(f.sizeBytes, f.code).toBeGreaterThan(0);
      } else {
        expect(f.googleFileId, f.code).toBeTruthy();
        expect(f.googleOwner, f.code).toMatch(/@/);
      }
    }
  });

  it("il contenuto è coerente col suo stato", () => {
    for (const f of DRIVE_FILES.filter((x) => x.unavailable === null)) {
      if (f.content === "ready") {
        expect(f.text.length, f.code).toBeGreaterThan(0);
        expect(f.summary, f.code).toBeTruthy();
      } else {
        expect(f.text, f.code).toBe("");
        expect(f.summary, f.code).toBeNull();
      }
      if (f.ocr) expect(f.content, f.code).toBe("ready");
    }
  });

  it("i file di una cartella stanno nel suo progetto e risultano aggiunti da chi l'ha collegata", () => {
    const linkById = new Map(FOLDER_LINKS.map((l) => [l.id, l]));
    for (const f of DRIVE_FILES.filter((x) => x.folderLinkId !== null)) {
      const link = linkById.get(f.folderLinkId!);
      expect(link, f.code).toBeDefined();
      expect(f.source).toBe("google");
      expect(f.projectId).toBe(link!.projectId);
      expect(f.addedById).toBe(link!.linkedById);
      expect(f.addedAt).toBe(link!.linkedAt);
    }
    for (const l of FOLDER_LINKS) {
      expect(projectsById.get(l.projectId)!.memberIds).toContain(l.linkedById);
    }
  });

  it("AUD: la cartella «AUD – Cliente» con contratto, preventivo (foglio) e presentazione, più i caricati", () => {
    const link = FOLDER_LINKS.find((l) => l.name === "AUD – Cliente")!;
    expect(link.projectId).toBe(project("AUD").id);
    expect(link.status).toBe("ok");
    const inFolder = filesOf("AUD").filter((f) => f.folderLinkId === link.id);
    expect(inFolder.some((f) => f.type === "document" && /contratto/i.test(f.name))).toBe(true);
    expect(inFolder.some((f) => f.type === "sheet" && /preventivo/i.test(f.name))).toBe(true);
    expect(inFolder.some((f) => f.type === "slides" && /presentazione/i.test(f.name))).toBe(true);
    const uploads = filesOf("AUD").filter((f) => f.source === "upload");
    expect(uploads.some((f) => f.type === "pdf" && /specifiche/i.test(f.name))).toBe(true);
    expect(
      uploads.filter((f) => f.type === "image" && /mockup/i.test(f.name)).length,
    ).toBeGreaterThan(1);
    expect(uploads.some((f) => f.name.endsWith(".zip") && f.content === "unsupported")).toBe(true);
  });

  it("MKX ha molti file grafici e una cartella collegata; un progetto non ha file", () => {
    expect(filesOf("MKX").filter((f) => f.type === "image").length).toBeGreaterThanOrEqual(20);
    expect(FOLDER_LINKS.some((l) => l.projectId === project("MKX").id)).toBe(true);
    expect(filesOf("UFF")).toEqual([]);
    expect(FOLDER_LINKS.some((l) => l.projectId === project("UFF").id)).toBe(false);
  });

  it("i casi del contenuto: Google non disponibile, in elaborazione, PDF con OCR, immagine senza testo", () => {
    const google = DRIVE_FILES.filter((f) => f.source === "google");
    expect(google.some((f) => f.unavailable === "deleted")).toBe(true);
    expect(google.some((f) => f.unavailable === null && f.content === "processing")).toBe(true);
    expect(DRIVE_FILES.some((f) => f.type === "pdf" && f.ocr)).toBe(true);
    expect(DRIVE_FILES.some((f) => f.type === "image" && f.content === "no_text")).toBe(true);
    // Un file di cartella nascosto, per il filtro «Nascosti».
    expect(google.some((f) => f.hidden && f.folderLinkId !== null)).toBe(true);
  });

  it("un file Google in due progetti è due riferimenti, con due codici", () => {
    const byGoogleId = new Map<string, Set<string>>();
    for (const f of DRIVE_FILES.filter((x) => x.googleFileId)) {
      const set = byGoogleId.get(f.googleFileId!) ?? new Set();
      expect(set.has(f.projectId), f.code).toBe(false);
      set.add(f.projectId);
      byGoogleId.set(f.googleFileId!, set);
    }
    expect([...byGoogleId.values()].some((s) => s.size > 1)).toBe(true);
  });

  it("il contratto di AUD risponde ai tempi di consegna", () => {
    const contract = filesOf("AUD").find((f) => /contratto/i.test(f.name))!;
    expect(contract.content).toBe("ready");
    expect(contract.text).toMatch(/delivery times/i);
    expect(contract.text).toMatch(/within 30 working days/i);
    expect(contract.summary).toMatch(/delivery within 30 working days/i);
  });

  it("aperture: su più di 90 giorni, di membri, dopo l'aggiunta, mai due della stessa persona entro 30 minuti", () => {
    const ats = DRIVE_OPENS.map((o) => ms(o.at));
    expect(ms(NOW) - Math.min(...ats)).toBeGreaterThan(90 * DAY);
    const last = new Map<string, number[]>();
    for (const o of DRIVE_OPENS) {
      const f = fileById.get(o.fileId)!;
      expect(f, o.fileId).toBeDefined();
      expect(projectsById.get(f.projectId)!.memberIds, f.code).toContain(o.personId);
      expect(ms(o.at)).toBeGreaterThanOrEqual(ms(f.addedAt));
      expect(ms(o.at)).toBeLessThanOrEqual(ms(NOW));
      expect(o.via === "google", f.code).toBe(f.source === "google");
      const key = `${o.fileId}|${o.personId}`;
      const prev = last.get(key) ?? [];
      for (const p of prev) expect(Math.abs(p - ms(o.at)), key).toBeGreaterThan(30 * 60_000);
      last.set(key, [...prev, ms(o.at)]);
    }
  });

  it("aperture: file molto usati, mai aperti, e uno aperto solo più di 90 giorni fa", () => {
    const visible = DRIVE_FILES.filter((f) => f.unavailable === null && !f.hidden);
    expect(Math.max(...visible.map((f) => opens90d(f.id)))).toBeGreaterThanOrEqual(20);
    expect(visible.filter((f) => opensOf(f.id).length === 0).length).toBeGreaterThan(2);
    expect(visible.some((f) => opensOf(f.id).length > 0 && opens90d(f.id) === 0)).toBe(true);
  });

  it("account Google: fra le persone del «vedi come» una collegata, una scaduta, una senza", () => {
    const personaIds = VIEW_AS_PERSONAS.map((p) => p.personId);
    const statuses = personaIds.map((id) => accountOf(id)?.status ?? "none");
    expect(statuses).toContain("connected");
    expect(statuses).toContain("expired");
    expect(statuses).toContain("none");
    expect(new Set(GOOGLE_ACCOUNTS.map((a) => a.personId)).size).toBe(GOOGLE_ACCOUNTS.length);
    // Una cartella scaduta lo è perché l'account di chi l'ha collegata è scaduto.
    for (const l of FOLDER_LINKS) {
      expect(accountOf(l.linkedById)?.status, l.name).toBe(
        l.status === "ok" ? "connected" : "expired",
      );
    }
    expect(FOLDER_LINKS.some((l) => l.status === "expired")).toBe(true);
  });

  it("un file Google fuori dai progetti, visibile solo a chi ha l'account collegato", () => {
    expect(GOOGLE_OUTSIDE_FILES.length).toBeGreaterThan(0);
    const inProjects = new Set(DRIVE_FILES.map((f) => f.googleFileId));
    for (const g of GOOGLE_OUTSIDE_FILES) {
      expect(inProjects.has(g.googleFileId), g.name).toBe(false);
      expect(g.visibleToPersonIds.length).toBeGreaterThan(0);
      for (const id of g.visibleToPersonIds) {
        expect(accountOf(id)?.status, `${g.name} / ${id}`).toBe("connected");
      }
    }
    // Una persona del «vedi come» lo trova.
    const personaIds = new Set(VIEW_AS_PERSONAS.map((p) => p.personId));
    expect(
      GOOGLE_OUTSIDE_FILES.some((g) => g.visibleToPersonIds.some((id) => personaIds.has(id))),
    ).toBe(true);
  });
});

describe("seed: Posta (area 6)", () => {
  const NOW = `${TODAY}T12:00:00Z`;
  const project = (code: string) => PROJECTS.find((p) => p.code === code)!;
  const AUD = project("AUD").id;
  const STW = project("STW").id;
  const MKX = project("MKX").id;
  type Message = (typeof MAIL_MESSAGES)[number];
  const message = (id: string): Message => {
    const m = MAIL_MESSAGES.find((x) => x.id === id);
    expect(m, id).toBeDefined();
    return m!;
  };
  /** I destinatari in Stubwise: mittente, `to`, `cc`, proprietari delle caselle. */
  const recipients = (m: Message) =>
    new Set([
      ...[m.from, ...m.to, ...(m.cc ?? [])].flatMap((a) => (a.personId ? [a.personId] : [])),
      ...m.mailboxPersonIds,
    ]);
  const done = (id: string) => {
    const c = message(id).classification;
    if (c.state !== "done") throw new Error(`${id}: ${c.state}`);
    return c;
  };
  const proposalsOf = (id: string) =>
    MAIL_PROPOSALS.filter((p) => p.sourceId === message(id).messageId);

  it("id e Message-ID unici: la stessa email a tre caselle è una riga sola", () => {
    expect(new Set(MAIL_MESSAGES.map((m) => m.id)).size).toBe(MAIL_MESSAGES.length);
    expect(new Set(MAIL_MESSAGES.map((m) => m.messageId)).size).toBe(MAIL_MESSAGES.length);
    expect(new Set(MAIL_PROPOSALS.map((p) => p.id)).size).toBe(MAIL_PROPOSALS.length);
    for (const m of MAIL_MESSAGES) {
      expect(m.messageId, m.id).toMatch(/^<[^<>\s]+@[^<>\s]+>$/);
      expect(m.at <= NOW, m.id).toBe(true);
      expect(m.mailboxPersonIds.length, m.id).toBeGreaterThan(0);
    }
    expect(MAIL_DRAFTS).toEqual([]);
  });

  it("caselle: Giulia e Matteo collegati, Laura scaduta; nessuna di Roberta", () => {
    const accountOf = (personId: string) => GOOGLE_ACCOUNTS.find((a) => a.personId === personId);
    const box = (personId: string) => MAILBOXES.find((b) => b.personId === personId);
    expect(MAILBOXES.map((b) => b.personId).sort()).toEqual(["p-giulia", "p-laura", "p-matteo"]);
    for (const b of MAILBOXES) {
      expect(accountOf(b.personId)?.email, b.personId).toBe(b.email);
      expect(b.syncedAt <= NOW, b.personId).toBe(true);
    }
    expect(box("p-giulia")!.proposalsEnabled).toBe(true);
    expect(accountOf("p-giulia")?.status).toBe("connected");
    expect(accountOf("p-matteo")?.status).toBe("connected");
    expect(accountOf("p-laura")?.status).toBe("expired");
    expect(box("p-laura")!.sync).toBe("failed");
    expect(box("p-roberta")).toBeUndefined();
    // Ogni messaggio sta in caselle che esistono, arrivato prima del loro ultimo allineamento.
    for (const m of MAIL_MESSAGES) {
      for (const id of m.mailboxPersonIds) {
        expect(m.at <= (box(id)?.syncedAt ?? ""), `${m.id} / ${id}`).toBe(true);
      }
    }
  });

  it("Roberta (admin) non è fra i destinatari di nessun messaggio", () => {
    for (const m of MAIL_MESSAGES) expect(recipients(m).has("p-roberta"), m.id).toBe(false);
  });

  it("AUD e STW, importanza alta/normale/bassa, con scadenze", () => {
    const classified = MAIL_MESSAGES.flatMap((m) =>
      m.classification.state === "done" ? [m.classification] : [],
    );
    for (const prj of [AUD, STW]) {
      const of = classified.filter((c) => c.projectIds.includes(prj));
      expect(new Set(of.map((c) => c.importance)), prj).toEqual(new Set(["high", "normal", "low"]));
      expect(
        of.some((c) => c.dueDate !== null && c.dueDate > TODAY),
        prj,
      ).toBe(true);
    }
  });

  it("newsletter e posta personale senza progetto e senza proposte", () => {
    for (const id of [MAIL_CASES.newsletter1, MAIL_CASES.newsletter2, MAIL_CASES.personal]) {
      const c = done(id);
      expect(c.projectIds, id).toEqual([]);
      expect(c.uncertainProjectIds, id).toEqual([]);
      expect(proposalsOf(id), id).toEqual([]);
    }
  });

  it("una email incerta fra AUD e MKX", () => {
    const c = done(MAIL_CASES.uncertain);
    expect(c.projectIds).toEqual([]);
    expect([...c.uncertainProjectIds].sort()).toEqual([AUD, MKX].sort());
    // Una sola proposta: «scegli il progetto», con le azioni pronte per i due.
    const ps = proposalsOf(MAIL_CASES.uncertain);
    expect(ps.map((p) => p.actions.map((a) => a.fn))).toEqual([["chooseProject"]]);
    const args = ps[0]!.actions[0]!.args as {
      projectIds: string[];
      actionsByProject: Record<string, { fn: string; args: { projectId: string } }[]>;
    };
    expect([...args.projectIds].sort()).toEqual([AUD, MKX].sort());
    for (const id of args.projectIds) {
      expect(args.actionsByProject[id]!.length, id).toBeGreaterThan(0);
      for (const a of args.actionsByProject[id]!) expect(a.args.projectId).toBe(id);
    }
  });

  it("una email a Giulia, Matteo e Laura con una proposta condivisa aperta", () => {
    const m = message(MAIL_CASES.shared);
    expect([...m.mailboxPersonIds].sort()).toEqual(["p-giulia", "p-laura", "p-matteo"]);
    const ps = proposalsOf(MAIL_CASES.shared);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.status).toBe("open");
    expect(ps[0]!.decidedById).toBeNull();
    // Tutti e tre membri del progetto: la vedono tutti e tre.
    const members = projectsById.get(ps[0]!.projectId)!.memberIds;
    for (const id of m.mailboxPersonIds) expect(members).toContain(id);
  });

  it("una proposta già confermata da Matteo e una passata al progetto", () => {
    const [confirmed] = proposalsOf(MAIL_CASES.confirmed);
    expect(confirmed?.status).toBe("confirmed");
    expect(confirmed?.decidedById).toBe("p-matteo");
    expect(confirmed?.decidedAt).not.toBeNull();
    expect(confirmed?.resultCodes.length).toBeGreaterThan(0);
    const [handed] = proposalsOf(MAIL_CASES.handed);
    expect(handed?.status).toBe("handed");
    expect(handed?.handedAt).not.toBeNull();
    expect(handed?.decidedById).not.toBeNull();
    expect(handed?.excerpt.length).toBeGreaterThan(0);
  });

  it("l'email di Gemini dopo la riunione AUD di ieri: trascrizione pronta e quattro task", () => {
    const m = message(MAIL_CASES.transcript);
    expect(m.kind).toBe("transcript");
    expect(m.at.slice(0, 10)).toBe(daysFromToday(-1));
    const t = MEETING_TRANSCRIPTS.find((x) => x.messageId === m.id)!;
    expect(t.doc).toBe("ready");
    expect(t.eventId).toBe(EV_AUD_REVIEW_YESTERDAY);
    expect(t.transcript.length).toBeGreaterThan(0);
    expect(t.summary).not.toBeNull();
    const ps = proposalsOf(MAIL_CASES.transcript);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.source).toBe("transcript");
    expect(ps[0]!.projectId).toBe(AUD);
    expect(ps[0]!.actions.map((a) => a.fn)).toEqual(Array(4).fill("createTask"));
    expect(ps[0]!.actions.map((a) => a.args.assigneeId)).toContain("p-chiara");
    // Chiara (marketing) non è nel progetto, e non era alla riunione.
    expect(PEOPLE.find((p) => p.id === "p-chiara")!.departmentIds).toEqual(["dep-marketing"]);
    expect(project("AUD").memberIds).not.toContain("p-chiara");
    expect(recipients(m).has("p-chiara")).toBe(false);
  });

  it("una trascrizione non raggiungibile, una classificazione in analisi e una fallita", () => {
    const m = message(MAIL_CASES.transcriptUnreachable);
    expect(m.kind).toBe("transcript");
    const t = MEETING_TRANSCRIPTS.find((x) => x.messageId === m.id)!;
    expect(t.doc).toBe("unreachable");
    expect(t.summary).toBeNull();
    expect(message(MAIL_CASES.pending).classification.state).toBe("pending");
    expect(message(MAIL_CASES.failed).classification.state).toBe("failed");
    for (const x of MEETING_TRANSCRIPTS) expect(message(x.messageId).kind).toBe("transcript");
  });

  it("contenuti estremi: 60 messaggi, HTML ostile, 40 destinatari", () => {
    const threadId = message(MAIL_CASES.longThread).threadId;
    const thread = MAIL_MESSAGES.filter((m) => m.threadId === threadId);
    expect(thread).toHaveLength(60);
    expect(new Set(thread.map((m) => m.at)).size).toBe(60);
    const hostile = message(MAIL_CASES.hostileHtml).html ?? "";
    expect(hostile).toMatch(/<script/i);
    expect(hostile).toMatch(/<img[^>]+src="https?:\/\//i);
    const crowd = message(MAIL_CASES.fortyRecipients);
    expect(crowd.to.length + (crowd.cc ?? []).length).toBe(40);
  });

  it("le caselle con le proposte spente non mandano la loro posta al modello", () => {
    const on = new Set(MAILBOXES.filter((b) => b.proposalsEnabled).map((b) => b.personId));
    for (const m of MAIL_MESSAGES) {
      const anyOn = m.mailboxPersonIds.some((id) => on.has(id));
      expect(m.classification.state === "off", m.id).toBe(!anyOn);
    }
    expect(MAIL_MESSAGES.some((m) => m.classification.state === "off")).toBe(true);
  });

  it("ogni proposta ha un progetto di cui almeno un destinatario è membro", () => {
    const byMessageId = new Map(MAIL_MESSAGES.map((m) => [m.messageId, m]));
    for (const p of MAIL_PROPOSALS) {
      const m = byMessageId.get(p.sourceId);
      expect(m, p.id).toBeDefined();
      const members = new Set(projectsById.get(p.projectId)!.memberIds);
      expect(
        [...recipients(m!)].some((id) => members.has(id)),
        p.id,
      ).toBe(true);
      expect(p.createdAt >= m!.at && p.createdAt <= NOW, p.id).toBe(true);
      expect(p.source, p.id).toBe(m!.kind === "transcript" ? "transcript" : "email");
      const c = m!.classification;
      const choosing = p.actions.some((a) => a.fn === "chooseProject");
      // Una «scegli il progetto» è di un'email incerta: il suo progetto è un candidato.
      expect(
        c.state === "done" ? (choosing ? c.uncertainProjectIds : c.projectIds) : [],
        p.id,
      ).toContain(p.projectId);
      expect(p.actions.length, p.id).toBeGreaterThan(0);
      if (choosing) expect(p.actions, p.id).toHaveLength(1);
      for (const a of p.actions) {
        expect(
          [
            "createTask",
            "createRequest",
            "updateTask",
            "addComment",
            "recordDecision",
            "createMilestone",
            "chooseProject",
          ],
          p.id,
        ).toContain(a.fn);
        const taskId = a.fn === "updateTask" ? a.args.id : a.args.taskId;
        if (a.fn === "updateTask" || a.fn === "addComment") {
          expect(tasksById.get(taskId as string)?.projectId, p.id).toBe(p.projectId);
        }
      }
      expect(p.status === "open", p.id).toBe(p.decidedById === null);
    }
  });

  it("le proposte del calendario: solo traguardo, richiesta o promemoria, da un evento con partecipanti membri", () => {
    const events = new Map(CALENDAR_EVENTS.map((e) => [e.id, e]));
    expect(CALENDAR_PROPOSALS.length).toBeGreaterThan(0);
    for (const p of CALENDAR_PROPOSALS) {
      expect(p.source, p.id).toBe("calendar");
      const e = events.get(p.sourceId);
      expect(e, p.id).toBeDefined();
      const members = new Set(projectsById.get(p.projectId)!.memberIds);
      expect(
        e!.attendees.some(
          (a) => a.personId && a.response !== "declined" && members.has(a.personId),
        ),
        p.id,
      ).toBe(true);
      for (const a of p.actions) {
        expect(["createMilestone", "createRequest", "acknowledgeReminder"], p.id).toContain(a.fn);
        // Un promemoria non crea nulla: porta solo titolo e data.
        if (a.fn === "acknowledgeReminder")
          expect(Object.keys(a.args).sort()).toEqual(["date", "title"]);
      }
    }
  });
});

describe("seed: Automations (area 7)", () => {
  const NOW = `${TODAY}T12:00:00Z`;
  const automation = (id: string) => {
    const a = AUTOMATIONS.find((x) => x.id === id);
    expect(a, id).toBeDefined();
    return a!;
  };
  const run = (id: string) => {
    const r = AUTOMATION_RUNS.find((x) => x.id === id);
    expect(r, id).toBeDefined();
    return r!;
  };
  const source = (id: string) => AUTOMATION_SOURCES.find((s) => s.id === id)!;
  /** Tutti i passi di un albero, rami compresi, in ordine di visita. */
  const allSteps = (steps: Step[]): Step[] =>
    steps.flatMap((s) => [
      s,
      ...(s.kind === "claude" ? Object.values(s.branches).flatMap(allSteps) : []),
      ...(s.kind === "condition" ? [...allSteps(s.then), ...allSteps(s.else)] : []),
      ...(s.kind === "forEach" ? allSteps(s.steps) : []),
      ...(s.kind === "repeatUntil" ? [...allSteps(s.steps), ...allSteps(s.onLimit)] : []),
    ]);
  const latestFlow = (id: string) => automation(id).versions.at(-1)!.flow;
  const published = (id: string) => automation(id).versions.filter((v) => v.publishedAt !== null);

  it("sorgenti: Audin collegato con 3 trattative chiuse, HubSpot scaduto, un webhook", () => {
    const audin = AUTOMATION_SOURCES.filter((s) => s.kind === "audin");
    expect(audin).toHaveLength(1);
    expect(audin[0]!.status).toBe("connected");
    expect(audin[0]!.sampleEvents).toHaveLength(3);
    const hubspot = AUTOMATION_SOURCES.filter((s) => s.kind === "hubspot");
    expect(hubspot.map((s) => s.status)).toEqual(["expired"]);
    const webhooks = AUTOMATION_SOURCES.filter((s) => s.kind === "webhook");
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]!.sampleEvents.length).toBeGreaterThan(0);
    expect(new Set(AUTOMATION_SOURCES.map((s) => s.id)).size).toBe(AUTOMATION_SOURCES.length);
    // Le collega chi ha integrations.manage.
    for (const s of AUTOMATION_SOURCES) {
      expect(can(viewerFor(s.connectedById), "integrations.manage"), s.id).toBe(true);
      expect(s.fields.length, s.id).toBeGreaterThan(0);
    }
  });

  it("le trattative di Audin: prodotti diversi e un contratto PDF con testo", () => {
    type Deal = {
      trattativa: { prodotti: { nome: string }[]; contratto: { tipo: string; testo: string } };
      cliente: { nome: string; email: string; dominio: string };
    };
    const deals = source(AUTOMATION_CASES.sources.audin).sampleEvents as unknown as Deal[];
    const products = deals.map((d) =>
      d.trattativa.prodotti
        .map((p) => p.nome)
        .sort()
        .join(","),
    );
    expect(new Set(products).size).toBe(3);
    for (const d of deals) {
      expect(d.trattativa.contratto.tipo).toBe("pdf");
      expect(d.trattativa.contratto.testo.length).toBeGreaterThan(200);
      expect(d.cliente.email).toMatch(/@/);
    }
    // Ogni campo dichiarato dalla sorgente c'è nelle trattative.
    const read = (o: unknown, key: string) =>
      key.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], o);
    for (const f of source(AUTOMATION_CASES.sources.audin).fields) {
      for (const d of deals) expect(read(d, f.key), f.key).toBeDefined();
    }
  });

  it("tabella cliente → progetto: 3 righe, una verso un progetto che qualcuno non vede", () => {
    expect(CLIENT_PROJECT_LINKS).toHaveLength(3);
    expect(new Set(CLIENT_PROJECT_LINKS.map((l) => l.clientKey)).size).toBe(3);
    for (const l of CLIENT_PROJECT_LINKS)
      expect(projectsById.has(l.projectId), l.clientKey).toBe(true);
    const hiddenTo = (projectId: string) =>
      VIEW_AS_PERSONAS.filter(
        (p) =>
          p.viewer.instancePermissions.includes("instance.full_admin") === false &&
          !projectsById.get(projectId)!.memberIds.includes(p.personId),
      );
    expect(CLIENT_PROJECT_LINKS.some((l) => hiddenTo(l.projectId).length > 0)).toBe(true);
    // Una trattativa di Audin col cliente fuori dalla tabella (→ «scegli il progetto»).
    const keys = new Set(CLIENT_PROJECT_LINKS.map((l) => l.clientKey));
    const deals = source(AUTOMATION_CASES.sources.audin).sampleEvents as {
      cliente: { dominio: string };
    }[];
    expect(deals.filter((d) => !keys.has(d.cliente.dominio))).toHaveLength(1);
  });

  it("codici unici e nel formato: <PRJ>-A<n> di progetto, AUT-<n> generale", () => {
    expect(new Set(AUTOMATIONS.map((a) => a.id)).size).toBe(AUTOMATIONS.length);
    expect(new Set(AUTOMATIONS.map((a) => a.code)).size).toBe(AUTOMATIONS.length);
    for (const a of AUTOMATIONS) {
      if (a.projectId === null) expect(a.code).toMatch(/^AUT-[1-9]\d*$/);
      else {
        const project = projectsById.get(a.projectId);
        expect(project, a.id).toBeDefined();
        expect(a.code).toMatch(new RegExp(`^${project!.code}-A[1-9]\\d*$`));
      }
    }
  });

  it("«Nuovo contratto» (AUT-1): generale, attiva, di chi ha automations.manage d'istanza", () => {
    const a = automation(AUTOMATION_CASES.automations.newContract);
    expect(a).toMatchObject({
      code: "AUT-1",
      name: "Nuovo contratto",
      projectId: null,
      status: "active",
    });
    expect(a.ownerId).not.toBeNull();
    expect(can(viewerFor(a.ownerId!), "automations.manage")).toBe(true);
    const flow = latestFlow(a.id);
    expect(flow.trigger).toEqual({
      kind: "source",
      sourceId: AUTOMATION_CASES.sources.audin,
      event: "deal_won",
    });
    const kinds = flow.steps.map((s) => s.kind);
    // Claude legge contratto e prodotti → traguardo → per ogni task → email di benvenuto.
    expect(kinds).toEqual(["claude", "createMilestone", "forEach", "sendEmail"]);
    const claude = flow.steps[0]!;
    if (claude.kind !== "claude") throw new Error("claude");
    expect(claude.inputs).toEqual(
      expect.arrayContaining(["trattativa.contratto", "trattativa.prodotti"]),
    );
    expect(claude.fields.find((f) => f.type === "list")).toBeDefined();
    const milestone = flow.steps[1]!;
    if (milestone.kind !== "createMilestone") throw new Error("milestone");
    expect(milestone.name).toMatch(/^Attivazione .+ – .+$/);
    expect(milestone.project.mode).toBe("from_client");
    const forEach = flow.steps[2]!;
    if (forEach.kind !== "forEach") throw new Error("forEach");
    const tasks = allSteps(forEach.steps).filter((s) => s.kind === "createTask");
    expect(tasks.length).toBeGreaterThan(1);
    for (const t of tasks) {
      if (t.kind !== "createTask") continue;
      expect(t.assignee && "departmentId" in t.assignee, t.id).toBe(true);
      expect(t.milestoneRef).toBe(milestone.id);
    }
    const email = flow.steps[3]!;
    expect(email.kind === "sendEmail" && email.approval.mode).toBe("ask");
  });

  it("«Richiesta dati al cliente» (AUD-A1): di AUD, attiva, di Laura; email → attesa → promemoria → Claude", () => {
    const a = automation(AUTOMATION_CASES.automations.clientData);
    expect(a).toMatchObject({
      code: "AUD-A1",
      name: "Richiesta dati al cliente",
      projectId: "prj-aud",
      status: "active",
      ownerId: "p-laura",
    });
    expect(can(viewerFor("p-laura"), "automations.manage", "prj-aud")).toBe(true);
    const flow = latestFlow(a.id);
    const [ask, wait, reminders, check] = flow.steps;
    expect(ask!.kind).toBe("sendEmail");
    expect(wait).toMatchObject({ kind: "wait", for: { replyTo: ask!.id, maxDays: 5 } });
    if (reminders!.kind !== "repeatUntil") throw new Error("repeatUntil");
    expect(reminders!.max).toBe(2);
    expect(reminders!.steps.map((s) => s.kind)).toEqual(["sendEmail", "wait"]);
    expect(reminders!.onLimit.length).toBeGreaterThan(0);
    const claude = allSteps(flow.steps).find((s) => s.kind === "claude");
    if (claude?.kind !== "claude") throw new Error("claude");
    expect(check!.kind).toBe("condition");
    expect(claude.outcomes).toEqual(["tutto presente", "mancano informazioni"]);
    expect(Object.keys(claude.branches).sort()).toEqual(claude.outcomes.slice().sort());
    expect(claude.branches["tutto presente"]!.some((s) => s.kind === "createTask")).toBe(true);
    const missing = claude.branches["mancano informazioni"]!;
    const missingEmail = missing.find((s) => s.kind === "sendEmail");
    expect(missingEmail?.kind === "sendEmail" && missingEmail.approval.mode).toBe("ask");
    // «e torna ad aspettare»
    expect(missing.some((s) => s.kind === "wait")).toBe(true);
  });

  it("una bozza mai accesa e un'automazione in pausa", () => {
    const draft = automation(AUTOMATION_CASES.automations.draft);
    expect(draft.status).toBe("draft");
    expect(draft.ownerId).toBeNull();
    expect(published(draft.id)).toHaveLength(0);
    expect(AUTOMATION_RUNS.some((r) => r.automationId === draft.id)).toBe(false);
    const paused = automation(AUTOMATION_CASES.automations.paused);
    expect(paused.status).toBe("paused");
    expect(paused.ownerId).not.toBeNull();
    expect(published(paused.id).length).toBeGreaterThan(0);
  });

  it("ogni flusso: id dei passi unici, ripetizioni entro il limite, approvatori indicati", () => {
    for (const a of AUTOMATIONS) {
      for (const v of a.versions) {
        const steps = allSteps(v.flow.steps);
        expect(new Set(steps.map((s) => s.id)).size, `${a.code} v${v.n}`).toBe(steps.length);
        for (const s of steps) {
          if (s.kind === "repeatUntil") {
            expect(s.max).toBeGreaterThan(0);
            expect(s.max).toBeLessThanOrEqual(10);
          }
          if (s.kind === "claude") {
            expect(s.outcomes.length + s.fields.length, s.id).toBeGreaterThan(0);
            for (const k of Object.keys(s.branches)) expect(s.outcomes, s.id).toContain(k);
          }
          if ("approval" in s && s.approval.mode === "ask" && "personId" in s.approval.who) {
            expect(
              PEOPLE.some(
                (p) => p.id === (s.approval as { who: { personId: string } }).who.personId,
              ),
            ).toBe(true);
          }
        }
        expect(v.flow.titleTemplate.length).toBeGreaterThan(0);
      }
      // Versioni numerate da 1; solo l'ultima può essere bozza.
      expect(a.versions.map((v) => v.n)).toEqual(a.versions.map((_, i) => i + 1));
      for (const v of a.versions.slice(0, -1)) expect(v.publishedAt, a.code).not.toBeNull();
      for (const v of a.versions) {
        if (v.publishedAt) {
          expect(v.publishedAt <= NOW).toBe(true);
          expect(v.publishedById).not.toBeNull();
        }
      }
    }
  });

  it.todo("ogni flusso del seme passa validateFlow (si attiva nel Task 2)");

  it("esecuzioni: in attesa del cliente da 3 giorni, ferma su un'approvazione, finita, fallita, senza progetto", () => {
    const waitingEvent = run(AUTOMATION_CASES.runs.waitingEvent);
    expect(waitingEvent.status).toBe("waiting_event");
    expect(waitingEvent.log.at(-1)!.outcome).toBe("waiting");
    expect(waitingEvent.log.at(-1)!.at.slice(0, 10)).toBe(daysFromToday(-3));
    expect(waitingEvent.waitingUntil! > NOW).toBe(true);

    const approval = run(AUTOMATION_CASES.runs.waitingApproval);
    expect(approval.status).toBe("waiting_approval");
    expect(approval.pending!.approverIds).toEqual(["p-laura"]);
    expect(Object.keys(approval.pending!.preview).sort()).toEqual(["body", "subject", "to"]);
    // Il passo da approvare non ha prodotto effetti.
    expect(approval.log.at(-1)).toMatchObject({
      kind: "sendEmail",
      outcome: "waiting",
      effects: [],
    });

    const done = run(AUTOMATION_CASES.runs.done);
    expect(done.status).toBe("done");
    expect(done.endedAt).not.toBeNull();
    expect(done.log.some((e) => e.kind === "claude" && e.reason)).toBe(true);
    expect(done.log.some((e) => e.outcome === "approved" && e.byId)).toBe(true);

    const failed = run(AUTOMATION_CASES.runs.failed);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("permesso perso");
    expect(failed.log.at(-1)).toMatchObject({ outcome: "failed", reason: "permesso perso" });

    const project = run(AUTOMATION_CASES.runs.waitingProject);
    expect(project.status).toBe("waiting_project");
    expect(project.projectIds).toEqual([]);
    expect(project.pending!.approverIds).toEqual([automation(project.automationId).ownerId]);
  });

  it("esecuzioni coerenti: numerate per automazione, versione pubblicata, date, stati finali", () => {
    const keys = AUTOMATION_RUNS.map((r) => `${r.automationId}#${r.n}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(AUTOMATION_RUNS.map((r) => r.id)).size).toBe(AUTOMATION_RUNS.length);
    const terminal = new Set(["done", "failed", "cancelled"]);
    for (const r of AUTOMATION_RUNS) {
      const a = automation(r.automationId);
      expect(
        published(a.id).map((v) => v.n),
        r.id,
      ).toContain(r.version);
      expect(r.startedAt <= NOW, r.id).toBe(true);
      expect(r.endedAt !== null, r.id).toBe(terminal.has(r.status));
      expect(r.pending !== null, r.id).toBe(
        r.status === "waiting_approval" || r.status === "waiting_project",
      );
      expect(r.log[0]!.kind, r.id).toBe("trigger");
      for (const e of r.log) {
        expect(e.at >= r.startedAt && e.at <= NOW, `${r.id} ${e.stepId}`).toBe(true);
        if (e.kind === "claude" && e.outcome === "ok") expect(e.reason, r.id).not.toBeNull();
      }
      for (const p of r.projectIds) expect(projectsById.has(p), r.id).toBe(true);
      if (a.projectId) expect(r.projectIds, r.id).toEqual([a.projectId]);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });
});
