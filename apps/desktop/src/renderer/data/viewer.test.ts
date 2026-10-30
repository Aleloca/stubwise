import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { GIULIA_LEAD_CODES, PROJECTS } from "./seed/projects";
import en from "../i18n/locales/en.json";
import itLocale from "../i18n/locales/it.json";
import { SEED_PROJECT_GRANTS } from "./access/index";
import {
  LOCAL_INSTANCE_PERMISSIONS,
  LOCAL_PROJECT_PERMISSIONS,
  VIEW_AS_PERSONAS,
  can,
  canInDepartment,
  grantInstancePermission,
  grantProjectPermission,
  grantProjectRole,
  resetViewerGrants,
  revokeInstancePermission,
  revokeProjectPermission,
  viewerFor,
} from "./viewer";
import { canSeeAdmin } from "./adminSections";

type Tree = { [key: string]: string | Tree };
const lookup = (tree: Tree, key: string) =>
  key
    .split(".")
    .reduce<
      string | Tree | undefined
    >((node, part) => (typeof node === "object" ? node[part] : undefined), tree);

const byPerson = (id: string) => viewerFor(id);

describe("viewer", () => {
  it("offre le sei persone «vedi come»", () => {
    expect(VIEW_AS_PERSONAS.map((p) => p.personId)).toEqual([
      "p-giulia",
      "p-marco",
      "p-laura",
      "p-sara",
      "p-matteo",
      "p-roberta",
    ]);
  });

  it("Matteo, proprietario di AUT-1: Project Lead dove è membro, `automations.manage` d'istanza", () => {
    const matteo = VIEW_AS_PERSONAS.find((p) => p.personId === "p-matteo")!.viewer;
    expect(matteo.instancePermissions).toContain("automations.manage");
    expect(matteo.instancePermissions).not.toContain("instance.full_admin");
    for (const project of PROJECTS) {
      expect(can(matteo, "plans.approve", project.id), project.code).toBe(
        project.memberIds.includes("p-matteo"),
      );
    }
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

  describe("permessi di progetto del Drive (area 5)", () => {
    const aud = PROJECTS.find((p) => p.code === "AUD")!;
    const mkx = PROJECTS.find((p) => p.code === "MKX")!;
    const stw = PROJECTS.find((p) => p.code === "STW")!;
    // Irene è Viewer: la si mette in STW per provarlo.
    const asViewer = () => grantProjectRole("p-irene", stw.id, "viewer");

    it("drive.upload: Project Lead, Developer, Contributor e Legacy Member; non il Viewer", () => {
      expect(can(byPerson("p-laura"), "drive.upload", aud.id)).toBe(true);
      expect(can(byPerson("p-marco"), "drive.upload", aud.id)).toBe(true);
      expect(can(byPerson("p-giulia"), "drive.upload", aud.id)).toBe(true);
      expect(can(byPerson("p-sara"), "drive.upload", stw.id)).toBe(true);
      // Elena è Legacy Member (shape drive.md, [A 14]).
      expect(can(byPerson("p-elena"), "drive.upload", mkx.id)).toBe(true);
      asViewer();
      expect(can(byPerson("p-irene"), "drive.upload", stw.id)).toBe(false);
      // Solo dove si è membri.
      expect(can(byPerson("p-sara"), "drive.upload", aud.id)).toBe(false);
      resetViewerGrants();
    });

    it("drive.manage e drive.history: solo il Project Lead (e il full admin ovunque)", () => {
      for (const perm of ["drive.manage", "drive.history"] as const) {
        expect(can(byPerson("p-laura"), perm, aud.id)).toBe(true);
        expect(can(byPerson("p-giulia"), perm, mkx.id)).toBe(true);
        expect(can(byPerson("p-giulia"), perm, aud.id)).toBe(false);
        expect(can(byPerson("p-marco"), perm, aud.id)).toBe(false);
        expect(can(byPerson("p-sara"), perm, stw.id)).toBe(false);
        expect(can(byPerson("p-elena"), perm, mkx.id)).toBe(false);
        for (const project of PROJECTS) {
          expect(can(byPerson("p-roberta"), perm, project.id)).toBe(true);
        }
      }
      asViewer();
      expect(can(byPerson("p-irene"), "drive.manage", stw.id)).toBe(false);
      expect(can(byPerson("p-irene"), "drive.history", stw.id)).toBe(false);
      resetViewerGrants();
    });

    it("si concedono e si tolgono come gli altri permessi del prototipo", () => {
      grantProjectPermission("p-marco", aud.id, "drive.history");
      expect(can(byPerson("p-marco"), "drive.history", aud.id)).toBe(true);
      revokeProjectPermission("p-giulia", aud.id, "drive.upload");
      expect(can(byPerson("p-giulia"), "drive.upload", aud.id)).toBe(false);
      resetViewerGrants();
      expect(can(byPerson("p-marco"), "drive.history", aud.id)).toBe(false);
      expect(can(byPerson("p-giulia"), "drive.upload", aud.id)).toBe(true);
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
      expect(can(byPerson("p-matteo"), "people.activity.view")).toBe(true);
      // Chi non è fra le persone «vedi come»: dal suo ruolo tipico.
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

describe("permessi delle Automations (area 7)", () => {
  const AUD = "prj-aud";
  const MKX = "prj-mkx";

  it("automations.manage di progetto: al Project Lead dove lo è, non a Developer né Contributor", () => {
    expect(can(byPerson("p-laura"), "automations.manage", AUD)).toBe(true);
    expect(can(byPerson("p-marco"), "automations.manage", AUD)).toBe(false);
    expect(can(byPerson("p-sara"), "automations.manage", "prj-stw")).toBe(false);
    expect(GIULIA_LEAD_CODES).toContain("MKX");
    expect(can(byPerson("p-giulia"), "automations.manage", MKX)).toBe(true);
    // Giulia è Contributor su AUD: lì niente.
    expect(can(byPerson("p-giulia"), "automations.manage", AUD)).toBe(false);
    // Matteo, Project Lead tipico, è membro di AUD.
    expect(can(byPerson("p-matteo"), "automations.manage", AUD)).toBe(true);
    // Fuori dai progetti di cui si è membri, niente.
    expect(can(byPerson("p-laura"), "automations.manage", MKX)).toBe(false);
  });

  it("automations.manage d'istanza (le generali): del preset admin, più la concessione personale del seme a Matteo (R-J10)", () => {
    expect(can(byPerson("p-roberta"), "automations.manage")).toBe(true);
    expect(byPerson("p-roberta").instancePermissions).toContain("automations.manage");
    for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara"]) {
      expect(can(byPerson(id), "automations.manage")).toBe(false);
    }
    // Una concessione personale, non del preset: si toglie e il reset la ridà.
    expect(can(viewerFor("p-matteo"), "automations.manage")).toBe(true);
    revokeInstancePermission("p-matteo", "automations.manage");
    expect(can(viewerFor("p-matteo"), "automations.manage")).toBe(false);
    resetViewerGrants();
    expect(can(viewerFor("p-matteo"), "automations.manage")).toBe(true);
  });

  it("integrations.manage (sorgenti e tabella cliente → progetto): solo all'admin", () => {
    expect(can(byPerson("p-roberta"), "integrations.manage")).toBe(true);
    for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-matteo"]) {
      expect(can(byPerson(id), "integrations.manage")).toBe(false);
    }
  });

  it("si concedono e si tolgono come gli altri permessi del prototipo, fino al reset", () => {
    grantProjectPermission("p-marco", AUD, "automations.manage");
    expect(can(byPerson("p-marco"), "automations.manage", AUD)).toBe(true);
    // Il permesso di progetto non dà quello d'istanza…
    expect(can(byPerson("p-marco"), "automations.manage")).toBe(false);
    revokeProjectPermission("p-laura", AUD, "automations.manage");
    expect(can(byPerson("p-laura"), "automations.manage", AUD)).toBe(false);
    grantInstancePermission("p-laura", "automations.manage");
    expect(can(byPerson("p-laura"), "automations.manage")).toBe(true);
    // …e quello d'istanza non dà quello di progetto.
    expect(can(byPerson("p-laura"), "automations.manage", AUD)).toBe(false);
    resetViewerGrants();
    expect(can(byPerson("p-marco"), "automations.manage", AUD)).toBe(false);
    expect(can(byPerson("p-laura"), "automations.manage", AUD)).toBe(true);
    expect(can(byPerson("p-laura"), "automations.manage")).toBe(false);
  });
});

describe("permessi del Support (area 8a)", () => {
  const AUD = "prj-aud";
  const ACQ = "prj-acq";

  it("support.reply: Project Lead, Developer e Legacy Member sì; Contributor e Viewer no", () => {
    expect(can(byPerson("p-laura"), "support.reply", AUD)).toBe(true);
    expect(can(byPerson("p-marco"), "support.reply", AUD)).toBe(true);
    // Elena è Legacy Member in AUD.
    expect(can(byPerson("p-elena"), "support.reply", AUD)).toBe(true);
    expect(can(byPerson("p-matteo"), "support.reply", ACQ)).toBe(true);
    // Sara (Contributor) e Silvia (Viewer) sono membri di ACQ ma non rispondono ai clienti.
    expect(byPerson("p-sara").projectPermissions[ACQ]).toBeDefined();
    expect(can(byPerson("p-sara"), "support.reply", ACQ)).toBe(false);
    expect(byPerson("p-silvia").projectPermissions[ACQ]).toBeDefined();
    expect(can(byPerson("p-silvia"), "support.reply", ACQ)).toBe(false);
    // Il full admin ce l'ha ovunque, come ogni permesso di progetto.
    expect(can(byPerson("p-roberta"), "support.reply", ACQ)).toBe(true);
  });
});

describe("permessi dei server (area 8b)", () => {
  const ACQ = "prj-acq";
  const AUD = "prj-aud";

  it("servers.operate: nessun preset di progetto lo contiene", () => {
    const presets = Object.entries(LOCAL_PROJECT_PERMISSIONS);
    expect(presets.length).toBeGreaterThan(0);
    for (const [preset, perms] of presets) expect(perms, preset).not.toContain("servers.operate");
  });

  it("servers.operate: Marco solo su ACQ (concessione del seme), Laura e Matteo no, Roberta sì (full admin)", () => {
    expect(SEED_PROJECT_GRANTS).toEqual({ "p-marco": { ACQ: ["servers.operate"] } });
    expect(can(byPerson("p-marco"), "servers.operate", ACQ)).toBe(true);
    expect(can(byPerson("p-marco"), "servers.operate", AUD)).toBe(false);
    expect(can(byPerson("p-marco"), "servers.operate", "prj-stw")).toBe(false);
    // Si aggiunge al ruolo: Marco resta Developer su ACQ (avvia, non approva).
    expect(can(byPerson("p-marco"), "plans.approve", ACQ)).toBe(false);
    expect(can(byPerson("p-marco"), "runs.start", ACQ)).toBe(true);
    for (const id of ["p-laura", "p-matteo", "p-sara", "p-giulia"]) {
      for (const projectId of [ACQ, AUD]) {
        expect(can(byPerson(id), "servers.operate", projectId), `${id} ${projectId}`).toBe(false);
      }
    }
    // Laura approva i piani su ACQ ma non avvia la correzione di un server.
    expect(can(byPerson("p-laura"), "plans.approve", ACQ)).toBe(true);
    expect(can(byPerson("p-laura"), "runs.start", ACQ)).toBe(true);
    expect(can(byPerson("p-roberta"), "servers.operate", ACQ)).toBe(true);
    expect(can(byPerson("p-roberta"), "servers.operate", AUD)).toBe(true);
  });

  it("servers.ssh.manage: d'istanza, del solo preset Admin", () => {
    expect(LOCAL_INSTANCE_PERMISSIONS).toContain("servers.ssh.manage");
    expect(byPerson("p-roberta").instancePermissions).toContain("servers.ssh.manage");
    for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-matteo", "p-elena"]) {
      expect(can(byPerson(id), "servers.ssh.manage"), id).toBe(false);
    }
    // Locale al prototipo, separato da monitor.manage.
    expect(INSTANCE_PERMISSIONS as readonly string[]).not.toContain("servers.ssh.manage");
  });

  it("le concessioni del seme si tolgono, e resetViewerGrants (resetApi) le rimette", () => {
    revokeProjectPermission("p-marco", ACQ, "servers.operate");
    expect(can(byPerson("p-marco"), "servers.operate", ACQ)).toBe(false);
    grantProjectPermission("p-laura", ACQ, "servers.operate");
    expect(can(byPerson("p-laura"), "servers.operate", ACQ)).toBe(true);
    resetViewerGrants();
    expect(can(byPerson("p-marco"), "servers.operate", ACQ)).toBe(true);
    expect(can(byPerson("p-laura"), "servers.operate", ACQ)).toBe(false);
  });
});

describe("R-L9: Claude, membro implicito di ogni progetto coi soli permessi di lavoro", () => {
  const ACQ = "prj-acq";
  const claude = () => viewerFor("p-claude");
  // Un progetto che non è nel seme (creato dall'app), e uno del seme di cui non è membro.
  const projects = [
    "prj-created-in-app",
    PROJECTS.find((p) => !p.memberIds.includes("p-claude"))!.id,
  ];

  it("lavora: vede, apre task, avvia i run, legge i repository", () => {
    for (const id of projects)
      for (const perm of [
        "tickets.view_all",
        "tickets.create",
        "runs.start",
        "repos.view",
      ] as const)
        expect(can(claude(), perm, id), `${perm} ${id}`).toBe(true);
  });

  it("non decide mai: niente approvazione, merge, server, gestione di progetto e membri", () => {
    const never = [
      "plans.approve",
      "release.merge",
      "servers.operate",
      "project.settings.manage",
      "project.members.manage",
      "environments.manage",
      "repos.manage",
    ] as const;
    for (const id of [...projects, ACQ]) {
      for (const perm of never) expect(can(claude(), perm, id), `${perm} ${id}`).toBe(false);
    }
    expect(can(claude(), "servers.ssh.manage")).toBe(false);
    expect(can(claude(), "monitor.manage")).toBe(false);
    // Nemmeno una concessione la sblocca.
    grantProjectPermission("p-claude", ACQ, "servers.operate");
    expect(can(claude(), "servers.operate", ACQ)).toBe(false);
    resetViewerGrants();
  });

  it("R-L11: niente registro decisioni né adozione di PR", () => {
    for (const id of [...projects, ACQ]) {
      expect(can(claude(), "decisions.record", id)).toBe(false);
      expect(can(claude(), "prs.adopt", id)).toBe(false);
    }
  });

  it("I3: nessuna strada ridà il vietato — concessione d'istanza, ruolo, riga del seme, full admin", () => {
    // Concessioni d'istanza (anche `automations.manage`, che vale a due livelli).
    grantInstancePermission("p-claude", "servers.ssh.manage");
    grantInstancePermission("p-claude", "automations.manage");
    expect(can(claude(), "servers.ssh.manage")).toBe(false);
    expect(can(claude(), "automations.manage")).toBe(false);
    expect(can(claude(), "automations.manage", ACQ)).toBe(false);
    // Un ruolo di progetto che dà tutto.
    grantProjectRole("p-claude", ACQ, "project_lead");
    for (const perm of ["automations.manage", "plans.approve", "release.merge"] as const)
      expect(can(claude(), perm, ACQ), perm).toBe(false);
    resetViewerGrants();
    // Un `Viewer` come lo darebbe una riga di `SEED_INSTANCE_GRANTS` o un
    // preset Admin: il ramo di Claude non lo legge.
    const forged = {
      ...claude(),
      instancePermissions: [...INSTANCE_PERMISSIONS, ...LOCAL_INSTANCE_PERMISSIONS],
      projectPermissions: { [ACQ]: [...PROJECT_PERMISSIONS, "servers.operate" as const] },
    };
    for (const perm of [
      "instance.full_admin",
      "servers.ssh.manage",
      "monitor.manage",
      "users.manage",
      "chat.general.manage",
    ] as const)
      expect(can(forged, perm), perm).toBe(false);
    for (const perm of ["plans.approve", "servers.operate", "project.members.manage"] as const)
      expect(can(forged, perm, ACQ), perm).toBe(false);
    // Nemmeno per la strada di reparto.
    const dept = { ...forged, departmentPermissions: { "dep-x": ["department.home.manage" as const] } };
    expect(canInDepartment(dept, "department.home.manage", "dep-x")).toBe(false);
    // Le letture di lavoro restano.
    expect(can(forged, "tickets.create", ACQ)).toBe(true);
    expect(can(forged, "monitor.view")).toBe(true);
  });
});
