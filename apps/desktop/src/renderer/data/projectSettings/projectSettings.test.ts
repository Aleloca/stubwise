import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIONS } from "../../domain/access/actions";
import en from "../../i18n/locales/en.json";
import it_ from "../../i18n/locales/it.json";
import { isMember } from "../access/index";
import { whoCan } from "../access/whoCan";
import { projectSettingsAccess } from "../adminSections";
import { changelog, resetApi, setLatency } from "../api";
import { REAUTH_REQUIRED } from "../auth/reauth";
import { recordChange } from "../changelog/index";
import { decodeSetting, encodeAiAccount, encodeNumber } from "../changelog/settingValues";
import { GROUP_ORDER } from "../changelog/visibility";
import { PROJECT_SETTINGS_SECTIONS } from "../routes";
import { PROJECT_PLUGINS } from "../seed/commands";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { PROJECTS } from "../seed/projects";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import {
  can,
  grantProjectPermission,
  projectRoleOf,
  revokeProjectPermission,
  viewerFor,
} from "../viewer";
import { PROJECT_CHANGE_TYPES } from "./changeTypes";
import { skillsForRun } from "./plugins";

// Lo stato delle impostazioni di progetto dell'area 9c (Task 1): le sezioni
// per persona, i tipi di voce del registro, la riconferma, il seme (RNC
// archiviato, il plugin base, i repository). Persone del seme: Roberta (full
// admin), Laura (Project Lead in ACQ), Sara (Contributor in ACQ), Giulia
// (Project Lead in RNC).

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";
const OLV = "prj-olv";
const RNC = "prj-rnc";
const SECTIONS = PROJECT_SETTINGS_SECTIONS.map((s) => s.id);

const access = (personId: string, projectId: string) =>
  projectSettingsAccess(viewerFor(personId), projectId);

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

describe("le sezioni di Progetto → Settings, per persona", () => {
  it("sono undici, nell'ordine della colonna, e General è la prima", () => {
    expect(SECTIONS).toEqual([
      "general",
      "statuses",
      "members",
      "ai",
      "automations",
      "repositories",
      "integration",
      "plugins",
      "usage",
      "changelog",
      "archive",
    ]);
  });

  it("Roberta (full admin) vede tutte le undici in ACQ, tutte scrivibili", () => {
    const a = access(ROBERTA, ACQ);
    expect(Object.keys(a)).toEqual(SECTIONS);
    for (const s of SECTIONS) expect(a[s], s).toMatchObject({ visible: true, canEdit: true });
  });

  it("Laura (Project Lead in ACQ) le vede tutte e scrive tutto; Delete resta del full admin", () => {
    const a = access(LAURA, ACQ);
    for (const s of SECTIONS) expect(a[s], s).toMatchObject({ visible: true, canEdit: true });
    expect(can(viewerFor(LAURA), "instance.full_admin")).toBe(false);
  });

  it("Sara (Contributor in ACQ) non vede Usage né Change log, e legge General in sola lettura", () => {
    const a = access(SARA, ACQ);
    expect(a.usage.visible).toBe(false);
    expect(a.changelog.visible).toBe(false);
    expect(a.general).toEqual({
      visible: true,
      canEdit: false,
      editAction: "manageProjectSettings",
    });
    // Ogni sezione in sola lettura dice chi la cambia: un'azione del catalogo.
    for (const s of SECTIONS)
      if (a[s].visible && !a[s].canEdit)
        expect(
          ACTIONS.map((x) => x.id),
          s,
        ).toContain(a[s].editAction);
  });

  it("chi gestisce solo i membri: General in sola lettura, Members scrivibile («View only»)", () => {
    grantProjectPermission(SARA, ACQ, "project.members.manage" as never);
    const a = access(SARA, ACQ);
    expect(a.general).toMatchObject({ visible: true, canEdit: false });
    expect(a.members).toEqual({ visible: true, canEdit: true, editAction: "manageMembers" });
    // Il registro del progetto lo legge chi gestisce i membri (9a).
    expect(a.changelog.visible).toBe(true);
  });

  it("Integration è scrivibile anche con il solo repos.manage (ruling [PS 4])", () => {
    expect(access(SARA, ACQ).integration.canEdit).toBe(false);
    grantProjectPermission(SARA, ACQ, "repos.manage" as never);
    const a = access(SARA, ACQ);
    expect(a.integration.canEdit).toBe(true);
    expect(a.general.canEdit).toBe(false);
    // `canRegenerateKey` (falso qui) è della lettura di Integration, Task 4.
  });

  it("Usage e Change log non sono mai «in sola lettura»: non hanno niente da scrivere", () => {
    for (const person of [ROBERTA, LAURA, SARA]) {
      const a = access(person, ACQ);
      expect(a.usage.editAction).toBeNull();
      expect(a.changelog.editAction).toBeNull();
    }
  });

  it("Repositories c'è anche in un progetto senza il modulo Releases (OLV)", () => {
    expect(PROJECTS.find((p) => p.id === OLV)!.modules).not.toContain("releases");
    expect(access(ROBERTA, OLV).repositories.visible).toBe(true);
    expect(access(GIULIA, OLV).repositories.visible).toBe(true);
  });

  it("un progetto che chi guarda non vede non ha nessuna sezione", () => {
    const hidden = PROJECTS.find((p) => !visibleProjectIds(SARA).has(p.id))!.id;
    for (const s of SECTIONS) expect(access(SARA, hidden)[s].visible, s).toBe(false);
  });

  it("«Who can?» su deleteProjects elenca solo i full admin", () => {
    const r = whoCan(ROBERTA, "deleteProjects", null);
    if (!r.visible) throw new Error("invisibile");
    const admins = PEOPLE.filter(
      (p) => !p.isClaude && viewerFor(p.id).instancePermissions.includes("instance.full_admin"),
    ).map((p) => p.id);
    expect(r.people.map((p) => p.personId).sort()).toEqual(admins.sort());
    expect(r.people.map((p) => p.personId)).toEqual([ROBERTA]);
    expect(r.claude.allowed).toBe(false);
  });
});

