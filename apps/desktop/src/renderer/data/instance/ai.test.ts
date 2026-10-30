import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __secretValuesForTest } from "../admin/secrets";
import { changelog, instance, resetApi, setLatency } from "../api";
import { markReauthenticated } from "../auth/reauth";
import { setSessionPersonId } from "../session";
import { now, state } from "../store";
import { grantInstancePermission, type LocalInstancePermission } from "../viewer";
import type { InstanceResult } from "./types";

// L'AI d'istanza nel livello dati (area 9b, Task 3): provider e catena,
// modelli per operazione, automazione, budget e lingua. Ogni rifiuto si
// controlla con lo stato invariato e nessuna voce del registro. Persone:
// Roberta (full admin), Marco (User: nessun permesso d'AI; i test gliene
// danno uno quando serve).

const ROBERTA = "p-roberta";
const MARCO = "p-marco";

const as = (personId: string) => setSessionPersonId(personId);
const reauth = (personId: string) => markReauthenticated(personId);
const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);

const names = () => state.instance.providers.map((p) => p.name);
const byName = (name: string) => state.instance.providers.find((p) => p.name === name)!;

/** Lo stato d'istanza e i segreti, serializzati: un rifiuto non li tocca. */
function snapshot(): string {
  return JSON.stringify({
    instance: state.instance,
    notifications: state.notifications,
    secrets: __secretValuesForTest().map((s) => s.id),
  });
}

async function refused(
  call: () => Promise<InstanceResult<object>>,
  expected: Partial<{ error: string; reason: string }>,
) {
  const before = snapshot();
  const entries = state.changelog.length;
  expect(await call()).toMatchObject({ ok: false, ...expected });
  expect(snapshot()).toBe(before);
  expect(state.changelog.length).toBe(entries);
}

const kinds = () => state.changelog.map((e) => e.kind);

beforeEach(() => {
  resetApi();
  setLatency(0);
  state.changelog.splice(0);
  as(ROBERTA);
});
afterEach(() => resetApi());

// --- permessi e riconferma ---------------------------------------------------

describe("permessi", () => {
  const writes: [string, () => Promise<InstanceResult<object>>][] = [
    [
      "createProvider",
      () =>
        instance.createProvider({
          name: "Team Max 2",
          kind: "subscription",
          credential: "sk-ant-oat-xyz1",
        }),
    ],
    ["setProviderEnabled", () => instance.setProviderEnabled("prv-backup-max", false)],
    ["moveProvider", () => instance.moveProvider("prv-backup-max", 0)],
    ["testProvider", () => instance.testProvider("prv-team-max")],
    [
      "replaceProviderCredential",
      () => instance.replaceProviderCredential("prv-billing-key", "sk-ant-api-new9"),
    ],
    ["deleteProvider", () => instance.deleteProvider("prv-backup-max")],
    ["simulateNextTest", () => instance.simulateNextTest("prv-team-max", "unreachable")],
    ["setModel", () => instance.setModel("triage", "opus")],
    [
      "saveAutomation",
      () =>
        instance.saveAutomation({
          rules: state.instance.automation.rules.map((r) => ({ ...r, autoFix: true })),
          prReview: { enabled: false, maxCostUsd: null },
        }),
    ],
    ["saveBudget", () => instance.saveBudget({ monthlyUsd: 800, contentLanguage: "it" })],
    ["simulateBudgetReached", () => instance.simulateBudgetReached(true)],
  ];

  for (const [name, call] of writes)
    it(`${name} senza permesso → forbidden, stato e registro invariati`, async () => {
      reauth(MARCO);
      as(MARCO);
      await refused(call, { error: "forbidden" });
    });

  it("i provider li scrive solo ai_providers.manage, il resto solo settings.manage", async () => {
    give(MARCO, "settings.manage");
    reauth(MARCO);
    as(MARCO);
    await refused(() => instance.setProviderEnabled("prv-backup-max", false), {
      error: "forbidden",
    });
    expect(await instance.setModel("triage", "opus")).toMatchObject({ ok: true });

    resetApi();
    give(MARCO, "ai_providers.manage");
    as(MARCO);
    await refused(() => instance.setModel("triage", "opus"), { error: "forbidden" });
    expect(await instance.setProviderEnabled("prv-backup-max", false)).toMatchObject({ ok: true });
  });

  it("le letture: con ai_providers.manage o settings.manage, altrimenti forbidden", async () => {
    as(MARCO);
    await expect(instance.listProviders()).rejects.toThrow("forbidden");
    await expect(instance.listModels()).rejects.toThrow("forbidden");
    await expect(instance.getAutomation()).rejects.toThrow("forbidden");
    await expect(instance.getBudget()).rejects.toThrow("forbidden");
    give(MARCO, "settings.manage");
    expect(await instance.listProviders()).toHaveLength(3);
    expect((await instance.getBudget()).monthlyUsd).toBe(600);
  });

  const plusR: [string, () => Promise<InstanceResult<object>>][] = [
    [
      "createProvider",
      () =>
        instance.createProvider({
          name: "Team Max 2",
          kind: "subscription",
          credential: "sk-ant-oat-xyz1",
        }),
    ],
    [
      "replaceProviderCredential",
      () => instance.replaceProviderCredential("prv-billing-key", "sk-ant-api-new9"),
    ],
    ["deleteProvider", () => instance.deleteProvider("prv-backup-max")],
  ];
  for (const [name, call] of plusR)
    it(`${name} senza riconferma → reauth_required; con → ok`, async () => {
      await refused(call, { error: "reauth_required" });
      reauth(ROBERTA);
      expect(await call()).toMatchObject({ ok: true });
    });

  it("le altre scritture non chiedono la riconferma", async () => {
    expect(await instance.setProviderEnabled("prv-backup-max", false)).toMatchObject({ ok: true });
    expect(await instance.moveProvider("prv-billing-key", 0)).toMatchObject({ ok: true });
    expect(await instance.testProvider("prv-team-max")).toMatchObject({ ok: true });
    expect(await instance.setModel("triage", "opus")).toMatchObject({ ok: true });
    expect(await instance.saveBudget({ monthlyUsd: 700, contentLanguage: "en" })).toMatchObject({
      ok: true,
    });
  });
});

