import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAccess } from "../access/index";
import { changelog, instance, resetApi, setLatency, startRun } from "../api";
import { setSessionPersonId } from "../session";
import { advanceNow, now, state } from "../store";
import { whenIdle } from "../stream";
import {
  grantInstancePermission,
  resetViewerGrants,
  revokeProjectPermission,
  type LocalInstancePermission,
} from "../viewer";
import { aiBlockFor, budgetReached, spentThisMonthUsd } from "./blocks";
import { dropHeld, holdJob, releaseBudgetHolds, type HeldJob } from "./queue";

// La coda e lo Stato dell'istanza (area 9b, Task 5): i blocchi (`aiBlockFor`),
// i lavori fermi (`holdJob`) e quando ripartono, Retry, Pause/Resume e la
// vista dello Stato dell'istanza. Persone del seme: Roberta (full admin),
// Laura (Project Lead in STW e ACQ), Marco (Developer in ACQ: `runs.start`
// senza `plans.approve`), Sara (User: vede STW e ACQ, non AUD né MKX).

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const CHIARA = "p-chiara"; // non è in STW
const ACQ = "prj-acq";
const STW = "prj-stw";
const DAY = 24 * 60 * 60 * 1000;

const as = (personId: string) => setSessionPersonId(personId);
const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);

/** Un lavoro fermo con una `start` che si annota nell'elenco `started`. */
function held(
  started: string[],
  name: string,
  projectId: string,
  extra: Partial<Omit<HeldJob, "id" | "since">> = {},
): HeldJob {
  return holdJob({
    projectId,
    kind: "task_run",
    taskId: projectId === STW ? "t-stw-7" : "t-acq-3",
    conversationId: null,
    automationRunId: null,
    starterId: ROBERTA,
    block: aiBlockFor(projectId)!,
    start: async () => {
      started.push(name);
    },
    ...extra,
  });
}

const status = () => instance.getInstanceStatus();
const waitingOf = async (projectId: string) =>
  (await status()).jobs.filter((j) => j.projectId === projectId && j.state === "waiting");