describe("il registro delle modifiche del 9c", () => {
  const GROUPS = ["project", "repositories", "projects"];

  it("i tipi stanno nei tre gruppi nuovi, dopo quelli del 9b", () => {
    expect([...new Set(PROJECT_CHANGE_TYPES.map((t) => t.group))]).toEqual(GROUPS);
    expect(GROUP_ORDER.slice(-3)).toEqual(GROUPS);
    for (const t of PROJECT_CHANGE_TYPES)
      expect(t.scope, t.kind).toBe(t.group === "projects" ? "instance" : "project");
    expect(PROJECT_CHANGE_TYPES.filter((t) => t.group === "projects").map((t) => t.kind)).toEqual([
      "project.deleted",
      "repository.deleted",
    ]);
  });

  it("ogni tipo registrato qui ha frase e gruppo in inglese e in italiano", () => {
    const at = (bundle: unknown, path: string[]): unknown =>
      path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundle);
    for (const [lng, bundle] of [
      ["en", en],
      ["it", it_],
    ] as const)
      for (const t of PROJECT_CHANGE_TYPES) {
        const phrase = at(bundle, t.templateKey.split("."));
        expect(typeof phrase, `${lng} ${t.kind}`).toBe("string");
        expect(phrase, `${lng} ${t.kind}`).toMatch(/<actor>\{\{actor\}\}<\/actor>/);
        expect(typeof at(bundle, ["changelog", "groups", t.group]), `${lng} ${t.group}`).toBe(
          "string",
        );
        expect(typeof at(bundle, ["changelog", "groupWords", t.group]), `${lng} ${t.group}`).toBe(
          "string",
        );
      }
  });

  it("le forme del 9c: valori stabili, decodificati in forma di dato", () => {
    expect(encodeAiAccount(null, false)).toBe("auto");
    expect(encodeAiAccount("prv-backup-max", true)).toBe("account:prv-backup-max:exclusive");
    expect(decodeSetting("project.ai_account_changed", "account:prv-backup-max:exclusive")).toEqual(
      { type: "ai_account", providerId: "prv-backup-max", exclusive: true },
    );
    expect(decodeSetting("project.ai_account_changed", "auto")).toEqual({
      type: "ai_account",
      providerId: null,
      exclusive: false,
    });
    expect(decodeSetting("project.pulse_interval_changed", encodeNumber(14))).toEqual({
      type: "number",
      value: 14,
    });
    expect(decodeSetting("project.correction_cap_changed", "")).toBeNull();
    expect(decodeSetting("project.switch_changed", "off")).toEqual({ type: "switch", on: false });
  });

  it("l'account AI della voce si legge col nome di adesso", async () => {
    recordChange({
      kind: "project.ai_account_changed",
      actorId: ROBERTA,
      projectId: ACQ,
      object: { type: "project", id: ACQ, label: "ACQ" },
      before: encodeAiAccount(null, false),
      after: encodeAiAccount("prv-backup-max", true),
    });
    setSessionPersonId(ROBERTA);
    const [entry] = await changelog.listProjectChanges(ACQ);
    expect(entry!.diff).toEqual({
      kind: "setting",
      before: { type: "ai_account", providerId: null, exclusive: false },
      after: {
        type: "ai_account",
        providerId: "prv-backup-max",
        exclusive: true,
        name: "Backup Max",
      },
    });
  });

  /** Una voce per tipo, scritta come la scriveranno i Task 2–5. */
  function recordOneOfEach() {
    for (const t of PROJECT_CHANGE_TYPES)
      recordChange({
        kind: t.kind,
        actorId: ROBERTA,
        projectId: t.scope === "project" ? ACQ : null,
        object: { type: "test", id: t.kind, label: t.kind },
      });
  }

  it("il full admin le legge tutte; Claude nessuna", async () => {
    recordOneOfEach();
    setSessionPersonId(ROBERTA);
    const all = await changelog.listChanges();
    expect(all.filter((e) => GROUPS.includes(e.group))).toHaveLength(PROJECT_CHANGE_TYPES.length);
    setSessionPersonId(CLAUDE_ID);
    expect((await changelog.listChanges()).filter((e) => GROUPS.includes(e.group))).toEqual([]);
  });

  it("Laura legge le voci di progetto di ACQ, non quelle d'istanza del gruppo projects", async () => {
    recordOneOfEach();
    setSessionPersonId(LAURA);
    const groups = new Set((await changelog.listProjectChanges(ACQ)).map((e) => e.group));
    expect(groups.has("project")).toBe(true);
    expect(groups.has("repositories")).toBe(true);
    const all = await changelog.listChanges();
    expect(all.some((e) => e.group === "projects")).toBe(false);
  });

  it("il link di una voce apre la sezione di Settings in cui sta l'oggetto", async () => {
    recordChange({
      kind: "project.switch_changed",
      actorId: ROBERTA,
      projectId: ACQ,
      object: { type: "project", id: ACQ, label: "ACQ" },
      before: "on",
      after: "off",
      params: { switch: "weeklyBrief" },
    });
    recordChange({
      kind: "env_var.set",
      actorId: ROBERTA,
      projectId: ACQ,
      object: { type: "env_file", id: "envf-x", label: ".env" },
      params: { key: "DATABASE_URL" },
    });
    setSessionPersonId(ROBERTA);
    const [envVar, sw] = await changelog.listProjectChanges(ACQ);
    expect(sw!.objectLink).toEqual({ to: "projectSettings", code: "ACQ", section: "automations" });
    expect(envVar!.objectLink).toEqual({
      to: "projectSettings",
      code: "ACQ",
      section: "repositories",
    });
    // Chi legge la voce ma non vede la sezione non ha il link: Sara gestisce i
    // membri (legge il registro di ACQ) senza `repos.view`.
    grantProjectPermission(SARA, ACQ, "project.members.manage" as never);
    revokeProjectPermission(SARA, ACQ, "repos.view" as never);
    expect(access(SARA, ACQ).repositories.visible).toBe(false);
    setSessionPersonId(SARA);
    const forSara = await changelog.listProjectChanges(ACQ);
    expect(forSara.find((e) => e.kind === "env_var.set")!.objectLink).toBeNull();
    expect(forSara.find((e) => e.kind === "project.switch_changed")!.objectLink).toEqual({
      to: "projectSettings",
      code: "ACQ",
      section: "automations",
    });
  });
});