// --- RF 1: la chiave non torna -----------------------------------------------

describe("RF 1: la chiave scritta non ricompare", () => {
  it("né nelle letture, né nel registro, né nelle notifiche", async () => {
    reauth(ROBERTA);
    const created = await instance.createProvider({
      name: "Team Max 2",
      kind: "subscription",
      credential: "sk-ant-oat01-secretvalue-7f3a",
    });
    expect(created).toMatchObject({ ok: true });
    expect(
      await instance.replaceProviderCredential("prv-billing-key", "sk-ant-api03-another-c0de"),
    ).toMatchObject({
      ok: true,
    });

    const values = __secretValuesForTest()
      .filter((s) => s.kind === "provider_credential")
      .flatMap((s) => s.values);
    expect(values).toContain("sk-ant-oat01-secretvalue-7f3a");
    expect(values).toContain("sk-ant-api03-another-c0de");

    const out = JSON.stringify({
      providers: await instance.listProviders(),
      changes: await changelog.listChanges(),
      notifications: state.notifications,
      models: await instance.listModels(),
      budget: await instance.getBudget(),
    });
    for (const v of values) expect(out).not.toContain(v);

    const views = await instance.listProviders();
    expect(views.find((p) => p.name === "Team Max 2")).toMatchObject({
      last4: "7f3a",
      lastTest: null,
    });
    expect(views.find((p) => p.name === "Billing key")).toMatchObject({
      last4: "c0de",
      lastTest: null,
    });
    expect(views[0]).not.toHaveProperty("secretId");

    // La voce dice «replaced», senza prima né dopo.
    const replaced = state.changelog.find((e) => e.kind === "provider.credential_replaced")!;
    expect(replaced).toMatchObject({
      object: { type: "provider", id: "prv-billing-key", label: "Billing key" },
      before: null,
      after: null,
    });
    const added = state.changelog.find((e) => e.kind === "provider.created")!;
    expect(added.params).toEqual({ kind: "subscription" });
  });

  it("la chiave sostituita esce dal caveau", async () => {
    reauth(ROBERTA);
    await instance.createProvider({
      name: "Key 2",
      kind: "api_key",
      credential: "sk-old-value-aaaa",
    });
    const id = state.instance.providers.find((p) => p.name === "Key 2")!.id;
    await instance.replaceProviderCredential(id, "sk-new-value-bbbb");
    const all = __secretValuesForTest().flatMap((s) => s.values);
    expect(all).not.toContain("sk-old-value-aaaa");
    expect(all).toContain("sk-new-value-bbbb");
  });

  it("un nome già preso è conflict, una chiave vuota è invalid", async () => {
    reauth(ROBERTA);
    await refused(
      () =>
        instance.createProvider({
          name: " team max ",
          kind: "subscription",
          credential: "abcd1234",
        }),
      { error: "conflict" },
    );
    await refused(
      () => instance.createProvider({ name: "New", kind: "api_key", credential: "  " }),
      {
        error: "invalid",
        reason: "credential",
      },
    );
    await refused(
      () => instance.createProvider({ name: " ", kind: "api_key", credential: "abcd1234" }),
      {
        error: "invalid",
        reason: "name",
      },
    );
  });
});