async function settle(id: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
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

describe("lo Stato dell'istanza del seme", () => {
  it("STW in pausa da Roberta, il lavoro fallito ieri fra gli errori, i due worker, i tre provider", async () => {
    const view = await status();

    const stw = view.queues.find((q) => q.projectId === STW)!;
    expect(stw).toMatchObject({
      code: "STW",
      paused: { byName: "Roberta Fontana", at: state.instance.queuePauses[0]!.at },
      pause: "allowed",
    });
    // In cima le code in pausa, poi quelle con lavori falliti.
    expect(view.queues[0]!.projectId).toBe(STW);

    const acq3 = view.jobs.find((j) => j.id === "cv-run-acq-3")!;
    expect(acq3).toMatchObject({
      kind: "task_run",
      projectCode: "ACQ",
      code: "ACQ-3",
      state: "failed",
      waiting: null,
      workerId: null,
      retry: "allowed",
      href: "#/p/ACQ/tasks?task=ACQ-3",
    });
    expect(view.errors.find((e) => e.jobId === "cv-run-acq-3")).toMatchObject({
      href: "#/p/ACQ/tasks?task=ACQ-3",
      summary: expect.stringContaining("billing export"),
    });
    expect(view.errors.length).toBeLessThanOrEqual(5);

    // I due worker hanno i due lavori in corso più vecchi.
    const running = view.jobs
      .filter((j) => j.state === "running")
      .sort((a, b) => a.since.localeCompare(b.since));
    expect(running.length).toBeGreaterThanOrEqual(2);
    expect(view.workers).toEqual([
      { id: "worker-1", jobId: running[0]!.id, hidden: false },
      { id: "worker-2", jobId: running[1]!.id, hidden: false },
    ]);
    expect(running[0]).toMatchObject({ workerId: "worker-1" });
    expect(running.slice(2).every((j) => j.workerId === null)).toBe(true);
    // La correzione in corso su STW-3 è una correzione, non un'esecuzione.
    expect(view.jobs.find((j) => j.id === "cv-run-stw-3")!.kind).toBe("correction");

    expect(view.quota.map((q) => q.name)).toEqual(["Team Max", "Backup Max", "Billing key"]);
    expect(view.quota[1]!.quota?.band).toBe("near");
    expect(view.otherProjects).toBeNull();
    expect(view.refreshedAt).toBe(now());

    // Il giro notturno della notte scorsa: quattro righe, una fallita.
    expect(view.nightly).toHaveLength(4);
    expect(view.nightly.filter((r) => r.state === "failed")).toHaveLength(1);
  });

  it("si legge con instance.status.view o settings.manage, non senza", async () => {
    as(SARA);
    await expect(status()).rejects.toThrow("forbidden");
    give(SARA, "instance.status.view");
    const view = await status();
    // In sola lettura: le azioni sono spente per permesso.
    expect(view.queues.every((q) => q.pause === "forbidden")).toBe(true);
    expect(view.jobs.filter((j) => j.state === "failed").every((j) => j.retry !== "allowed")).toBe(
      true,
    );
  });

  it("RF 2: chi vede solo alcuni progetti non trova codici né titoli degli altri", async () => {
    give(SARA, "instance.status.view");
    as(SARA);
    const view = await status();
    const text = JSON.stringify(view);
    for (const hidden of ["prj-aud", "prj-mkx", "AUD", "MKX"])
      expect(text, hidden).not.toMatch(new RegExp(`\\b${hidden}\\b`));
    const hiddenTitles = state.conversations
      .filter((c) => c.projectId === "prj-aud" || c.projectId === "prj-mkx")
      .map((c) => c.title);
    expect(hiddenTitles.length).toBeGreaterThan(0);
    for (const title of hiddenTitles) expect(text).not.toContain(title);
    expect(state.instance.nightly.some((r) => r.projectId === "prj-aud")).toBe(true);

    // AUD-5 e MKX-11 sono al lavoro: contati in «Other projects».
    expect(view.otherProjects).toEqual({ running: 2, waiting: 0, failed: 0 });
    // Il worker 2 lavora su AUD-5: occupato, senza dire dove.
    expect(view.workers[1]).toEqual({ id: "worker-2", jobId: null, hidden: true });
    expect(view.workers[0]).toMatchObject({ jobId: "cv-run-stw-3", hidden: false });
  });

  it("i lavori fermi dei progetti invisibili sono solo contati", async () => {
    const started: string[] = [];
    await instance.simulateBudgetReached(true);
    held(started, "aud", "prj-aud", { taskId: null });
    give(SARA, "instance.status.view");
    as(SARA);
    const view = await status();
    expect(view.otherProjects).toEqual({ running: 2, waiting: 1, failed: 0 });
    expect(view.jobs.some((j) => j.state === "waiting")).toBe(false);
  });
});

describe("aiBlockFor", () => {
  it("il budget raggiunto vale ovunque, anche senza progetto", async () => {
    await instance.simulateBudgetReached(true);
    expect(aiBlockFor(null)).toEqual({ reason: "monthly_budget" });
    expect(aiBlockFor(ACQ)).toEqual({ reason: "monthly_budget" });
    // Con entrambi vince il budget (EF 1).
    expect(aiBlockFor(STW)).toEqual({ reason: "monthly_budget" });
  });

  it("la pausa solo in STW, col nome di chi l'ha messa anche dopo averla disattivata", () => {
    const since = state.instance.queuePauses[0]!.at;
    const expected = { reason: "queue_paused", byId: ROBERTA, byName: "Roberta Fontana", since };
    expect(aiBlockFor(STW)).toEqual(expected);
    expect(aiBlockFor(ACQ)).toBeNull();
    expect(aiBlockFor(null)).toBeNull();
    writeAccess((a) => {
      a.people.find((p) => p.personId === ROBERTA)!.status = "deactivated";
    });
    expect(aiBlockFor(STW)).toEqual(expected);
  });
});

describe("Pause e Resume", () => {
  it("chiedono settings.manage su un progetto visibile; una pausa già messa è already_paused", async () => {
    as(LAURA);
    expect(await instance.pauseQueue(ACQ)).toEqual({ ok: false, error: "forbidden" });
    expect(await instance.resumeQueue(STW)).toEqual({ ok: false, error: "forbidden" });
    give(CHIARA, "settings.manage");
    as(CHIARA);
    expect(await instance.resumeQueue(STW)).toEqual({ ok: false, error: "not_found" });
    as(ROBERTA);
    expect(await instance.pauseQueue(STW)).toEqual({
      ok: false,
      error: "invalid",
      reason: "already_paused",
    });
    expect(await instance.resumeQueue(ACQ)).toEqual({
      ok: false,
      error: "invalid",
      reason: "not_paused",
    });
    expect(state.changelog.filter((e) => e.kind.startsWith("queue."))).toEqual([]);

    expect(await instance.pauseQueue(ACQ)).toEqual({ ok: true });
    expect(aiBlockFor(ACQ)).toMatchObject({ reason: "queue_paused", byId: ROBERTA, since: now() });
    expect(await instance.resumeQueue(ACQ)).toEqual({ ok: true });
    expect(aiBlockFor(ACQ)).toBeNull();
  });

  it("RF 3: alla ripresa i lavori fermi partono nell'ordine d'arrivo, ognuno una volta", async () => {
    const started: string[] = [];
    held(started, "first", STW);
    held(started, "second", STW);
    held(started, "acq", ACQ, { block: { reason: "monthly_budget" } });
    expect((await waitingOf(STW)).map((j) => j.waiting)).toEqual([
      aiBlockFor(STW),
      aiBlockFor(STW),
    ]);
    expect((await status()).queues.find((q) => q.projectId === STW)!.waiting).toBe(2);

    expect(await instance.resumeQueue(STW)).toEqual({ ok: true });
    expect(started).toEqual(["first", "second"]);
    expect(await waitingOf(STW)).toEqual([]);
    // Una seconda pausa e ripresa non li fa ripartire.
    await instance.pauseQueue(STW);
    await instance.resumeQueue(STW);
    expect(started).toEqual(["first", "second"]);
  });

  it("RF 3: resetApi prima della ripresa → non parte niente", async () => {
    const started: string[] = [];
    held(started, "first", STW);
    held(started, "second", STW);
    resetApi();
    as(ROBERTA);
    expect(await instance.resumeQueue(STW)).toEqual({ ok: true });
    expect(started).toEqual([]);
  });

  it("I2: una start che rigetta segna il lavoro fallito, con la frase, nello Stato", async () => {
    const started: string[] = [];
    held(started, "broken", STW, {
      start: async () => {
        throw new Error("conflict");
      },
    });
    held(started, "reset", STW, {
      start: async () => {
        throw new Error("reset");
      },
    });
    held(started, "ok", STW);
    await instance.resumeQueue(STW);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["ok"]);
    const failed = (await status()).jobs.filter(
      (j) =>
        j.projectId === STW &&
        j.state === "failed" &&
        j.code === "STW-7" &&
        j.summary === "conflict",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "task_run", retry: "unavailable", waiting: null });
    expect((await status()).errors.some((e) => e.jobId === failed[0]!.id)).toBe(true);
    // Il ripristino lo svuota.
    resetApi();
    as(ROBERTA);
    expect((await status()).jobs.some((j) => j.summary === "conflict")).toBe(false);
  });

  it("un lavoro in attesa fermato con Stop (dropHeld) non parte alla ripresa; l'altro sì", async () => {
    const started: string[] = [];
    held(started, "stopped", STW, { conversationId: "cv-stopped" });
    held(started, "kept", STW, { conversationId: "cv-kept" });
    dropHeld("cv-stopped");
    await instance.resumeQueue(STW);
    expect(started).toEqual(["kept"]);
  });
});

