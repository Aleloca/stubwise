import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changelog, failNext, resetApi, setLatency } from "../api";
import { roleIdOf, writeAccess } from "../access/index";
import { setSessionPersonId } from "../session";
import { seedChangelog } from "../seed/changelog";
import { advanceNow, state } from "../store";
import { can, grantProjectRole, viewerFor } from "../viewer";
import * as changelogModule from "./index";
import { recordChange, registerChangeTypes } from "./index";

// Il registro delle modifiche (area 9a, Task 3). I tipi veri di 9a li
// registra `admin/changeTypes.ts` (Task 4): qui ne bastano due finti, uno
// per livello.

const ACQ = "prj-acq";
const AUD = "prj-aud";
const MKX = "prj-mkx";
const STW = "prj-stw";

registerChangeTypes([
  {
    kind: "test.role.updated",
    templateKey: "changelog.test.role",
    readPermission: "roles.manage",
    scope: "instance",
    group: "test",
  },
  {
    kind: "test.person.updated",
    templateKey: "changelog.test.person",
    readPermission: "users.manage",
    scope: "instance",
    group: "test",
  },
  {
    kind: "test.member.added",
    templateKey: "changelog.test.member",
    readPermission: "project.members.manage",
    scope: "project",
    group: "test",
  },
  {
    kind: "test.server.updated",
    templateKey: "changelog.test.server",
    readPermission: "servers.operate",
    scope: "project",
    group: "test",
  },
]);

const as = (personId: string) => setSessionPersonId(personId);
const instanceEntry = (kind = "test.role.updated", actorId = "p-roberta") =>
  recordChange({
    kind,
    actorId,
    projectId: null,
    object: { type: "role", id: roleIdOf("developer"), label: "Developer" },
    before: "Developer",
    after: "Developer + merge pull requests",
  });
const projectEntry = (projectId: string, actorId = "p-roberta") =>
  recordChange({
    kind: "test.member.added",
    actorId,
    projectId,
    object: { type: "person", id: "p-marco", label: "Marco Bellini" },
    params: { role: "developer" },
  });
const kinds = async () =>
  (await changelog.listChanges()).map((e) => `${e.kind}@${e.projectCode ?? "-"}`);
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

beforeEach(() => {
  resetApi();
  setLatency(0);
  // Questi test provano il meccanismo del registro: partono senza le voci
  // del seme (che prova `pages/admin/Audit.test.tsx`).
  state.changelog.splice(0);
});
afterEach(() => resetApi());

describe("tipi registrati", () => {
  it("una voce di un tipo registrato si scrive, con i campi calcolati", async () => {
    instanceEntry();
    as("p-roberta");
    const [entry] = await changelog.listChanges();
    expect(entry).toMatchObject({
      kind: "test.role.updated",
      templateKey: "changelog.test.role",
      scope: "instance",
      group: "test",
      actorId: "p-roberta",
      actorName: "Roberta Fontana",
      projectId: null,
      projectCode: null,
      before: "Developer",
      after: "Developer + merge pull requests",
      at: state.changelog[0]!.at,
    });
  });

  it("un tipo non registrato lancia, e non scrive niente", () => {
    expect(() =>
      recordChange({
        kind: "test.unknown",
        actorId: "p-roberta",
        projectId: null,
        object: { type: "x", id: "x", label: "x" },
      }),
    ).toThrow(/Unregistered change type/);
    expect(state.changelog).toEqual([]);
  });

  it("il livello del tipo vale: una voce di progetto senza progetto lancia, e viceversa", () => {
    expect(() =>
      recordChange({
        kind: "test.member.added",
        actorId: "p-roberta",
        projectId: null,
        object: { type: "x", id: "x", label: "x" },
      }),
    ).toThrow();
    expect(() =>
      recordChange({
        kind: "test.role.updated",
        actorId: "p-roberta",
        projectId: ACQ,
        object: { type: "x", id: "x", label: "x" },
      }),
    ).toThrow();
    expect(state.changelog).toEqual([]);
  });

  it("ri-registrare lo stesso tipo uguale va bene, diverso no", () => {
    expect(() =>
      registerChangeTypes([
        {
          kind: "test.role.updated",
          templateKey: "changelog.test.role",
          readPermission: "roles.manage",
          scope: "instance",
          group: "test",
        },
      ]),
    ).not.toThrow();
    expect(() =>
      registerChangeTypes([
        {
          kind: "test.role.updated",
          templateKey: "changelog.test.role",
          readPermission: "usage.view",
          scope: "instance",
          group: "test",
        },
      ]),
    ).toThrow();
  });

  it("resetApi riporta le voci al seme, ma non i tipi", () => {
    instanceEntry();
    resetApi();
    expect(state.changelog.map((e) => e.id)).toEqual(seedChangelog().map((e) => e.id));
    expect(() => instanceEntry()).not.toThrow();
  });
});

