import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  automations,
  getTaskWork,
  projectSettings,
  releases,
  resetApi,
  setLatency,
  startRun,
} from "../api";
import { markReauthenticated } from "../auth/reauth";
import { setSessionPersonId } from "../session";
import { now, state } from "../store";
import type { AutomationFlow } from "../types";
import { grantInstancePermission, resetViewerGrants } from "../viewer";

// Gli effetti delle impostazioni di progetto nel resto dell'app (area 9c,
// Task 6), livello dati: gli interruttori come li legge chi guarda, l'account
// e le skill scritti alla nascita della sessione, il tetto delle correzioni,
// le automazioni generali verso un progetto non più disponibile. Persone
// del seme: Roberta (full admin), Laura (Project Lead in ACQ e AUD), Sara
// (Contributor in ACQ). AUD lavora solo con «Backup Max».

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const SARA = "p-sara";
const PAOLO = "p-paolo";
const ACQ = "prj-acq";
const AUD = "prj-aud";
const STW = "prj-stw";
const MKX = "prj-mkx";
const RNC = "prj-rnc";

const as = (personId: string) => setSessionPersonId(personId);
const backupMax = () => state.instance.providers.find((p) => p.id === "prv-backup-max")!;
const limit = () => {
  const p = backupMax();
  p.quota = { ...p.quota!, limitedUntil: new Date(Date.parse(now()) + 86_400_000).toISOString() };
};
/** Una task aperta del progetto, senza lavoro di Claude. */
const readyTask = (projectId: string) =>
  state.tasks.find((t) => t.projectId === projectId && t.claude === "none" && t.closedAt === null)!;
const conversation = (id: string) => state.conversations.find((c) => c.id === id)!;
const automationsInput = (projectId: string) => {
  const s = state.projectSettings.get(projectId)!;
  return {
    switches: { ...s.switches },
    pulseEveryDays: s.pulseEveryDays,
    correctionCap: state.projectsById.get(projectId)!.correctionCap ?? 3,
  };
};

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  resetApi();
});

describe("gli interruttori come li legge chi guarda (useProjectSwitches)", () => {
  it("STW acceso, MKX col brief spento, CBV col pulse spento", async () => {
    as(ROBERTA);
    expect(await projectSettings.getProjectSwitches(STW)).toMatchObject({
      weeklyBrief: true,
      docsNightly: true,
      pulse: true,
    });
    expect((await projectSettings.getProjectSwitches(MKX))?.weeklyBrief).toBe(false);
    expect((await projectSettings.getProjectSwitches("prj-cbv"))?.pulse).toBe(false);
  });

  it("dopo saveProjectAutomations la lettura dice lo stato nuovo", async () => {
    as(ROBERTA);
    const input = automationsInput(STW);
    input.switches.weeklyBrief = false;
    expect(await projectSettings.saveProjectAutomations(STW, input)).toEqual({ ok: true });
    expect((await projectSettings.getProjectSwitches(STW))?.weeklyBrief).toBe(false);
  });

  it("un progetto invisibile, archiviato o inesistente risponde null (R-G5)", async () => {
    as(PAOLO);
    expect(await projectSettings.getProjectSwitches(ACQ)).toBeNull();
    as(SARA);
    expect(await projectSettings.getProjectSwitches(ACQ)).not.toBeNull();
    as(ROBERTA);
    expect(await projectSettings.getProjectSwitches(RNC)).toBeNull();
    expect(await projectSettings.getProjectSwitches("prj-nope")).toBeNull();
  });
});

