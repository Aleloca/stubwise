import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEPARTMENT_PERMISSIONS,
  effectiveInstancePermissions,
  effectiveProjectPermissions,
  INSTANCE_PERMISSIONS,
  isSubsetOf,
  PRESET_ROLES,
  PROJECT_PERMISSIONS,
} from "./permissions.js";

// Le etichette stanno nei locali del web; si leggono da file (non con un import
// JSON) perché stanno fuori dal `rootDir` di questo package.
const loadLocale = (lang: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../apps/web/src/i18n/locales/${lang}.json`, import.meta.url),
      "utf8",
    ),
  );
const en = loadLocale("en");
const it_ = loadLocale("it");

const CREDENTIAL_PERMISSIONS = ["credentials.create", "credentials.edit", "credentials.share"];

const preset = (name: string) => PRESET_ROLES.find((r) => r.name === name)!;

function label(tree: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
}

describe("catalogo dei permessi", () => {
  it("non ha chiavi duplicate, né fra i livelli", () => {
    const all = [...INSTANCE_PERMISSIONS, ...PROJECT_PERMISSIONS, ...DEPARTMENT_PERMISSIONS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("ogni preset usa solo chiavi del proprio livello", () => {
    for (const role of PRESET_ROLES) {
      const allowed = new Set<string>(
        role.scope === "instance" ? INSTANCE_PERMISSIONS : PROJECT_PERMISSIONS,
      );
      for (const p of role.permissions) expect(allowed.has(p), `${role.name}: ${p}`).toBe(true);
    }
  });

  it("i sette preset ci sono, con nomi unici per tipo", () => {
    expect(PRESET_ROLES.map((r) => r.name)).toEqual([
      "Admin",
      "User",
      "Project Lead",
      "Developer",
      "Contributor",
      "Viewer",
      "Legacy Member",
    ]);
  });

  it("full admin ha ogni permesso d'istanza", () => {
    const eff = effectiveInstancePermissions(["instance.full_admin"]);
    for (const p of INSTANCE_PERMISSIONS) expect(eff.has(p)).toBe(true);
  });

  it("un ruolo senza full admin ha solo ciò che elenca (ignorando chiavi ignote)", () => {
    const eff = effectiveInstancePermissions(["monitor.view", "boh"]);
    expect([...eff]).toEqual(["monitor.view"]);
  });

  it("non membro e non full admin: progetto invisibile (null)", () => {
    expect(effectiveProjectPermissions(new Set(), null)).toBeNull();
  });

  it("full admin senza appartenenza vede ogni permesso di progetto", () => {
    const eff = effectiveProjectPermissions(new Set(["instance.full_admin"]), null)!;
    expect([...eff].sort()).toEqual([...PROJECT_PERMISSIONS].sort());
  });

  it("un membro ha i permessi del suo ruolo", () => {
    const eff = effectiveProjectPermissions(new Set(), ["docs.view"])!;
    expect([...eff]).toEqual(["docs.view"]);
  });

  it("Developer non ha approvazione, rilascio, membri, impostazioni e credenziali", () => {
    const perms = preset("Developer").permissions;
    for (const p of [
      "plans.approve",
      "release.merge",
      "project.members.manage",
      "project.settings.manage",
      ...CREDENTIAL_PERMISSIONS,
    ])
      expect(perms).not.toContain(p);
    // Le sette di prima più planning.others (fetta 2).
    expect(perms).toHaveLength(PROJECT_PERMISSIONS.length - 8);
    expect(perms).toContain("docs.generate");
    expect(perms).toContain("prs.adopt");
  });

  it("solo Project Lead ha i tre permessi delle credenziali", () => {
    for (const p of CREDENTIAL_PERMISSIONS)
      expect(PROJECT_PERMISSIONS as readonly string[]).toContain(p);
    for (const role of PRESET_ROLES) {
      const has = CREDENTIAL_PERMISSIONS.filter((p) => role.permissions.includes(p));
      expect(has, role.name).toEqual(role.name === "Project Lead" ? CREDENTIAL_PERMISSIONS : []);
    }
  });

  it("Contributor è esattamente docs.view, tickets.create, tickets.comment, backlog.create", () => {
    expect([...preset("Contributor").permissions].sort()).toEqual(
      ["backlog.create", "docs.view", "tickets.comment", "tickets.create"].sort(),
    );
  });

  it("Viewer ha ogni chiave di progetto .view/.view_all e nessun'altra", () => {
    const expected = PROJECT_PERMISSIONS.filter(
      (p) => p.endsWith(".view") || p.endsWith(".view_all"),
    );
    expect([...preset("Viewer").permissions].sort()).toEqual([...expected].sort());
    expect(expected.length).toBeGreaterThan(0);
  });

  it("Legacy Member esclude esattamente ciò che oggi è solo per admin", () => {
    const perms = preset("Legacy Member").permissions;
    const missing = PROJECT_PERMISSIONS.filter((p) => !perms.includes(p)).sort();
    expect(missing).toEqual(
      [
        "plans.approve",
        "release.merge",
        "project.settings.manage",
        "project.members.manage",
        "repos.manage",
        "environments.manage",
        "widget.manage",
        "docs.generate",
        "prs.adopt",
        "project.usage.view",
        // Moderare commenti/allegati altrui e intervenire nei job AI: oggi
        // solo admin (nel refinement i member scrivono con `backlog.edit`).
        "tickets.moderate",
        "agent_sessions.intervene",
        // La cassaforte è nuova: nessun member di prima poteva già usarla.
        ...CREDENTIAL_PERMISSIONS,
        // Pianificare le task altrui (fetta 2): decisione del maintainer.
        "planning.others",
      ].sort(),
    );
  });

  it("User ha le letture d'istanza di un member di oggi, e nessuna scrittura", () => {
    const perms = preset("User").permissions;
    expect([...perms].sort()).toEqual(
      ["git_accounts.view", "mail_admission.view", "monitor.view", "users.view_all"].sort(),
    );
    expect(perms.some((p) => p.endsWith(".manage") || p === "instance.full_admin")).toBe(false);
  });

  it("isSubsetOf", () => {
    expect(isSubsetOf(["a"], new Set(["a", "b"]))).toBe(true);
    expect(isSubsetOf(["a", "c"], new Set(["a", "b"]))).toBe(false);
    expect(isSubsetOf([], new Set())).toBe(true);
  });

  it("ogni chiave ha un'etichetta in it e en", () => {
    for (const key of [...INSTANCE_PERMISSIONS, ...PROJECT_PERMISSIONS, ...DEPARTMENT_PERMISSIONS]) {
      for (const [lang, tree] of [
        ["en", en],
        ["it", it_],
      ] as const) {
        const value = label((tree as Record<string, unknown>).permissions, `label.${key}`);
        expect(typeof value, `${lang}: ${key}`).toBe("string");
        expect((value as string).trim().length, `${lang}: ${key} vuota`).toBeGreaterThan(0);
      }
    }
  });
});

describe("planning.others (integrazione area 2, fetta 2)", () => {
  const preset = (key: string) => PRESET_ROLES.find((r) => r.key === key)!.permissions as readonly string[];
  it("è nel registro e lo ha il Project Lead", () => {
    expect(PROJECT_PERMISSIONS).toContain("planning.others");
    expect(preset("project_lead")).toContain("planning.others");
  });
  it("Legacy Member e Developer non hanno planning.others (decisione del maintainer); Contributor e Viewer nemmeno", () => {
    for (const key of ["developer", "legacy_member", "contributor", "viewer"]) {
      expect(preset(key), key).not.toContain("planning.others");
    }
  });
});

describe("permessi di reparto (integrazione area 2, fetta 3)", () => {
  it("un livello nuovo con department.home.manage, che nessun preset di ruolo contiene", () => {
    expect(DEPARTMENT_PERMISSIONS).toEqual(["department.home.manage"]);
    for (const role of PRESET_ROLES) expect(role.permissions, role.key).not.toContain("department.home.manage");
  });
});
