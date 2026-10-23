import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { GIULIA_LEAD_CODES, PROJECTS } from "./seed/projects";
import en from "../i18n/locales/en.json";
import itLocale from "../i18n/locales/it.json";
import { VIEW_AS_PERSONAS, can, canSeeAdmin, viewerFor } from "./viewer";

type Tree = { [key: string]: string | Tree };
const lookup = (tree: Tree, key: string) =>
  key
    .split(".")
    .reduce<
      string | Tree | undefined
    >((node, part) => (typeof node === "object" ? node[part] : undefined), tree);

const byPerson = (id: string) => viewerFor(id);

describe("viewer", () => {
  it("offre le persone «vedi come» richieste", () => {
    const ids = VIEW_AS_PERSONAS.map((p) => p.personId);
    expect(ids).toContain("p-giulia");
    expect(VIEW_AS_PERSONAS.length).toBeGreaterThanOrEqual(4);
  });

  it("le descrizioni delle persone stanno nei locali, tradotte in en e it", () => {
    for (const p of VIEW_AS_PERSONAS) {
      expect(p.name).not.toMatch(/—/);
      const enText = lookup(en as Tree, p.descriptionKey);
      const itText = lookup(itLocale as Tree, p.descriptionKey);
      expect(typeof enText).toBe("string");
      expect(typeof itText).toBe("string");
      expect(enText).not.toBe(itText);
    }
    // Nessun italiano nell'interfaccia inglese (il difetto di partenza).
    const enAll = VIEW_AS_PERSONAS.map((p) => lookup(en as Tree, p.descriptionKey)).join(" ");
    expect(enAll).not.toMatch(/\b(su|alcuni|progetti|completo)\b/);
  });

  it("il Developer non approva piani né mergia", () => {
    const dev = byPerson("p-marco");
    expect(can(dev, "plans.approve")).toBe(false);
    expect(can(dev, "release.merge")).toBe(false);
    expect(can(dev, "runs.start")).toBe(true);
  });

  it("il full admin ha tutto ovunque", () => {
    const admin = byPerson("p-roberta");
    for (const p of INSTANCE_PERMISSIONS) expect(can(admin, p)).toBe(true);
    for (const p of PROJECT_PERMISSIONS) {
      for (const project of PROJECTS) expect(can(admin, p, project.id)).toBe(true);
    }
    expect(canSeeAdmin(admin)).toBe(true);
  });

  it("Giulia gestisce le impostazioni solo dove è Project Lead", () => {
    const giulia = byPerson("p-giulia");
    const lead = new Set<string>(GIULIA_LEAD_CODES);
    for (const project of PROJECTS) {
      expect(can(giulia, "project.settings.manage", project.id)).toBe(lead.has(project.code));
    }
    // senza projectId: «in almeno un progetto»
    expect(can(giulia, "project.settings.manage")).toBe(true);
    expect(can(giulia, "users.manage")).toBe(false);
    expect(canSeeAdmin(giulia)).toBe(false);
  });

  it("il Contributor non ha permessi di sviluppo", () => {
    const sara = byPerson("p-sara");
    expect(can(sara, "tickets.create")).toBe(true);
    expect(can(sara, "runs.start")).toBe(false);
  });
});
