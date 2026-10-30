import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  automations,
  createConversation,
  drive,
  getConversation,
  getTaskWork,
  instance,
  listProjectPulses,
  listProjects,
  relaunchWithInstructions,
  releases,
  requestChanges,
  resetApi,
  resumeCorrection,
  sendMessage,
  servers,
  setLatency,
  startRun,
  stop,
  stopAndSend,
} from "../api";
import { whenAutomationsIdle } from "../automations/runner";
import { whenAnalysesIdle } from "../servers/analysis";
import { setSessionPersonId } from "../session";
import { eventsOf, state } from "../store";
import { runScript, whenIdle } from "../stream";
import type { AutomationFlow } from "../types";
import {
  grantInstancePermission,
  resetViewerGrants,
  type LocalInstancePermission,
} from "../viewer";
import { aiBlockFor } from "./blocks";
import { dropHeld, heldJobs, holdJob } from "./queue";

// Gli effetti delle impostazioni d'istanza nelle altre aree (area 9b, Task
// 6), dal livello dati: il budget del mese esaurito rifiuta gli avvii di
// Claude, la coda in pausa li fa aspettare (una volta sola, alla ripresa),
// il modello di Models e l'account della catena valgono per le sessioni
// nuove e per i loro consumi, i passi d'automazione aspettano senza
// fallire, i caricamenti si spengono con l'archiviazione. Persone del seme:
// Roberta (full admin), Laura (Project Lead in STW e ACQ), Marco (Developer
// in ACQ). Nel seme la coda di STW è in pausa da Roberta.

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const STW = "prj-stw";
const ACQ = "prj-acq";

const as = (personId: string) => setSessionPersonId(personId);
const conv = (id: string) => state.conversations.find((c) => c.id === id)!;

async function settle(id: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await whenIdle(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  as(ROBERTA);
});
afterEach(() => resetApi());

describe("budget del mese esaurito", () => {
  it("«Start» rifiutato con monthly_budget e detto prima; il lavoro partito finisce; alzato, riparte", async () => {
    as(LAURA);
    const running = await startRun("t-acq-3");
    as(ROBERTA);
    expect(await instance.simulateBudgetReached(true)).toEqual({ ok: true });

    // Il lavoro già partito finisce.
    await settle(running.id);
    expect(conv(running.id).state).not.toBe("working");

    as(LAURA);
    const work = await getTaskWork("t-acq-1");
    expect(work!.blocked).toEqual({ reason: "monthly_budget" });
    const before = state.conversations.length;
    await expect(startRun("t-acq-1")).rejects.toThrow("invalid: monthly_budget");
    expect(state.conversations.length).toBe(before);

    as(ROBERTA);
    await instance.simulateBudgetReached(false);
    as(LAURA);
    expect((await getTaskWork("t-acq-1"))!.blocked).toBeNull();
    expect((await startRun("t-acq-1")).state).toBe("working");
  });

  it("anche Rilancia, Chiedi modifiche, Riprendi la correzione e la correzione di un server", async () => {
    state.instance.queuePauses = [];
    await instance.simulateBudgetReached(true);
    as(LAURA);
    await expect(relaunchWithInstructions("t-aud-4", "Go")).rejects.toThrow();
    as("p-marco");
    await expect(relaunchWithInstructions("t-aud-4", "Go")).rejects.toThrow(
      "invalid: monthly_budget",
    );
    as(LAURA);
    await runScript("cv-run-stw-3", [{ step: "state", state: "finished", outcome: "ok" }]);
    await expect(requestChanges("t-stw-3", "Rename it")).rejects.toThrow("invalid: monthly_budget");
    // Una correzione ferma: «Riprendi la correzione» segue la stessa regola (ruling 13).
    const stw3 = conv("cv-run-stw-3");
    stw3.state = "paused";
    state.conversationEvents.get(stw3.id)!.push({
      id: "e-corr",
      at: stw3.updatedAt,
      type: "phase",
      phase: "correction",
      outcome: "stopped",
    });
    await expect(resumeCorrection("t-stw-3")).rejects.toThrow("invalid: monthly_budget");
    // La correzione di un server (ACQ-6, la diagnosi di SRV-1).
    as(ROBERTA);
    const before = state.conversations.length;
    await expect(servers.startServerFix("t-acq-srv-1")).rejects.toThrow("invalid: monthly_budget");
    expect(state.conversations.length).toBe(before);
  });

  it("«Chiedi a Claude» rifiuta il messaggio; la coda in pausa invece non la tocca", async () => {
    const c = await createConversation({ contextProjectId: STW });
    await sendMessage(c.id, { text: "What is STW about?" });
    await settle(c.id);
    expect(eventsOf(c.id).some((e) => e.type === "assistant")).toBe(true);

    await instance.simulateBudgetReached(true);
    const count = eventsOf(c.id).length;
    await expect(sendMessage(c.id, { text: "And then?" })).rejects.toThrow(
      "invalid: monthly_budget",
    );
    expect(eventsOf(c.id)).toHaveLength(count);
  });
});

