import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessState, roleIdOf, writeAccess } from "../access/index";
import { __secretValuesForTest, revealOnce, storeProvidedSecret } from "../admin/secrets";
import { adminSections, administersSomething, aiTabsFor, canSeeAdmin } from "../adminSections";
import { auth, changelog, resetApi, setLatency } from "../api";
import { recordChange } from "../changelog/index";
import { GROUP_ORDER } from "../changelog/visibility";
import { ADMIN_SECTIONS, AI_TABS } from "../routes";
import { CLAUDE_ID } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { grantInstancePermission, viewerFor, type LocalInstancePermission } from "../viewer";
import { queuePauseOf, storageAllowsUploads } from "./blocks";
import { INSTANCE_CHANGE_TYPES } from "./changeTypes";
import { ENV_MODELS } from "./seed";

// Lo stato d'istanza dell'area 9b (Task 1): le voci dell'Amministrazione per
// permesso, i tipi di voce del registro, i segreti scritti da chi
// amministra, il seme e l'istanza vuota. Persone del seme: Roberta (full
// admin), Giulia (Project Lead nei suoi progetti), Sara e Marco (User).

const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const SARA = "p-sara";
const MARCO = "p-marco";
const ACQ = "prj-acq";
const STW = "prj-stw";

const INSTANCE_SECTIONS = ["ai", "git-accounts", "plugins", "google", "storage", "webhooks"];
const ESTATE_SECTIONS = ["servers", "repositories", "status"];
const NINE_B = [...INSTANCE_SECTIONS, ...ESTATE_SECTIONS];

const as = (personId: string) => setSessionPersonId(personId);
const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);
const ids = (personId: string) => adminSections(viewerFor(personId)).map((s) => s.id);
const nineB = (personId: string) => ids(personId).filter((id) => NINE_B.includes(id));

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

describe("le voci dell'istanza, per permesso", () => {
  it("le voci nuove stanno dopo quelle del 9a, nei gruppi instance ed estate", () => {
    expect(ADMIN_SECTIONS.map((s) => s.id)).toEqual([
      "people",
      "departments",
      "roles",
      "changelog",
      "who-can",
      ...NINE_B,
    ]);
    expect(ADMIN_SECTIONS.filter((s) => s.group === "instance").map((s) => s.id)).toEqual(
      INSTANCE_SECTIONS,
    );
    expect(ADMIN_SECTIONS.filter((s) => s.group === "estate").map((s) => s.id)).toEqual(
      ESTATE_SECTIONS,
    );
    expect(AI_TABS).toEqual(["providers", "models", "automation", "budget", "usage"]);
  });

  it("il full admin vede tutte le voci, nei gruppi del 9a più i due nuovi, e tutte le schede di AI", () => {
    const sections = adminSections(viewerFor(ROBERTA));
    expect(sections.map((s) => s.id)).toEqual(ADMIN_SECTIONS.map((s) => s.id));
    expect([...new Set(sections.filter((s) => NINE_B.includes(s.id)).map((s) => s.group))]).toEqual(
      ["instance", "estate"],
    );
    expect(aiTabsFor(viewerFor(ROBERTA))).toEqual([...AI_TABS]);
    expect(administersSomething(viewerFor(ROBERTA))).toBe(true);
  });

  it("chi ha il ruolo Auditor vede solo AI, con la sola scheda Usage", () => {
    // `au-1` è `usage.view` + `changelog.view`; nel seme non ce l'ha nessuno.
    writeAccess((a) => {
      a.people.find((p) => p.personId === SARA)!.instanceRoleId = roleIdOf("au-1");
    });
    expect(nineB(SARA)).toEqual(["ai"]);
    expect(aiTabsFor(viewerFor(SARA))).toEqual(["usage"]);
  });

  it("i permessi dell'Auditor sopra il preset User: AI con la sola Usage, più Git accounts in sola lettura", () => {
    const auditor = accessState().roles.find((r) => r.id === roleIdOf("au-1"))!;
    for (const perm of auditor.permissions) give(SARA, perm);
    expect(nineB(SARA)).toEqual(["ai", "git-accounts"]);
    expect(aiTabsFor(viewerFor(SARA))).toEqual(["usage"]);
  });

  it("Sara (User) vede fra le voci 9b solo Git accounts, e non amministra niente finché non le si dà git_accounts.manage", () => {
    expect(nineB(SARA)).toEqual(["git-accounts"]);
    expect(aiTabsFor(viewerFor(SARA))).toEqual([]);
    expect(administersSomething(viewerFor(SARA))).toBe(false);
    give(SARA, "git_accounts.manage");
    expect(nineB(SARA)).toEqual(["git-accounts"]);
    expect(administersSomething(viewerFor(SARA))).toBe(true);
  });

  it("Repositories: Giulia (Project Lead, repos.manage) la vede; Sara (senza repos.manage) no", () => {
    expect(nineB(GIULIA)).toContain("repositories");
    expect(nineB(SARA)).not.toContain("repositories");
  });

  it("ogni voce col suo permesso", () => {
    const cases: [string, string[]][] = [
      ["ai_providers.manage", ["ai"]],
      ["settings.manage", ["ai", "storage", "webhooks", "status"]],
      ["plugins.manage", ["plugins"]],
      ["integrations.manage", ["google"]],
      ["monitor.manage", ["servers"]],
      ["instance.status.view", ["status"]],
    ];
    for (const [perm, expected] of cases) {
      resetApi();
      give(MARCO, perm);
      const seen = nineB(MARCO).filter((id) => id !== "git-accounts" && id !== "repositories");
      expect(seen, perm).toEqual(expected);
    }
    resetApi();
    give(MARCO, "ai_providers.manage");
    expect(aiTabsFor(viewerFor(MARCO))).toEqual(["providers", "models", "automation", "budget"]);
  });

  it("Claude non vede nessuna voce 9b", () => {
    expect(nineB(CLAUDE_ID)).toEqual([]);
    expect(aiTabsFor(viewerFor(CLAUDE_ID))).toEqual([]);
    expect(canSeeAdmin(viewerFor(CLAUDE_ID))).toBe(false);
  });
});

