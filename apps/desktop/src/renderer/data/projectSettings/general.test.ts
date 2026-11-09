import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instance, projectSettings, resetApi, setLatency } from "../api";
import { pickProvider } from "../instance/blocks";
import { capOf } from "../releases/visibility";
import { setSessionPersonId } from "../session";
import { now, state } from "../store";
import type { ProjectSwitch } from "./state";

// General, AI, Automations e Usage del progetto, livello dati (area 9c, Task
// 2). Persone del seme: Roberta (full admin), Laura (Project Lead in ACQ),
// Sara (Contributor in ACQ, senza `project.settings.manage` né
// `project.usage.view`). AUD lavora solo con «Backup Max»; ACQ è su
// «Automatic».

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";
const AUD = "prj-aud";
const RNC = "prj-rnc";

const settingsOf = (projectId: string) => state.projectSettings.get(projectId)!;
const projectOf = (projectId: string) => state.projectsById.get(projectId)!;
/** Le voci scritte dal test (il seme ne ha già). */
let seeded = 0;
const entries = (kind?: string) =>
  state.changelog.slice(seeded).filter((e) => !kind || e.kind === kind);
const backupMax = () => state.instance.providers.find((p) => p.id === "prv-backup-max")!;
/** Mette un abbonamento al limite fino a domani. */
const limit = (p: ReturnType<typeof backupMax>) => {
  p.quota = { ...p.quota!, limitedUntil: new Date(Date.parse(now()) + 86_400_000).toISOString() };
};

const automationsOf = (projectId: string) => {
  const s = settingsOf(projectId);
  return {
    switches: { ...s.switches },
    pulseEveryDays: s.pulseEveryDays,
    correctionCap: capOf(projectId),
  };
};

beforeEach(() => {
  setLatency(0);
  resetApi();
  seeded = state.changelog.length;
});
afterEach(() => resetApi());

describe("la lettura delle impostazioni", () => {
  it("Laura legge ACQ: nome, codice, AI su Automatic, interruttori e accessi", async () => {
    setSessionPersonId(LAURA);
    const view = await projectSettings.getProjectSettings(ACQ);
    expect(view).toMatchObject({
      projectId: ACQ,
      code: "ACQ",
      name: projectOf(ACQ).name,
      ai: { providerId: null, exclusive: false, chosenUnavailable: false },
      pulseEveryDays: 7,
      correctionCap: 3,
      pulseNeedsBacklog: false,
    });
    expect(view!.ai.choices.map((c) => c.name)).toEqual(["Team Max", "Backup Max", "Billing key"]);
    // Solo nome, tipo e stato: mai quota o segreto.
    for (const c of view!.ai.choices)
      expect(Object.keys(c).sort()).toEqual(["enabled", "id", "kind", "limited", "name"]);
    expect(view!.access.general.canEdit).toBe(true);
  });

  it("un progetto invisibile, archiviato o inesistente è null", async () => {
    setSessionPersonId(SARA);
    expect(await projectSettings.getProjectSettings(AUD)).toBeNull();
    setSessionPersonId(ROBERTA);
    expect(await projectSettings.getProjectSettings(RNC)).toBeNull();
    expect(await projectSettings.getProjectSettings("prj-nope")).toBeNull();
  });

  it("pulseNeedsBacklog è vero con la discovery spenta", async () => {
    settingsOf(ACQ).switches.backlogDiscovery = false;
    settingsOf(ACQ).switches.pulse = false;
    setSessionPersonId(LAURA);
    expect((await projectSettings.getProjectSettings(ACQ))!.pulseNeedsBacklog).toBe(true);
  });

  it("projectSwitchOn è falso su un archiviato o inesistente", () => {
    expect(projectSettings.projectSwitchOn(ACQ, "weeklyBrief")).toBe(true);
    expect(projectSettings.projectSwitchOn("prj-mkx", "weeklyBrief")).toBe(false);
    expect(settingsOf(RNC).switches.weeklyBrief).toBe(true);
    expect(projectSettings.projectSwitchOn(RNC, "weeklyBrief")).toBe(false);
    expect(projectSettings.projectSwitchOn("prj-nope", "weeklyBrief")).toBe(false);
  });
});

