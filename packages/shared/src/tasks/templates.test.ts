import { describe, expect, it } from "vitest";
import type { ProjectTemplate } from "./templates.js";
import { MODULE_ORDER, PROJECT_TEMPLATES, TEMPLATE_MODULES, TEMPLATE_STATUSES } from "./templates.js";

const TEMPLATES: ProjectTemplate[] = ["software", "marketing", "client", "empty"];

describe("modelli di progetto", () => {
  it.each(TEMPLATES)(
    "%s: almeno uno stato per famiglia, il primo todo prima di ogni active",
    (t) => {
      const s = TEMPLATE_STATUSES[t];
      for (const family of ["todo", "active", "closed"] as const) {
        expect(s.some((x) => x.family === family)).toBe(true);
      }
      const firstTodo = s.findIndex((x) => x.family === "todo");
      const firstActive = s.findIndex((x) => x.family === "active");
      expect(firstTodo).toBeLessThan(firstActive);
    },
  );

  it("gli stati di ogni modello", () => {
    const names = (t: ProjectTemplate) => TEMPLATE_STATUSES[t].map((x) => x.name);
    expect(names("software")).toEqual(["To do", "In progress", "In review", "Done", "Dropped"]);
    expect(names("marketing")).toEqual(["Idea", "Draft", "In approval", "Published", "Dropped"]);
    expect(names("client")).toEqual([
      "To do",
      "In progress",
      "Waiting on client",
      "Delivered",
      "Dropped",
    ]);
    expect(names("empty")).toEqual(["To do", "In progress", "Done"]);
  });

  it("i moduli di ogni modello", () => {
    expect(TEMPLATE_MODULES).toEqual({
      software: ["docs", "releases", "support", "servers"],
      marketing: [],
      client: ["docs"],
      empty: [],
    });
  });
});

describe("modelli e moduli come elenchi (fetta 4)", () => {
  it("i quattro modelli, i quattro moduli nel loro ordine", () => {
    expect([...PROJECT_TEMPLATES]).toEqual(["software", "marketing", "client", "empty"]);
    expect([...MODULE_ORDER]).toEqual(["docs", "releases", "support", "servers"]);
  });
});