describe("il budget che torna disponibile (RF 4)", () => {
  const overSpent = () => Math.ceil(spentThisMonthUsd()) + 100;

  async function twoHeldForBudget(started: string[]) {
    expect(budgetReached()).toBe(true);
    held(started, "one", ACQ, { kind: "automation", taskId: null, automationRunId: "arun-1" });
    held(started, "two", ACQ, { kind: "automation", taskId: null, automationRunId: "arun-2" });
    const waiting = await waitingOf(ACQ);
    expect(waiting.map((j) => j.waiting)).toEqual([
      { reason: "monthly_budget" },
      { reason: "monthly_budget" },
    ]);
  }

  it("alzare il budget fa ripartire i passi fermi, nell'ordine, una volta", async () => {
    const started: string[] = [];
    await instance.saveBudget({ monthlyUsd: 1, contentLanguage: "en" });
    await twoHeldForBudget(started);
    await instance.saveBudget({ monthlyUsd: overSpent(), contentLanguage: "en" });
    expect(started).toEqual(["one", "two"]);
    expect(await waitingOf(ACQ)).toEqual([]);
    await instance.saveBudget({ monthlyUsd: overSpent() + 1, contentLanguage: "en" });
    releaseBudgetHolds();
    expect(started).toEqual(["one", "two"]);
  });

  it("lo stesso spegnendo la simulazione", async () => {
    const started: string[] = [];
    await instance.simulateBudgetReached(true);
    await twoHeldForBudget(started);
    await instance.simulateBudgetReached(false);
    expect(started).toEqual(["one", "two"]);
    expect(await waitingOf(ACQ)).toEqual([]);
  });

  it("senza modifiche al budget restano fermi", async () => {
    const started: string[] = [];
    await instance.saveBudget({ monthlyUsd: 1, contentLanguage: "en" });
    await twoHeldForBudget(started);
    await instance.saveBudget({ monthlyUsd: 1, contentLanguage: "it" });
    await instance.saveBudget({ monthlyUsd: 2, contentLanguage: "it" });
    advanceNow(DAY);
    releaseBudgetHolds();
    expect(started).toEqual([]);
    expect((await waitingOf(ACQ)).map((j) => j.waiting)).toEqual([
      { reason: "monthly_budget" },
      { reason: "monthly_budget" },
    ]);
  });

  it("due blocchi: alzato il budget resta fermo per la pausa, e la ripresa lo fa partire", async () => {
    const started: string[] = [];
    await instance.saveBudget({ monthlyUsd: 1, contentLanguage: "en" });
    held(started, "stw", STW, { kind: "automation", taskId: null, automationRunId: "arun-s" });
    expect((await waitingOf(STW))[0]!.waiting).toEqual({ reason: "monthly_budget" });
    await instance.saveBudget({ monthlyUsd: overSpent(), contentLanguage: "en" });
    expect(started).toEqual([]);
    expect((await waitingOf(STW))[0]!.waiting).toEqual(aiBlockFor(STW));
    expect(aiBlockFor(STW)).toMatchObject({ reason: "queue_paused" });
    await instance.resumeQueue(STW);
    expect(started).toEqual(["stw"]);
  });

  it("alla ripresa un lavoro che trova il budget raggiunto resta fermo, ora per il budget", async () => {
    const started: string[] = [];
    held(started, "stw", STW);
    await instance.simulateBudgetReached(true);
    await instance.resumeQueue(STW);
    expect(started).toEqual([]);
    expect((await waitingOf(STW))[0]!.waiting).toEqual({ reason: "monthly_budget" });
    await instance.simulateBudgetReached(false);
    expect(started).toEqual(["stw"]);
  });
});