describe("coda in pausa (STW)", () => {
  it("«Start» non è rifiutato: la sessione aspetta senza eventi, un secondo è conflict, alla ripresa parte e arriva il piano", async () => {
    const work = await getTaskWork("t-stw-7");
    expect(work!.blocked).toMatchObject({ reason: "queue_paused", byName: "Roberta Fontana" });
    expect(work!.actions.start).toBe("allowed");

    const run = await startRun("t-stw-7");
    expect(run.waiting).toMatchObject({ reason: "queue_paused", byName: "Roberta Fontana" });
    expect(eventsOf(run.id)).toEqual([]);
    const waiting = (await getTaskWork("t-stw-7"))!.runs.at(-1)!;
    expect(waiting).toMatchObject({ id: run.id, waiting: { reason: "queue_paused" } });
    await expect(startRun("t-stw-7")).rejects.toThrow("conflict");
    expect(heldJobs().filter((h) => h.conversationId === run.id)).toHaveLength(1);

    await instance.resumeQueue(STW);
    await settle(run.id);
    expect(conv(run.id).waiting).toBeNull();
    expect(eventsOf(run.id).some((e) => e.type === "plan")).toBe(true);
  });

  it("ruling 14: Stop su una sessione in attesa la toglie dalla fila e non parte alla ripresa", async () => {
    const run = await startRun("t-stw-7");
    await stop(run.id);
    expect(heldJobs()).toEqual([]);
    expect(conv(run.id)).toMatchObject({ state: "finished", outcome: "stopped", waiting: null });
    await instance.resumeQueue(STW);
    await settle(run.id);
    expect(eventsOf(run.id).some((e) => e.type === "plan")).toBe(false);
    // Fermata prima di girare: nessun consumo.
    expect(state.instance.usage.some((u) => u.conversationId === run.id)).toBe(false);
  });

  it("Retry dello Stato dell'istanza con STW in pausa: il lavoro aspetta la ripresa (shape EF)", async () => {
    const result = await instance.retryJob("cv-run-stw-7");
    expect(result).toMatchObject({ ok: true });
    const id = (result as { conversationId: string }).conversationId;
    expect(conv(id).waiting).toMatchObject({ reason: "queue_paused" });
    const status = await instance.getInstanceStatus();
    expect(status.jobs.find((j) => j.id === id)).toMatchObject({
      state: "waiting",
      waiting: { reason: "queue_paused" },
    });
    await instance.resumeQueue(STW);
    await settle(id);
    expect(eventsOf(id).some((e) => e.type === "plan")).toBe(true);
  });
});