describe("il registro delle modifiche del 9b", () => {
  const GROUPS = ["ai", "integrations", "servers", "queue"];

  it("i tipi stanno nei quattro gruppi nuovi; queue è di progetto, gli altri d'istanza", () => {
    expect([...new Set(INSTANCE_CHANGE_TYPES.map((t) => t.group))]).toEqual(GROUPS);
    for (const t of INSTANCE_CHANGE_TYPES)
      expect(t.scope, t.kind).toBe(t.group === "queue" ? "project" : "instance");
    expect(INSTANCE_CHANGE_TYPES.map((t) => t.kind)).toContain("webhook.changed");
    // ai 9, integrations 16, servers 7, queue 3.
    expect(INSTANCE_CHANGE_TYPES).toHaveLength(35);
  });

  /** Una voce per tipo, scritta come la scriveranno i Task 3–7. */
  function recordOneOfEach() {
    for (const t of INSTANCE_CHANGE_TYPES)
      recordChange({
        kind: t.kind,
        actorId: ROBERTA,
        projectId: t.scope === "project" ? ACQ : null,
        object: { type: "test", id: t.kind, label: t.kind },
      });
  }

  it("il full admin le legge tutte; Claude nessuna", async () => {
    recordOneOfEach();
    as(ROBERTA);
    const all = await changelog.listChanges();
    expect(all.filter((e) => GROUPS.includes(e.group))).toHaveLength(INSTANCE_CHANGE_TYPES.length);
    as(CLAUDE_ID);
    expect((await changelog.listChanges()).filter((e) => GROUPS.includes(e.group))).toEqual([]);
    await expect(changelog.listProjectChanges(ACQ)).rejects.toThrow("forbidden");
  });

  it("il filtro «Type» mette i gruppi nuovi dopo quelli del 9a", async () => {
    const order = [
      "people",
      "invites",
      "roles",
      "members",
      "departments",
      "security",
      "ai",
      "integrations",
      "servers",
      "queue",
    ];
    // L'ordine è dichiarato, non affidato all'ordine in cui i moduli registrano i tipi.
    expect(GROUP_ORDER).toEqual(order);
    as(ROBERTA);
    const choices = await changelog.listChangeFilterChoices();
    expect(choices.groups).toEqual(order);
  });

  it("i link nuovi: una voce di un provider porta ad AI, una di un server al server", async () => {
    recordChange({
      kind: "provider.updated",
      actorId: ROBERTA,
      projectId: null,
      object: { type: "provider", id: "prv-backup-max", label: "Backup Max" },
      before: "On",
      after: "Off",
    });
    recordChange({
      kind: "server.updated",
      actorId: ROBERTA,
      projectId: null,
      object: { type: "server", id: "SRV-1", label: "SRV-1" },
      before: "api-1",
      after: "api-01",
    });
    recordChange({
      kind: "plugin.removed",
      actorId: ROBERTA,
      projectId: null,
      object: { type: "plugin", id: "plg-gone", label: "gone" },
    });
    as(ROBERTA);
    const [plugin, server, provider] = await changelog.listChanges();
    expect(provider!.objectLink).toEqual({ to: "admin", section: "ai", id: "prv-backup-max" });
    expect(provider!.diff).toEqual({ kind: "values", before: "On", after: "Off" });
    expect(server!.objectLink).toEqual({ to: "server", code: "SRV-1" });
    expect(server!.diff).toEqual({ kind: "values", before: "api-1", after: "api-01" });
    // Un plugin che non c'è più: «(deleted)», senza link e senza prima/dopo.
    expect(plugin!.objectLink).toBeNull();
    expect(plugin!.objectDeleted).toBe(true);
    expect(plugin!.diff).toBeNull();
    // Chi non vede la voce AI non ha il link (legge la voce con changelog.view).
    give(SARA, "changelog.view");
    as(SARA);
    const sara = await changelog.listChanges();
    expect(sara.find((e) => e.kind === "provider.updated")!.objectLink).toBeNull();
    expect(sara.find((e) => e.kind === "server.updated")!.objectLink).toBeNull();
  });

  it("una voce che sostituisce un segreto non ha prima/dopo", async () => {
    recordChange({
      kind: "provider.credential_replaced",
      actorId: ROBERTA,
      projectId: null,
      object: { type: "provider", id: "prv-billing-key", label: "Billing key" },
      before: "x",
      after: "y",
    });
    as(ROBERTA);
    const [entry] = await changelog.listChanges();
    expect(entry!.diff).toBeNull();
  });
});