describe("chi non ha project.settings.manage non scrive niente", () => {
  it("Sara in ACQ: ogni scrittura è forbidden, stato invariato, nessuna voce", async () => {
    setSessionPersonId(SARA);
    const before = { name: projectOf(ACQ).name, settings: structuredClone(settingsOf(ACQ)) };
    const cap = capOf(ACQ);
    const count = state.changelog.length;
    expect(await projectSettings.updateProjectGeneral(ACQ, { name: "Altro" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      await projectSettings.setProjectAi(ACQ, { providerId: "prv-team-max", exclusive: true }),
    ).toEqual({ ok: false, error: "forbidden" });
    const off = { ...automationsOf(ACQ), correctionCap: 0 };
    off.switches.weeklyBrief = false;
    expect(await projectSettings.saveProjectAutomations(ACQ, off)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(projectOf(ACQ).name).toBe(before.name);
    expect(settingsOf(ACQ)).toEqual(before.settings);
    expect(capOf(ACQ)).toBe(cap);
    expect(state.changelog.length).toBe(count);
  });

  it("un progetto che chi scrive non vede è not_found, anche archiviato", async () => {
    setSessionPersonId(SARA);
    expect(await projectSettings.updateProjectGeneral(AUD, { name: "X" })).toEqual({
      ok: false,
      error: "not_found",
    });
    setSessionPersonId(ROBERTA);
    expect(await projectSettings.updateProjectGeneral(RNC, { name: "X" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("General", () => {
  it("un nome vuoto è invalid; il codice non si cambia da qui", async () => {
    setSessionPersonId(LAURA);
    expect(await projectSettings.updateProjectGeneral(ACQ, { name: "   " })).toEqual({
      ok: false,
      error: "invalid",
      reason: "name",
    });
    const res = await projectSettings.updateProjectGeneral(ACQ, {
      name: "Acquisti",
      code: "ZZZ",
    } as { name: string });
    expect(res).toEqual({ ok: true });
    expect(projectOf(ACQ).code).toBe("ACQ");
  });

  it("una voce per campo cambiato: il nome con prima e dopo, la descrizione senza testo", async () => {
    setSessionPersonId(LAURA);
    const oldName = projectOf(ACQ).name;
    const res = await projectSettings.updateProjectGeneral(ACQ, {
      name: "Acquisti online",
      description: "Il testo nuovo, lungo e privato.",
    });
    expect(res).toEqual({ ok: true });
    expect(projectOf(ACQ).name).toBe("Acquisti online");
    expect(projectOf(ACQ).description).toBe("Il testo nuovo, lungo e privato.");
    const renamed = entries("project.renamed");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({
      actorId: LAURA,
      projectId: ACQ,
      object: { type: "project", id: ACQ, label: "ACQ" },
      before: oldName,
      after: "Acquisti online",
    });
    const described = entries("project.description_changed");
    expect(described).toHaveLength(1);
    expect(JSON.stringify(described[0])).not.toContain("privato");
    // Un salvataggio che non cambia niente non scrive voci.
    const count = state.changelog.length;
    await projectSettings.updateProjectGeneral(ACQ, { name: "Acquisti online" });
    expect(state.changelog.length).toBe(count);
  });
});

describe("AI", () => {
  it("un account che non c'è è invalid; exclusive senza account è invalid", async () => {
    setSessionPersonId(LAURA);
    expect(
      await projectSettings.setProjectAi(ACQ, { providerId: "prv-nope", exclusive: false }),
    ).toEqual({ ok: false, error: "invalid", reason: "provider" });
    expect(await projectSettings.setProjectAi(ACQ, { providerId: null, exclusive: true })).toEqual({
      ok: false,
      error: "invalid",
      reason: "exclusive_needs_account",
    });
    expect(entries()).toHaveLength(0);
  });

  it("la voce salva auto o account:<id> con exclusive; il nome di allora solo in params", async () => {
    setSessionPersonId(LAURA);
    expect(
      await projectSettings.setProjectAi(ACQ, { providerId: "prv-backup-max", exclusive: true }),
    ).toEqual({ ok: true });
    expect(settingsOf(ACQ)).toMatchObject({
      aiProviderId: "prv-backup-max",
      aiProviderExclusive: true,
    });
    const [entry] = entries("project.ai_account_changed");
    expect(entry).toMatchObject({ before: "auto", after: "account:prv-backup-max:exclusive" });
    // Il valore resta un id; il nome (dato da una persona) serve a dire
    // «Backup Max (deleted)» quando l'account non c'è più (Task 12).
    expect(entry!.params).toEqual({ accountAfter: "Backup Max" });
    expect(String(entry!.before) + String(entry!.after)).not.toContain("Backup Max");
  });

  it("l'account eliminato: chosenUnavailable, e si parte con la catena", async () => {
    setSessionPersonId(LAURA);
    await projectSettings.setProjectAi(ACQ, { providerId: "prv-backup-max", exclusive: true });
    state.instance.providers = state.instance.providers.filter((p) => p.id !== "prv-backup-max");
    const view = await projectSettings.getProjectSettings(ACQ);
    expect(view!.ai.chosenUnavailable).toBe(true);
    expect(pickProvider(ACQ)).toEqual({ kind: "account", name: "Team Max", id: "prv-team-max" });
  });

  it("uno spento non è chosenUnavailable: si legge da choices[].enabled (P15)", async () => {
    backupMax().enabled = false;
    setSessionPersonId(ROBERTA);
    const view = await projectSettings.getProjectSettings(AUD);
    expect(view!.ai.chosenUnavailable).toBe(false);
    expect(view!.ai.choices.find((c) => c.id === "prv-backup-max")!.enabled).toBe(false);
  });
});

describe("pickProvider del progetto", () => {
  it("AUD (Backup Max, exclusive) → Backup Max", () => {
    expect(pickProvider(AUD)).toEqual({
      kind: "account",
      name: "Backup Max",
      id: "prv-backup-max",
    });
  });

  it("Backup Max al limite, AUD exclusive → null", () => {
    limit(backupMax());
    expect(pickProvider(AUD)).toBeNull();
  });

  it("Backup Max spento, AUD exclusive → null", () => {
    backupMax().enabled = false;
    expect(pickProvider(AUD)).toBeNull();
  });

  it("Backup Max al limite, senza exclusive → Team Max (P19)", () => {
    settingsOf(AUD).aiProviderExclusive = false;
    limit(backupMax());
    expect(pickProvider(AUD)).toEqual({ kind: "account", name: "Team Max", id: "prv-team-max" });
  });

  it("ACQ (Automatic) → Team Max; senza progetto, come prima", () => {
    expect(pickProvider(ACQ)).toEqual({ kind: "account", name: "Team Max", id: "prv-team-max" });
    expect(pickProvider()).toEqual({ kind: "account", name: "Team Max", id: "prv-team-max" });
    expect(pickProvider(null)).toEqual(pickProvider());
  });
});

describe("Automations", () => {
  it("project.switch_changed: on → off, params.switch, nessuna parola tradotta", async () => {
    setSessionPersonId(LAURA);
    const input = automationsOf(ACQ);
    input.switches.weeklyBrief = false;
    expect(await projectSettings.saveProjectAutomations(ACQ, input)).toEqual({ ok: true });
    expect(settingsOf(ACQ).switches.weeklyBrief).toBe(false);
    const all = entries();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: "project.switch_changed",
      projectId: ACQ,
      before: "on",
      after: "off",
      params: { switch: "weeklyBrief" },
    });
    expect(JSON.stringify(all[0])).not.toMatch(/brief settimanale|weekly brief/i);
  });

  it("una voce per ogni valore cambiato; il tetto scrive Project.correctionCap", async () => {
    setSessionPersonId(LAURA);
    const input = automationsOf(ACQ);
    input.switches.docsNightly = !input.switches.docsNightly;
    input.switches.dailyReport = !input.switches.dailyReport;
    input.pulseEveryDays = 14;
    input.correctionCap = 5;
    expect(await projectSettings.saveProjectAutomations(ACQ, input)).toEqual({ ok: true });
    expect(entries().map((e) => e.kind)).toEqual([
      "project.switch_changed",
      "project.switch_changed",
      "project.pulse_interval_changed",
      "project.correction_cap_changed",
    ]);
    expect(entries("project.pulse_interval_changed")[0]).toMatchObject({
      before: "7",
      after: "14",
    });
    expect(entries("project.correction_cap_changed")[0]).toMatchObject({
      before: "3",
      after: "5",
    });
    expect(projectOf(ACQ).correctionCap).toBe(5);
    expect(capOf(ACQ)).toBe(5);
  });

  it("i bordi del pulse e del tetto", async () => {
    setSessionPersonId(LAURA);
    const save = (patch: { pulseEveryDays?: number; correctionCap?: number }) =>
      projectSettings.saveProjectAutomations(ACQ, { ...automationsOf(ACQ), ...patch });
    for (const days of [0, 31, 2.5, Number.NaN])
      expect(await save({ pulseEveryDays: days }), String(days)).toEqual({
        ok: false,
        error: "invalid",
        reason: "pulse_days",
      });
    for (const cap of [-1, 11, 1.5])
      expect(await save({ correctionCap: cap }), String(cap)).toEqual({
        ok: false,
        error: "invalid",
        reason: "correction_cap",
      });
    expect(entries()).toHaveLength(0);
    expect(await save({ pulseEveryDays: 1 })).toEqual({ ok: true });
    expect(await save({ pulseEveryDays: 30 })).toEqual({ ok: true });
    expect(await save({ correctionCap: 0 })).toEqual({ ok: true });
    expect(settingsOf(ACQ).pulseEveryDays).toBe(30);
    expect(capOf(ACQ)).toBe(0);
  });

  it("il pulse senza discovery è rifiutato; spegnerli insieme passa", async () => {
    setSessionPersonId(LAURA);
    const input = automationsOf(ACQ);
    input.switches.backlogDiscovery = false;
    expect(await projectSettings.saveProjectAutomations(ACQ, input)).toEqual({
      ok: false,
      error: "invalid",
      reason: "pulse_needs_backlog",
    });
    expect(settingsOf(ACQ).switches.backlogDiscovery).toBe(true);
    input.switches.pulse = false;
    expect(await projectSettings.saveProjectAutomations(ACQ, input)).toEqual({ ok: true });
    expect(settingsOf(ACQ).switches).toMatchObject({ backlogDiscovery: false, pulse: false });
    const changed = entries("project.switch_changed").map((e) => e.params.switch);
    expect(changed.sort()).toEqual(["backlogDiscovery", "pulse"]);
  });

  it("un interruttore sconosciuto o mancante è invalid", async () => {
    setSessionPersonId(LAURA);
    const input = automationsOf(ACQ);
    delete (input.switches as Partial<Record<ProjectSwitch, boolean>>).pulse;
    expect(await projectSettings.saveProjectAutomations(ACQ, input)).toEqual({
      ok: false,
      error: "invalid",
      reason: "switches",
    });
  });
});

describe("Usage del progetto", () => {
  const range = { days: 90 } as const;

  it("i totali di ACQ sono la riga di ACQ di getUsage (Roberta, per progetto)", async () => {
    setSessionPersonId(ROBERTA);
    const all = await instance.getUsage({ range, groupBy: "project" });
    const row = all.rows.find((r) => r.key === ACQ)!;
    expect(row.runs).toBeGreaterThan(0);
    const mine = await projectSettings.getProjectUsage(ACQ, { range, groupBy: "model" });
    expect(mine!.totals.costUsd).toBe(row.costUsd);
    expect(mine!.totals.runs).toBe(row.runs);
    expect(mine!.totals.inputTokens + mine!.totals.outputTokens).toBe(row.tokens);
    expect(mine!.rows.reduce((a, r) => a + r.runs, 0)).toBe(row.runs);
    expect(mine!.byDay.reduce((a, d) => a + d.runs, 0)).toBe(row.runs);
  });

  it("Laura (project.usage.view in ACQ, senza usage.view d'istanza) legge ACQ", async () => {
    setSessionPersonId(LAURA);
    await expect(instance.getUsage({ range, groupBy: "model" })).rejects.toThrow("forbidden");
    const mine = await projectSettings.getProjectUsage(ACQ, { range, groupBy: "operation" });
    expect(mine!.totals.runs).toBeGreaterThan(0);
  });

  it("Sara senza project.usage.view → forbidden; un progetto invisibile → null", async () => {
    setSessionPersonId(SARA);
    await expect(projectSettings.getProjectUsage(ACQ, { range, groupBy: "model" })).rejects.toThrow(
      "forbidden",
    );
    expect(await projectSettings.getProjectUsage(AUD, { range, groupBy: "model" })).toBeNull();
    setSessionPersonId(ROBERTA);
    expect(await projectSettings.getProjectUsage(RNC, { range, groupBy: "model" })).toBeNull();
  });

  it("RNC archiviato non ha una riga sua nell'Usage d'istanza di Roberta (P12)", async () => {
    instance.recordUsage({
      at: now(),
      operation: "fix_plan",
      model: "claude-sonnet-4-5",
      projectId: RNC,
      providerId: "prv-team-max",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      costUsd: 0.01,
      conversationId: null,
    });
    setSessionPersonId(ROBERTA);
    const all = await instance.getUsage({ range, groupBy: "project" });
    expect(all.rows.some((r) => r.key === RNC || r.code === "RNC")).toBe(false);
    expect(all.rows.some((r) => r.key === "other")).toBe(true);
  });
});