describe("chi legge cosa", () => {
  beforeEach(() => {
    instanceEntry("test.role.updated");
    instanceEntry("test.person.updated");
    projectEntry(ACQ);
    projectEntry(AUD);
    projectEntry(MKX);
    projectEntry(STW);
  });

  it("il full admin legge tutto", async () => {
    as("p-roberta");
    expect((await kinds()).sort()).toEqual(
      [
        "test.member.added@ACQ",
        "test.member.added@AUD",
        "test.member.added@MKX",
        "test.member.added@STW",
        "test.person.updated@-",
        "test.role.updated@-",
      ].sort(),
    );
  });

  it("l'Auditor legge le voci d'istanza e quelle di tutti i progetti che vede", async () => {
    // Giulia con il ruolo d'istanza «Auditor» (usage.view + changelog.view),
    // membra di ACQ come Developer, senza gestione. R-M1: la voce «Roberta
    // aggiunge Marco ad ACQ» la legge. Vede anche AUD, MKX e STW.
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-giulia")!.instanceRoleId = roleIdOf("au-1");
    });
    grantProjectRole("p-giulia", ACQ, "developer");
    as("p-giulia");
    expect((await kinds()).sort()).toEqual(
      [
        "test.member.added@ACQ",
        "test.member.added@AUD",
        "test.member.added@MKX",
        "test.member.added@STW",
        "test.person.updated@-",
        "test.role.updated@-",
      ].sort(),
    );
  });

  it("l'Auditor che non è membro di AUD non ne legge la voce (R-G5)", async () => {
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-giulia")!.instanceRoleId = roleIdOf("au-1");
      s.memberships = s.memberships.filter(
        (m) => !(m.personId === "p-giulia" && m.projectId === AUD),
      );
    });
    as("p-giulia");
    expect(await kinds()).not.toContain("test.member.added@AUD");
    expect(await kinds()).toContain("test.member.added@STW");
  });

  it("una voce di progetto la legge chi ha lì il readPermission del tipo", async () => {
    // Marco, Developer di ACQ senza gestione, ha `servers.operate` su ACQ
    // dal seme: legge la voce dei server di ACQ, non quella dei membri. In
    // un progetto che vede ma dove non ha `servers.operate`, niente.
    const elsewhere = state.projects.find(
      (p) =>
        p.id !== ACQ &&
        p.memberIds.includes("p-marco") &&
        !can(viewerFor("p-marco"), "servers.operate", p.id),
    )!;
    const serverEntry = (projectId: string) =>
      recordChange({
        kind: "test.server.updated",
        actorId: "p-roberta",
        projectId,
        object: { type: "server", id: "SRV-1", label: "SRV-1" },
      });
    serverEntry(ACQ);
    serverEntry(elsewhere.id);
    as("p-marco");
    expect(can(viewerFor("p-marco"), "project.members.manage", ACQ)).toBe(false);
    expect(
      (await kinds()).filter((k) => k.endsWith("@ACQ") || k.endsWith(`@${elsewhere.code}`)),
    ).toEqual(["test.server.updated@ACQ"]);
  });

  it("senza changelog.view una voce d'istanza la legge chi ha il readPermission del tipo", async () => {
    // Giulia (ruolo «User») con roles.manage: legge i ruoli, non le persone.
    writeAccess((s) => {
      s.grants.push({
        personId: "p-giulia",
        projectId: null,
        permission: "roles.manage",
        grantedById: null,
        at: state.changelog[0]!.at,
      });
    });
    as("p-giulia");
    expect(await kinds()).toContain("test.role.updated@-");
    expect(await kinds()).not.toContain("test.person.updated@-");
  });

  it("Laura legge solo le voci dei progetti che gestisce", async () => {
    // Laura è Project Lead dove è membra: la rendo Developer in STW, che
    // continua a vedere ma non gestisce più. MKX non lo vede.
    grantProjectRole("p-laura", STW, "developer");
    as("p-laura");
    expect((await kinds()).sort()).toEqual(["test.member.added@ACQ", "test.member.added@AUD"]);
  });

  it("chi gestisce il progetto legge anche i tipi il cui readPermission non ha", async () => {
    // Laura gestisce ACQ; le tolgo `servers.operate` lì, se il ruolo
    // gliel'avesse dato: la voce dei server di ACQ la legge comunque.
    writeAccess((s) => {
      s.revocations.push({ personId: "p-laura", projectId: ACQ, permission: "servers.operate" });
    });
    expect(can(viewerFor("p-laura"), "servers.operate", ACQ)).toBe(false);
    recordChange({
      kind: "test.server.updated",
      actorId: "p-roberta",
      projectId: ACQ,
      object: { type: "server", id: "SRV-1", label: "SRV-1" },
    });
    as("p-laura");
    expect(await kinds()).toContain("test.server.updated@ACQ");
  });

  it("Sara non legge niente", async () => {
    as("p-sara");
    expect(await changelog.listChanges()).toEqual([]);
  });

  it("Claude non legge niente", async () => {
    as("p-claude");
    expect(await changelog.listChanges()).toEqual([]);
  });

  it("una voce di AUD non compare a chi non vede AUD", async () => {
    // Laura esce da AUD: non lo vede più, e la voce sparisce con lui.
    as("p-laura");
    expect(await kinds()).toContain("test.member.added@AUD");
    writeAccess((s) => {
      s.memberships = s.memberships.filter(
        (m) => !(m.personId === "p-laura" && m.projectId === AUD),
      );
    });
    expect(await kinds()).not.toContain("test.member.added@AUD");
    expect(await message(changelog.listProjectChanges(AUD))).toBe("not_found");
  });
});

