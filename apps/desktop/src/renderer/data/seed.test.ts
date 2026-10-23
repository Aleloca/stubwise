import { notificationKindSchema, ticketStatusSchema } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { DEPARTMENTS } from "./seed/departments";
import { NOTIFICATIONS } from "./seed/notifications";
import { PEOPLE } from "./seed/people";
import { GIULIA_PINNED_CODES, PROJECTS } from "./seed/projects";
import { TASKS } from "./seed/tasks";

describe("seed", () => {
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
    for (const p of PROJECTS) {
      if (p.template === "software") expect(p.modules).toEqual(expect.arrayContaining(["docs", "releases"]));
      if (p.template === "marketing") {
        expect(p.modules).not.toContain("releases");
        expect(p.modules).not.toContain("servers");
      }
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

  it("le task hanno riferimenti esistenti e codici univoci", () => {
    const projectsById = new Map(PROJECTS.map((p) => [p.id, p]));
    expect(new Set(TASKS.map((t) => t.code)).size).toBe(TASKS.length);
    for (const t of TASKS) {
      const project = projectsById.get(t.projectId);
      expect(project).toBeDefined();
      expect(t.code).toMatch(new RegExp(`^${project!.code}-\\d+$`));
      expect(DEPARTMENTS.some((d) => d.id === t.departmentId)).toBe(true);
      if (t.assigneeId) expect(PEOPLE.some((p) => p.id === t.assigneeId)).toBe(true);
    }
  });

  it("copre ogni TaskStatus e ogni reparto", () => {
    for (const s of ticketStatusSchema.options) expect(TASKS.some((t) => t.status === s)).toBe(true);
    for (const d of DEPARTMENTS) expect(TASKS.some((t) => t.departmentId === d.id)).toBe(true);
  });

  it("ha un nome progetto lungo (>= 34) e 12+ progetti fissati per Giulia", () => {
    expect(PROJECTS.some((p) => p.name.length >= 34)).toBe(true);
    expect(GIULIA_PINNED_CODES.length).toBeGreaterThanOrEqual(12);
    for (const c of GIULIA_PINNED_CODES) expect(PROJECTS.some((p) => p.code === c)).toBe(true);
  });

  it("ha notifiche per almeno 5 kind diversi, tutti validi", () => {
    const kinds = new Set(NOTIFICATIONS.map((n) => n.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(5);
    for (const k of kinds) expect(notificationKindSchema.options).toContain(k);
  });
});