// --- la catena ---------------------------------------------------------------

describe("la catena dei provider", () => {
  const future = "2026-10-23T16:00:00Z";

  it("moveProvider cambia pickProvider() e scrive l'ordine prima e dopo", async () => {
    expect(instance.pickProvider()).toEqual({
      kind: "account",
      name: "Team Max",
      id: "prv-team-max",
    });
    expect(await instance.moveProvider("prv-backup-max", 0)).toMatchObject({ ok: true });
    expect(names()).toEqual(["Backup Max", "Team Max", "Billing key"]);
    expect(instance.pickProvider()).toMatchObject({ name: "Backup Max", id: "prv-backup-max" });
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "provider.reordered",
      before: "Team Max, Backup Max, Billing key",
      after: "Backup Max, Team Max, Billing key",
    });
    // Le posizioni seguono l'ordine.
    expect((await instance.listProviders()).map((p) => [p.name, p.position])).toEqual([
      ["Backup Max", 1],
      ["Team Max", 2],
      ["Billing key", 3],
    ]);
  });

  it("un indice fuori dalla catena è invalid; lo stesso posto non scrive niente", async () => {
    await refused(() => instance.moveProvider("prv-team-max", 3), {
      error: "invalid",
      reason: "index",
    });
    expect(await instance.moveProvider("prv-team-max", 0)).toMatchObject({ ok: true });
    expect(state.changelog).toHaveLength(0);
  });

  it("RF 4: con gli abbonamenti al limite la chiave API non si usa", () => {
    byName("Team Max").quota!.limitedUntil = future;
    expect(instance.pickProvider()).toMatchObject({ name: "Backup Max" });
    byName("Backup Max").quota!.limitedUntil = future;
    expect(instance.pickProvider()).toBeNull();
  });

  it("un limite passato non conta", () => {
    byName("Team Max").quota!.limitedUntil = "2026-10-23T08:00:00Z";
    expect(instance.pickProvider()).toMatchObject({ name: "Team Max" });
  });

  it("con gli abbonamenti disabilitati si usa la chiave API", async () => {
    await instance.setProviderEnabled("prv-team-max", false);
    await instance.setProviderEnabled("prv-backup-max", false);
    expect(instance.pickProvider()).toEqual({
      kind: "api_key",
      name: "Billing key",
      id: "prv-billing-key",
    });
    expect(state.changelog.map((e) => [e.kind, e.object.label, e.before, e.after])).toEqual([
      ["provider.updated", "Team Max", "On", "Off"],
      ["provider.updated", "Backup Max", "On", "Off"],
    ]);
  });

  it("RF 4: l'ultimo abilitato non si disabilita né si elimina", async () => {
    await instance.setProviderEnabled("prv-team-max", false);
    await instance.setProviderEnabled("prv-backup-max", false);
    reauth(ROBERTA);
    await refused(() => instance.setProviderEnabled("prv-billing-key", false), {
      error: "invalid",
      reason: "last_enabled_provider",
    });
    await refused(() => instance.deleteProvider("prv-billing-key"), {
      error: "invalid",
      reason: "last_enabled_provider",
    });
    // Uno disabilitato si elimina anche se ne resta uno solo abilitato.
    expect(await instance.deleteProvider("prv-team-max")).toMatchObject({ ok: true });
    expect(names()).toEqual(["Backup Max", "Billing key"]);
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "provider.deleted",
      object: { type: "provider", id: "prv-team-max", label: "Team Max" },
    });
  });

  it("listProviders: la banda della quota", async () => {
    byName("Team Max").quota!.limitedUntil = future;
    const views = await instance.listProviders();
    expect(views.map((p) => p.quota?.band ?? null)).toEqual(["limited", "near", null]);
    expect(views[0]!.quota).toMatchObject({ limitedUntil: future, weeklyPct: 41 });
    expect(instance.QUOTA_NEAR_PCT).toBe(80);
    expect(instance.BACKGROUND_WEEKLY_THRESHOLD).toBe(90);
  });

  it("un provider che non c'è è not_found", async () => {
    await refused(() => instance.setProviderEnabled("prv-nope", false), { error: "not_found" });
    await refused(() => instance.testProvider("prv-nope"), { error: "not_found" });
  });
});

