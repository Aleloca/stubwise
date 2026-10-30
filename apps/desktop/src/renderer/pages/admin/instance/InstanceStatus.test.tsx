import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationFlow } from "../../../data/types";
import { whenAutomationsIdle } from "../../../data/automations/runner";
import {
  automations,
  failNext,
  instance,
  resetApi,
  setLatency,
  setStreamLatency,
  startRun,
} from "../../../data/api";
import { writeAccess } from "../../../data/access/index";
import { aiBlockFor } from "../../../data/instance/blocks";
import { holdJob } from "../../../data/instance/queue";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import {
  grantInstancePermission,
  resetViewerGrants,
  revokeProjectPermission,
  type LocalInstancePermission,
} from "../../../data/viewer";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { clearToasts } from "../../../tasks-ui/Toast";
import { expectNoDeploy } from "../../../test/noDeploy";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// Lo Stato dell'istanza (area 9b, Task 13, shape admin-instance.md
// «Instance status»). Persone del seme: Roberta (full admin), Sara (User:
// vede STW e ACQ, non AUD né MKX), Marco (Developer in ACQ: `runs.start`
// senza `plans.approve`; ruling 2: il Retry col gate lo prova lui, con la
// concessione di `settings.manage`). Al seme STW è in pausa da Roberta da
// ieri alle 18:00, ACQ-3 è fallito ieri alle 16:20, STW-7 l'altro ieri.

const ROBERTA = "p-roberta";
const SARA = "p-sara";
const MARCO = "p-marco";
const ACQ = "prj-acq";
const STW = "prj-stw";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  cleanup();
  clearToasts();
  vi.useRealTimers();
  setStreamLatency(null);
  resetViewerGrants();
  resetApi();
  act(() => setLanguage("en"));
});

const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);
const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const queueRow = (code: string) =>
  document.querySelector<HTMLElement>(`[data-queue-row="${code}"]`)!;
const jobRow = (id: string) => document.querySelector<HTMLElement>(`[data-job-row="${id}"]`);
const jobRows = () => [...document.querySelectorAll<HTMLElement>("[data-job-row]")];

function fakeTime() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/**
 * «Avvia» su una task altrove, come Roberta, senza aspettare che Claude
 * finisca (`startRun` si risolve a fine giro): basta che la sessione sia al
 * lavoro. Con lo stream lento resta viva per tutto il test.
 */
async function startLive(taskId: string) {
  setStreamLatency(120_000);
  setSessionPersonId(ROBERTA);
  void startRun(taskId).catch(() => {});
  await waitFor(() =>
    expect(state.conversations.some((c) => c.taskId === taskId && c.state === "working")).toBe(
      true,
    ),
  );
}

async function openStatus(personId = ROBERTA, path = "/admin/status") {
  setSessionPersonId(personId);
  const router = renderRoute(path, personId);
  expect(await heading("Instance status")).toBeVisible();
  await screen.findByRole("region", { name: "Queues" });
  return router;
}