describe("i segreti scritti da chi amministra", () => {
  it("storeProvidedSecret restituisce le ultime 4 cifre, mai il valore; il valore sta nel caveau", () => {
    const value = "sk-ant-api03-prototype-value-9e2b";
    const stored = storeProvidedSecret("provider_credential", "prv-new", value);
    expect(stored.last4).toBe("9e2b");
    expect(JSON.stringify(stored)).not.toContain(value);
    expect(__secretValuesForTest()).toContainEqual({
      id: stored.id,
      kind: "provider_credential",
      values: [value],
    });
    // Nemmeno la via «mostra una volta» lo restituisce: chi l'ha scritto lo conosce già.
    expect(revealOnce(stored.id)).toBeNull();
  });

  it("i segreti del seme hanno id e ultime 4 cifre, e nessun valore nello stato", () => {
    const secrets = [
      ...state.instance.providers.map((p) => [p.secretId, p.last4]),
      ...state.instance.gitAccounts.map((g) => [g.secretId, g.last4]),
      ...state.googleWorkspaces.map((w) => [w.secretId, w.last4]),
      [state.instance.storage.secretId, state.instance.storage.last4],
    ];
    for (const [id, last4] of secrets) {
      expect(id).toMatch(/^sec-/);
      expect(last4).toMatch(/^[0-9a-z]{4}$/);
    }
  });
});