describe("Retry (RF 5)", () => {
  it("una correzione ferma non si rimette in coda", async () => {
    const stw3 = state.conversations.find((c) => c.id === "cv-run-stw-3")!;
    stw3.state = "paused";
    expect(await instance.retryJob("cv-run-stw-3")).toEqual({
      ok: false,
      error: "invalid",
      reason: "not_retryable",
    });
    // Una correzione fallita è nella vista, senza Retry.
    stw3.state = "finished";
    stw3.outcome = "failed";
    const job = (await status()).jobs.find((j) => j.id === "cv-run-stw-3")!;
    expect(job).toMatchObject({ kind: "correction", state: "failed", retry: "unavailable" });
    expect(await instance.retryJob("cv-run-stw-3")).toMatchObject({ reason: "not_retryable" });
    // Nemmeno un lavoro ancora in corso.
    expect(await instance.retryJob("cv-run-aud-5")).toMatchObject({ reason: "not_retryable" });
    expect(state.changelog.filter((e) => e.kind === "job.retried")).toEqual([]);
  });

  it("I1: una correzione ferma compare in attesa, senza Retry, fuori dai worker e dai conteggi", async () => {
    const stw3 = state.conversations.find((c) => c.id === "cv-run-stw-3")!;
    stw3.state = "paused";
    const view = await status();
    expect(view.jobs.find((j) => j.id === "cv-run-stw-3")).toMatchObject({
      kind: "correction",
      code: "STW-3",
      state: "waiting",
      waiting: null,
      workerId: null,
      retry: "unavailable",
      href: "#/p/STW/tasks?task=STW-3",
    });
    expect(view.workers.map((w) => w.jobId)).not.toContain("cv-run-stw-3");
    // «N waiting» conta solo ciò che parte alla ripresa.
    expect(view.queues.find((q) => q.projectId === STW)!.waiting).toBe(0);
    // Le altre sessioni che aspettano una persona restano fuori.
    expect(view.jobs.some((j) => j.id === "cv-run-stw-13" || j.id === "cv-run-aud-4")).toBe(false);
  });

  it("su una task con un lavoro vivo → conflict", async () => {
    await startRun("t-acq-3");
    expect(await instance.retryJob("cv-run-acq-3")).toEqual({ ok: false, error: "conflict" });
    expect(state.changelog.filter((e) => e.kind === "job.retried")).toEqual([]);
  });

  it("con settings.manage ma senza runs.start → forbidden", async () => {
    give(SARA, "settings.manage");
    as(SARA);
    expect((await status()).jobs.find((j) => j.id === "cv-run-acq-3")!.retry).toBe("forbidden");
    expect(await instance.retryJob("cv-run-acq-3")).toEqual({ ok: false, error: "forbidden" });
    as(MARCO);
    expect(await instance.retryJob("cv-run-acq-3")).toEqual({ ok: false, error: "forbidden" });
    as(CHIARA);
    give(CHIARA, "settings.manage");
    expect(await instance.retryJob("cv-run-acq-3")).toEqual({ ok: false, error: "not_found" });
  });

  it("Marco con settings.manage riprova: parte a suo nome e si ferma al gate del piano", async () => {
    give(MARCO, "settings.manage");
    as(MARCO);
    expect((await status()).jobs.find((j) => j.id === "cv-run-acq-3")!.retry).toBe("allowed");
    const result = await instance.retryJob("cv-run-acq-3");
    expect(result).toMatchObject({ ok: true, conversationId: expect.any(String) });
    const id = (result as { conversationId: string }).conversationId;
    const run = state.conversations.find((c) => c.id === id)!;
    expect(run).toMatchObject({ kind: "task_run", taskId: "t-acq-3", ownerId: MARCO });
    await settle(id);
    expect(state.conversations.find((c) => c.id === id)!.state).toBe("awaiting_approval");
    expect(state.changelog.filter((e) => e.kind === "job.retried")).toMatchObject([
      { actorId: MARCO, projectId: ACQ, object: { type: "task", id: "t-acq-3", label: "ACQ-3" } },
    ]);
  });
});