describe("l'account e le skill scritti alla nascita della sessione", () => {
  it("AUD: la sessione nasce con Backup Max, l'esclusività e le skill del progetto", async () => {
    as(LAURA);
    const c = await startRun(readyTask(AUD).id);
    expect(c.provider).toMatchObject({ kind: "account", name: "Backup Max" });
    expect(c.requiredProvider).toEqual({ name: "Backup Max" });
    // AUD ha `test-driven-development` spenta: non entra; il plugin base c'è sempre.
    const names = c.skills!.map((s) => `${s.plugin}:${s.skill}`);
    expect(names).not.toContain("superpowers:test-driven-development");
    expect(names).toContain("superpowers:brainstorming");
    expect(names).toContain("stubwise:start");
    expect(Object.keys(c.skills![0]!).sort()).toEqual(["plugin", "skill"]);
  });

  it("Backup Max al limite: nessun account, e l'esclusività resta anche dopo averla tolta (P16)", async () => {
    limit();
    as(LAURA);
    const c = await startRun(readyTask(AUD).id);
    expect(c.provider).toBeNull();
    expect(c.requiredProvider).toEqual({ name: "Backup Max" });
    as(ROBERTA);
    await projectSettings.setProjectAi(AUD, { providerId: "prv-backup-max", exclusive: false });
    expect(conversation(c.id).requiredProvider).toEqual({ name: "Backup Max" });
    as(LAURA);
    const work = await getTaskWork(c.taskId!);
    expect(work!.runs.at(-1)).toMatchObject({
      provider: null,
      requiredProvider: { name: "Backup Max" },
    });
  });

  it("senza esclusività: requiredProvider null", async () => {
    as(LAURA);
    const c = await startRun(readyTask(ACQ).id);
    expect(c.requiredProvider).toBeNull();
    expect(c.provider).toMatchObject({ name: "Team Max" });
  });

  it("brainstorming spenta su STW: la sessione nuova non la elenca, quella di prima sì", async () => {
    as(ROBERTA);
    const before = await startRun(readyTask(STW).id);
    expect(before.skills!.some((s) => s.skill === "brainstorming")).toBe(true);
    const plugins = await projectSettings.getProjectPlugins(STW);
    const saved = await projectSettings.saveProjectPlugins(STW, {
      version: plugins!.version,
      disabled: [{ plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] }],
    });
    expect(saved.ok).toBe(true);
    const after = await startRun(
      state.tasks.find(
        (t) =>
          t.projectId === STW && t.claude === "none" && t.closedAt === null && t.id !== before.taskId,
      )!.id,
    );
    expect(after.skills!.some((s) => s.skill === "brainstorming")).toBe(false);
    expect(conversation(before.id).skills!.some((s) => s.skill === "brainstorming")).toBe(true);
    // La task lo legge com'era alla nascita, campo per campo (P17).
    const work = await getTaskWork(before.taskId!);
    expect(work!.runs.at(-1)!.skills!.some((s) => s.skill === "brainstorming")).toBe(true);
  });

  it("una sessione del seme non ha skills: nessuna riga da mostrare", async () => {
    as(LAURA);
    const work = await getTaskWork("t-aud-3");
    expect(work!.runs.at(-1)!.skills).toBeNull();
  });
});

describe("il tetto delle correzioni (capOf, nessun codice nuovo)", () => {
  // Nel seme STW non ha PR di colleghi con giri automatici: la prova è su
  // AUD, la cui #246 ha già un giro automatico e problemi aperti.
  const pr = async (id: string) => (await releases.listOpenPrs(AUD)).find((p) => p.id === id)!;

  it("tetto 1: la PR con un giro si legge al tetto; tetto 0: il ciclo automatico non parte", async () => {
    as(ROBERTA);
    expect((await pr("opr-aud-246")).prState).toMatchObject({ state: "issues", canAutoCorrect: true });
    await projectSettings.saveProjectAutomations(AUD, { ...automationsInput(AUD), correctionCap: 1 });
    expect((await pr("opr-aud-246")).prState).toMatchObject({
      state: "capped",
      canAutoCorrect: false,
    });

    await projectSettings.saveProjectAutomations(AUD, { ...automationsInput(AUD), correctionCap: 0 });
    for (const p of await releases.listOpenPrs(AUD)) expect(p.prState.canAutoCorrect).toBe(false);
    const before = (await pr("opr-aud-246")).corrections.length;
    await releases.simulateAuthorPush("opr-aud-246");
    await releases.advancePrWork("opr-aud-246");
    await releases.advancePrWork("opr-aud-246");
    expect((await pr("opr-aud-246")).corrections.length).toBe(before);
  });
});

