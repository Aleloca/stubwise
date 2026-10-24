import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { GIULIA_LEAD_CODES, PROJECTS } from "./seed/projects";
import en from "../i18n/locales/en.json";
import itLocale from "../i18n/locales/it.json";
import {
  VIEW_AS_PERSONAS,
  can,
  canInDepartment,
  canSeeAdmin,
  grantInstancePermission,
  grantProjectPermission,
  grantProjectRole,
  resetViewerGrants,
  revokeInstancePermission,
  revokeProjectPermission,
  viewerFor,
} from "./viewer";

type Tree = { [key: string]: string | Tree };
const lookup = (tree: Tree, key: string) =>
  key
    .split(".")
    .reduce<
      string | Tree | undefined
    >((node, part) => (typeof node === "object" ? node[part] : undefined), tree);

const byPerson = (id: string) => viewerFor(id);

describe("viewer", () => {
  it("offre le cinque persone «vedi come»", () => {
    expect(VIEW_AS_PERSONAS.map((p) => p.personId)).toEqual([
      "p-giulia",
      "p-marco",
      "p-laura",
      "p-sara",
      "p-roberta",
    ]);
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

  it("il Contributor non ha permessi di sviluppo né di pianificazione", () => {
    const sara = byPerson("p-sara");
    expect(can(sara, "tickets.create")).toBe(true);
    expect(can(sara, "runs.start")).toBe(false);
    expect(can(sara, "tickets.edit")).toBe(false);
    for (const project of PROJECTS) {
      expect(can(sara, "planning.others", project.id)).toBe(false);
    }
  });

  it("planning.others: al Project Lead dove lo è, non al Developer", () => {
    const giulia = byPerson("p-giulia");
    const mkx = PROJECTS.find((p) => p.code === "MKX")!;
    const aud = PROJECTS.find((p) => p.code === "AUD")!;
    expect(can(giulia, "planning.others", mkx.id)).toBe(true);
    expect(can(giulia, "planning.others", aud.id)).toBe(false);
    expect(can(byPerson("p-marco"), "planning.others")).toBe(false);
    expect(can(byPerson("p-laura"), "planning.others", aud.id)).toBe(true);
    for (const project of PROJECTS) {
      expect(can(byPerson("p-roberta"), "planning.others", project.id)).toBe(true);
    }
  });

  it("department.home.manage: Giulia su Marketing, Laura su Development, il full admin ovunque", () => {
    const giulia = byPerson("p-giulia");
    expect(canInDepartment(giulia, "department.home.manage", "dep-marketing")).toBe(true);
    expect(canInDepartment(giulia, "department.home.manage", "dep-sales")).toBe(false);
    expect(canInDepartment(byPerson("p-laura"), "department.home.manage", "dep-development")).toBe(
      true,
    );
    expect(canInDepartment(byPerson("p-sara"), "department.home.manage", "dep-support")).toBe(
      false,
    );
    expect(canInDepartment(byPerson("p-roberta"), "department.home.manage", "dep-sales")).toBe(
      true,
    );
  });

  it("i permessi di progetto riguardano solo i progetti di cui si è membri", () => {
    const sara = byPerson("p-sara");
    for (const project of PROJECTS) {
      expect(can(sara, "tickets.create", project.id)).toBe(project.memberIds.includes("p-sara"));
    }
  });

  describe("permessi di progetto della Chat (area 4)", () => {
    const aud = PROJECTS.find((p) => p.code === "AUD")!;
    const mkx = PROJECTS.find((p) => p.code === "MKX")!;
    const stw = PROJECTS.find((p) => p.code === "STW")!;

    it("chat.channels.create: Project Lead e Developer, non il Contributor", () => {
      expect(can(byPerson("p-laura"), "chat.channels.create", aud.id)).toBe(true);
      expect(can(byPerson("p-marco"), "chat.channels.create", aud.id)).toBe(true);
      expect(can(byPerson("p-giulia"), "chat.channels.create", mkx.id)).toBe(true);
      // Giulia è Contributor su AUD e STW.
      expect(can(byPerson("p-giulia"), "chat.channels.create", aud.id)).toBe(false);
      expect(can(byPerson("p-sara"), "chat.channels.create", stw.id)).toBe(false);
      // Solo dove si è membri.
      expect(can(byPerson("p-marco"), "chat.channels.create", mkx.id)).toBe(false);
    });

    it("chat.channels.manage: solo il Project Lead (e il full admin ovunque)", () => {
      expect(can(byPerson("p-laura"), "chat.channels.manage", aud.id)).toBe(true);
      expect(can(byPerson("p-giulia"), "chat.channels.manage", mkx.id)).toBe(true);
      expect(can(byPerson("p-giulia"), "chat.channels.manage", aud.id)).toBe(false);
      expect(can(byPerson("p-marco"), "chat.channels.manage", aud.id)).toBe(false);
      expect(can(byPerson("p-sara"), "chat.channels.manage", stw.id)).toBe(false);
      for (const project of PROJECTS) {
        expect(can(byPerson("p-roberta"), "chat.channels.manage", project.id)).toBe(true);
      }
    });

    it("si concedono e si tolgono a qualunque ruolo su un progetto, fino al reset", () => {
      grantProjectPermission("p-sara", stw.id, "chat.channels.manage");
      expect(can(byPerson("p-sara"), "chat.channels.manage", stw.id)).toBe(true);
      expect(can(byPerson("p-sara"), "tickets.create", stw.id)).toBe(true);
      revokeProjectPermission("p-marco", aud.id, "chat.channels.create");
      expect(can(byPerson("p-marco"), "chat.channels.create", aud.id)).toBe(false);
      expect(can(byPerson("p-marco"), "runs.start", aud.id)).toBe(true);
      resetViewerGrants();
      expect(can(byPerson("p-sara"), "chat.channels.manage", stw.id)).toBe(false);
      expect(can(byPerson("p-marco"), "chat.channels.create", aud.id)).toBe(true);
    });
  });

  describe("permessi d'istanza del prototipo (aree 3 e 4)", () => {
    it("claude.public.view: di base a tutti (preset User e Admin)", () => {
      for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-roberta", "p-irene"]) {
        expect(can(byPerson(id), "claude.public.view")).toBe(true);
      }
    });

    it("people.activity.view: al full admin e a chi è Project Lead in almeno un progetto", () => {
      expect(can(byPerson("p-sara"), "claude.public.view")).toBe(true);
      expect(can(byPerson("p-sara"), "people.activity.view")).toBe(false);
      expect(can(byPerson("p-giulia"), "claude.public.view")).toBe(true);
      expect(can(byPerson("p-giulia"), "people.activity.view")).toBe(true);
      expect(can(byPerson("p-roberta"), "claude.public.view")).toBe(true);
      expect(can(byPerson("p-roberta"), "people.activity.view")).toBe(true);
      expect(can(byPerson("p-laura"), "people.activity.view")).toBe(true);
      expect(can(byPerson("p-marco"), "people.activity.view")).toBe(false);
      // Chi non è fra le persone «vedi come»: dal suo ruolo tipico.
      expect(can(byPerson("p-matteo"), "people.activity.view")).toBe(true);
      expect(can(byPerson("p-davide"), "people.activity.view")).toBe(false);
    });

    it("si possono concedere e togliere a qualunque ruolo; resetViewerGrants rimette i default", () => {
      grantInstancePermission("p-marco", "people.activity.view");
      expect(can(byPerson("p-marco"), "people.activity.view")).toBe(true);
      revokeInstancePermission("p-sara", "claude.public.view");
      expect(can(byPerson("p-sara"), "claude.public.view")).toBe(false);
      resetViewerGrants();
      expect(can(byPerson("p-marco"), "people.activity.view")).toBe(false);
      expect(can(byPerson("p-sara"), "claude.public.view")).toBe(true);
    });

    it("chat.general.create a tutti gli utenti; chat.general.manage solo all'admin", () => {
      for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-roberta", "p-irene"]) {
        expect(can(byPerson(id), "chat.general.create")).toBe(true);
      }
      for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-irene"]) {
        expect(can(byPerson(id), "chat.general.manage")).toBe(false);
      }
      expect(can(byPerson("p-roberta"), "chat.general.manage")).toBe(true);
    });

    it("i permessi della Chat d'istanza si concedono e si tolgono a qualunque ruolo", () => {
      grantInstancePermission("p-sara", "chat.general.manage");
      expect(can(byPerson("p-sara"), "chat.general.manage")).toBe(true);
      revokeInstancePermission("p-marco", "chat.general.create");
      expect(can(byPerson("p-marco"), "chat.general.create")).toBe(false);
      resetViewerGrants();
      expect(can(byPerson("p-sara"), "chat.general.manage")).toBe(false);
      expect(can(byPerson("p-marco"), "chat.general.create")).toBe(true);
    });

    it("diventare Project Lead di un progetto nuovo dà people.activity.view, fino al reset", () => {
      grantProjectRole("p-sara", "prj-new", "project_lead");
      expect(can(byPerson("p-sara"), "people.activity.view")).toBe(true);
      resetViewerGrants();
      expect(can(byPerson("p-sara"), "people.activity.view")).toBe(false);
    });
  });
});