describe("le voci del registro della coda", () => {
  it("si leggono da chi gestisce STW, non da chi non lo vede", async () => {
    await instance.resumeQueue(STW);
    await instance.pauseQueue(STW);
    const retried = await instance.retryJob("cv-run-stw-7");
    expect(retried).toMatchObject({ ok: true });
    // Con la coda in pausa il Retry non parte: aspetta la ripresa (Task 6, shape EF).
    const id = (retried as { conversationId: string }).conversationId;
    expect(state.conversations.find((c) => c.id === id)!.waiting).toMatchObject({
      reason: "queue_paused",
    });
    expect((await waitingOf(STW)).map((j) => j.id)).toContain(id);
    const kinds = ["queue.paused", "queue.resumed", "job.retried"];

    as(LAURA);
    const laura = (await changelog.listChanges()).filter((e) => kinds.includes(e.kind));
    expect(laura.map((e) => e.kind).sort()).toEqual([...kinds].sort());
    expect(laura.every((e) => e.projectCode === "STW")).toBe(true);
    // Il prima/dopo della ripresa: valori stabili, tradotti dalla pagina.
    const resumed = state.changelog.find((e) => e.kind === "queue.resumed")!;
    expect([resumed.before, resumed.after]).toEqual([
      `paused:${"2026-10-22T18:00:00Z"}`,
      "running",
    ]);

    give(CHIARA, "settings.manage");
    as(CHIARA);
    expect((await changelog.listChanges()).filter((e) => kinds.includes(e.kind))).toEqual([]);
  });
});