describe("la riconferma", () => {
  it("REAUTH_REQUIRED nomina le otto funzioni +R del 9c", () => {
    for (const fn of [
      "projectSettings.regenerateIngestionKey",
      "projectSettings.regenerateWebhookSecret",
      "projectSettings.importEnvFile",
      "projectSettings.setEnvVar",
      "projectSettings.removeEnvVar",
      "projectSettings.deleteEnvFile",
      "projectSettings.deleteProject",
      "instance.deleteDetachedRepository",
    ] as const)
      expect(REAUTH_REQUIRED.has(fn), fn).toBe(true);
    // Archive e Reopen si tornano indietro: niente riconferma.
    expect(REAUTH_REQUIRED.has("projectSettings.archiveProject")).toBe(false);
    expect(REAUTH_REQUIRED.has("projectSettings.reopenProject")).toBe(false);
  });
});

describe("il seme del 9c", () => {
  const pid = (code: string) => PROJECTS.find((p) => p.code === code)!.id;

  it("STW ha un ambiente test; ACQ ha portale-utenti col webhook da configurare", () => {
    expect(
      state.environments.filter((e) => e.projectId === pid("STW")).map((e) => e.kind),
    ).toContain("test");
    const portale = state.repositories.find((r) => r.name === "portale-utenti")!;
    expect(portale.projectId).toBe(ACQ);
    expect(portale.fullName).toBe("audin/portale-utenti");
    expect(portale.webhook?.state).toBe("not_configured");
    for (const r of state.repositories.filter((x) =>
      ["prj-stw", "prj-aud"].includes(x.projectId),
    )) {
      expect(r.webhook?.state, r.name).toBe("configured");
      expect(r.protectedBranches, r.name).toEqual(["main", "release/*"]);
      expect(r.url, r.name).toMatch(/^https:\/\//);
    }
  });

  it("il plugin base stubwise vale per tutti i progetti e non è fra le scelte", () => {
    for (const enabled of Object.values(PROJECT_PLUGINS))
      expect(enabled.map((e) => e.pluginId)).not.toContain("plg-stubwise");
    for (const s of state.projectSettings.values())
      expect(s.plugins.disabled.map((d) => d.plugin)).not.toContain("stubwise");
    const labels = (projectId: string) =>
      skillsForRun(projectId).map((s) => `/${s.plugin}:${s.skill}`);
    const aud = labels(pid("AUD"));
    expect(aud).toContain("/stubwise:start");
    for (const p of PROJECTS)
      expect(labels(p.id), p.code).toEqual(
        expect.arrayContaining(["/stubwise:stubwise", "/stubwise:init", "/stubwise:start"]),
      );
    // In coda: dopo le skill dei plugin scelti.
    expect(aud.slice(-3)).toEqual(["/stubwise:stubwise", "/stubwise:init", "/stubwise:start"]);
  });

  it("le impostazioni di ogni progetto: interruttori, pulse, account AI", () => {
    expect(state.projectSettings.size).toBe(PROJECTS.length);
    for (const p of PROJECTS) {
      const s = state.projectSettings.get(p.id)!;
      const software = p.template === "software";
      expect(s.switches.docsNightly, p.code).toBe(software);
      expect(s.switches.dailyReport, p.code).toBe(software);
      expect(s.switches.backlogDiscovery, p.code).toBe(true);
      expect(s.switches.pulse, p.code).toBe(p.code !== "CBV");
      expect(s.switches.weeklyBrief, p.code).toBe(p.code !== "MKX");
      expect(s.pulseEveryDays, p.code).toBe(7);
      expect(s.ingestion.secretId).toBeNull();
      expect(s.ingestion.last4).toMatch(/^[0-9a-f]{4}$/);
    }
    expect(state.projectSettings.get(pid("AUD"))).toMatchObject({
      aiProviderId: "prv-backup-max",
      aiProviderExclusive: true,
    });
    expect(state.projectSettings.get(ACQ)).toMatchObject({
      aiProviderId: null,
      aiProviderExclusive: false,
    });
    for (const code of ["STW", "AUD", "ACQ"])
      expect(state.projects.find((p) => p.code === code)!.description, code).toBeTruthy();
  });

  it("i file d'ambiente: STW test 3 chiavi e production 2; ACQ nessuno; nessun valore nel caveau", () => {
    const keysOf = (envId: string) =>
      state.envFiles.filter((f) => f.environmentId === envId).flatMap((f) => f.vars);
    const stwEnvs = state.environments.filter((e) => e.projectId === pid("STW"));
    const test = stwEnvs.find((e) => e.kind === "test")!;
    const prod = stwEnvs.find((e) => e.kind === "production")!;
    const stubwise = state.repositories.find((r) => r.id === "repo-stw")!;
    expect(state.envFiles.filter((f) => f.environmentId === test.id)).toEqual([
      expect.objectContaining({ repositoryId: stubwise.id, path: ".env" }),
    ]);
    expect(keysOf(test.id)).toHaveLength(3);
    expect(keysOf(prod.id)).toHaveLength(2);
    const acqRepos = state.repositories.filter((r) => r.projectId === ACQ).map((r) => r.id);
    expect(state.envFiles.filter((f) => acqRepos.includes(f.repositoryId))).toEqual([]);
    expect(state.envFiles.flatMap((f) => f.vars).every((v) => v.secretId === null)).toBe(true);
  });

  it("RNC non è in visibleProjectIds di nessuno, nemmeno di Roberta e di Claude", () => {
    const rnc = state.projects.find((p) => p.id === RNC)!;
    expect(rnc).toMatchObject({
      code: "RNC",
      name: "Vetrina online Tenuta Ronchi",
      clientName: "Tenuta Ronchi Srl",
      template: "client",
      archived: { byId: ROBERTA },
    });
    for (const person of PEOPLE)
      expect(visibleProjectIds(person.id).has(RNC), person.id).toBe(false);
    expect(visibleProjectIds(CLAUDE_ID).has(RNC)).toBe(false);
    // Gli altri restano tutti visibili al full admin.
    expect(visibleProjectIds(ROBERTA).size).toBe(state.projects.length - 1);
  });

  it("RNC: Giulia Project Lead, Marco ed Elena; Sara e Laura no; nessun membro calcolato", () => {
    const rnc = state.projects.find((p) => p.id === RNC)!;
    // Le persone; Claude c'è come in ogni progetto in cui ha lavorato (R-L9).
    expect(rnc.memberIds.filter((id) => id !== CLAUDE_ID).sort()).toEqual([
      "p-elena",
      "p-giulia",
      "p-marco",
    ]);
    expect(projectRoleOf(GIULIA, RNC)).toBe("project_lead");
    expect(isMember(SARA, RNC)).toBe(false);
    expect(isMember(LAURA, RNC)).toBe(false);
  });

  it("RNC ha il suo lavoro: 6 task, 2 richieste, una conversazione finita, general, 3 file", () => {
    expect(state.tasks.filter((t) => t.projectId === RNC)).toHaveLength(6);
    expect(state.requests.filter((r) => r.projectId === RNC)).toHaveLength(2);
    const conversations = state.conversations.filter((c) => c.projectId === RNC);
    expect(conversations.map((c) => c.state)).toEqual(["finished"]);
    expect(state.channels.filter((c) => c.projectId === RNC).map((c) => c.name)).toContain(
      "general",
    );
    expect(state.driveFiles.filter((f) => f.projectId === RNC)).toHaveLength(3);
    expect(state.notifications.some((n) => n.projectId === RNC)).toBe(true);
  });

  it("shop-frontend: 2 pagine dei Docs, un file d'ambiente in production, un server tutto suo", () => {
    const repo = state.repositories.find((r) => r.name === "shop-frontend")!;
    expect(repo.projectId).toBe(RNC);
    expect(state.docPages.filter((d) => d.repositoryId === repo.id)).toHaveLength(2);
    const envs = state.environments.filter((e) => e.projectId === RNC);
    expect(envs.map((e) => e.kind)).toEqual(["production"]);
    expect(state.envFiles.filter((f) => f.repositoryId === repo.id)).toEqual([
      expect.objectContaining({ environmentId: envs[0]!.id }),
    ]);
    const codes = envs[0]!.servers.map((s) => s.serverCode);
    expect(codes).toHaveLength(1);
    const elsewhere = state.environments
      .filter((e) => e.projectId !== RNC)
      .flatMap((e) => e.servers.map((s) => s.serverCode));
    expect(elsewhere).not.toContain(codes[0]);
  });

  it("shop-frontend usa «GitHub Shop», e nessun altro repository usa quell'account", () => {
    const shop = state.instance.gitAccounts.find((g) => g.name === "GitHub Shop")!;
    expect(shop.provider).toBe("github");
    expect(
      state.repositories.filter((r) => r.gitAccountId === shop.id).map((r) => r.name),
    ).toEqual(["shop-frontend"]);
  });

  it("nessun repository senza progetto nel seme", () => {
    expect(state.detachedRepositories).toEqual([]);
    expect(state.deletedProjects).toEqual([]);
  });
});