/** Un'automazione di `projectId`, a mano, con un solo passo: Claude (come in `effects.test.ts`). */
async function claudeAutomation(projectId: string): Promise<string> {
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

// --- Lettura ---------------------------------------------------------------------

describe("lo Stato dell'istanza del seme", () => {
  it("le code per progetto, i lavori con tipo, età e stato, i worker, la quota, gli errori col link e il giro notturno", async () => {
    await openStatus();
    expect(
      screen.getByText("What Stubwise is doing right now, in the projects you can see."),
    ).toBeVisible();
    expect(screen.getByText(/^Updated \d{2}:\d{2}:\d{2} · every 10 seconds$/)).toBeVisible();

    // Le code: in pausa, poi con lavori falliti, poi per codice.
    const codes = [...document.querySelectorAll("[data-queue-row]")].map((r) =>
      r.getAttribute("data-queue-row"),
    );
    expect(codes).toEqual(["STW", "ACQ", "AUD", "MKX"]);
    expect(queueRow("STW")).toHaveTextContent("1 running · 1 failed");
    expect(queueRow("STW")).toHaveTextContent("Paused by Roberta Fontana · yesterday at 18:00");
    expect(
      within(queueRow("STW")).getByRole("button", { name: "Resume STW's queue" }),
    ).toBeEnabled();
    expect(queueRow("ACQ")).toHaveTextContent("1 failed");
    expect(queueRow("ACQ")).not.toHaveTextContent("running");
    expect(
      within(queueRow("ACQ")).getByRole("button", { name: "Pause ACQ's queue" }),
    ).toBeEnabled();
    expect(screen.getByText("Projects with no work aren't listed.")).toBeVisible();
    // Roberta vede tutto: nessuna riga «Other projects».
    expect(screen.queryByText("Other projects")).toBeNull();

    // I lavori: in corso, poi i falliti dal più recente.
    const work = screen.getByRole("list", { name: "Work" });
    const running = jobRow("cv-run-stw-3")!;
    expect(running).toHaveTextContent("STW-3");
    expect(running).toHaveTextContent("Correction");
    expect(running).toHaveTextContent("Running · worker 1");
    expect(running).toHaveTextContent("2 days");
    expect(within(running).getByRole("link", { name: /STW-3/ })).toHaveAttribute(
      "href",
      "/p/STW/tasks?task=STW-3",
    );
    const failed = jobRow("cv-run-acq-3")!;
    expect(failed).toHaveTextContent("Task run");
    expect(failed).toHaveTextContent("Failed yesterday at 16:20");
    expect(failed).toHaveTextContent("didn't match the billing export");
    expect(failed).toHaveTextContent("yesterday");
    expect(within(failed).getByRole("button", { name: "Retry ACQ-3" })).toBeEnabled();
    // Nessun bottone Retry sui lavori in corso.
    expect(within(running).queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(within(work).getAllByRole("listitem")).toHaveLength(5);

    // I worker.
    const workers = screen.getByRole("region", { name: "Workers" });
    expect(workers).toHaveTextContent("Worker 1");
    expect(workers).toHaveTextContent("STW-3");
    expect(workers).toHaveTextContent("Worker 2");
    expect(workers).toHaveTextContent("AUD-5");
    expect(workers).toHaveTextContent("Prototype: two simulated workers.");

    // La quota, con la banda.
    const accounts = screen.getByRole("region", { name: "AI accounts" });
    expect(accounts).toHaveTextContent("Team Max");
    expect(accounts).toHaveTextContent("week 41%");
    expect(accounts).toHaveTextContent("Near the limit · 87%");
    expect(accounts).toHaveTextContent("Billing key");
    expect(accounts).toHaveTextContent("API key");
    expect(within(accounts).getByRole("link", { name: "Open AI accounts" })).toHaveAttribute(
      "href",
      "/admin/ai?tab=providers",
    );

    // Gli errori recenti col link alla task.
    const errors = screen.getByRole("region", { name: "Recent errors" });
    const first = within(errors).getAllByRole("listitem")[0]!;
    expect(first).toHaveTextContent("ACQ-3");
    expect(first).toHaveTextContent("didn't match the billing export");
    expect(within(first).getByRole("link", { name: /Open task/ })).toHaveAttribute(
      "href",
      "/p/ACQ/tasks?task=ACQ-3",
    );

    // Il giro notturno, solo da leggere.
    const nightly = screen.getByRole("region", { name: "Nightly run · last night" });
    expect(within(nightly).getAllByRole("listitem")).toHaveLength(4);
    expect(nightly).toHaveTextContent("stubwise");
    expect(nightly).toHaveTextContent("Commit summaries");
    expect(nightly).toHaveTextContent("tag v2.4.0");
    expect(nightly).toHaveTextContent("Read only: the nightly run picks up where it stopped.");
    expect(within(nightly).queryByRole("button")).toBeNull();

    expect(
      screen.getByText(
        "Stubwise only changes its own queue here: nothing restarts a server, a worker or a deploy.",
      ),
    ).toBeVisible();
  });

  it("R-G5: Sara col solo instance.status.view non legge AUD né MKX; Other projects coi conteggi; azioni spente con Who?", async () => {
    give(SARA, "instance.status.view");
    await openStatus(SARA);
    const text = document.body.textContent ?? "";
    for (const hidden of ["AUD", "MKX", "Audin", "Export the call history"])
      expect(text).not.toContain(hidden);
    const other = document.querySelector<HTMLElement>("[data-queue-row='other']")!;
    expect(other).toHaveTextContent("Other projects");
    expect(other).toHaveTextContent("2 running");
    expect(other).toHaveAttribute("title", "Projects you can't see.");
    expect(within(other).queryByRole("button")).toBeNull();
    expect(screen.getByRole("region", { name: "Workers" })).toHaveTextContent(
      "Worker 2busy in a project you can't see",
    );

    // Pause/Resume spenti con la frase e «Who?» (manageSettings).
    const pause = within(queueRow("ACQ")).getByRole("button", { name: "Pause ACQ's queue" });
    expect(pause).toBeDisabled();
    expect(queueRow("ACQ")).toHaveTextContent(
      "Only people who can manage settings pause or resume a queue.",
    );
    expect(queueRow("ACQ").querySelector("[data-who-can='manageSettings']")).not.toBeNull();
    // Retry spento con la frase e «Who?» (manageSettings).
    const failed = jobRow("cv-run-acq-3")!;
    expect(within(failed).getByRole("button", { name: "Retry ACQ-3" })).toBeDisabled();
    expect(failed).toHaveTextContent(
      "Only people who can manage settings put work back in the queue.",
    );
    expect(failed.querySelector("[data-who-can='manageSettings']")).not.toBeNull();
  });

  it("con settings.manage ma senza runs.start nel progetto, Retry è spento col «Who?» di startRun", async () => {
    give(MARCO, "settings.manage");
    revokeProjectPermission(MARCO, ACQ, "runs.start" as never);
    await openStatus(MARCO);
    const failed = jobRow("cv-run-acq-3")!;
    expect(within(failed).getByRole("button", { name: "Retry ACQ-3" })).toBeDisabled();
    expect(failed).toHaveTextContent(
      "Only people who can start Claude in ACQ put work back in the queue.",
    );
    expect(failed.querySelector("[data-who-can='startRun']")).not.toBeNull();
    expect(failed.querySelector("[data-who-can='manageSettings']")).toBeNull();
    // Pause è acceso: settings.manage basta.
    expect(
      within(queueRow("ACQ")).getByRole("button", { name: "Pause ACQ's queue" }),
    ).toBeEnabled();
  });

  it("una correzione ferma: niente Retry, la frase e «Open task» (ruling T5 I1)", async () => {
    state.conversations.find((c) => c.id === "cv-run-stw-3")!.state = "paused";
    await openStatus();
    const row = jobRow("cv-run-stw-3")!;
    expect(row).toHaveTextContent("Stopped: waits for someone to resume it");
    expect(row).toHaveTextContent("Corrections are resumed from the task.");
    expect(within(row).queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(within(row).getByRole("link", { name: "Open task" })).toHaveAttribute(
      "href",
      "/p/STW/tasks?task=STW-3",
    );
  });
});

// --- Pause e Resume ---------------------------------------------------------------

describe("Pause e Resume", () => {
  it("STW dice «Paused by Roberta Fontana»; Resume con conferma: la riga cambia, la voce è nel registro", async () => {
    const user = userEvent.setup();
    await openStatus();
    const resume = within(queueRow("STW")).getByRole("button", { name: "Resume STW's queue" });
    await user.click(resume);
    const dialog = await screen.findByRole("dialog", { name: "Resume STW's queue?" });
    expect(dialog).toHaveTextContent("Nothing is waiting.");
    // Il fuoco va all'annullamento: l'azione tocca altri.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Resume queue" }));

    expect(await screen.findByText("STW's queue is running again.")).toBeVisible();
    await waitFor(() => expect(queueRow("STW")).not.toHaveTextContent("Paused by"));
    expect(
      within(queueRow("STW")).getByRole("button", { name: "Pause STW's queue" }),
    ).toHaveFocus();
    expect(state.changelog.filter((e) => e.kind === "queue.resumed")).toMatchObject([
      { actorId: ROBERTA, projectId: STW },
    ]);
  });

  it("due lavori in attesa: «2 waiting» e «Waiting: queue paused by Roberta Fontana»; alla ripresa partono", async () => {
    setSessionPersonId(ROBERTA);
    await startRun("t-stw-7");
    await startRun("t-stw-12");
    const user = userEvent.setup();
    await openStatus();
    expect(queueRow("STW")).toHaveTextContent("1 running · 2 waiting · 1 failed");
    const waiting = jobRows().filter((r) => r.dataset.jobState === "waiting");
    expect(waiting).toHaveLength(2);
    expect(waiting[0]).toHaveTextContent("STW-7");
    expect(waiting[0]).toHaveTextContent("Task run");
    expect(waiting[0]).toHaveTextContent("Waiting: queue paused by Roberta Fontana");

    await user.click(within(queueRow("STW")).getByRole("button", { name: "Resume STW's queue" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume STW's queue?" });
    expect(dialog).toHaveTextContent("2 waiting jobs start now, in the order they arrived.");
    await user.click(within(dialog).getByRole("button", { name: "Resume queue" }));
    await waitFor(() => expect(queueRow("STW")).not.toHaveTextContent("waiting"));
    expect(queueRow("STW")).toHaveTextContent("3 running · 1 failed");
  });

  it("Pause con conferma: le conseguenze, il toast, la riga in pausa a nome di chi l'ha messa", async () => {
    const user = userEvent.setup();
    await openStatus();
    await user.click(within(queueRow("ACQ")).getByRole("button", { name: "Pause ACQ's queue" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause ACQ's queue?" });
    for (const line of [
      "Work already running finishes.",
      "New work waits: starting Claude on a task, corrections, pull request reviews, server analyses and fixes, automation steps that use Claude.",
      "Ask Claude isn't affected.",
      "Everyone in ACQ reads “Queue paused by Roberta Fontana”.",
    ])
      expect(dialog).toHaveTextContent(line);
    await user.click(within(dialog).getByRole("button", { name: "Pause queue" }));
    expect(await screen.findByText("ACQ's queue is paused.")).toBeVisible();
    await waitFor(() =>
      expect(queueRow("ACQ")).toHaveTextContent("Paused by Roberta Fontana · today at 12:00"),
    );
    expect(state.changelog.filter((e) => e.kind === "queue.paused")).toMatchObject([
      { actorId: ROBERTA, projectId: ACQ },
    ]);
  });

  it("già in pausa altrove: il rifiuto in parole e la riga si aggiorna", async () => {
    const user = userEvent.setup();
    await openStatus();
    await user.click(within(queueRow("ACQ")).getByRole("button", { name: "Pause ACQ's queue" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause ACQ's queue?" });
    await instance.pauseQueue(ACQ);
    await user.click(within(dialog).getByRole("button", { name: "Pause queue" }));
    expect(await within(dialog).findByText("Someone already paused ACQ's queue.")).toBeVisible();
    await waitFor(() => expect(queueRow("ACQ")).toHaveTextContent("Paused by Roberta Fontana"));
  });

  it("chi ha messo la pausa ed è stato disattivato resta, con «(deactivated)»", async () => {
    state.instance.queuePauses[0]!.byId = "p-laura";
    writeAccess((a) => {
      a.people.find((p) => p.personId === "p-laura")!.status = "deactivated";
    });
    await openStatus();
    await waitFor(() =>
      expect(queueRow("STW")).toHaveTextContent(
        "Paused by Laura Costa (deactivated) · yesterday at 18:00",
      ),
    );
  });

  it("col budget raggiunto il dialogo di Resume non dice che i lavori partono", async () => {
    const user = userEvent.setup();
    setSessionPersonId(ROBERTA);
    // STW è in pausa: «Avvia» entra in attesa e si risolve subito.
    await startRun("t-stw-12");
    await instance.simulateBudgetReached(true);
    await openStatus();
    await user.click(within(queueRow("STW")).getByRole("button", { name: "Resume STW's queue" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume STW's queue?" });
    expect(dialog).toHaveTextContent("The waiting job still waits for the monthly AI budget.");
    expect(dialog).not.toHaveTextContent("starts now");
  });

  it("I2: budget raggiunto, poi «Avvia» (un passo d'automazione in STW), poi Resume: non parte niente", async () => {
    const user = userEvent.setup();
    setSessionPersonId(ROBERTA);
    await instance.simulateBudgetReached(true);
    const runId = await claudeAutomation(STW);
    await openStatus();
    expect(jobRow(runId)).toHaveTextContent("Waiting: monthly AI budget reached");
    await user.click(within(queueRow("STW")).getByRole("button", { name: "Resume STW's queue" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume STW's queue?" });
    expect(dialog).toHaveTextContent("The waiting job still waits for the monthly AI budget.");
    expect(dialog).not.toHaveTextContent("starts now");
    await user.click(within(dialog).getByRole("button", { name: "Resume queue" }));
    await waitFor(() => expect(queueRow("STW")).not.toHaveTextContent("Paused by"));
    expect(jobRow(runId)!.dataset.jobState).toBe("waiting");
  });
});

// --- Retry ------------------------------------------------------------------------

describe("Rimetti in coda", () => {
  it("Retry con conferma sul lavoro fallito di ieri: la task ha una sessione nuova, avviata da chi ha riprovato", async () => {
    const user = userEvent.setup();
    await openStatus();
    const before = state.conversations.length;
    await user.click(within(jobRow("cv-run-acq-3")!).getByRole("button", { name: "Retry ACQ-3" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Put ACQ-3's work back in the queue?",
    });
    expect(dialog).toHaveTextContent(
      "Claude starts again from the beginning, on your behalf, as if you pressed Start.",
    );
    // Roberta approva i piani in ACQ, e la coda di ACQ non è in pausa.
    expect(dialog).not.toHaveTextContent("It stops at the plan");
    expect(dialog).not.toHaveTextContent("queue is paused");
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("ACQ-3 is back in the queue.")).toBeVisible();
    expect(state.conversations.length).toBe(before + 1);
    const fresh = state.conversations.find(
      (c) => c.taskId === "t-acq-3" && c.id !== "cv-run-acq-3" && c.kind === "task_run",
    )!;
    expect(fresh.ownerId).toBe(ROBERTA);
    expect(state.changelog.filter((e) => e.kind === "job.retried")).toMatchObject([
      { actorId: ROBERTA, projectId: ACQ },
    ]);
    // Il toast porta alla task.
    expect(screen.getByRole("button", { name: "Open task" })).toBeVisible();
  });

  it("senza plans.approve il dialogo dice che si ferma al piano (ruling 2: Marco con settings.manage)", async () => {
    give(MARCO, "settings.manage");
    const user = userEvent.setup();
    await openStatus(MARCO);
    await user.click(within(jobRow("cv-run-acq-3")!).getByRole("button", { name: "Retry ACQ-3" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Put ACQ-3's work back in the queue?",
    });
    expect(dialog).toHaveTextContent(
      "It stops at the plan, for someone who can approve plans in ACQ.",
    );
  });

  it("sulla coda in pausa il dialogo dice che aspetta la ripresa; il lavoro compare in attesa", async () => {
    const user = userEvent.setup();
    await openStatus();
    await user.click(within(jobRow("cv-run-stw-7")!).getByRole("button", { name: "Retry STW-7" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Put STW-7's work back in the queue?",
    });
    expect(dialog).toHaveTextContent("STW's queue is paused: it waits for Resume.");
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(queueRow("STW")).toHaveTextContent("1 waiting"));
  });

  it("conflict: il lavoro c'è già, niente di aggiunto", async () => {
    // Il lavoro partito altrove resta vivo per tutto il test.
    setStreamLatency(120_000);
    const user = userEvent.setup();
    await openStatus();
    await user.click(within(jobRow("cv-run-acq-3")!).getByRole("button", { name: "Retry ACQ-3" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Put ACQ-3's work back in the queue?",
    });
    setSessionPersonId(ROBERTA);
    await startLive("t-acq-3");
    const before = state.conversations.length;
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("ACQ-3 already has work running. Nothing was added."),
    ).toBeVisible();
    expect(state.conversations.length).toBe(before);
  });

  it("I1: dopo il Retry la riga fallita resta, senza Retry acceso e con la frase che lo dice", async () => {
    const user = userEvent.setup();
    await openStatus();
    await user.click(within(jobRow("cv-run-acq-3")!).getByRole("button", { name: "Retry ACQ-3" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Put ACQ-3's work back in the queue?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await screen.findByText("ACQ-3 is back in the queue.");
    await waitFor(() =>
      expect(within(jobRow("cv-run-acq-3")!).queryByRole("button", { name: /Retry/ })).toBeNull(),
    );
    expect(jobRow("cv-run-acq-3")).toHaveTextContent(
      "A newer run of ACQ-3 has taken its place: nothing to put back.",
    );
  });

  it("I1, in italiano: la stessa frase tradotta", async () => {
    setStreamLatency(120_000);
    act(() => setLanguage("it"));
    await startLive("t-acq-3");
    setSessionPersonId(ROBERTA);
    renderRoute("/admin/status", ROBERTA);
    await screen.findByRole("region", { name: "Code" });
    expect(jobRow("cv-run-acq-3")).toHaveTextContent(
      "Su ACQ-3 c'è un lavoro più recente: non c'è niente da rimettere in coda.",
    );
    expect(within(jobRow("cv-run-acq-3")!).queryByRole("button")).toBeNull();
  });

  it("dopo la conferma di Retry il fuoco torna alla riga", async () => {
    const user = userEvent.setup();
    await openStatus();
    await user.click(within(jobRow("cv-run-acq-3")!).getByRole("button", { name: "Retry ACQ-3" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Put ACQ-3's work back in the queue?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await screen.findByText("ACQ-3 is back in the queue.");
    // Anche dopo che il giro ha tolto il bottone, il fuoco è sulla riga.
    await waitFor(() =>
      expect(within(jobRow("cv-run-acq-3")!).queryByRole("button", { name: /Retry/ })).toBeNull(),
    );
    expect(jobRow("cv-run-acq-3")).toHaveFocus();
  });
});

// --- Fermi per budget, ripartenze fallite --------------------------------------------

describe("i lavori fermi", () => {
  it("budget raggiunto: «Waiting: monthly AI budget reached»; alzato il budget, dopo 10 s non è più fra i fermi", async () => {
    setSessionPersonId(ROBERTA);
    await instance.saveBudget({ monthlyUsd: 0, contentLanguage: "it" });
    const runId = await claudeAutomation(ACQ);
    fakeTime();
    await openStatus();
    const row = await waitFor(() => jobRow(runId)!);
    expect(row).toHaveTextContent("Automation");
    expect(row).toHaveTextContent("Waiting: monthly AI budget reached");
    expect(row.dataset.jobState).toBe("waiting");

    // Alzato da AI → Budget (altrove): la pagina lo vede al giro dopo.
    await instance.saveBudget({ monthlyUsd: null, contentLanguage: "it" });
    await advance(10_000);
    await waitFor(() =>
      expect(jobRows().filter((r) => r.dataset.jobState === "waiting")).toHaveLength(0),
    );
  });

  it("aggiornamento: un lavoro partito altrove compare dopo 10 s", async () => {
    const runningAcq3 = () =>
      jobRows().some((r) => r.dataset.jobState === "running" && r.textContent?.includes("ACQ-3"));
    fakeTime();
    await openStatus();
    expect(runningAcq3()).toBe(false);
    // «Avvia» altrove non avvisa lo Stato dell'istanza: lo porta il giro.
    await startLive("t-acq-3");
    await advance(9_000);
    expect(runningAcq3()).toBe(false);
    await advance(1_000);
    await waitFor(() => expect(runningAcq3()).toBe(true));

    // La riga nuova ha lo sfondo per 2 s; `aria-live` dice il cambio dei conteggi di ACQ.
    const fresh = jobRows().find(
      (r) => r.dataset.jobState === "running" && r.textContent?.includes("ACQ-3"),
    )!;
    expect(fresh).toHaveAttribute("data-fresh", "true");
    expect(document.querySelector("[aria-live='polite']")).toHaveTextContent(
      "ACQ: 1 running · 1 failed",
    );
    await advance(2_000);
    await waitFor(() => expect(fresh).not.toHaveAttribute("data-fresh"));
    // Il seme al primo giro non era nuovo.
    expect(jobRow("cv-run-acq-3")).not.toHaveAttribute("data-fresh");
  });

  it("I4: un secondo giro diverso entro 2 s non lascia la riga nuova evidenziata per sempre", async () => {
    fakeTime();
    await openStatus();
    await startLive("t-acq-3");
    await advance(10_000);
    const fresh = await waitFor(() => {
      const row = jobRows().find(
        (r) => r.dataset.jobState === "running" && r.textContent?.includes("ACQ-3"),
      );
      expect(row).toHaveAttribute("data-fresh", "true");
      return row!;
    });
    // Entro 2 s un altro cambio: «Avvia» su STW in pausa avvisa l'istanza e la pagina si rilegge.
    await advance(500);
    await startRun("t-stw-12");
    await waitFor(() =>
      expect(jobRows().some((r) => r.textContent?.includes("STW-12"))).toBe(true),
    );
    await advance(2_000);
    await waitFor(() => expect(fresh).not.toHaveAttribute("data-fresh"));
  });

  it("un aggiornamento automatico fallito non svuota la pagina", async () => {
    fakeTime();
    await openStatus();
    failNext("instance.getInstanceStatus");
    await advance(10_000);
    expect(
      await screen.findByText(
        /^Couldn't update at \d{2}:\d{2}:\d{2}\. Showing \d{2}:\d{2}:\d{2}\.$/,
      ),
    ).toBeVisible();
    expect(jobRow("cv-run-acq-3")).not.toBeNull();
  });

  it("una ripartenza fallita: la frase tradotta, non il codice (Minor del Task 5)", async () => {
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
    setSessionPersonId(ROBERTA);
    await instance.resumeQueue(STW);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await openStatus();
    const failed = jobRows().find(
      (r) => r.dataset.jobState === "failed" && r.textContent?.includes("STW-12"),
    )!;
    expect(failed).toHaveTextContent(
      "Didn't start when it was released: the task already had work running.",
    );
    expect(failed.textContent).not.toMatch(/·\s*conflict/);
    const errors = screen.getByRole("region", { name: "Recent errors" });
    expect(errors).toHaveTextContent("the task already had work running");

    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(failed).toHaveTextContent(
        "Non è partito quando è stato sbloccato: la task aveva già un lavoro in corso.",
      ),
    );
  });
});

// --- Filtri, errore, noDeploy ---------------------------------------------------------

describe("filtri, errore e confine", () => {
  it("i filtri di WORK stanno nell'indirizzo: stato, progetto, tipo; «Nothing matches.» e Clear filters", async () => {
    const user = userEvent.setup();
    const router = await openStatus(ROBERTA, "/admin/status?status=failed");
    expect(screen.getByRole("radio", { name: "Failed" })).toHaveAttribute("aria-checked", "true");
    expect(jobRows().map((r) => r.dataset.jobState)).toEqual(["failed", "failed"]);

    await user.click(screen.getByRole("button", { name: "Project" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /ACQ/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ status: "failed", project: "ACQ" }),
    );
    expect(jobRows().map((r) => r.dataset.jobRow)).toEqual(["cv-run-acq-3"]);

    await user.click(screen.getByRole("button", { name: "Type" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Correction" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ kind: "correction" }));
    expect(screen.getByText("Nothing matches.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(jobRows()).toHaveLength(5));
    expect(router.state.location.search).not.toHaveProperty("status", "failed");
    expect(screen.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
  });

  it("errore di lettura: «Load again», mai «Riprova» (ruling 18)", async () => {
    const user = userEvent.setup();
    failNext("instance.getInstanceStatus");
    setSessionPersonId(ROBERTA);
    renderRoute("/admin/status", ROBERTA);
    expect(await screen.findByText("Couldn't load the instance status.")).toBeVisible();
    expectNoDeploy();
    await user.click(screen.getByRole("button", { name: "Load again" }));
    expect(await screen.findByRole("region", { name: "Queues" })).toBeVisible();

    cleanup();
    act(() => setLanguage("it"));
    failNext("instance.getInstanceStatus");
    renderRoute("/admin/status", ROBERTA);
    expect(await screen.findByText("Impossibile caricare lo stato dell'istanza.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ricarica" })).toBeVisible();
    expectNoDeploy();
  });

  it("RF 5: expectNoDeploy in en e in it", async () => {
    await openStatus();
    expectNoDeploy();
    cleanup();
    act(() => setLanguage("it"));
    renderRoute("/admin/status", ROBERTA);
    expect(await heading("Stato dell'istanza")).toBeVisible();
    await screen.findByRole("region", { name: "Code" });
    expect(screen.getByRole("button", { name: "Rimetti in coda ACQ-3" })).toBeVisible();
    expect(
      screen.getByText(
        "Qui Stubwise cambia solo la propria coda: niente riavvia un server, un worker o un deploy.",
      ),
    ).toBeVisible();
    expectNoDeploy();
  });

  it("senza instance.status.view né settings.manage: la voce non c'è e l'indirizzo è «not found»", async () => {
    setSessionPersonId(SARA);
    renderRoute("/admin/status", SARA);
    expect(await heading("Page not found")).toBeVisible();
  });
});