describe("modello e account delle sessioni nuove", () => {
  it("setModel(fix_plan, haiku), poi «Start»: la sessione dice Haiku e i consumi lo contano", async () => {
    expect(await instance.setModel("fix_plan", "haiku")).toEqual({ ok: true });
    as(LAURA);
    const run = await startRun("t-acq-1");
    expect(run).toMatchObject({
      model: "claude-haiku-5-5",
      provider: { kind: "account", name: "Team Max", id: "prv-team-max" },
    });
    expect((await getTaskWork("t-acq-1"))!.runs.at(-1)!.model).toBe("claude-haiku-5-5");
    await settle(run.id);
    expect(conv(run.id).state).toBe("finished");

    const usage = (await getTaskWork("t-acq-1"))!.usage;
    expect(usage.map((u) => u.model)).toContain("claude-haiku-5-5");
    as(ROBERTA);
    const byModel = await instance.getUsage({ range: { days: 7 }, groupBy: "model" });
    expect(byModel.rows.find((r) => r.key === "claude-haiku-5-5")).toMatchObject({ runs: 1 });
    expect(
      state.instance.usage.filter((u) => u.conversationId === run.id).map((u) => u.operation),
    ).toEqual(["fix_plan", "fix_execute"]);
  });

  it("Team Max disabilitato: una sessione nuova gira con Backup Max", async () => {
    expect(await instance.setProviderEnabled("prv-team-max", false)).toEqual({ ok: true });
    as(LAURA);
    const run = await startRun("t-acq-1");
    expect(run.provider).toMatchObject({ name: "Backup Max", id: "prv-backup-max" });
  });

  it("ruling 11: senza un account libero la sessione parte con provider null, senza attese", async () => {
    for (const p of state.instance.providers) p.enabled = false;
    as(LAURA);
    const run = await startRun("t-acq-1");
    expect(run).toMatchObject({ provider: null, state: "working" });
    expect(run.waiting ?? null).toBeNull();
  });
});

/** Un'automazione di `projectId`, a mano, con un solo passo: Claude. */
async function claudeAutomation(projectId: string | null): Promise<string> {
  const flow: AutomationFlow = {
    trigger: { kind: "manual" },
    titleTemplate: "Prova",
    steps: [
      {
        id: "c-classify",
        kind: "claude",
        instruction: "Classifica la richiesta.",
        inputs: ["avvio.data"],
        outcomes: ["bug", "funzionalità"],
        fields: [],
        branches: {},
      },
    ],
  };
  const a = await automations.createAutomation({ name: "Prova", projectId, flow });
  await automations.activate(a.id);
  const runId = await automations.startManual(a.id);
  await whenAutomationsIdle();
  return runId;
}

const runOf = (id: string) => state.automationRuns.find((r) => r.id === id)!;

describe("i passi d'automazione che avvierebbero Claude", () => {
  it("STW in pausa: l'esecuzione aspetta la ripresa, poi finisce", async () => {
    const id = await claudeAutomation(STW);
    expect(runOf(id).status).toBe("running");
    expect(runOf(id).log.at(-1)).toMatchObject({
      outcome: "waiting",
      why: { code: "aiQueuePaused" },
    });
    await instance.resumeQueue(STW);
    await whenAutomationsIdle();
    expect(runOf(id).status).toBe("done");
  });

  it("ACQ col budget esaurito: ferma al passo, fra i lavori fermi per budget; il tempo non la sblocca; alzato il budget riparte una volta e finisce", async () => {
    await instance.simulateBudgetReached(true);
    const id = await claudeAutomation(ACQ);
    const run = runOf(id);
    expect(run.status).toBe("running");
    expect(run.log.filter((e) => e.outcome === "waiting")).toHaveLength(1);
    expect(run.log.at(-1)).toMatchObject({ outcome: "waiting", why: { code: "aiBudget" } });
    const status = await instance.getInstanceStatus();
    expect(status.jobs.find((j) => j.id === id)).toMatchObject({
      kind: "automation",
      state: "waiting",
      waiting: { reason: "monthly_budget" },
    });

    // «Fai passare il tempo» non la muove, né aggiunge righe.
    await automations.advanceTime(id, 2);
    await whenAutomationsIdle();
    expect(runOf(id).status).toBe("running");
    expect(runOf(id).log.filter((e) => e.outcome === "waiting")).toHaveLength(1);
    expect(heldJobs().filter((h) => h.automationRunId === id)).toHaveLength(1);
    // Un salvataggio che non libera il budget non la muove.
    await instance.saveBudget({ monthlyUsd: 600, contentLanguage: "it" });
    await whenAutomationsIdle();
    expect(runOf(id).status).toBe("running");

    await instance.simulateBudgetReached(false);
    await whenAutomationsIdle();
    expect(runOf(id).status).toBe("done");
    expect(runOf(id).log.filter((e) => e.outcome === "resumed")).toHaveLength(1);
    expect(heldJobs()).toEqual([]);
  });
});

