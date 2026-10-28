import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  automations,
  createMilestone,
  createRequest,
  createTask,
  failNext,
  mail,
  resetApi,
  setLatency,
  updateMilestone,
  updateTask,
} from "../api";
import { AUTOMATION_CASES } from "../seed/automations";
import { AUTOMATION_MAIL_IDS } from "../seed/automations/mail";
import { MAIL_MESSAGES } from "../seed/mail";
import { setSessionPersonId } from "../session";
import { now, onAutomationSignal, signalAutomations, state, visibleProjectIds } from "../store";
import type { AutomationFlow, AutomationRun, Step } from "../types";
import { grantInstancePermission, grantProjectRole } from "../viewer";

/** Il passo su cui si decide (`expectedPath`, obbligatorio): quello che l'esecuzione aspetta adesso. */
const at = (runId: string) => ({
  expectedPath: state.automationRuns.find((r) => r.id === runId)?.cursor ?? "",
});

const as = (personId: string) => setSessionPersonId(personId);
const A = AUTOMATION_CASES.automations;
const R = AUTOMATION_CASES.runs;
const S = AUTOMATION_CASES.sources;
const AUD = "prj-aud";
const idle = () => automations.whenAutomationsIdle();
const run = (id: string): AutomationRun => state.automationRuns.find((r) => r.id === id)!;
const runsOf = (automationId: string) =>
  state.automationRuns.filter((r) => r.automationId === automationId);
const lastRunOf = (automationId: string) => runsOf(automationId).at(-1)!;
/** Le email mandate durante il test (non quelle del seme, R-J10). */
const SEEDED = new Set(MAIL_MESSAGES.map((m) => m.id));
const sentBy = (personId: string) =>
  state.mailMessages.filter((m) => m.delivery?.sentById === personId && !SEEDED.has(m.id));

/** L'account Google di una persona scade (la sua casella non spedisce più). */
function expire(personId: string): void {
  state.googleAccounts.find((a) => a.personId === personId)!.status = "expired";
}

/** Collega l'account Google (e la casella) di una persona. */
function connect(personId: string): void {
  const email = `${personId.slice(2)}@example.com`;
  const account = state.googleAccounts.find((a) => a.personId === personId);
  if (account) account.status = "connected";
  else state.googleAccounts.push({ personId, email, status: "connected", since: now() });
  if (!state.mailboxes.some((b) => b.personId === personId)) {
    state.mailboxes.push({
      personId,
      email: account?.email ?? email,
      proposalsEnabled: false,
      syncedAt: now(),
      sync: "ok",
    });
  }
}

/** Toglie una persona dai membri di un progetto. */
function leave(personId: string, projectId: string): void {
  const p = state.projectsById.get(projectId)!;
  p.memberIds = p.memberIds.filter((id) => id !== personId);
}

const AUTO = { mode: "auto" } as const;
const ASK_OWNER = { mode: "ask", who: { owner: true } } as const;

const task = (id: string, extra: Partial<Extract<Step, { kind: "createTask" }>> = {}): Step => ({
  id,
  kind: "createTask",
  title: `Task ${id}`,
  description: "",
  assignee: null,
  dueInDays: null,
  project: { mode: "own" },
  milestoneRef: null,
  approval: AUTO,
  ...extra,
});

const manual = (steps: Step[]): AutomationFlow => ({
  trigger: { kind: "manual" },
  steps,
  titleTemplate: "Prova",
});

/** Crea e accende un'automazione a nome di chi guarda. */
async function make(projectId: string | null, flow: AutomationFlow, name = "Prova") {
  const a = await automations.createAutomation({ name, projectId, flow });
  await automations.activate(a.id);
  return a.id;
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-roberta");
});

afterEach(async () => {
  await idle();
});

// --- visibilità, codici, R-G5 ----------------------------------------------------

describe("Automations: chi vede e chi gestisce", () => {
  it("R-G5: un'automazione o un'esecuzione nascoste rispondono come inesistenti", async () => {
    as("p-sara");
    // Sara non ha automations.manage d'istanza: le generali non le vede.
    expect(await automations.getAutomation(A.newContract)).toBeNull();
    expect(await automations.getAutomation("aut-nope")).toBeNull();
    expect(await automations.getRun(R.done)).toBeNull();
    expect(await automations.getRun("arun-nope")).toBeNull();
    const rows = await automations.listAutomations();
    expect(rows.map((a) => a.id)).not.toContain(A.newContract);
    await expect(automations.cancelRun(R.done)).rejects.toThrow("not_found");
    await expect(automations.cancelRun("arun-nope")).rejects.toThrow("not_found");
  });

  it("le automazioni di un progetto le vedono i membri, le gestisce chi ha automations.manage nel progetto", async () => {
    as("p-marco");
    const detail = await automations.getAutomation(A.clientData);
    expect(detail?.automation.permissions.manage).toBe(false);
    await expect(automations.pause(A.clientData)).rejects.toThrow("forbidden");
    as("p-laura");
    expect((await automations.getAutomation(A.clientData))?.automation.permissions.manage).toBe(
      true,
    );
  });

  it("getRun dà il registro, il codice e i permessi; listRuns mette in alto quelle in corso", async () => {
    as("p-matteo");
    const detail = (await automations.getRun(R.waitingApproval))!;
    expect(detail.code).toBe("AUD-A1 #1");
    expect(detail.permissions).toMatchObject({ manage: true, approve: true, chooseProject: false });
    expect(detail.deciders).toEqual(["p-matteo"]);
    as("p-roberta");
    const runs = await automations.listRuns({ projectId: "prj-cbv" });
    // La generale AUT-1 #1 ha agito in CBV.
    expect(runs.map((r) => r.code)).toContain("AUT-1 #1");
    const all = await automations.listRuns();
    const firstDone = all.findIndex((r) => ["done", "failed", "cancelled"].includes(r.status));
    expect(
      all.slice(firstDone).every((r) => ["done", "failed", "cancelled"].includes(r.status)),
    ).toBe(true);
  });

  it("codici: <PRJ>-A<n> e AUT-<n>, mai riusati; esecuzioni numerate per automazione", async () => {
    as("p-laura");
    const a = await automations.createAutomation({ name: "Una", projectId: AUD });
    expect(a.code).toBe("AUD-A2");
    await automations.deleteDraft(a.id);
    const b = await automations.createAutomation({ name: "Due", projectId: AUD });
    expect(b.code).toBe("AUD-A3");
    as("p-roberta");
    expect((await automations.createAutomation({ name: "G", projectId: null })).code).toBe("AUT-2");
    connect("p-roberta");
    const [id] = await automations.simulateSourceEvent(S.audin, 0);
    expect(run(id!).n).toBe(3);
    expect((await automations.getRun(id!))?.code).toBe("AUT-1 #3");
  });

  it("una generale si crea solo col permesso d'istanza; un progetto che non vedo è not_found", async () => {
    as("p-laura");
    await expect(automations.createAutomation({ name: "G", projectId: null })).rejects.toThrow(
      "forbidden",
    );
    as("p-sara");
    await expect(automations.createAutomation({ name: "X", projectId: "prj-mkx" })).rejects.toThrow(
      "not_found",
    );
  });

  it("searchAutomations trova automazioni ed esecuzioni visibili, per codice e nome", async () => {
    as("p-laura");
    const found = await automations.searchAutomations("aud-a1");
    expect(found.map((r) => r.code)).toEqual(
      expect.arrayContaining(["AUD-A1", "AUD-A1 #1", "AUD-A1 #2"]),
    );
    expect((await automations.searchAutomations("contratto")).some((r) => r.code === "AUT-1")).toBe(
      false,
    );
  });

  it("sorgenti e tabella cliente → progetto: un progetto che non vedo resta senza id", async () => {
    as("p-sara");
    expect(await automations.listSources()).toEqual([]);
    grantInstancePermission("p-sara", "automations.manage");
    const links = await automations.listClientLinks();
    const mix = links.find((l) => l.clientKey === "mixcucine.example")!;
    expect(mix).toMatchObject({ projectVisible: false, projectId: "" });
    expect((await automations.listSources())[0]!.permissions.manage).toBe(false);
    await expect(automations.disconnectSource(S.audin)).rejects.toThrow("forbidden");
  });
});

