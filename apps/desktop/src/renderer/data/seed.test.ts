import { notificationKindSchema } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import type { StallReason } from "../domain/stalled";
import { stallOf } from "../domain/stalled";
import { TEMPLATE_MODULES } from "../domain/templates";
import { compareWeeks } from "../domain/weeks";
import { ACTIVITY } from "./seed/activity";
import { TODAY } from "./seed/dates";
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
import type { StatusFamily, Task } from "./types";

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
    for (const name of [
      "Open",
      "Closed this month",
      "Stalled",
      "No estimate",
      "Unassigned",
    ]) {
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