describe("revisione finale: un'automazione generale ferma", () => {
  afterEach(() => resetViewerGrants());
  const AUD = "prj-aud";
  const SARA = "p-sara";

  it("I2: col budget raggiunto non è «un progetto che non vedi»: chi vede l'automazione la legge fra i lavori", async () => {
    await instance.simulateBudgetReached(true);
    const id = await claudeAutomation(null);
    expect(runOf(id).status).toBe("running");
    const view = await instance.getInstanceStatus();
    expect(view.otherProjects).toBeNull();
    expect(view.jobs.find((j) => j.id === id)).toMatchObject({
      kind: "automation",
      state: "waiting",
      projectId: null,
      waiting: { reason: "monthly_budget" },
    });
    // Sara (solo lo Stato) non vede l'automazione generale: né riga né conteggio.
    grantInstancePermission(SARA, "instance.status.view" as LocalInstancePermission);
    as(SARA);
    const hers = await instance.getInstanceStatus();
    expect(hers.jobs.some((j) => j.id === id)).toBe(false);
    expect(hers.otherProjects?.waiting ?? 0).toBe(0);
  });

  it("M3: ferma per la pausa di un progetto che chi guarda non vede: né codice né nome di chi l'ha messa", async () => {
    await instance.simulateBudgetReached(true);
    const id = await claudeAutomation(null);
    // Ha già agito in AUD, e lì la coda è in pausa (Roberta).
    dropHeld(id);
    await instance.simulateBudgetReached(false);
    await instance.pauseQueue(AUD);
    runOf(id).projectIds = [AUD];
    holdJob({
      projectId: AUD,
      kind: "automation",
      taskId: null,
      conversationId: null,
      automationRunId: id,
      starterId: ROBERTA,
      block: aiBlockFor(AUD)!,
      start: async () => {},
    });
    expect((await automations.getRun(id))!).toMatchObject({
      aiWaiting: { reason: "queue_paused", byId: ROBERTA },
      aiWaitingCode: "AUD",
    });
    // Sara gestisce le automazioni d'istanza ma non vede AUD (R-G5).
    grantInstancePermission(SARA, "automations.manage" as LocalInstancePermission);
    as(SARA);
    const run = (await automations.getRun(id))!;
    expect(run.aiWaiting ?? null).toBeNull();
    expect(JSON.stringify(run)).not.toContain("Roberta");
    expect(run.aiWaitingCode ?? null).toBeNull();
  });
});

// --- giro di correzione 1 (task-6-review.md) -----------------------------------

const planPhases = (id: string) =>
  eventsOf(id).filter((e) => e.type === "phase" && e.phase === "plan" && e.outcome === null);

describe("I1: una sessione in attesa della coda non si scrive", () => {
  it("sendMessage e stopAndSend rifiutati, nessun evento di Claude; alla ripresa una sola fase plan", async () => {
    const run = await startRun("t-stw-7");
    const detail = (await getConversation(run.id))!;
    expect(detail).toMatchObject({
      canWrite: false,
      canInterrupt: true,
      readOnlyReason: "waiting",
    });
    await expect(sendMessage(run.id, { text: "Hurry up" })).rejects.toThrow("invalid: waiting");
    await expect(stopAndSend(run.id, "Do it now")).rejects.toThrow("invalid: waiting");
    expect(eventsOf(run.id)).toEqual([]);
    expect(conv(run.id).waiting).toMatchObject({ reason: "queue_paused" });

    await instance.resumeQueue(STW);
    await settle(run.id);
    expect(planPhases(run.id)).toHaveLength(1);
    expect(eventsOf(run.id).filter((e) => e.type === "user")).toEqual([]);
  });
});