describe("testProvider", () => {
  it("dà l'esito simulato, lo salva in lastTest, poi torna a ok", async () => {
    expect(await instance.simulateNextTest("prv-backup-max", "invalid_credentials")).toMatchObject({
      ok: true,
    });
    expect(await instance.testProvider("prv-backup-max")).toEqual({
      ok: true,
      outcome: "invalid_credentials",
    });
    expect(byName("Backup Max").lastTest).toEqual({
      at: now(),
      outcome: "invalid_credentials",
    });
    expect(await instance.testProvider("prv-backup-max")).toEqual({ ok: true, outcome: "ok" });
    // Una prova non è una modifica: nessuna voce.
    expect(state.changelog).toHaveLength(0);
  });
});

// --- modelli -----------------------------------------------------------------

describe("modelli per operazione", () => {
  it("modelFor: impostazione, env, default", () => {
    expect(instance.modelFor("fix_plan")).toEqual({ model: "opus", source: "setting" });
    expect(instance.modelFor("mail_classify")).toEqual({ model: "haiku", source: "env" });
    expect(instance.modelFor("triage")).toEqual({ model: "sonnet", source: "default" });
    expect(instance.modelFor("daily_report")).toEqual({ model: "haiku", source: "default" });
  });

  it("setModel(op, null) torna alla fonte di prima", async () => {
    expect(await instance.setModel("mail_classify", "opus")).toMatchObject({ ok: true });
    expect(instance.modelFor("mail_classify")).toEqual({ model: "opus", source: "setting" });
    expect(await instance.setModel("mail_classify", null)).toMatchObject({ ok: true });
    expect(instance.modelFor("mail_classify")).toEqual({ model: "haiku", source: "env" });
    expect(await instance.setModel("fix_plan", null)).toMatchObject({ ok: true });
    expect(instance.modelFor("fix_plan")).toEqual({ model: "sonnet", source: "default" });
    expect(state.changelog.map((e) => [e.kind, e.object.id, e.before, e.after])).toEqual([
      ["model.changed", "mail_classify", "Server configuration (Haiku)", "Opus"],
      ["model.changed", "mail_classify", "Opus", "Server configuration (Haiku)"],
      ["model.changed", "fix_plan", "Opus", "Default (Sonnet)"],
    ]);
    expect(state.changelog[2]!.object).toMatchObject({ type: "ai_settings", label: "Fix plan" });
  });

  it("listModels: solo le operazioni configurabili, con gruppo e fonte", async () => {
    const rows = await instance.listModels();
    expect(rows.map((r) => r.operation)).not.toContain("plugin_smoke");
    expect(rows).toHaveLength(16);
    expect(rows.find((r) => r.operation === "fix_plan")).toEqual({
      operation: "fix_plan",
      group: "tickets",
      model: "opus",
      source: "setting",
    });
  });

  it("un'operazione tecnica o un modello sconosciuto sono invalid", async () => {
    await refused(() => instance.setModel("plugin_smoke", "opus"), {
      error: "invalid",
      reason: "operation",
    });
    await refused(() => instance.setModel("triage", "gpt-4" as never), {
      error: "invalid",
      reason: "model",
    });
  });
});

// --- automazione -------------------------------------------------------------