// --- Review Focus 1: l'approvazione non si scavalca --------------------------------

describe("Automations: un'approvazione blocca davvero (Review Focus 1)", () => {
  it("l'approvatore che perde l'accesso al progetto non approva più e non la vede in «Da decidere»", async () => {
    as("p-matteo");
    expect((await automations.listMyApprovals()).map((d) => d.runId)).toContain(R.waitingApproval);
    leave("p-matteo", AUD);
    // Resta solo il progetto da scegliere di AUT-1 #2 (Matteo ne è il proprietario).
    expect((await automations.listMyApprovals()).map((d) => d.runId)).toEqual([R.waitingProject]);
    await expect(
      automations.approve(R.waitingApproval, undefined, at(R.waitingApproval)),
    ).rejects.toThrow("not_found");
    await idle();
    // R-J11: nessuno può più approvare → fallita `no_approver`, mai approvata da altri.
    expect(run(R.waitingApproval)).toMatchObject({ status: "failed", error: "no_approver" });
    expect(run(R.waitingApproval).log.at(-1)!.reason).toMatch(/Nessuno può approvare/);
    expect(sentBy("p-matteo")).toEqual([]);
  });

  it("chi approva si legge adesso: ripubblicata da un altro, `approverIds` nomina il proprietario nuovo", async () => {
    as("p-matteo");
    expect((await automations.getRun(R.waitingApproval))!.pending?.approverIds).toEqual([
      "p-matteo",
    ]);
    as("p-roberta");
    const a = state.automations.find((x) => x.id === A.clientData)!;
    await automations.saveDraft(A.clientData, a.versions[0]!.flow);
    connect("p-roberta");
    await automations.publish(A.clientData);
    await idle();
    const seen = (await automations.getRun(R.waitingApproval))!;
    expect(seen.status).toBe("waiting_approval");
    expect(seen.pending?.approverIds).toEqual(["p-roberta"]);
  });

  it("R-J11 scoperto da una lettura: chi mostra i dati è avvisato, una volta sola (niente cicli)", async () => {
    let calls = 0;
    const off = automations.onAutomationsSettled(() => calls++);
    leave("p-matteo", AUD);
    as("p-roberta");
    await automations.listRuns({});
    await Promise.resolve();
    expect(run(R.waitingApproval)).toMatchObject({ status: "failed", error: "no_approver" });
    expect(calls).toBe(1);
    // La rilettura che l'avviso provoca non fallisce più nulla: nessun avviso nuovo.
    await automations.listRuns({});
    await Promise.resolve();
    expect(calls).toBe(1);
    off();
  });

  it("una decisione dice sempre su che passo cade: un passo diverso da quello che aspetta è `not_waiting`", async () => {
    as("p-matteo");
    const stale = { expectedPath: "0" };
    expect(run(R.waitingApproval).cursor).not.toBe("0");
    await expect(automations.approve(R.waitingApproval, undefined, stale)).rejects.toThrow(
      "invalid: not_waiting",
    );
    await expect(automations.reject(R.waitingApproval, stale)).rejects.toThrow(
      "invalid: not_waiting",
    );
    await expect(automations.chooseProject(R.waitingProject, AUD, stale)).rejects.toThrow(
      "invalid: not_waiting",
    );
    await idle();
    expect(run(R.waitingApproval).status).toBe("waiting_approval");
    expect(run(R.waitingProject).status).toBe("waiting_project");
  });

  it("chi gestisce ma non è l'approvatore: forbidden (R-J8)", async () => {
    as("p-roberta");
    expect((await automations.getRun(R.waitingApproval))?.permissions.approve).toBe(false);
    await expect(
      automations.approve(R.waitingApproval, undefined, at(R.waitingApproval)),
    ).rejects.toThrow("forbidden");
    await expect(automations.reject(R.waitingApproval, at(R.waitingApproval))).rejects.toThrow(
      "forbidden",
    );
    await idle();
    expect(run(R.waitingApproval).status).toBe("waiting_approval");
  });

  it("pausa e riaccensione durante l'attesa: sospesa, non approvabile, poi di nuovo in attesa — nessun effetto prima", async () => {
    as("p-matteo");
    connect("p-matteo");
    const before = run(R.waitingApproval).log.length;
    await automations.pause(A.clientData);
    expect(run(R.waitingApproval)).toMatchObject({
      status: "suspended",
      suspendedFrom: "waiting_approval",
    });
    expect((await automations.listMyApprovals()).map((d) => d.runId)).toEqual([R.waitingProject]);
    await expect(
      automations.approve(R.waitingApproval, undefined, at(R.waitingApproval)),
    ).rejects.toThrow("invalid: suspended");
    await automations.advanceTime(R.waitingApproval, 10);
    await automations.activate(A.clientData);
    await idle();
    expect(run(R.waitingApproval).status).toBe("waiting_approval");
    expect(
      run(R.waitingApproval)
        .log.slice(before)
        .map((e) => e.outcome),
    ).toEqual(["suspended", "resumed"]);
    expect(sentBy("p-matteo")).toEqual([]);
    await automations.approve(R.waitingApproval, undefined, at(R.waitingApproval));
    await idle();
    expect(sentBy("p-matteo")).toHaveLength(1);
    expect(run(R.waitingApproval).status).toBe("waiting_event");
  });

  it("«Fai passare il tempo» non scavalca un'approvazione", async () => {
    as("p-matteo");
    connect("p-matteo");
    const log = run(R.waitingApproval).log.length;
    await automations.advanceTime(R.waitingApproval, 30);
    await idle();
    expect(run(R.waitingApproval).status).toBe("waiting_approval");
    expect(run(R.waitingApproval).log).toHaveLength(log);
    expect(sentBy("p-matteo")).toEqual([]);
  });

  it("un avvio annidato non salta l'approvazione dell'automazione avviata", async () => {
    as("p-laura");
    const child = await make(AUD, manual([task("c-1", { approval: ASK_OWNER })]), "Figlia");
    const parent = await make(
      AUD,
      manual([{ id: "p-1", kind: "startAutomation", automationId: child, approval: AUTO }]),
      "Madre",
    );
    const tasks = state.tasks.length;
    await automations.startManual(parent);
    await idle();
    const kid = lastRunOf(child);
    expect(kid.parentRunId).toBe(lastRunOf(parent).id);
    expect(kid.status).toBe("waiting_approval");
    expect(lastRunOf(parent).status).toBe("done");
    expect(state.tasks).toHaveLength(tasks);
    await automations.approve(kid.id, undefined, at(kid.id));
    await idle();
    expect(state.tasks).toHaveLength(tasks + 1);
    expect(state.tasks.at(-1)!.automationRef).toEqual({ automationId: child, runId: kid.id });
  });

  it("rifiutare annulla l'esecuzione (R-J7) senza effetti", async () => {
    as("p-matteo");
    await automations.reject(R.waitingApproval, at(R.waitingApproval));
    await idle();
    expect(run(R.waitingApproval)).toMatchObject({ status: "cancelled", error: "rejected" });
    expect(run(R.waitingApproval).log.at(-1)).toMatchObject({
      outcome: "rejected",
      byId: "p-matteo",
    });
    expect(sentBy("p-matteo")).toEqual([]);
  });

  it("un'email da approvare si corregge prima di approvarla (solo i campi dell'anteprima)", async () => {
    as("p-matteo");
    connect("p-matteo");
    await expect(
      automations.approve(R.waitingApproval, { cc: "x@example.com" }, at(R.waitingApproval)),
    ).rejects.toThrow("invalid: edited");
    await automations.approve(
      R.waitingApproval,
      { body: "Testo corretto." },
      at(R.waitingApproval),
    );
    await idle();
    expect(sentBy("p-matteo")[0]!.text).toBe("Testo corretto.");
  });
});