describe("⚠️3: coda ripresa col budget esaurito, poi budget alzato", () => {
  it("la sessione aspetta il budget, poi parte una volta sola", async () => {
    const run = await startRun("t-stw-7");
    await instance.simulateBudgetReached(true);
    await instance.resumeQueue(STW);
    await settle(run.id);
    expect(conv(run.id).waiting).toEqual({ reason: "monthly_budget" });
    expect(eventsOf(run.id)).toEqual([]);
    await instance.simulateBudgetReached(false);
    await settle(run.id);
    await instance.simulateBudgetReached(false);
    await settle(run.id);
    expect(conv(run.id).waiting).toBeNull();
    expect(planPhases(run.id)).toHaveLength(1);
    expect(heldJobs()).toEqual([]);
  });
});

describe("la storia e lo stato di una sessione che ha aspettato", () => {
  it("la task dice «waiting», poi «working»; la sessione ricorda chi ha ripreso la coda", async () => {
    const run = await startRun("t-stw-7");
    expect(state.tasksById.get("t-stw-7")!.claude).toBe("waiting");
    expect((await getTaskWork("t-stw-7"))!.runs.at(-1)!.queued).toEqual({
      resumedById: null,
      resumedAt: null,
    });
    await instance.resumeQueue(STW);
    await settle(run.id);
    expect(state.tasksById.get("t-stw-7")!.claude).not.toBe("waiting");
    expect((await getTaskWork("t-stw-7"))!.runs.at(-1)!.queued).toEqual({
      resumedById: ROBERTA,
      resumedAt: expect.any(String),
    });
  });

  it("all'esecuzione la sessione scrive il modello di fix_execute (se diverso, la storia lo dice)", async () => {
    await instance.setModel("fix_plan", "opus");
    await instance.setModel("fix_execute", "sonnet");
    as(LAURA);
    const run = await startRun("t-acq-1");
    await settle(run.id);
    const latest = (await getTaskWork("t-acq-1"))!.runs.at(-1)!;
    expect(latest).toMatchObject({ model: "claude-opus-5-5", executionModel: "claude-sonnet-5-5" });
  });
});

describe("la pausa si legge da sola, anche col budget raggiunto", () => {
  it("getQueuePause dice chi e da quando; un progetto che non si vede risponde null", async () => {
    await instance.simulateBudgetReached(true);
    expect(await instance.getQueuePause(STW)).toMatchObject({
      byId: ROBERTA,
      byName: "Roberta Fontana",
    });
    expect(await instance.getQueuePause(ACQ)).toBeNull();
    as("p-chiara");
    expect(await instance.getQueuePause(STW)).toBeNull();
  });

  it("il polso e il progetto dicono che Claude aspetta, col blocco", async () => {
    await startRun("t-stw-7");
    const pulse = (await listProjectPulses()).find((p) => p.projectId === STW)!;
    expect(pulse.claudeWaiting).toMatchObject({
      reason: "queue_paused",
      byName: "Roberta Fontana",
    });
    const stw = (await listProjects()).find((p) => p.id === STW)!;
    expect(stw.signals.claudeWaiting).toMatchObject({ reason: "queue_paused" });
    expect(
      (await listProjectPulses()).find((p) => p.projectId === ACQ)!.claudeWaiting ?? null,
    ).toBeNull();
  });
});