describe("automazione", () => {
  it("salva con una voce sola, prima e dopo delle sole righe cambiate", async () => {
    const a = await instance.getAutomation();
    const rules = a.rules.map((r) => (r.taskType === "bug" ? { ...r, maxEffort: 3 as const } : r));
    expect(
      await instance.saveAutomation({ rules, prReview: { enabled: true, maxCostUsd: 3 } }),
    ).toMatchObject({ ok: true });
    expect(state.instance.automation.rules.find((r) => r.taskType === "bug")!.maxEffort).toBe(3);
    expect(state.changelog).toHaveLength(1);
    const e = state.changelog[0]!;
    expect(e.kind).toBe("automation.changed");
    expect(e.before).toBe("Bug: auto-fix up to effort 2 · PR review cap $2");
    expect(e.after).toBe("Bug: auto-fix up to effort 3 · PR review cap $3");
  });

  it("un costo negativo o un effort fuori da 1–5 sono invalid", async () => {
    const { rules, prReview } = await instance.getAutomation();
    await refused(
      () =>
        instance.saveAutomation({ rules: rules.map((r) => ({ ...r, maxCostUsd: -1 })), prReview }),
      { error: "invalid", reason: "cost" },
    );
    await refused(
      () => instance.saveAutomation({ rules, prReview: { enabled: true, maxCostUsd: -0.5 } }),
      { error: "invalid", reason: "cost" },
    );
    await refused(
      () =>
        instance.saveAutomation({
          rules: rules.map((r) => ({ ...r, maxEffort: 6 as never })),
          prReview,
        }),
      { error: "invalid", reason: "effort" },
    );
    await refused(
      () =>
        instance.saveAutomation({
          rules: rules.map((r) => ({ ...r, planApprovalMinEffort: 0 as never })),
          prReview,
        }),
      { error: "invalid", reason: "effort" },
    );
  });

  it("un salvataggio senza cambi non scrive la voce", async () => {
    const a = await instance.getAutomation();
    expect(await instance.saveAutomation(a)).toMatchObject({ ok: true });
    expect(state.changelog).toHaveLength(0);
  });
});

// --- budget e lingua ---------------------------------------------------------

describe("budget e lingua", () => {
  it("reached col simulatore, senza voce", async () => {
    expect((await instance.getBudget()).reached).toBe(false);
    expect(instance.budgetReached()).toBe(false);
    expect(await instance.simulateBudgetReached(true)).toMatchObject({ ok: true });
    expect((await instance.getBudget()).reached).toBe(true);
    expect(instance.budgetReached()).toBe(true);
    await instance.simulateBudgetReached(false);
    expect(instance.budgetReached()).toBe(false);
    expect(state.changelog).toHaveLength(0);
  });

  it("reached con il budget sotto lo speso; alzarlo lo spegne", async () => {
    const { spentUsd } = await instance.getBudget();
    expect(spentUsd).toBeGreaterThan(100);
    expect(await instance.saveBudget({ monthlyUsd: 100, contentLanguage: "en" })).toMatchObject({
      ok: true,
    });
    expect(await instance.getBudget()).toMatchObject({ monthlyUsd: 100, reached: true });
    await instance.saveBudget({ monthlyUsd: 5000, contentLanguage: "en" });
    expect(await instance.getBudget()).toMatchObject({ reached: false });
    await instance.saveBudget({ monthlyUsd: null, contentLanguage: "en" });
    expect(instance.budgetReached()).toBe(false);
    expect(state.changelog.map((e) => [e.kind, e.before, e.after])).toEqual([
      ["budget.changed", "$600", "$100"],
      ["budget.changed", "$100", "$5000"],
      ["budget.changed", "$5000", "No budget"],
    ]);
  });

  it("budget e lingua: voci separate", async () => {
    await instance.saveBudget({ monthlyUsd: 800, contentLanguage: "it" });
    expect(kinds()).toEqual(["budget.changed", "content_language.changed"]);
    expect(state.changelog[1]).toMatchObject({ before: "English", after: "Italiano" });
    await instance.saveBudget({ monthlyUsd: 800, contentLanguage: "it" });
    expect(state.changelog).toHaveLength(2);
  });

  it("un importo negativo è invalid", async () => {
    await refused(() => instance.saveBudget({ monthlyUsd: -1, contentLanguage: "en" }), {
      error: "invalid",
      reason: "amount",
    });
  });
});