// --- Review Focus 3: proprietario e permessi --------------------------------------

describe("Automations: proprietario e permessi (Review Focus 3)", () => {
  it("il proprietario perde tickets.create a metà esecuzione: passo fallito «permesso perso», poi Riprova", async () => {
    as("p-laura");
    const id = await make(AUD, manual([{ id: "w", kind: "wait", for: { days: 1 } }, task("t")]));
    await automations.startManual(id);
    await idle();
    const r = lastRunOf(id);
    expect(r.status).toBe("waiting_event");
    grantProjectRole("p-laura", AUD, "viewer");
    const tasks = state.tasks.length;
    as("p-roberta");
    await automations.advanceTime(r.id, 2);
    await idle();
    expect(run(r.id)).toMatchObject({ status: "failed", error: "permission_lost" });
    expect(run(r.id).log.at(-1)!.reason).toMatch(/Permesso perso/);
    expect(state.tasks).toHaveLength(tasks);
    grantProjectRole("p-laura", AUD, "project_lead");
    as("p-laura");
    await automations.retryStep(r.id);
    await idle();
    expect(run(r.id).status).toBe("done");
    expect(run(r.id).log.find((e) => e.outcome === "retried")).toMatchObject({
      byId: "p-laura",
      kind: "createTask",
    });
    expect(state.tasks.at(-1)).toMatchObject({ createdById: "p-laura", source: "automation" });
  });

  it("chi ripubblica diventa il proprietario: le approvazioni del proprietario passano a lui", async () => {
    as("p-roberta");
    const a = state.automations.find((x) => x.id === A.clientData)!;
    await automations.saveDraft(A.clientData, a.versions[0]!.flow);
    // Chi pubblica un flusso con email deve avere una casella collegata (Task 5, [A 12]).
    connect("p-roberta");
    await automations.publish(A.clientData);
    expect(a.ownerId).toBe("p-roberta");
    expect((await automations.listMyApprovals()).map((d) => d.runId)).toContain(R.waitingApproval);
    as("p-matteo");
    await expect(
      automations.approve(R.waitingApproval, undefined, at(R.waitingApproval)),
    ).rejects.toThrow("forbidden");
    // L'email ora partirebbe dalla casella di Roberta, che nel frattempo l'ha scollegata.
    state.mailboxes = state.mailboxes.filter((b) => b.personId !== "p-roberta");
    as("p-roberta");
    await automations.approve(R.waitingApproval, undefined, at(R.waitingApproval));
    await idle();
    expect(run(R.waitingApproval)).toMatchObject({ status: "failed", error: "mailbox_missing" });
  });

  it("un'email da una casella scaduta: passo fallito, nessun invio", async () => {
    as("p-matteo");
    expire("p-matteo");
    await automations.approve(R.waitingApproval, undefined, at(R.waitingApproval));
    await idle();
    expect(run(R.waitingApproval)).toMatchObject({ status: "failed", error: "mailbox_expired" });
    expect(run(R.waitingApproval).log.at(-1)).toMatchObject({
      outcome: "failed",
      kind: "sendEmail",
    });
    expect(sentBy("p-matteo")).toEqual([]);
    connect("p-matteo");
    await automations.retryStep(R.waitingApproval);
    await idle();
    // Riprovare riapre l'approvazione: niente parte senza.
    expect(run(R.waitingApproval).status).toBe("waiting_approval");
    expect(sentBy("p-matteo")).toEqual([]);
  });

  it("cliente → progetto che il proprietario non vede: «scegli il progetto» per lui", async () => {
    grantInstancePermission("p-sara", "automations.manage");
    as("p-roberta");
    await automations.pause(A.newContract);
    as("p-sara");
    connect("p-sara");
    await automations.activate(A.newContract);
    expect(visibleProjectIds("p-sara").has("prj-mkx")).toBe(false);
    const [id] = await automations.simulateSourceEvent(S.audin, 1);
    await idle();
    expect(run(id!)).toMatchObject({ status: "waiting_project" });
    expect(run(id!).pending?.approverIds).toEqual(["p-sara"]);
    // Anche l'attesa del seme (AUT-1 #2) ora è sua: è lei la proprietaria.
    const mine = await automations.listMyApprovals();
    expect(mine.map((d) => [d.runId, d.kind])).toEqual([
      [R.waitingProject, "project"],
      [id, "project"],
    ]);
    expect(state.milestones.some((m) => m.automationRef?.runId === id)).toBe(false);
    await expect(automations.chooseProject(id!, "prj-mkx", at(id!))).rejects.toThrow("not_found");
    as("p-laura");
    await expect(automations.chooseProject(id!, AUD, at(id!))).rejects.toThrow("not_found");
    as("p-sara");
    const cbv = "prj-cbv";
    grantProjectRole("p-sara", cbv, "project_lead");
    await automations.chooseProject(id!, cbv, at(id!));
    await idle();
    expect(run(id!).log.find((e) => e.byId === "p-sara")).toMatchObject({ outcome: "approved" });
    expect(run(id!).projectIds).toContain(cbv);
    expect(state.milestones.find((m) => m.automationRef?.runId === id)?.projectId).toBe(cbv);
  });
});

// --- Review Focus 4: modifiche durante le esecuzioni --------------------------------

