import { notificationKindSchema } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import type { StallReason } from "../domain/stalled";
import { stallOf } from "../domain/stalled";
import { TEMPLATE_MODULES } from "../domain/templates";
import { compareWeeks } from "../domain/weeks";
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
import type {
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
      "/plan-week",
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