describe("automazione generale verso un progetto non più disponibile ([PX 5], P18)", () => {
  const flowInto = (projectId: string): AutomationFlow => ({
    trigger: { kind: "manual" },
    steps: [
      { id: "n", kind: "notify", who: { personId: ROBERTA }, text: "Before", approval: { mode: "auto" } },
      {
        id: "t",
        kind: "createTask",
        title: "From the general one",
        description: "",
        assignee: null,
        dueInDays: null,
        project: { mode: "fixed", projectId },
        milestoneRef: null,
        approval: { mode: "auto" },
      },
    ],
    titleTemplate: "Into the project",
  });

  async function generalInto(projectId: string) {
    as(ROBERTA);
    const a = await automations.createAutomation({
      name: "Into the project",
      projectId: null,
      flow: flowInto(projectId),
    });
    await automations.activate(a.id);
    return a.id;
  }

  it("ACQ archiviato: il passo non si fa, la ragione è «progetto non disponibile», Needs attention", async () => {
    const id = await generalInto(ACQ);
    as(LAURA);
    await projectSettings.archiveProject(ACQ);
    as(ROBERTA);
    const runId = await automations.startManual(id);
    await automations.whenAutomationsIdle();
    const run = state.automationRuns.find((r) => r.id === runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("project_unavailable");
    const failed = run.log.find((e) => e.outcome === "failed")!;
    expect(failed.why).toEqual({ code: "projectUnavailable" });
    expect(JSON.stringify(run.log)).not.toContain("Permesso perso");
    expect(state.tasks.some((t) => t.title === "From the general one")).toBe(false);
    const mine = await automations.listMyRuns();
    expect(mine.find((r) => r.id === runId)?.concern).toBe("failed");
  });

  it("il flusso letto marca il passo come non disponibile, senza id (archiviato e invisibile)", async () => {
    const id = await generalInto(ACQ);
    as(LAURA);
    await projectSettings.archiveProject(ACQ);
    as(ROBERTA);
    const row = (await automations.getAutomation(id))!.automation;
    const step = row.versions.at(-1)!.flow.steps[1] as { project: unknown };
    expect(step.project).toEqual({ mode: "fixed", projectId: "", unavailable: true });
  });

  it("un passo su un progetto che chi legge non vede: marcato; uno visibile no", async () => {
    const id = await generalInto(ACQ);
    const stepOf = async () =>
      ((await automations.getAutomation(id))!.automation.versions.at(-1)!.flow.steps[1] as { project: unknown })
        .project;
    as(ROBERTA);
    expect(await stepOf()).toEqual({ mode: "fixed", projectId: ACQ });
    // Paolo (il proprietario, adesso) non vede ACQ: lo legge come non disponibile, senza id.
    state.automations.find((a) => a.id === id)!.ownerId = PAOLO;
    grantInstancePermission(PAOLO, "automations.general.manage");
    as(PAOLO);
    expect(await stepOf()).toEqual({ mode: "fixed", projectId: "", unavailable: true });
  });

  it("RNC eliminato: il passo resta senza progetto e marcato; l'esecuzione dice la stessa ragione", async () => {
    const id = await generalInto(ACQ);
    // Il passo punta a RNC (archiviato nel seme), poi RNC si elimina.
    const a = state.automations.find((x) => x.id === id)!;
    for (const v of a.versions)
      (v.flow.steps[1] as { project: { mode: "fixed"; projectId: string } }).project.projectId =
        RNC;
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    expect(await projectSettings.deleteProject(RNC, { confirmCode: "RNC" })).toEqual({ ok: true });
    const stored = a.versions.at(-1)!.flow.steps[1] as { project: unknown };
    expect(stored.project).toEqual({ mode: "fixed", projectId: "", unavailable: true });
    const runId = await automations.startManual(id);
    await automations.whenAutomationsIdle();
    const run = state.automationRuns.find((r) => r.id === runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("project_unavailable");
  });

  it("salvare il flusso letto non scrive il segno nello stato, e il progetto nascosto torna", async () => {
    const id = await generalInto(ACQ);
    as(LAURA);
    await projectSettings.archiveProject(ACQ);
    as(ROBERTA);
    const row = (await automations.getAutomation(id))!.automation;
    const flow = row.versions.at(-1)!.flow;
    await automations.saveDraft(id, flow);
    const stored = state.automations.find((a) => a.id === id)!.versions.at(-1)!.flow.steps[1] as {
      project: unknown;
    };
    expect(stored.project).toEqual({ mode: "fixed", projectId: ACQ });
  });
});