describe("il seme dell'istanza", () => {
  it("provider: Team Max, Backup Max vicino alla soglia, Billing key per ultima", () => {
    const providers = state.instance.providers;
    expect(providers.map((p) => [p.name, p.kind, p.enabled])).toEqual([
      ["Team Max", "subscription", true],
      ["Backup Max", "subscription", true],
      ["Billing key", "api_key", true],
    ]);
    expect(providers.map((p) => p.quota?.weeklyPct ?? null)).toEqual([41, 87, null]);
  });

  it("modelli, automazione, budget e lingua", () => {
    const i = state.instance;
    expect(i.models).toEqual({ fix_plan: "opus" });
    expect(ENV_MODELS).toEqual({ mail_classify: "haiku" });
    expect(i.automation.rules.map((r) => [r.taskType, r.autoFix, r.maxEffort])).toEqual([
      ["bug", true, 2],
      ["feature", false, 2],
      ["activity", false, 2],
    ]);
    expect(i.automation.prReview).toEqual({ enabled: true, maxCostUsd: 2 });
    expect(i.budget).toEqual({ monthlyUsd: 600, contentLanguage: "en" });
  });

  it("account git, e ogni repository del seme legato a uno dei due", () => {
    const accounts = state.instance.gitAccounts;
    expect(accounts.map((a) => [a.name, a.provider, a.workspace, a.defaultReviewer])).toEqual([
      ["Bitbucket Audin", "bitbucket", "audin", false],
      ["GitHub Stubwise", "github", null, true],
    ]);
    const known = new Set(accounts.map((a) => a.id));
    expect(state.repositories.length).toBeGreaterThan(0);
    for (const r of state.repositories) expect(known.has(r.gitAccountId!), r.id).toBe(true);
  });

  it("plugin: superpowers pronto con l'inventario, lint-helpers fallito con l'errore", () => {
    const [superpowers, lint] = state.instance.plugins;
    expect(superpowers).toMatchObject({ slug: "superpowers", status: "ready", smoke: "passed" });
    expect(superpowers!.inventory!.skills.length).toBeGreaterThan(0);
    expect(superpowers!.inventory!.hooks[0]!.key).toBe("SessionStart#0");
    expect(lint).toMatchObject({ slug: "lint-helpers", status: "failed", inventory: null });
    expect(lint!.error).toBeTruthy();
  });

  it("app Google con client id e chiave; archiviazione con gli allegati; webhook Slack su 4 eventi", () => {
    for (const w of state.googleWorkspaces) {
      expect(w.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
      expect(w.createdAt).toBeTruthy();
    }
    expect(state.instance.storage).toMatchObject({
      attachmentsEnabled: true,
      bucket: "stubwise-files",
    });
    expect(storageAllowsUploads()).toBe(true);
    const webhook = state.instance.webhook;
    expect(webhook).toMatchObject({ enabled: true, format: "slack" });
    expect(webhook.url).toMatch(/^https:\/\/hooks\.slack\.com\//);
    expect(Object.values(webhook.events).filter(Boolean)).toHaveLength(4);
  });

  it("la coda di STW in pausa da Roberta, ieri alle 18:00; le altre no", () => {
    expect(queuePauseOf(STW)).toEqual({
      projectId: STW,
      byId: ROBERTA,
      at: "2026-10-22T18:00:00Z",
    });
    expect(queuePauseOf(ACQ)).toBeNull();
  });

  it("un lavoro fallito ieri: una sessione di ACQ col riassunto del fallimento", () => {
    const failed = state.conversations.filter(
      (c) =>
        c.kind === "task_run" &&
        c.projectId === ACQ &&
        c.outcome === "failed" &&
        c.updatedAt.startsWith("2026-10-22"),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.failureSummary).toBeTruthy();
    // La task resta aperta: si può rimettere in coda (Task 5).
    expect(state.tasksById.get(failed[0]!.taskId!)!.claude).toBe("stopped");
  });

  it("i consumi hanno il loro seme (Task 2); il giro notturno arriva col Task 5; nessuna simulazione accesa", () => {
    expect(state.instance.usage.length).toBeGreaterThan(0);
    expect(state.instance.nightly).toEqual([]);
    expect(state.instance.simulate).toEqual({ nextTest: {}, budgetReached: false });
  });
});

describe("l'istanza vuota", () => {
  it("dopo resetToEmptyInstance l'istanza non ha niente; resetApi torna al seme", async () => {
    await auth.resetToEmptyInstance();
    const i = state.instance;
    expect(i.providers).toEqual([]);
    expect(i.gitAccounts).toEqual([]);
    expect(i.plugins).toEqual([]);
    expect(state.googleWorkspaces).toEqual([]);
    expect(i.models).toEqual({});
    expect(i.queuePauses).toEqual([]);
    expect(i.budget.monthlyUsd).toBeNull();
    expect(i.automation.rules.every((r) => !r.autoFix)).toBe(true);
    expect(i.automation.prReview.enabled).toBe(false);
    expect(i.storage).toMatchObject({ secretId: null, last4: null, attachmentsEnabled: false });
    expect(storageAllowsUploads()).toBe(false);
    expect(i.webhook).toMatchObject({ enabled: false, url: null });
    expect(Object.values(i.webhook.events).some(Boolean)).toBe(false);
    resetApi();
    expect(state.instance.providers).toHaveLength(3);
    expect(queuePauseOf(STW)).not.toBeNull();
  });
});