describe("I2 e i due blocchi delle automazioni", () => {
  it("annullata mentre aspetta: esce dalla fila e non si legge più «in attesa»", async () => {
    await instance.simulateBudgetReached(true);
    const id = await claudeAutomation(ACQ);
    expect(heldJobs()).toHaveLength(1);
    await automations.cancelRun(id);
    expect(heldJobs()).toEqual([]);
    const view = await automations.getRun(id);
    expect(view?.status).toBe("cancelled");
    expect(view?.aiWaiting ?? null).toBeNull();
    await instance.simulateBudgetReached(false);
    await whenAutomationsIdle();
    expect(runOf(id).status).toBe("cancelled");
  });

  it("automazione messa in pausa mentre aspetta: sospesa, fuori dalla fila", async () => {
    await instance.simulateBudgetReached(true);
    const id = await claudeAutomation(ACQ);
    const a = state.automations.find((x) => x.id === runOf(id).automationId)!;
    await automations.pause(a.id);
    expect(runOf(id).status).toBe("suspended");
    expect(heldJobs()).toEqual([]);
  });

  it("budget di nuovo disponibile ma coda in pausa: il registro lo dice, poi la ripresa la fa finire", async () => {
    await instance.simulateBudgetReached(true);
    const id = await claudeAutomation(STW);
    expect(runOf(id).log.at(-1)).toMatchObject({ why: { code: "aiBudget" } });
    await instance.simulateBudgetReached(false);
    await whenAutomationsIdle();
    expect(runOf(id).status).toBe("running");
    expect(runOf(id).log.at(-1)).toMatchObject({
      outcome: "waiting",
      why: { code: "aiBudgetBackStillQueue", params: { byId: ROBERTA } },
    });
    await instance.resumeQueue(STW);
    await whenAutomationsIdle();
    expect(runOf(id).status).toBe("done");
  });
});

describe("residuo m1: il registro dell'esecuzione e la pausa di un progetto che non si vede", () => {
  afterEach(() => resetViewerGrants());

  it("la riga d'attesa scritta da holdForAi non nomina la pausa né chi l'ha messa a chi non vede il progetto", async () => {
    const AUD = "prj-aud";
    const SARA = "p-sara";
    // Un'automazione generale, ferma per il budget prima di agire.
    await instance.simulateBudgetReached(true);
    const id = await claudeAutomation(null);
    // Poi ha agito in AUD (in pausa da Roberta): al giro dopo aspetta la coda di AUD.
    dropHeld(id);
    await instance.pauseQueue(AUD);
    runOf(id).projectIds = [AUD];
    await instance.simulateBudgetReached(false);
    await automations.advanceTime(id, 1);
    await whenAutomationsIdle();
    const queued = runOf(id).log.filter((e) => e.why?.code === "aiQueuePaused");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason).toContain("Roberta Fontana");

    // Roberta vede AUD: la riga c'è, col nome.
    expect((await automations.getRun(id))!.log.some((e) => e.why?.code === "aiQueuePaused")).toBe(
      true,
    );
    // Sara gestisce le automazioni d'istanza ma non vede AUD.
    grantInstancePermission(SARA, "automations.manage" as LocalInstancePermission);
    as(SARA);
    const run = (await automations.getRun(id))!;
    expect(run.log.some((e) => e.why?.code === "aiQueuePaused")).toBe(false);
    expect(JSON.stringify(run.log)).not.toContain("Roberta");
    expect(JSON.stringify(run.log)).not.toContain(AUD);
  });
});