describe("registro di un progetto", () => {
  beforeEach(() => {
    instanceEntry();
    projectEntry(ACQ, "p-laura");
    projectEntry(AUD);
  });

  it("chi gestisce il progetto ne legge solo le voci", async () => {
    as("p-laura");
    const rows = await changelog.listProjectChanges(ACQ);
    expect(rows.map((r) => r.projectCode)).toEqual(["ACQ"]);
    expect(rows[0]!.actorName).toBe("Laura Costa");
  });

  it("R-G5: un progetto invisibile è not_found, uno visibile senza gestione forbidden", async () => {
    as("p-sara");
    expect(await message(changelog.listProjectChanges(AUD))).toBe("not_found");
    expect(await message(changelog.listProjectChanges("prj-nope"))).toBe("not_found");
    expect(await message(changelog.listProjectChanges(ACQ))).toBe("forbidden");
  });

  it("failNext rifiuta la prossima lettura", async () => {
    as("p-roberta");
    failNext("changelog.listProjectChanges");
    expect(await message(changelog.listProjectChanges(ACQ))).toMatch(/Simulated failure/);
    failNext("changelog.listChanges");
    expect(await message(changelog.listChanges())).toMatch(/Simulated failure/);
  });
});

describe("ordine e filtri", () => {
  it("più recenti prima, e a parità d'ora l'ultima scritta prima", async () => {
    instanceEntry("test.role.updated");
    advanceNow(60_000);
    instanceEntry("test.person.updated");
    instanceEntry("test.role.updated", "p-laura");
    as("p-roberta");
    const rows = await changelog.listChanges();
    expect(rows.map((r) => `${r.kind}/${r.actorId}`)).toEqual([
      "test.role.updated/p-laura",
      "test.person.updated/p-roberta",
      "test.role.updated/p-roberta",
    ]);
  });

  it("filtra per persona, progetto (null = solo istanza), tipo e periodo", async () => {
    const t0 = "2026-10-23T12:00:00Z";
    instanceEntry("test.role.updated", "p-laura");
    advanceNow(3_600_000);
    projectEntry(ACQ);
    instanceEntry("test.person.updated");
    as("p-roberta");
    const ids = async (f: Parameters<typeof changelog.listChanges>[0]) =>
      (await changelog.listChanges(f)).map((r) => r.kind + "@" + (r.projectCode ?? "-"));
    expect(await ids({ personId: "p-laura" })).toEqual(["test.role.updated@-"]);
    expect(await ids({ projectId: ACQ })).toEqual(["test.member.added@ACQ"]);
    expect(await ids({ projectId: null })).toEqual([
      "test.person.updated@-",
      "test.role.updated@-",
    ]);
    expect(await ids({ kind: "test.person.updated" })).toEqual(["test.person.updated@-"]);
    expect(await ids({ to: t0 })).toEqual(["test.role.updated@-"]);
    expect(await ids({ from: "2026-10-23T12:30:00Z" })).toEqual([
      "test.person.updated@-",
      "test.member.added@ACQ",
    ]);
  });
});

describe("una voce non si tocca", () => {
  it("nessuna funzione esportata la modifica o la cancella", () => {
    const names = Object.keys(changelogModule);
    expect(names.length).toBeGreaterThan(3);
    expect(
      names.filter((n) => /update|edit|delete|remove|clear|set|undo|forget|replace/i.test(n)),
    ).toEqual([]);
    // Solo letture: le voci e le scelte dei filtri (Task 11).
    expect(Object.keys(changelog).sort()).toEqual([
      "listChangeFilterChoices",
      "listChanges",
      "listProjectChanges",
    ]);
  });

  it("le voci salvate sono congelate, e la vista è una copia", async () => {
    projectEntry(ACQ);
    const entry = state.changelog[0]!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.object)).toBe(true);
    expect(Object.isFrozen(entry.params)).toBe(true);
    as("p-roberta");
    const [row] = await changelog.listChanges();
    row!.object.label = "changed";
    row!.params.role = "changed";
    expect(state.changelog[0]!.object.label).toBe("Marco Bellini");
    expect(state.changelog[0]!.params.role).toBe("developer");
  });
});