describe("Automations: modifiche durante le esecuzioni (Review Focus 4)", () => {
  it("versione nuova pubblicata con esecuzioni in corso: quelle finiscono con la loro", async () => {
    connect("p-roberta");
    await automations.publish(A.newContract);
    const a = state.automations.find((x) => x.id === A.newContract)!;
    expect(a.versions.map((v) => v.publishedAt !== null)).toEqual([true, true]);
    await automations.chooseProject(R.waitingProject, "prj-cbv", at(R.waitingProject));
    await idle();
    const old = run(R.waitingProject);
    expect(old).toMatchObject({ version: 1, status: "waiting_approval" });
    expect(old.pending?.preview.subject).toBe("Benvenuti in Audin, Forneria Rossi & Lari");
    const [id] = await automations.simulateSourceEvent(S.audin, 0);
    await idle();
    expect(run(id!)).toMatchObject({ version: 2, status: "waiting_approval" });
    expect(run(id!).pending?.preview.subject).toBe(
      "Benvenuti, Cantina Bellavista Srl: i prossimi passi con Audin",
    );
  });

  it("un passo eliminato nella bozza non tocca l'esecuzione in corso", async () => {
    as("p-laura");
    const a = state.automations.find((x) => x.id === A.clientData)!;
    const flow = structuredClone(a.versions[0]!.flow);
    flow.steps = flow.steps.slice(0, 2);
    await automations.saveDraft(A.clientData, flow);
    // Salvare una bozza non cambia il proprietario: approva ancora Matteo.
    as("p-matteo");
    await automations.approve(R.waitingApproval, undefined, at(R.waitingApproval));
    await idle();
    expect(run(R.waitingApproval)).toMatchObject({ status: "waiting_event", version: 1 });
    expect(run(R.waitingApproval).cursor).toBe("3/then/0/mancano informazioni/1");
  });

  it("sorgente scollegata: errore di configurazione, niente avvii nuovi, le esecuzioni in corso vanno avanti", async () => {
    await automations.disconnectSource(S.audin);
    const detail = (await automations.getAutomation(A.newContract))!;
    expect(detail.liveErrors.map((e) => e.code)).toContain("source_disconnected");
    await expect(automations.simulateSourceEvent(S.audin, 0)).rejects.toThrow(
      "invalid: source_not_connected",
    );
    await automations.pause(A.newContract);
    await expect(automations.activate(A.newContract)).rejects.toThrow("invalid: config");
    await automations.connectSource(S.audin);
    connect("p-roberta");
    await automations.activate(A.newContract);
    await automations.disconnectSource(S.audin);
    await automations.chooseProject(R.waitingProject, "prj-cbv", at(R.waitingProject));
    await idle();
    expect(run(R.waitingProject).status).toBe("waiting_approval");
  });

  it("pausa con un'esecuzione in waiting_event: sospesa, la risposta arrivata in pausa si perde, poi riprende", async () => {
    as("p-matteo");
    connect("p-matteo");
    const [id] = await automations.simulateSourceEvent(S.webhook, 1);
    await idle();
    const r = run(id!);
    expect(r.status).toBe("waiting_event");
    const ask = sentBy("p-matteo")[0]!;
    await automations.pause(A.clientData);
    expect(run(id!)).toMatchObject({ status: "suspended", suspendedFrom: "waiting_event" });
    expect(run(id!).waitingUntil).not.toBeNull();
    await mail.simulateReply(ask.threadId, "Ecco il numero WhatsApp Business.");
    await idle();
    expect(run(id!).status).toBe("suspended");
    await automations.activate(A.clientData);
    await idle();
    // La risposta arrivata in pausa non è recuperata.
    expect(run(id!).status).toBe("waiting_event");
    expect(run(id!).vars["risposta.testo"]).toBeUndefined();
    await mail.simulateReply(
      ask.threadId,
      "Il numero WhatsApp Business è 333 000111; il logo in alta risoluzione è allegato; l'elenco dei contatti con il consenso arriva domani.",
    );
    await idle();
    expect(run(id!).vars["risposta.arrivata"]).toBe(true);
  });

  it("R-J10: l'esecuzione del seme in attesa del cliente si sblocca con la risposta simulata nella sua conversazione", async () => {
    as("p-matteo");
    const seeded = run(R.waitingEvent);
    const ask = state.mailMessages.find((m) => m.id === AUTOMATION_MAIL_IDS.mixAsk)!;
    expect(seeded.log.find((e) => e.stepId === "cd-ask")?.effects).toEqual([
      { kind: "email", code: ask.id },
    ]);
    await mail.simulateReply(
      ask.threadId,
      "Il numero WhatsApp Business è 333 000111, il logo in alta risoluzione è allegato e l'elenco dei contatti con il consenso pure.",
    );
    await idle();
    const r = run(R.waitingEvent);
    expect(r.log.find((e) => e.stepId === "cd-wait" && e.outcome === "ok")?.output).toMatchObject({
      "risposta.arrivata": true,
    });
    expect(r.log.find((e) => e.kind === "claude")?.output.uscita).toBe("tutto presente");
    expect(r.status).toBe("done");
  });

  it("pausa mentre un effetto è in volo: si sospende al confine del passo, senza ripeterlo", async () => {
    as("p-laura");
    const id = await make(AUD, manual([task("a"), task("b")]));
    // La pausa arriva esattamente mentre il primo effetto è in esecuzione:
    // dentro `createTaskAs` della task «a» (come farebbe `pause` in quel momento).
    const off = onAutomationSignal((s) => {
      if (s.kind === "task_created" && state.tasksById.get(s.taskId)?.title === "Task a")
        state.automations.find((a) => a.id === id)!.status = "paused";
    });
    const r = await automations.startManual(id);
    await idle();
    off();
    const made = () => state.tasks.filter((t) => t.automationRef?.runId === r).map((t) => t.title);
    // L'effetto in volo è finito; quello dopo non è partito e aspetta al suo passo.
    expect(made()).toEqual(["Task a"]);
    expect(run(r)).toMatchObject({ status: "suspended", suspendedFrom: "running", cursor: "1" });
    expect(run(r).log.at(-1)).toMatchObject({ outcome: "suspended", path: "1" });
    await automations.activate(id);
    await idle();
    expect(run(r).status).toBe("done");
    expect(made()).toEqual(["Task a", "Task b"]);
  });
});

// --- il flusso del seme, la Posta, gli stati ---------------------------------------