// --- Task 13: ciò che la pagina legge invece di ricalcolarlo -----------------------

describe("lo Stato dell'istanza per la pagina (Task 13)", () => {
  afterEach(() => resetViewerGrants());

  it("la pausa porta chi l'ha messa (per «(deactivated)»)", async () => {
    const stw = (await status()).queues.find((q) => q.projectId === STW)!;
    expect(stw.paused).toMatchObject({ byId: ROBERTA, byName: "Roberta Fontana" });
  });

  it("retryNeeds dice il permesso che manca; retryStopsAtPlan il gate di chi riprova", async () => {
    const acq3 = async () => (await status()).jobs.find((j) => j.id === "cv-run-acq-3")!;
    expect(await acq3()).toMatchObject({
      retry: "allowed",
      retryNeeds: null,
      retryStopsAtPlan: false,
    });

    give(SARA, "instance.status.view");
    as(SARA);
    expect(await acq3()).toMatchObject({ retry: "forbidden", retryNeeds: "manageSettings" });

    // Ruling 2: Marco, con settings.manage, ha runs.start in ACQ ma non plans.approve.
    give(MARCO, "settings.manage");
    as(MARCO);
    expect(await acq3()).toMatchObject({
      retry: "allowed",
      retryNeeds: null,
      retryStopsAtPlan: true,
    });
    revokeProjectPermission(MARCO, ACQ, "runs.start" as never);
    expect(await acq3()).toMatchObject({
      retry: "forbidden",
      retryNeeds: "startRun",
      retryStopsAtPlan: false,
    });
  });

  it("budgetAfterResume: i lavori della pausa che restano fermi col budget raggiunto", async () => {
    const started: string[] = [];
    held(started, "stw", STW);
    const stw = async () => (await status()).queues.find((q) => q.projectId === STW)!;
    expect(await stw()).toMatchObject({ waiting: 1, budgetAfterResume: 0 });
    await instance.simulateBudgetReached(true);
    expect(await stw()).toMatchObject({ waiting: 1, budgetAfterResume: 1 });
    // Una coda non in pausa non ha niente da riprendere.
    expect((await status()).queues.every((q) => q.paused || q.budgetAfterResume === 0)).toBe(true);
  });

  it("startFailed segna la ripartenza fallita, il cui summary è il messaggio dell'errore", async () => {
    holdJob({
      projectId: STW,
      kind: "task_run",
      taskId: "t-stw-12",
      conversationId: null,
      automationRunId: null,
      starterId: ROBERTA,
      block: aiBlockFor(STW)!,
      start: () => Promise.reject(new Error("conflict")),
    });
    await instance.resumeQueue(STW);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const view = await status();
    const failed = view.jobs.find((j) => j.state === "failed" && j.code === "STW-12")!;
    expect(failed).toMatchObject({ startFailed: true, summary: "conflict", retry: "unavailable" });
    expect(view.errors.find((e) => e.jobId === failed.id)).toMatchObject({ startFailed: true });
    expect(view.jobs.find((j) => j.id === "cv-run-acq-3")!.startFailed).toBe(false);
  });
});