describe("revisione finale M4: l'avviso e il riquadro dicono perché Claude non guarda", () => {
  const alertBody = (kind: string) =>
    state.notifications.filter(
      (n) => n.id.startsWith("n-alert") && n.kind === kind && n.objectCode === "SRV-1",
    )[0]?.body ?? "";

  it("coda in pausa: l'avviso non dice che Claude sta guardando", async () => {
    await instance.pauseQueue(ACQ);
    await servers.simulateServerRecovery("SRV-1").catch(() => undefined);
    await servers.simulateServerAlert("SRV-1", "memory");
    const body = alertBody("server.trouble");
    expect(body).not.toContain("Claude is looking into it");
    expect(body).toContain("Claude looks into it when ACQ's queue resumes.");
  });

  it("residuo N1 (R-G5): un server in due produzioni: l'avviso all'altro progetto non nomina quello dell'analisi", async () => {
    // SRV-1 anche nella produzione di STW: l'analisi resta in ACQ (il principale).
    state.environments
      .find((e) => e.id === "env-stw-prod")!
      .servers.push({ repositoryId: null, serverCode: "SRV-1", reportedSha: null } as never);
    await instance.pauseQueue(ACQ);
    await servers.simulateServerRecovery("SRV-1").catch(() => undefined);
    await servers.simulateServerAlert("SRV-1", "memory");
    const alerts = state.notifications.filter(
      (n) => n.id.startsWith("n-alert") && n.kind === "server.trouble" && n.objectCode === "SRV-1",
    );
    const toStw = alerts.find((n) => n.projectId === STW)!;
    const toAcq = alerts.find((n) => n.projectId === ACQ)!;
    expect(toAcq.body).toContain("Claude looks into it when ACQ's queue resumes.");
    expect(toStw.body).not.toContain("ACQ");
    expect(toStw.body).toContain("Claude looks into it when the queue resumes.");
  });

  it("budget raggiunto: l'avviso lo dice, e l'episodio ricorda perché non c'è analisi", async () => {
    await instance.simulateBudgetReached(true);
    await servers.simulateServerRecovery("SRV-1").catch(() => undefined);
    await servers.simulateServerAlert("SRV-1", "memory");
    expect(alertBody("server.trouble")).toContain(
      "Claude can't look into it: the monthly AI budget is used up.",
    );
    const episode = (await servers.getServer("SRV-1")).episodes[0]!;
    expect(episode.analysis).toBeNull();
    expect(episode.analysisBlocked).toBe("monthly_budget");
  });
});

describe("l'analisi di un server con la coda in pausa", () => {
  it("nasce in attesa; il dettaglio del server lo dice; alla ripresa parte", async () => {
    await instance.pauseQueue(ACQ);
    await servers.simulateServerRecovery("SRV-1").catch(() => undefined);
    await servers.simulateServerAlert("SRV-1", "agent_silent");
    const detail = await servers.getServer("SRV-1");
    const episode = detail.episodes[0]!;
    expect(episode.analysis?.outcome).toBe("running");
    expect(episode.analysisWaiting).toMatchObject({
      reason: "queue_paused",
      byName: "Roberta Fontana",
    });
    const id = episode.analysis!.conversationId;
    expect(eventsOf(id)).toEqual([]);
    await instance.resumeQueue(ACQ);
    await whenAnalysesIdle();
    expect(eventsOf(id).length).toBeGreaterThan(0);
    expect((await servers.getServer("SRV-1")).episodes[0]!.analysisWaiting ?? null).toBeNull();
  });
});

describe("⚠️1: «Request changes» dai Rilasci col budget esaurito", () => {
  it("risponde monthly_budget, e nessuna correzione nasce", async () => {
    await instance.simulateBudgetReached(true);
    const before = state.conversations.length;
    expect(await releases.requestPrCorrection("opr-aud-248", "Keep 30 days")).toEqual({
      ok: false,
      error: "monthly_budget",
    });
    expect(state.conversations.length).toBe(before);
  });
});

describe("archiviazione spenta", () => {
  it("uploadFiles → storage_off, e niente si carica", async () => {
    expect(await instance.setAttachments(false)).toEqual({ ok: true });
    expect(await instance.getUploadsAllowed()).toBe(false);
    const before = state.driveFiles.length;
    await expect(
      drive.uploadFiles(ACQ, [{ name: "a.pdf", mime: "application/pdf", sizeBytes: 10 }]),
    ).rejects.toThrow("invalid: storage_off");
    expect(state.driveFiles.length).toBe(before);
  });
});