describe("Automations: esecuzioni vere", () => {
  it("«Nuovo contratto» da una trattativa Audin: Claude, traguardo, task per reparto, email da approvare", async () => {
    const [id] = await automations.simulateSourceEvent(S.audin, 0);
    expect(run(id!).status).toBe("running");
    await idle();
    const r = run(id!);
    expect(r).toMatchObject({ status: "waiting_approval", projectIds: ["prj-cbv"], version: 1 });
    expect(r.title).toBe("Nuovo contratto – Cantina Bellavista Srl");
    const ms = state.milestones.find((m) => m.automationRef?.runId === id)!;
    expect(ms).toMatchObject({
      projectId: "prj-cbv",
      name: "Attivazione CRM – Cantina Bellavista Srl",
    });
    const made = state.tasks.filter((t) => t.automationRef?.runId === id);
    expect(made.map((t) => [t.title, t.departmentId])).toEqual([
      ["Importare l'anagrafica clienti nel CRM", "dep-development"],
      ["Pianificare le sessioni di formazione sul CRM", "dep-sales"],
      ["Configurare il Centralino AI", "dep-support"],
      ["Fatturare il primo canone all'attivazione", "dep-administration"],
    ]);
    expect(made.every((t) => t.milestoneId === ms.id && t.assigneeId === null)).toBe(true);
    // Il registro: ogni passo con i suoi codici, Claude con la motivazione.
    expect(r.log.find((e) => e.kind === "claude")?.reason).toMatch(/contratto/);
    expect(r.log.filter((e) => e.kind === "createTask").flatMap((e) => e.effects)).toHaveLength(4);
    // L'email di benvenuto la approva il proprietario (Matteo, R-J10), e parte dalla sua casella.
    await expect(automations.approve(id!, undefined, at(id!))).rejects.toThrow("forbidden");
    as("p-matteo");
    await automations.approve(id!, undefined, at(id!));
    await idle();
    expect(run(id!).status).toBe("done");
    expect(sentBy("p-matteo")[0]!.to[0]!.email).toBe("amministrazione@cantinabellavista.example");
  });

  it("la risposta del cliente simulata nella Posta sblocca wait.replyTo; Claude verifica; i promemoria stanno nella stessa conversazione", async () => {
    as("p-matteo");
    connect("p-matteo");
    const [id] = await automations.simulateSourceEvent(S.webhook, 0);
    await idle();
    expect(run(id!).status).toBe("waiting_event");
    const ask = sentBy("p-matteo")[0]!;
    // Nessuna risposta in 5 giorni: il primo promemoria, nella stessa conversazione.
    await automations.advanceTime(id!, 6);
    await idle();
    expect(sentBy("p-matteo")).toHaveLength(2);
    expect(sentBy("p-matteo")[1]!.threadId).toBe(ask.threadId);
    expect(run(id!).cursor).toBe("2/repeat[0]/1");
    await mail.simulateReply(
      ask.threadId,
      "I numeri da collegare sono 0577 000111 e 0577 000112; gli orari di apertura dalle 9 alle 18; il messaggio di benvenuto: «Benvenuti in cantina».",
    );
    await idle();
    const r = run(id!);
    expect(r.status).toBe("done");
    expect(r.log.find((e) => e.kind === "claude")?.output.uscita).toBe("tutto presente");
    expect(state.tasks.at(-1)).toMatchObject({
      title: "Attivare Centralino AI per Cantina Bellavista Srl",
      automationRef: { automationId: A.clientData, runId: id },
    });
  });

  it("una risposta da un'altra conversazione o di un collega non sblocca l'attesa", async () => {
    as("p-matteo");
    connect("p-matteo");
    const [id] = await automations.simulateSourceEvent(S.webhook, 1);
    await idle();
    const ask = sentBy("p-matteo")[0]!;
    // Un esterno, ma in un'altra conversazione della casella di Matteo.
    const stranger = state.mailMessages.find(
      (m) =>
        m.mailboxPersonIds.includes("p-matteo") &&
        m.from.personId === null &&
        m.threadId !== ask.threadId,
    )!;
    // Un collega, nella conversazione giusta.
    const colleague = {
      ...structuredClone(ask),
      id: "mm-colleague",
      from: { name: "Giulia Ferri", email: "giulia.ferri@example.com", personId: "p-giulia" },
      text: "Ecco tutto.",
      delivery: undefined,
    };
    state.mailMessages.push(colleague);
    signalAutomations({ kind: "mail_received", messageIds: [stranger.id, colleague.id] });
    await idle();
    expect(run(id!).status).toBe("waiting_event");
    // La risposta vera del cliente, nella stessa conversazione, sì.
    await mail.simulateReply(ask.threadId, "Ecco il numero.");
    await idle();
    expect(run(id!).vars["risposta.testo"]).toBe("Ecco il numero.");
  });

  it("ogni stato dell'esecuzione è raggiungibile", async () => {
    as("p-laura");
    // Solo stati raggiunti da esecuzioni nate nel test, non quelli del seme.
    const seen = new Set<string>();
    const id = await make(
      AUD,
      manual([task("a"), { id: "w", kind: "wait", for: { days: 2 } }, task("t")]),
    );
    // Durante l'effetto del primo passo l'esecuzione è `running`.
    const off = onAutomationSignal((s) => {
      if (s.kind !== "task_created") return;
      const r = state.automationRuns.find((x) => x.automationId === id && x.status === "running");
      if (r) seen.add(r.status);
    });
    const started = await automations.startManual(id);
    await idle();
    off();
    seen.add(run(started).status);
    // In attesa di approvazione.
    const asking = await make(AUD, manual([task("q", { approval: ASK_OWNER })]), "Chiede");
    seen.add(run(await automations.startManual(asking)).status);
    await idle();
    seen.add(lastRunOf(asking).status);
    // Fallita: il ritardo simulato dell'effetto non risponde.
    failNext("automations.advanceRun");
    const broken = await automations.startManual(id);
    await idle();
    seen.add(run(broken).status);
    // In attesa del progetto: un cliente che non è nella tabella (Forneria).
    as("p-roberta");
    const [orphan] = await automations.simulateSourceEvent(S.audin, 2);
    await idle();
    seen.add(run(orphan!).status);
    as("p-laura");
    await automations.pause(id);
    seen.add(run(started).status);
    await automations.activate(id);
    await automations.advanceTime(started, 3);
    await idle();
    seen.add(run(started).status);
    const other = await automations.startManual(id);
    await idle();
    await automations.cancelRun(other);
    seen.add(run(other).status);
    expect([...seen].sort()).toEqual(
      [
        "cancelled",
        "done",
        "failed",
        "running",
        "suspended",
        "waiting_approval",
        "waiting_event",
        "waiting_project",
      ].sort(),
    );
    expect(run(other).log.at(-1)).toMatchObject({ outcome: "cancelled", byId: "p-laura" });
  });

  it("«Salta» un passo fallito: l'esecuzione prosegue da quello dopo", async () => {
    as("p-matteo");
    expire("p-matteo");
    await automations.approve(R.waitingApproval, undefined, at(R.waitingApproval));
    await idle();
    expect(run(R.waitingApproval).error).toBe("mailbox_expired");
    await automations.skipStep(R.waitingApproval);
    await idle();
    // Dopo l'email saltata: l'attesa della sua risposta.
    expect(run(R.waitingApproval)).toMatchObject({
      status: "waiting_event",
      cursor: "3/then/0/mancano informazioni/1",
    });
    expect(
      run(R.waitingApproval).log.find((e) => e.reason?.startsWith("Passo saltato")),
    ).toMatchObject({
      outcome: "skipped",
      byId: "p-matteo",
    });
  });

  it("il ritardo simulato che fallisce: passo fallito senza essere eseguito, Riprova lo esegue", async () => {
    as("p-laura");
    const id = await make(AUD, manual([task("t")]));
    failNext("automations.advanceRun");
    const r = await automations.startManual(id);
    await idle();
    expect(run(r)).toMatchObject({ status: "failed", error: "unavailable" });
    expect(state.tasks.some((t) => t.automationRef?.runId === r)).toBe(false);
    await automations.retryStep(r);
    await idle();
    expect(run(r).status).toBe("done");
    expect(state.tasks.filter((t) => t.automationRef?.runId === r)).toHaveLength(1);
  });

  it("resetApi ripulisce: esecuzioni, orologi e il lavoro in volo non scrive nello stato nuovo", async () => {
    as("p-laura");
    const id = await make(AUD, manual([task("t")]));
    setLatency(30);
    await automations.startManual(id);
    resetApi();
    setLatency(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await idle();
    expect(state.automations.some((a) => a.id === id)).toBe(false);
    expect(state.automationRuns.map((r) => r.id)).toEqual(Object.values(R));
    expect(
      state.tasks.some((t) => t.source === "automation" && t.automationRef?.automationId === id),
    ).toBe(false);
    expect(state.automationClock.size).toBe(0);
  });
});

// --- inizi di Stubwise, date, catene, limiti ---------------------------------------

describe("Automations: inizi e catene", () => {
  const onTaskCreated = (steps: Step[]): AutomationFlow => ({
    trigger: { kind: "stubwise", event: "task_created" },
    steps,
    titleTemplate: "Nuova task {{task.codice}}",
  });

  it("task creata: parte per il suo progetto, e una task creata dall'esecuzione non la riavvia", async () => {
    as("p-laura");
    const id = await make(AUD, onTaskCreated([task("t")]));
    await createTask({ projectId: "prj-stw", title: "Altrove" });
    await idle();
    expect(runsOf(id)).toHaveLength(0);
    await createTask({ projectId: AUD, title: "Qui" });
    await idle();
    expect(runsOf(id)).toHaveLength(1);
    expect(runsOf(id)[0]).toMatchObject({ status: "done" });
    expect(runsOf(id)[0]!.title).toMatch(/^Nuova task AUD-/);
  });

  it("email in arrivo: solo dalle caselle del proprietario", async () => {
    as("p-laura");
    const id = await make(AUD, {
      trigger: { kind: "stubwise", event: "mail_received" },
      steps: [task("t")],
      titleTemplate: "Email: {{email.oggetto}}",
    });
    const theirs = state.mailMessages.find(
      (m) => !m.mailboxPersonIds.includes("p-laura") && m.mailboxPersonIds.length > 0,
    )!;
    signalAutomations({ kind: "mail_received", messageIds: [theirs.id] });
    await idle();
    expect(runsOf(id)).toHaveLength(0);
    const mine = state.mailMessages.find((m) => m.mailboxPersonIds.includes("p-laura"))!;
    signalAutomations({ kind: "mail_received", messageIds: [mine.id] });
    await idle();
    expect(runsOf(id)).toHaveLength(1);
  });

  it("una ricorrenza parte una volta sola al giorno, se cade adesso", async () => {
    as("p-laura");
    // Oggi (23 ottobre 2026) è venerdì, a mezzogiorno.
    const id = await make(AUD, {
      trigger: { kind: "schedule", rule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9" },
      steps: [task("t")],
      titleTemplate: "Settimanale",
    });
    const monday = await make(AUD, {
      trigger: { kind: "schedule", rule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9" },
      steps: [task("t")],
      titleTemplate: "Lunedì",
    });
    expect(await automations.runDueSchedules()).toHaveLength(1);
    expect(await automations.runDueSchedules()).toHaveLength(0);
    await idle();
    expect(runsOf(id)).toHaveLength(1);
    expect(runsOf(monday)).toHaveLength(0);
  });

  it("configurazione: avviare un'automazione sconosciuta o sé stessa (A → … → A) è un errore e non si pubblica", async () => {
    as("p-laura");
    const a = await automations.createAutomation({ name: "A", projectId: AUD });
    await automations.saveDraft(
      a.id,
      manual([{ id: "s", kind: "startAutomation", automationId: "aut-nope", approval: AUTO }]),
    );
    expect((await automations.getAutomation(a.id))!.configErrors).toEqual([
      expect.objectContaining({ path: "0", code: "unknown_ref" }),
    ]);
    await expect(automations.publish(a.id)).rejects.toThrow("invalid: config");
    // A → B → A.
    const b = await make(
      AUD,
      manual([{ id: "s", kind: "startAutomation", automationId: a.id, approval: AUTO }]),
      "B",
    );
    await automations.saveDraft(
      a.id,
      manual([{ id: "s", kind: "startAutomation", automationId: b, approval: AUTO }]),
    );
    expect((await automations.getAutomation(a.id))!.configErrors).toEqual([
      expect.objectContaining({ path: "0", code: "limit" }),
    ]);
    await expect(automations.activate(a.id)).rejects.toThrow("invalid: config");
  });

  it("R-J21: «Avvia un'altra automazione» vuole che il proprietario possa gestire quella da avviare, non solo vederla", async () => {
    as("p-laura");
    const target = await make(AUD, manual([task("t")]), "Bersaglio");
    grantInstancePermission("p-laura", "automations.manage");
    const parent = await make(
      null,
      manual([{ id: "s", kind: "startAutomation", automationId: target, approval: AUTO }]),
      "Madre",
    );
    // Laura resta nel progetto ma non gestisce più le sue automazioni.
    grantProjectRole("p-laura", AUD, "viewer");
    expect(visibleProjectIds("p-laura").has(AUD)).toBe(true);
    expect((await automations.getAutomation(parent))!.configErrors).toEqual([
      expect.objectContaining({ path: "0", code: "unknown_ref" }),
    ]);
    as("p-roberta");
    await automations.startManual(parent);
    await idle();
    expect(lastRunOf(parent)).toMatchObject({ status: "failed", error: "permission_lost" });
    expect(runsOf(target)).toHaveLength(0);
  });

  it("una catena di avvii si ferma alla profondità 3", async () => {
    as("p-laura");
    const d = await make(AUD, manual([task("d")]), "D");
    const starts = (target: string): AutomationFlow =>
      manual([{ id: "s", kind: "startAutomation", automationId: target, approval: AUTO }]);
    const c = await make(AUD, starts(d), "C");
    const b = await make(AUD, starts(c), "B");
    const a = await make(AUD, starts(b), "A");
    await automations.startManual(a);
    await idle();
    expect(lastRunOf(a).status).toBe("done");
    expect(lastRunOf(b).status).toBe("done");
    expect(lastRunOf(c)).toMatchObject({ status: "failed", error: "chain_limit" });
    expect(runsOf(d)).toHaveLength(0);
  });

  it("al massimo 100 esecuzioni non finite per automazione", async () => {
    as("p-laura");
    const id = await make(AUD, manual([{ id: "w", kind: "wait", for: { days: 1 } }]));
    for (let i = 0; i < automations.MAX_ACTIVE_RUNS; i++) await automations.startManual(id);
    await idle();
    await expect(automations.startManual(id)).rejects.toThrow("invalid: run_limit");
    expect(runsOf(id)).toHaveLength(automations.MAX_ACTIVE_RUNS);
  });

  it("«Avvisa» con la persona vuota è un passo fallito, non un avviso a nessuno", async () => {
    as("p-laura");
    const notifications = state.notifications.length;
    const id = await make(AUD, {
      trigger: { kind: "stubwise", event: "task_created" },
      steps: [
        {
          id: "n",
          kind: "notify",
          who: { personRef: "task.incaricato" },
          text: "Ciao",
          approval: AUTO,
        },
      ],
      titleTemplate: "{{task.codice}}",
    });
    // Una task senza incaricato: la persona da avvisare è vuota.
    await createTask({ projectId: AUD, title: "Senza incaricato" });
    await idle();
    expect(lastRunOf(id)).toMatchObject({ status: "failed", error: "no_recipient" });
    expect(state.notifications).toHaveLength(notifications);
    // Con la persona: l'avviso arriva a lei, col codice dell'esecuzione.
    await createTask({ projectId: AUD, title: "A Marco", assigneeId: "p-marco" });
    await idle();
    expect(lastRunOf(id).status).toBe("done");
    expect(state.notifications.at(-1)).toMatchObject({
      recipientIds: ["p-marco"],
      objectCode: `${state.automations.find((a) => a.id === id)!.code} #2`,
    });
  });

  it("il limite di 20 email vale per la catena intera", async () => {
    as("p-laura");
    connect("p-laura");
    const flowOn = (extra: Step[]): AutomationFlow => ({
      trigger: { kind: "source", sourceId: S.audin, event: "deal_won" },
      titleTemplate: "Email",
      steps: [
        {
          id: "each",
          kind: "forEach",
          list: "trattativa.prodotti",
          as: "p",
          steps: [
            {
              id: "mail",
              kind: "sendEmail",
              to: "{{cliente.email}}",
              subject: "{{p.nome}}",
              body: "Ciao",
              attachRefs: [],
              approval: AUTO,
            },
          ],
        },
        ...extra,
      ],
    });
    const child = await make(AUD, flowOn([]), "Figlia");
    const parent = await make(
      AUD,
      flowOn([{ id: "s", kind: "startAutomation", automationId: child, approval: AUTO }]),
      "Madre",
    );
    const event = {
      trattativa: { prodotti: Array.from({ length: 15 }, (_, i) => ({ nome: `P${i}` })) },
      cliente: { email: "cliente@client.example" },
    };
    await automations.startManual(parent, event);
    await idle();
    expect(lastRunOf(parent).status).toBe("done");
    expect(lastRunOf(child)).toMatchObject({ status: "failed", error: "email_limit" });
    expect(sentBy("p-laura")).toHaveLength(20);
  });
});

// --- revisione del Task 3 ------------------------------------------------------------

describe("Automations: revisione del Task 3", () => {
  const closedStatus = (projectId: string) =>
    state.statuses.find((s) => s.projectId === projectId && s.family === "closed")!.id;

  it("pausa subito dopo un'approvazione: l'approvazione già data non si perde, si sospende al passo dopo", async () => {
    as("p-matteo");
    await Promise.all([
      automations.approve(R.waitingApproval, undefined, at(R.waitingApproval)),
      automations.pause(A.clientData),
    ]);
    await idle();
    // L'email approvata è partita; la pausa ferma l'esecuzione sull'attesa che segue.
    expect(sentBy("p-matteo")).toHaveLength(1);
    expect(run(R.waitingApproval)).toMatchObject({
      status: "suspended",
      suspendedFrom: "waiting_event",
    });
    expect(run(R.waitingApproval).log.some((e) => e.outcome === "approved")).toBe(true);
    await automations.activate(A.clientData);
    await idle();
    expect(run(R.waitingApproval).status).toBe("waiting_event");
    expect(sentBy("p-matteo")).toHaveLength(1);
  });

  it("R-J11: un'approvazione che nessuno può dare fallisce `no_approver`, e il proprietario lo sa", async () => {
    as("p-laura");
    const id = await make(
      AUD,
      manual([task("t", { approval: { mode: "ask", who: { personId: "p-marco" } } })]),
    );
    leave("p-marco", AUD);
    const r = await automations.startManual(id);
    await idle();
    expect(run(r)).toMatchObject({ status: "failed", error: "no_approver", pending: null });
    expect(state.tasks.some((t) => t.automationRef?.runId === r)).toBe(false);
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "automation.failed",
      recipientIds: ["p-laura"],
    });
    expect((await automations.getRun(r))?.log.at(-1)).toMatchObject({ outcome: "failed" });
  });

  it("R-J11: un approvatore (persona) che non vede un progetto in cui il passo può agire è un errore di configurazione", async () => {
    as("p-roberta");
    const flowFor = (personId: string): AutomationFlow => ({
      trigger: { kind: "source", sourceId: S.audin, event: "deal_won" },
      titleTemplate: "Prova",
      steps: [
        task("t", {
          project: { mode: "from_client", clientRef: "cliente.dominio" },
          approval: { mode: "ask", who: { personId } },
        }),
      ],
    });
    const a = await automations.createAutomation({
      name: "G",
      projectId: null,
      flow: flowFor("p-sara"),
    });
    // Sara non vede MKX, uno dei progetti della tabella cliente → progetto.
    expect((await automations.getAutomation(a.id))!.configErrors).toEqual([
      expect.objectContaining({ path: "0", code: "approver_cant_see" }),
    ]);
    await automations.saveDraft(a.id, flowFor("p-roberta"));
    expect((await automations.getAutomation(a.id))!.configErrors).toEqual([]);
  });

  it("R-J12: dentro un'esecuzione i progetti che non vedo non hanno né id né codice; filtrare per uno di essi è come per uno inesistente", async () => {
    grantInstancePermission("p-laura", "automations.manage");
    as("p-laura");
    expect(visibleProjectIds("p-laura").has("prj-cbv")).toBe(false);
    const r = (await automations.getRun(R.done))!;
    expect(r.projectIds).toEqual([]);
    const ms = r.log.find((e) => e.kind === "createMilestone")!;
    expect(ms.input.progetto).toBe("");
    expect(ms.effects).toEqual([{ kind: "milestone", code: "" }]);
    const tasks = r.log.filter((e) => e.kind === "createTask");
    expect(
      tasks.every((e) => e.effects.every((x) => x.code === "") && e.input.progetto === ""),
    ).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/prj-cbv|CBV-\d|ms-cbv/);
    expect(await automations.listRuns({ projectId: "prj-cbv" })).toEqual(
      await automations.listRuns({ projectId: "prj-nope" }),
    );
    expect(await automations.listRuns({ projectId: "prj-cbv" })).toEqual([]);
    // Chi vede CBV vede tutto.
    as("p-matteo");
    const full = (await automations.getRun(R.done))!;
    expect(full.projectIds).toEqual(["prj-cbv"]);
    expect(full.log.find((e) => e.kind === "createMilestone")!.effects[0]!.code).toBe(
      "ms-cbv-aut1",
    );
  });

  it("R-G5 nel flusso: un progetto fisso che non vedo non ha id in automazione ed esecuzione, e salvare non lo perde", async () => {
    as("p-roberta");
    const id = await make(
      null,
      manual([task("t", { project: { mode: "fixed", projectId: "prj-cbv" } })]),
      "Fissa",
    );
    const r = await automations.startManual(id);
    await idle();
    grantInstancePermission("p-laura", "automations.manage");
    as("p-laura");
    expect(visibleProjectIds("p-laura").has("prj-cbv")).toBe(false);
    const detail = (await automations.getAutomation(id))!;
    expect(JSON.stringify(detail)).not.toContain("prj-cbv");
    expect(JSON.stringify(await automations.listAutomations())).not.toContain("prj-cbv");
    expect(JSON.stringify(await automations.getRun(r))).not.toContain("prj-cbv");
    // Laura gestisce e salva il flusso come lo vede: il progetto resta quello di prima.
    const flow = detail.automation.versions.at(-1)!.flow;
    expect(await automations.checkDraft(id, flow)).toEqual([]);
    await automations.saveDraft(id, { ...flow, titleTemplate: "Fissa 2" });
    const saved = state.automations.find((a) => a.id === id)!.versions.at(-1)!.flow;
    expect(saved.steps[0]).toMatchObject({ project: { mode: "fixed", projectId: "prj-cbv" } });
  });

  it("R-J13 nelle motivazioni: un passo fallito su un dato dell'email non lo ripete a chi non è il proprietario", async () => {
    as("p-laura");
    connect("p-laura");
    const id = await make(AUD, {
      trigger: { kind: "stubwise", event: "mail_received" },
      titleTemplate: "Email",
      steps: [
        {
          id: "e",
          kind: "sendEmail",
          to: "{{email.oggetto}}",
          subject: "Re",
          body: "ciao",
          attachRefs: [],
          approval: AUTO,
        } as Step,
      ],
    });
    const mine = state.mailMessages.find(
      (m) => m.mailboxPersonIds.includes("p-laura") && m.subject.length > 8,
    )!;
    signalAutomations({ kind: "mail_received", messageIds: [mine.id] });
    await idle();
    const r = lastRunOf(id);
    expect(r).toMatchObject({ status: "failed", error: "invalid_address" });
    // Il proprietario legge il motivo coi suoi dati.
    expect(JSON.stringify((await automations.getRun(r.id))!.log)).toContain(mine.subject);
    as("p-marco");
    const seen = (await automations.getRun(r.id))!;
    expect(JSON.stringify(seen)).not.toContain(mine.subject);
    const failed = seen.log.find((e) => e.outcome === "failed")!;
    expect(failed.why?.code).toBe("invalidAddress");
    expect(failed.reason).toBeNull();
  });

  it("R-G5 attraverso «Avvia un'altra automazione»: chi vede la madre ma non la figlia non ne legge codice, id né nome", async () => {
    as("p-roberta");
    const STW = "prj-stw";
    expect(visibleProjectIds("p-sara").has(STW)).toBe(true);
    expect(visibleProjectIds("p-sara").has(AUD)).toBe(false);
    const target = await make(AUD, manual([task("t")]), "Bersaglio segreto");
    const code = state.automations.find((a) => a.id === target)!.code;
    const parent = await make(
      STW,
      manual([{ id: "s", kind: "startAutomation", automationId: target, approval: AUTO }]),
      "Madre",
    );
    const ok = await automations.startManual(parent);
    await idle();
    // Ora il bersaglio è in pausa: il secondo avvio fallisce col suo nome nel motivo.
    await automations.pause(target);
    const ko = await automations.startManual(parent);
    await idle();
    expect(run(ok).log.some((e) => e.effects.some((x) => x.kind === "run" && x.code))).toBe(true);
    expect(run(ko)).toMatchObject({ status: "failed", error: "automation_not_active" });
    as("p-sara");
    for (const r of [ok, ko]) {
      const seen = JSON.stringify(await automations.getRun(r));
      expect(seen).not.toContain(code);
      expect(seen).not.toContain(target);
      expect(seen).not.toContain("Bersaglio");
    }
    expect(JSON.stringify(await automations.getAutomation(parent))).not.toContain(target);
    // Chi vede la figlia la legge intera.
    as("p-roberta");
    expect(JSON.stringify(await automations.getRun(ok))).toContain(code);
  });

  it("R-J13: di un'esecuzione partita da un'email solo il proprietario vede mittente, oggetto e testo", async () => {
    as("p-laura");
    const id = await make(AUD, {
      trigger: { kind: "stubwise", event: "mail_received" },
      steps: [task("t", { title: "Rispondere: {{email.oggetto}}" })],
      titleTemplate: "Email: {{email.oggetto}}",
    });
    const mine = state.mailMessages.find(
      (m) => m.mailboxPersonIds.includes("p-laura") && m.subject.length > 8,
    )!;
    signalAutomations({ kind: "mail_received", messageIds: [mine.id] });
    await idle();
    const r = lastRunOf(id);
    expect((await automations.getRun(r.id))!.event).toMatchObject({
      email: { oggetto: mine.subject },
    });
    as("p-marco");
    const seen = (await automations.getRun(r.id))!;
    expect(seen.event).toEqual({ email: { mittente: "", oggetto: "", testo: "" } });
    // Niente testo dal livello dati: la pagina dice, tradotto, che l'email è nascosta.
    expect(seen.mailHidden).toBe(true);
    expect(seen.log[0]!.output).toEqual(seen.event);
    const leaks = [mine.subject, mine.from.email, mine.text.slice(0, 30)];
    for (const text of leaks) expect(JSON.stringify(seen)).not.toContain(text);
    const listed = await automations.listRuns({ automationId: id });
    for (const text of leaks) expect(JSON.stringify(listed)).not.toContain(text);
    expect(await automations.searchAutomations(mine.subject)).toEqual([]);
  });

  it("R-J13 lungo la catena: un'esecuzione figlia di una partita da un'email nasconde l'email a chi non ne è il proprietario", async () => {
    as("p-laura");
    const child = await make(
      AUD,
      {
        trigger: { kind: "manual" },
        steps: [task("c", { title: "Seguire l'email" })],
        titleTemplate: "Figlia",
      },
      "Figlia",
    );
    await make(AUD, {
      trigger: { kind: "stubwise", event: "mail_received" },
      steps: [{ id: "s", kind: "startAutomation", automationId: child, approval: AUTO }],
      titleTemplate: "Email: {{email.oggetto}}",
    });
    const mine = state.mailMessages.find(
      (m) => m.mailboxPersonIds.includes("p-laura") && m.subject.length > 8,
    )!;
    signalAutomations({ kind: "mail_received", messageIds: [mine.id] });
    await idle();
    const kid = lastRunOf(child);
    expect(kid.parentRunId).toBeTruthy();
    expect((await automations.getRun(kid.id))!.event).toMatchObject({
      email: { oggetto: mine.subject },
    });
    as("p-marco");
    const seen = (await automations.getRun(kid.id))!;
    expect(seen.event).toEqual({ email: { mittente: "", oggetto: "", testo: "" } });
    // Niente testo dal livello dati: la pagina dice, tradotto, che l'email è nascosta.
    expect(seen.mailHidden).toBe(true);
    const leaks = [mine.subject, mine.from.email, mine.text.slice(0, 30)];
    for (const text of leaks) expect(JSON.stringify(seen)).not.toContain(text);
    const listed = await automations.listRuns({ automationId: child });
    for (const text of leaks) expect(JSON.stringify(listed)).not.toContain(text);
  });

  it("un errore inatteso nel runner: l'esecuzione fallisce `internal_error`, non resta in corso", async () => {
    as("p-matteo");
    // Un registro rovinato: la ripresa non trova il passo del cursore.
    run(R.waitingEvent).cursor = "9";
    await automations.advanceTime(R.waitingEvent, 1);
    await idle();
    expect(run(R.waitingEvent)).toMatchObject({ status: "failed", error: "internal_error" });
    expect(run(R.waitingEvent).log.at(-1)!.reason).toMatch(/^Errore interno/);
  });

  it("«Avvisa» in una generale non prende un progetto a caso fra quelli toccati", async () => {
    as("p-roberta");
    const a = await automations.createAutomation({
      name: "Avviso",
      projectId: null,
      flow: {
        trigger: { kind: "source", sourceId: S.audin, event: "deal_won" },
        titleTemplate: "Avviso",
        steps: [
          {
            id: "m",
            kind: "createMilestone",
            name: "Attivazione",
            dueInDays: null,
            project: { mode: "from_client", clientRef: "cliente.dominio" },
            approval: { mode: "auto" },
          },
          {
            id: "n",
            kind: "notify",
            who: { personRef: "trattativa.commerciale" },
            text: "Contratto chiuso",
            approval: { mode: "auto" },
          },
        ],
      },
    });
    await automations.activate(a.id);
    // Elena (la commerciale) non è in CBV, dove il traguardo è nato.
    expect(visibleProjectIds("p-elena").has("prj-cbv")).toBe(false);
    await automations.simulateSourceEvent(S.audin, 0);
    await idle();
    expect(lastRunOf(a.id).status).toBe("done");
    expect(state.notifications.at(-1)).toMatchObject({
      recipientIds: ["p-elena"],
      projectId: null,
    });
  });

  it("una ricorrenza conta solo gli avvii della ricorrenza, non quelli a mano", async () => {
    as("p-laura");
    const id = await make(AUD, {
      trigger: { kind: "schedule", rule: "FREQ=DAILY;BYHOUR=9" },
      steps: [task("t")],
      titleTemplate: "Ogni giorno",
    });
    await automations.startManual(id, { avvio: { data: now().slice(0, 10) } });
    expect(await automations.runDueSchedules()).toHaveLength(1);
    expect(await automations.runDueSchedules()).toHaveLength(0);
    await idle();
    expect(runsOf(id).map((r) => r.origin)).toEqual(["manual", "schedule"]);
  });

  it("wait.taskClosed: chiudere la task creata dal passo sblocca l'attesa", async () => {
    as("p-laura");
    const id = await make(
      AUD,
      manual([
        task("t"),
        { id: "w", kind: "wait", for: { taskClosed: "t", maxDays: 5 } },
        task("dopo"),
      ]),
    );
    const r = await automations.startManual(id);
    await idle();
    expect(run(r).status).toBe("waiting_event");
    const created = state.tasks.find((t) => t.automationRef?.runId === r)!;
    await updateTask(created.id, { statusId: closedStatus(AUD) });
    await idle();
    expect(run(r).status).toBe("done");
    expect(state.tasks.filter((t) => t.automationRef?.runId === r).map((t) => t.title)).toEqual([
      "Task t",
      "Task dopo",
    ]);
  });

  it("inizi «richiesta creata» e «traguardo raggiunto»", async () => {
    as("p-laura");
    const onRequest = await make(AUD, {
      trigger: { kind: "stubwise", event: "request_created" },
      steps: [task("r")],
      titleTemplate: "Richiesta {{richiesta.codice}}",
    });
    const onMilestone = await make(AUD, {
      trigger: { kind: "stubwise", event: "milestone_reached" },
      steps: [task("m")],
      titleTemplate: "Traguardo {{traguardo.nome}}",
    });
    const request = await createRequest({ projectId: AUD, title: "Esportazione in CSV" });
    await idle();
    expect(runsOf(onRequest).map((r) => [r.title, r.status])).toEqual([
      [`Richiesta ${request.code}`, "done"],
    ]);
    const ms = await createMilestone(AUD, { name: "Rilascio 3" });
    await idle();
    expect(runsOf(onMilestone)).toHaveLength(0);
    await updateMilestone(ms.id, { closed: true });
    await idle();
    expect(runsOf(onMilestone).map((r) => [r.title, r.status])).toEqual([
      ["Traguardo Rilascio 3", "done"],
    ]);
  });

  it("permesso perso anche su «Crea richiesta» e «Crea traguardo»", async () => {
    as("p-laura");
    const request = await make(
      AUD,
      manual([
        {
          id: "r",
          kind: "createRequest",
          title: "Richiesta",
          description: "",
          project: { mode: "own" },
          approval: { mode: "auto" },
        },
      ]),
      "R",
    );
    const milestone = await make(
      AUD,
      manual([
        {
          id: "m",
          kind: "createMilestone",
          name: "Traguardo",
          dueInDays: null,
          project: { mode: "own" },
          approval: { mode: "auto" },
        },
      ]),
      "M",
    );
    grantProjectRole("p-laura", AUD, "viewer");
    // Le avvia l'admin: il proprietario (Laura) resta lei, ed è lei che non può più.
    as("p-roberta");
    const requests = state.requests.length;
    const milestones = state.milestones.length;
    await automations.startManual(request);
    await automations.startManual(milestone);
    await idle();
    expect(lastRunOf(request)).toMatchObject({ status: "failed", error: "permission_lost" });
    expect(lastRunOf(milestone)).toMatchObject({ status: "failed", error: "permission_lost" });
    expect(state.requests).toHaveLength(requests);
    expect(state.milestones).toHaveLength(milestones);
  });

  it("permesso perso anche su «Avvisa»: nessun avviso nel progetto che il proprietario non vede più", async () => {
    as("p-laura");
    const id = await make(
      AUD,
      manual([
        {
          id: "n",
          kind: "notify",
          who: { personId: "p-marco" },
          text: "Avviso",
          approval: { mode: "auto" },
        },
      ]),
      "N",
    );
    leave("p-laura", AUD);
    as("p-roberta");
    const notifications = state.notifications.length;
    await automations.startManual(id);
    await idle();
    expect(lastRunOf(id)).toMatchObject({ status: "failed", error: "permission_lost" });
    expect(state.notifications).toHaveLength(notifications);
  });
});
