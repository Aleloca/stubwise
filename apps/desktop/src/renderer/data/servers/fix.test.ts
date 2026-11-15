import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inClosedSet } from "../../domain/servers/commands";
import { fixCommandsBeforeApproval } from "../../domain/servers/fixGate";
import {
  decidePlan,
  failNext,
  listClaudeDecisions,
  listNotifications,
  preApprovePlan,
  releases,
  resetApi,
  servers,
  setLatency,
  startRun,
  stop,
  stopAndSend,
  getConversation,
} from "../api";
import { createTaskAs } from "../api-mutations";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { createProject } from "../api";
import { setSessionPersonId } from "../session";
import {
  conversationPermissions,
  conversationRow,
  eventsOf,
  setStreamLatency,
  state,
  visibleProjectIds,
  waitingClaudeEvents,
  waitingOnMe,
} from "../store";
import type { Conversation, ConversationEvent } from "../types";
import { can, grantProjectPermission, grantProjectRole, viewerFor } from "../viewer";
import { whenFixesIdle } from "./fix";
import { __privateValuesForTest } from "./secrets";

// La correzione di un server da una task (area 8, F4b). Il piano è di sole
// azioni dell'insieme CHIUSO (`SERVER_ACTIONS`), le esegue l'AGENTE (mai
// l'SSH) con le operazioni accese, e lo approva solo chi ha `plans.approve`
// nel progetto della task (quello attribuito dall'analisi). Le asserzioni
// stanno sullo STATO — sessioni, eventi, `fixCommandsBeforeApproval`,
// conteggio delle azioni `server.fix` — non sui bottoni.

const ACQ = "prj-acq";
const TASK = "t-acq-srv-1"; // ACQ-6, la task della diagnosis di SRV-1 (seme)
const as = (personId: string) => setSessionPersonId(personId);
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );
type Action = Extract<ConversationEvent, { type: "action" }>;
type Plan = Extract<ConversationEvent, { type: "plan" }>;
type Phase = Extract<ConversationEvent, { type: "phase" }>;
type WorkResult = Extract<ConversationEvent, { type: "work_result" }>;

const fixSessions = (): Conversation[] => state.conversations.filter((c) => c.serverFix);
const session = (id: string) => state.conversations.find((c) => c.id === id)!;
const actions = (id: string, tool: string) =>
  eventsOf(id).filter((e): e is Action => e.type === "action" && e.tool === tool);
/** Tutte le azioni di correzione dello store, di ogni sessione. */
const allFixCommands = () => state.conversations.flatMap((c) => actions(c.id, "server.fix")).length;
const plans = (id: string) => eventsOf(id).filter((e): e is Plan => e.type === "plan");
const phases = (id: string) => eventsOf(id).filter((e): e is Phase => e.type === "phase");
const checks = (id: string) =>
  eventsOf(id).filter(
    (e): e is WorkResult => e.type === "work_result" && e.kind === "server_check",
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const srv1 = () => state.servers.find((s) => s.code === "SRV-1")!;
const RESTART_IMPORT = {
  action: "container.restart",
  params: { container: "portale-import", timeoutSeconds: 30 },
};

/**
 * Una task di SRV-1 con un episodio di memoria E di disco: un piano di tre
 * passi (riavvia `portale-import`, libera spazio due volte), per cogliere
 * l'esecuzione a metà.
 */
function threeStepTask(): string {
  const ep = {
    id: "ep-test-3",
    serverCode: "SRV-1",
    severity: "trouble" as const,
    reasons: [
      { kind: "memory" as const, valuePct: 94, thresholdPct: 90 },
      { kind: "disk" as const, valuePct: 96, thresholdPct: 90 },
    ],
    startedAt: "2026-11-14T10:00:00Z",
    recoveredAt: null,
    analysisId: null,
  };
  state.serverEpisodes.push(ep);
  return createTaskAs(
    CLAUDE_ID,
    {
      projectId: ACQ,
      title: "Memory and disk on acq-prod-01",
      type: "bug",
      description: "`portale-import` keeps everything in memory; the disk is full of old images.",
    },
    { source: "server", serverRef: { serverCode: "SRV-1", episodeId: ep.id } },
  ).id;
}
const FAST = { interval: 2, timeout: 2000 };
/** Una persona che non vede ACQ (R-G5: la sua task e il suo server non esistono per lei). */
const outsider = () =>
  PEOPLE.find((p) => p.id !== CLAUDE_ID && !visibleProjectIds(p.id).has(ACQ))!.id;

/** Avvia come `personId` e aspetta che il piano sia arrivato. */
async function started(personId: string, taskId = TASK): Promise<Conversation> {
  as(personId);
  const c = await servers.startServerFix(taskId);
  await whenFixesIdle();
  return session(c.id);
}

async function approved(c: Conversation, personId: string): Promise<void> {
  as(personId);
  await decidePlan(c.id, "approve");
  await whenFixesIdle();
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(async () => {
  await whenFixesIdle();
  // Architettura (anti-obiettivo 2): dopo ogni scenario, nessun comando di
  // correzione precede un piano approvato da una persona, in nessuna sessione.
  for (const c of state.conversations)
    expect(fixCommandsBeforeApproval(eventsOf(c.id)), c.id).toBe(0);
  resetApi();
});

describe("RF 1: chi avvia, chi approva", () => {
  it("Laura su ACQ (runs.start + plans.approve, senza servers.operate) → forbidden, nessuna sessione", async () => {
    const laura = viewerFor("p-laura");
    expect(can(laura, "runs.start", ACQ)).toBe(true);
    expect(can(laura, "plans.approve", ACQ)).toBe(true);
    expect(can(laura, "servers.operate", ACQ)).toBe(false);
    const before = state.conversations.length;
    as("p-laura");
    expect(await message(servers.startServerFix(TASK))).toBe("forbidden");
    expect(state.conversations).toHaveLength(before);
    expect(fixSessions()).toEqual([]);
  });

  it("Roberta (entrambi) → piano da approvare, zero comandi; approva lei stessa e i comandi partono", async () => {
    const c = await started("p-roberta");
    expect(c).toMatchObject({
      kind: "task_run",
      ownerId: "p-roberta",
      projectId: ACQ,
      taskId: TASK,
      state: "awaiting_approval",
      serverFix: { serverCode: "SRV-1" },
    });
    expect(plans(c.id).map((p) => p.status)).toEqual(["pending"]);
    expect(plans(c.id)[0]!.decidedById).toBeUndefined();
    // Il piano: azioni dell'insieme chiuso, col perché; nessun comando libero.
    expect(plans(c.id)[0]!.serverPlan).toEqual({
      steps: [{ ...RESTART_IMPORT, why: expect.any(String) }],
    });
    expect(actions(c.id, "server.fix")).toEqual([]);
    // Prima del piano Claude guarda i container, via AGENTE e in sola lettura.
    const reads = actions(c.id, "server.read");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.serverCommand).toMatchObject({ kind: "read", via: "agent", approvalId: null });
      expect(inClosedSet(r.serverCommand!), r.input).toBe(true);
    }
    // La correzione non usa l'SSH: l'ultimo uso resta quello dell'analisi.
    expect(state.serverAccess.get("SRV-1")!.lastUse?.ref.kind).toBe("analysis");
    expect(conversationPermissions("p-roberta", c).canDecidePlan).toBe(true);
    expect(conversationPermissions("p-roberta", c).canPreApprovePlan).toBe(false);
    expect(conversationPermissions("p-roberta", c).planBlockedReason).toBeNull();

    await approved(c, "p-roberta");
    const fixes = actions(c.id, "server.fix");
    const plan = plans(c.id).at(-1)!;
    // Un comando per passo, via agente, coperto dall'id del piano approvato.
    expect(fixes.map((a) => a.serverCommand)).toEqual([
      { ...RESTART_IMPORT, kind: "change", via: "agent", approvalId: plan.id, exitCode: 0 },
    ]);
    expect(fixes.every((a) => a.state === "done")).toBe(true);
    expect(plan).toMatchObject({ status: "approved", decidedById: "p-roberta" });
    expect(state.serverAccess.get("SRV-1")!.lastUse?.ref.kind).toBe("analysis");
    // Il controllo finale in sola lettura dice «risolto» (R-L3), poi la sessione si chiude.
    expect(checks(c.id).map((e) => e.resolved)).toEqual([true]);
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "ok" });
    // La task resta aperta: la chiude una persona.
    expect(state.tasksById.get(TASK)!.closedAt).toBeNull();
  });

  it("Marco (servers.operate senza plans.approve) avvia, non approva; Laura approva e partono", async () => {
    const c = await started("p-marco");
    expect(c.state).toBe("awaiting_approval");
    expect(conversationPermissions("p-marco", c).canDecidePlan).toBe(false);
    expect(await message(decidePlan(c.id, "approve"))).toBe("forbidden");
    expect(plans(c.id).map((p) => p.status)).toEqual(["pending"]);
    expect(actions(c.id, "server.fix")).toEqual([]);

    await approved(c, "p-laura");
    expect(actions(c.id, "server.fix").length).toBe(1);
    expect(plans(c.id).at(-1)).toMatchObject({ status: "approved", decidedById: "p-laura" });
  });

  it("plans.approve in un ALTRO progetto del server non basta: approva solo chi lo ha nel progetto della task", async () => {
    // Un secondo progetto usa SRV-1; chi vi ha plans.approve, in ACQ no.
    as("p-roberta");
    const other = await createProject({ code: "SRVY", name: "Other on SRV-1", template: "software" });
    await releases.createEnvironment(other.id, {
      name: "Production",
      kind: "production",
      url: null,
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    // Marco vede la correzione (servers.operate in ACQ) ma non ha plans.approve in ACQ.
    const approver = "p-marco";
    expect(can(viewerFor(approver), "plans.approve", ACQ)).toBe(false);
    // Ha plans.approve nell'altro progetto del server, non in quello della task.
    grantProjectRole(approver, other.id, "contributor");
    grantProjectPermission(approver, other.id, "plans.approve");
    expect(can(viewerFor(approver), "plans.approve", other.id)).toBe(true);
    const c = await started("p-roberta");
    expect(conversationPermissions(approver, session(c.id)).canDecidePlan).toBe(false);
    as(approver);
    expect(await message(decidePlan(c.id, "approve"))).toBe("forbidden");
    expect(allFixCommands()).toBe(0);
  });

  it("preApprovePlan prima del piano → invalid: kind, e il piano arriva comunque pending", async () => {
    setLatency(5);
    as("p-roberta");
    const opened = await servers.startServerFix(TASK);
    expect(plans(opened.id)).toEqual([]);
    expect(conversationPermissions("p-roberta", session(opened.id)).canPreApprovePlan).toBe(false);
    expect(await message(preApprovePlan(opened.id))).toBe("invalid: kind");
    expect(state.preApprovedPlans.has(opened.id)).toBe(false);
    await whenFixesIdle();
    expect(plans(opened.id).map((p) => p.status)).toEqual(["pending"]);
    expect(session(opened.id).state).toBe("awaiting_approval");
    expect(actions(opened.id, "server.fix")).toEqual([]);
  });

  it("un'approvazione in anticipo infilata a mano non vale: il piano resta da approvare", async () => {
    setLatency(5);
    as("p-roberta");
    const opened = await servers.startServerFix(TASK);
    state.preApprovedPlans.set(opened.id, "p-roberta");
    await whenFixesIdle();
    expect(plans(opened.id).map((p) => p.status)).toEqual(["pending"]);
    expect(actions(opened.id, "server.fix")).toEqual([]);
  });

  it("rifiuto con indicazioni → nuovo piano di nuovo da approvare; approvato, i comandi partono", async () => {
    const c = await started("p-roberta");
    as("p-roberta");
    await decidePlan(c.id, "reject", "Restart it after the import window.");
    await whenFixesIdle();
    expect(plans(c.id).map((p) => p.status)).toEqual(["rejected", "pending"]);
    expect(plans(c.id)[1]!.planText).toContain("Restart it after the import window.");
    expect(session(c.id).state).toBe("awaiting_approval");
    expect(actions(c.id, "server.fix")).toEqual([]);
    await approved(c, "p-roberta");
    expect(actions(c.id, "server.fix").length).toBe(1);
  });

  it("d1: le note per Claude entrano nel piano, che resta da approvare", async () => {
    as("p-roberta");
    const c = await servers.startServerFix(TASK, { notes: "Users import at night." });
    await whenFixesIdle();
    expect(plans(c.id)).toHaveLength(1);
    expect(plans(c.id)[0]).toMatchObject({ status: "pending" });
    expect(plans(c.id)[0]!.planText).toContain("Users import at night.");
    expect(actions(c.id, "server.fix")).toEqual([]);
  });

  it("Minor 2: un piano bloccato (operazioni spente) rifiutato CON indicazioni chiude la correzione e libera il server", async () => {
    const c = await started("p-marco");
    srv1().agentOperations = false;
    as("p-laura");
    await decidePlan(c.id, "reject", "Try a restart only.");
    await whenFixesIdle();
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    expect(plans(c.id).map((p) => p.status)).toEqual(["rejected"]);
    as("p-roberta");
    expect(await message(servers.deleteServer("SRV-1"))).toBe("ok");
  });

  it("Minor 2: lo stesso con il server tolto dal progetto (server_gone)", async () => {
    const c = await started("p-marco");
    detachSrv1(true);
    as("p-laura");
    await decidePlan(c.id, "reject", "Try a restart only.");
    await whenFixesIdle();
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    expect(plans(c.id).map((p) => p.status)).toEqual(["rejected"]);
  });

  it("rifiuto senza indicazioni → la sessione si chiude, nessun comando", async () => {
    const c = await started("p-roberta");
    as("p-roberta");
    await decidePlan(c.id, "reject");
    await whenFixesIdle();
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    expect(actions(c.id, "server.fix")).toEqual([]);
    as("p-roberta");
    expect((await servers.getServerTaskInfo(TASK))!.state).toBe("plan_rejected");
  });
});

describe("F4b: le operazioni dell'agente, e l'SSH che non c'entra", () => {
  it("operazioni spente con il piano in attesa → approvazione spenta col motivo, zero comandi; il rifiuto resta", async () => {
    const c = await started("p-roberta");
    srv1().agentOperations = false;
    // In attesa resta ferma lì: l'approvazione si spegne, non la sessione.
    expect(session(c.id).state).toBe("awaiting_approval");
    const perms = conversationPermissions("p-roberta", session(c.id));
    expect(perms.canDecidePlan).toBe(false);
    expect(perms.planBlockedReason).toBe("operations_off");
    // Chi non può approvare non vede una ragione che non lo riguarda.
    expect(conversationPermissions("p-marco", session(c.id)).planBlockedReason).toBeNull();
    as("p-roberta");
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: operations_off");
    as("p-laura");
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: operations_off");
    expect(plans(c.id).map((p) => p.status)).toEqual(["pending"]);
    expect(allFixCommands()).toBe(0);
    // Riaccese (il comando d'installazione rifatto): si approva.
    srv1().agentOperations = true;
    await approved(c, "p-roberta");
    expect(actions(c.id, "server.fix").length).toBe(1);
  });

  it("I1: operazioni spente col piano che aspetta Laura → resta in «Waiting on me» col solo rifiuto", async () => {
    const c = await started("p-marco");
    srv1().agentOperations = false;
    const perms = conversationPermissions("p-laura", session(c.id));
    expect(perms).toMatchObject({
      canDecidePlan: false,
      canRejectPlan: true,
      planBlockedReason: "operations_off",
    });
    expect(conversationRow("p-laura", session(c.id)).waitsOnViewer).toBe(true);
    expect(waitingClaudeEvents("p-laura").map((w) => w.conversation.id)).toContain(c.id);
    expect(waitingOnMe("p-laura").has(ACQ)).toBe(true);
    as("p-laura");
    const decisions = (await listClaudeDecisions()).filter(
      (d) => d.kind !== "productQuestion" && d.conversationId === c.id,
    );
    expect(decisions).toMatchObject([{ kind: "plan", blockedReason: "operations_off" }]);
    as("p-roberta");
    expect(await message(servers.deleteServer("SRV-1"))).toBe("invalid: busy");
    as("p-laura");
    await decidePlan(c.id, "reject");
    await whenFixesIdle();
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    expect(allFixCommands()).toBe(0);
    as("p-roberta");
    expect(await message(servers.deleteServer("SRV-1"))).toBe("ok");
  });

  it("operazioni spente durante l'esecuzione → si ferma col motivo, nessuna azione dopo", async () => {
    as("p-roberta");
    const c = await started("p-roberta", threeStepTask());
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    srv1().agentOperations = false;
    const atOff = actions(c.id, "server.fix").length;
    await whenFixesIdle();
    await sleep(80);
    expect(actions(c.id, "server.fix").length).toBe(atOff);
    expect(atOff).toBeLessThan(3);
    expect(actions(c.id, "server.fix").every((a) => a.state !== "running")).toBe(true);
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    const last = phases(c.id).at(-1)!;
    expect(last).toMatchObject({ outcome: "stopped", reason: "operations_off" });
    as("p-roberta");
    expect((await servers.getServerTaskInfo(c.taskId!))!.fix!.planError).toBe("operations_off");
    expect(last.stoppedById).toBeUndefined();
    expect(checks(c.id)).toEqual([]);
  });

  it("senza le operazioni la correzione non parte: operations_off, nessuna sessione", async () => {
    srv1().agentOperations = false;
    as("p-roberta");
    expect((await servers.getServerTaskInfo(TASK))!.startBlock).toBe("operations_off");
    expect(await message(servers.startServerFix(TASK))).toBe("invalid: operations_off");
    expect(fixSessions()).toEqual([]);
  });

  it("la revoca dell'accesso SSH NON ferma la correzione: passa dall'agente", async () => {
    const c = await started("p-roberta");
    as("p-roberta");
    await servers.revokeSshAccess("SRV-1");
    await whenFixesIdle();
    expect(conversationPermissions("p-roberta", session(c.id))).toMatchObject({
      canDecidePlan: true,
      planBlockedReason: null,
    });
    await approved(c, "p-roberta");
    expect(actions(c.id, "server.fix").length).toBe(1);
    expect(checks(c.id).map((x) => x.resolved)).toEqual([true]);
  });
});

describe("F4b: le parole del server per gli errori della correzione", () => {
  it("approve: il piano si rivalida (plan_stale); fuori attesa → not_awaiting_approval", async () => {
    const c = await started("p-roberta");
    // Dopo il piano, `portale-import` diventa di un altro progetto.
    as("p-roberta");
    const other = await createProject({ code: "SRVV", name: "Importer", template: "software" });
    await releases.createEnvironment(other.id, {
      name: "portale-import",
      kind: "production",
      url: null,
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    as("p-roberta");
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: plan_stale");
    expect(allFixCommands()).toBe(0);
    await decidePlan(c.id, "reject");
    await whenFixesIdle();
    expect(await message(decidePlan(c.id, "approve"))).not.toBe("ok");
  });

  it("approvare una correzione senza piano in attesa → not_awaiting_approval; Stop a correzione chiusa → not_running", async () => {
    setLatency(5);
    as("p-roberta");
    const opened = await servers.startServerFix(TASK);
    expect(await message(decidePlan(opened.id, "approve"))).toBe("invalid: not_awaiting_approval");
    await whenFixesIdle();
    setLatency(0);
    await approved(session(opened.id), "p-roberta");
    expect(session(opened.id).state).toBe("finished");
    as("p-roberta");
    expect(await message(stop(opened.id))).toBe("invalid: not_running");
  });
});

describe("F4b: il piano è dell'insieme chiuso, e «libera spazio» su un server condiviso si dice prima", () => {
  it("ogni azione eseguita è nell'insieme chiuso, via agente, coperta dal piano approvato", async () => {
    const c = await started("p-roberta", threeStepTask());
    expect(plans(c.id)[0]!.serverPlan!.steps.map((x) => [x.action, x.params])).toEqual([
      [RESTART_IMPORT.action, RESTART_IMPORT.params],
      ["docker.prune", { what: "images_unused" }],
      ["docker.prune", { what: "build_cache" }],
    ]);
    await approved(c, "p-roberta");
    const plan = plans(c.id).at(-1)!;
    const fixes = actions(c.id, "server.fix");
    expect(fixes).toHaveLength(3);
    for (const a of fixes) {
      expect(a.serverCommand).toMatchObject({ kind: "change", via: "agent", approvalId: plan.id });
      expect(inClosedSet(a.serverCommand!), a.input).toBe(true);
      expect(a.input).not.toMatch(/\bsudo\b|\bssh\b|;|&&/);
    }
  });

  it("un server condiviso: «libera spazio» si propone lo stesso, e chi guarda sa con chi lo condivide", async () => {
    as("p-roberta");
    const other = await createProject({ code: "SRVZ", name: "Shop on SRV-1", template: "software" });
    await releases.createEnvironment(other.id, {
      name: "Production",
      kind: "production",
      url: null,
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    const c = await started("p-roberta", threeStepTask());
    expect(plans(c.id)[0]!.serverPlan!.steps.some((x) => x.action === "docker.prune")).toBe(true);
    as("p-roberta");
    const info = (await servers.getServerTaskInfo(c.taskId!))!;
    expect(info.fix!.pruneWarning).toEqual({ projects: ["Shop on SRV-1"], hiddenCount: 0 });
    // Chi non vede l'altro progetto ne legge solo il numero (R-G5).
    as("p-marco");
    expect(visibleProjectIds("p-marco").has(other.id)).toBe(false);
    expect((await servers.getServerTaskInfo(c.taskId!))!.fix!.pruneWarning).toEqual({
      projects: [],
      hiddenCount: 1,
    });
  });

  it("un container legato a un altro progetto non entra nel piano", async () => {
    as("p-roberta");
    const other = await createProject({ code: "SRVW", name: "Imports", template: "software" });
    await releases.createEnvironment(other.id, {
      name: "portale-import",
      kind: "production",
      url: null,
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    const c = await started("p-roberta");
    // Il solo passo possibile era su `portale-import`: nessun piano.
    expect(plans(c.id)).toEqual([]);
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "ok" });
    as("p-roberta");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info.state).toBe("no_plan");
    // Un codice, mai testo del modello (`planError` del server).
    expect(info.fix!.planError).toBe("container_of_other_project");
    expect(allFixCommands()).toBe(0);
  });

  it("R0-D: un container del server che non è fra quelli del progetto non entra (`container_not_of_project`)", async () => {
    // La produzione di ACQ dichiara solo `portale-web` su SRV-1: `portale-import` non è suo.
    state.environments.find((e) => e.id === "env-acq-prod")!.servers[0]!.containers = [
      "portale-web",
    ];
    const c = await started("p-roberta");
    expect(plans(c.id)).toEqual([]);
    as("p-roberta");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info.state).toBe("no_plan");
    expect(info.fix!.planError).toBe("container_not_of_project");
    expect(allFixCommands()).toBe(0);
  });

  it("nessuna azione ammessa serve (l'agente muto): niente piano, e la task lo dice", async () => {
    const ep = {
      id: "ep-test-silent",
      serverCode: "SRV-1",
      severity: "down" as const,
      reasons: [{ kind: "agent_silent" as const, since: "2026-11-14T10:00:00Z" }],
      startedAt: "2026-11-14T10:00:00Z",
      recoveredAt: null,
      analysisId: null,
    };
    state.serverEpisodes.push(ep);
    const t = createTaskAs(
      CLAUDE_ID,
      { projectId: ACQ, title: "SRV-1 silent", type: "bug" },
      { source: "server", serverRef: { serverCode: "SRV-1", episodeId: ep.id } },
    );
    const c = await started("p-roberta", t.id);
    expect(plans(c.id)).toEqual([]);
    as("p-roberta");
    const info = (await servers.getServerTaskInfo(t.id))!;
    expect(info.state).toBe("no_plan");
    expect(info.fix!.status).toBe("failed");
    expect(info.fix!.planError).toBe("no_plan");
  });
});

describe("RF 1: fermare, e i percorsi che non sono la correzione", () => {
  it("lo Stop di una persona (dalla task) → fermata da lei, nessuna azione dopo; dalla sessione no", async () => {
    const c = await started("p-roberta", threeStepTask());
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    // Review F4b I4: la sessione di una correzione non si ferma da sé.
    expect(await message(stop(c.id))).toBe("forbidden");
    await servers.stopServerFix(c.taskId!);
    const atStop = actions(c.id, "server.fix").length;
    await whenFixesIdle();
    await sleep(80);
    expect(actions(c.id, "server.fix").length).toBe(atStop);
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    const last = phases(c.id).at(-1)!;
    expect(last).toMatchObject({ outcome: "stopped", stoppedById: "p-roberta" });
    expect(last.reason).toBeUndefined();
    expect(checks(c.id)).toEqual([]);
    as("p-roberta");
    const info = (await servers.getServerTaskInfo(c.taskId!))!;
    expect(info.state).toBe("stopped");
    expect(info.startBlock).toBeNull(); // «Start fix again»
    expect(info.fix!.steps.map((x) => x.status)).toContain("skipped");
  });

  it("review F4b I4: nella sessione di una correzione non si scrive e non c'è «Ferma e scrivi»", async () => {
    const c = await started("p-roberta", threeStepTask());
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    expect(await message(stopAndSend(c.id, "Only free up space, nothing else."))).toBe(
      "forbidden",
    );
    const detail = await getConversation(c.id);
    expect(detail).toMatchObject({
      canWrite: false,
      canInterrupt: false,
      readOnlyReason: "server_fix",
    });
    setStreamLatency(0);
    await whenFixesIdle();
  });

  it("review F4b I5: Stop dalla task con servers.operate o plans.approve, non senza", async () => {
    const c = await started("p-roberta", threeStepTask());
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    // Marco ha servers.operate in ACQ (senza plans.approve): può fermare.
    as("p-marco");
    expect((await servers.getServerTaskInfo(c.taskId!))!.fix!.canStop).toBe(true);
    // Chi legge ACQ senza nessuno dei due: no.
    const reader = PEOPLE.find(
      (p) =>
        p.id !== CLAUDE_ID &&
        visibleProjectIds(p.id).has(ACQ) &&
        !can(viewerFor(p.id), "servers.operate", ACQ) &&
        !can(viewerFor(p.id), "plans.approve", ACQ),
    );
    if (reader) {
      as(reader.id);
      expect((await servers.getServerTaskInfo(c.taskId!))!.fix!.canStop).toBe(false);
      expect(await message(servers.stopServerFix(c.taskId!))).toBe("forbidden");
    }
    as("p-marco");
    await servers.stopServerFix(c.taskId!);
    setStreamLatency(0);
    await whenFixesIdle();
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
  });

  it("task senza serverRef → not_server_task; un server con le operazioni spente → operations_off", async () => {
    const plain = [...state.tasksById.values()].find(
      (t) => t.projectId === ACQ && !t.serverRef && t.closedAt === null,
    )!;
    as("p-roberta");
    expect(await message(servers.startServerFix(plain.id))).toBe("invalid: not_server_task");
    // SRV-3 (AUD): l'agente senza operazioni (il default).
    const aud = state.projects.find((p) => p.code === "AUD")!;
    const t = createTaskAs(
      CLAUDE_ID,
      { projectId: aud.id, title: "SRV-3 in trouble", type: "bug" },
      { source: "server", serverRef: { serverCode: "SRV-3", episodeId: null } },
    );
    expect(await message(servers.startServerFix(t.id))).toBe("invalid: operations_off");
    expect(fixSessions()).toEqual([]);
  });

  it("una task invisibile risponde not_found prima del permesso; una correzione viva → run_live", async () => {
    as(outsider());
    expect(await message(servers.startServerFix("t-nope"))).toBe("not_found");
    await started("p-roberta");
    expect(await message(servers.startServerFix(TASK))).toBe("invalid: fix_busy");
    expect(fixSessions()).toHaveLength(1);
  });

  it("«Avvia» (runs.start) su una task di server → sessione senza serverFix, nessun server.fix", async () => {
    as("p-roberta");
    const c = await startRun(TASK);
    await expect.poll(() => session(c.id).state, { timeout: 2000 }).toBe("finished");
    expect(session(c.id).serverFix).toBeUndefined();
    expect(allFixCommands()).toBe(0);
    expect(eventsOf(c.id).some((e) => e.type === "action" && e.tool.startsWith("server."))).toBe(
      false,
    );
  });

  it("«Fai sistemare a Claude» di un rilascio → task senza serverRef", async () => {
    as("p-laura");
    const task = await releases.fixRelease("AUD-V3");
    expect(state.tasksById.get(task.id)!.serverRef).toBeUndefined();
    expect(allFixCommands()).toBe(0);
  });

  it("deleteServer durante una correzione viva → invalid: busy (R-L6); dopo, si può", async () => {
    const c = await started("p-roberta");
    as("p-roberta");
    expect(await message(servers.deleteServer("SRV-1"))).toBe("invalid: busy");
    await decidePlan(c.id, "reject");
    expect(await message(servers.deleteServer("SRV-1"))).toBe("ok");
  });
});

/** Toglie SRV-1 dagli ambienti di ACQ (e, se si vuole, lo mette in STW). */
function detachSrv1(toStw = false): void {
  for (const env of state.environments) {
    if (env.projectId === ACQ) env.servers = env.servers.filter((s) => s.serverCode !== "SRV-1");
  }
  if (toStw) {
    const stw = state.projects.find((p) => p.code === "STW")!;
    const env = state.environments.find((e) => e.projectId === stw.id)!;
    env.servers.push({ ...env.servers[0]!, repositoryId: null, serverCode: "SRV-1" });
  }
}

describe("I1: il server deve essere ancora del progetto della task (R-L2, R-G5)", () => {
  it("tolto prima dell'avvio → server_gone, nessuna sessione, anche per chi lo vede altrove", async () => {
    detachSrv1();
    as("p-marco");
    expect((await servers.getServerTaskInfo(TASK))!.startBlock).toBe("server_gone");
    expect(await message(servers.startServerFix(TASK))).toBe("invalid: server_gone");
    // Spostato su STW: Roberta lo vede (per STW) ma da una task di ACQ non lo corregge.
    detachSrv1(true);
    as("p-roberta");
    expect((await servers.getServerTaskInfo(TASK))!.startBlock).toBe("server_gone");
    expect(await message(servers.startServerFix(TASK))).toBe("invalid: server_gone");
    expect(fixSessions()).toEqual([]);
    expect(allFixCommands()).toBe(0);
  });

  it("tolto mentre il piano aspetta → approvazione spenta col motivo, rifiutata, zero comandi", async () => {
    const c = await started("p-marco");
    detachSrv1(true);
    const perms = conversationPermissions("p-laura", session(c.id));
    expect(perms).toMatchObject({
      canDecidePlan: false,
      canRejectPlan: true,
      planBlockedReason: "server_gone",
    });
    as("p-laura");
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: server_gone");
    as("p-roberta");
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: server_gone");
    expect(plans(c.id).map((p) => p.status)).toEqual(["pending"]);
    await whenFixesIdle();
    expect(allFixCommands()).toBe(0);
  });

  it("tolto durante l'esecuzione → si ferma (server_gone), nessuna azione dopo", async () => {
    const c = await started("p-roberta", threeStepTask());
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    detachSrv1();
    const atDetach = actions(c.id, "server.fix").length;
    await whenFixesIdle();
    await sleep(60);
    expect(actions(c.id, "server.fix").length).toBe(atDetach);
    expect(atDetach).toBeLessThan(3);
    expect(phases(c.id).at(-1)).toMatchObject({ outcome: "stopped", reason: "server_gone" });
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    expect(checks(c.id)).toEqual([]);
  });

  it("R1: tolto mentre Claude legge per il piano → si ferma (server_gone), nessuna lettura dopo e nessun piano", async () => {
    setStreamLatency(20);
    as("p-roberta");
    const c = await servers.startServerFix(TASK);
    await expect.poll(() => actions(c.id, "server.read").length, FAST).toBeGreaterThan(0);
    detachSrv1(true);
    const atDetach = actions(c.id, "server.read").length;
    await whenFixesIdle();
    await sleep(80);
    expect(actions(c.id, "server.read").length).toBe(atDetach);
    expect(plans(c.id)).toEqual([]);
    expect(phases(c.id).at(-1)).toMatchObject({ outcome: "stopped", reason: "server_gone" });
    expect(session(c.id).state).toBe("finished");
  });
});

describe("I2: il rifiuto è un permesso calcolato", () => {
  it("canRejectPlan: vero con l'approvazione spenta per chi decide, falso per chi non decide", async () => {
    const c = await started("p-marco");
    const before = conversationPermissions("p-roberta", session(c.id));
    expect(before.canRejectPlan).toBe(true);
    expect(before.canRejectPlan).toBe(before.canDecidePlan);
    expect(conversationPermissions("p-marco", session(c.id)).canRejectPlan).toBe(false);
    srv1().agentOperations = false;
    expect(conversationPermissions("p-roberta", session(c.id))).toMatchObject({
      canDecidePlan: false,
      canRejectPlan: true,
    });
    expect(conversationPermissions("p-marco", session(c.id)).canRejectPlan).toBe(false);
    as("p-marco");
    expect(await message(decidePlan(c.id, "reject"))).toBe("forbidden");
  });
});

describe("una correzione viva per server", () => {
  it("una seconda task dello stesso server → server_busy finché la prima è viva", async () => {
    const c = await started("p-roberta");
    const second = createTaskAs(
      CLAUDE_ID,
      { projectId: ACQ, title: "SRV-1 again", type: "bug" },
      { source: "server", serverRef: { serverCode: "SRV-1", episodeId: null } },
    );
    as("p-roberta");
    expect(await message(servers.startServerFix(second.id))).toBe("invalid: fix_busy");
    expect((await servers.getServerTaskInfo(second.id))!.startBlock).toBe("server_busy");
    await decidePlan(c.id, "reject");
    expect((await servers.getServerTaskInfo(second.id))!.startBlock).toBeNull();
  });
});

describe("il controllo finale", () => {
  it("«Simula: non risolto» → server_check resolved false, task non risolta, sessione chiusa", async () => {
    as("p-roberta");
    await servers.simulateFixCheck("SRV-1", "not_resolved");
    const c = await started("p-roberta");
    await approved(c, "p-roberta");
    const [check] = checks(c.id);
    expect(check).toMatchObject({ resolved: false });
    expect(check!.text).toMatch(/not resolved — memory still at/);
    expect(session(c.id).state).toBe("finished");
    as("p-roberta");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info.state).toBe("not_resolved");
    // L'esito simulato vale una volta sola.
    expect(state.fixCheckNext.has("SRV-1")).toBe(false);
  });

  it("di base risolto; le letture del controllo sono letture dell'agente", async () => {
    const c = await started("p-roberta");
    await approved(c, "p-roberta");
    expect(checks(c.id)[0]!.text).toMatch(/^Check after the fix: resolved/);
    for (const r of actions(c.id, "server.read")) {
      expect(r.serverCommand).toMatchObject({ kind: "read", via: "agent" });
      expect(inClosedSet(r.serverCommand!), r.input).toBe(true);
    }
    as("p-roberta");
    expect((await servers.getServerTaskInfo(TASK))!.state).toBe("resolved");
  });

  it("simulateFixCheck: esito sbagliato → invalid: outcome; server invisibile → not_found", async () => {
    as("p-roberta");
    expect(await message(servers.simulateFixCheck("SRV-1", "maybe" as unknown as "resolved"))).toBe(
      "invalid: outcome",
    );
    as(outsider());
    expect(await message(servers.simulateFixCheck("SRV-1", "resolved"))).toBe("not_found");
  });
});

describe("getServerTaskInfo", () => {
  it("dice server, episodio, stato, blocco e correzione; null per una task senza serverRef", async () => {
    as("p-marco");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info.server).toEqual({ code: "SRV-1", name: expect.any(String), projectCode: "ACQ" });
    expect(info.serverGone).toBe(false);
    expect(info.episode?.serverCode).toBe("SRV-1");
    expect(info.state).toBe("diagnosis_ready");
    expect(info.startBlock).toBeNull();
    expect(info.fix).toMatchObject({
      status: "none",
      steps: [],
      operationsOn: true,
      canRequestPlan: true,
      canApprove: false,
      canStop: false,
      commands: [],
      pruneWarning: null,
      planError: null,
    });
    expect(info.fixConversationId).toBeNull();
    as("p-laura");
    expect((await servers.getServerTaskInfo(TASK))!.startBlock).toBe("no_permission");
    const plain = [...state.tasksById.values()].find((t) => t.projectId === ACQ && !t.serverRef)!;
    expect(await servers.getServerTaskInfo(plain.id)).toBeNull();
    as(outsider());
    expect(await message(servers.getServerTaskInfo(TASK))).toBe("not_found");
  });

  it("il link «Open» porta dove il server è: il progetto della task, o un altro che chi guarda vede", async () => {
    as("p-roberta");
    expect((await servers.getServerTaskInfo(TASK))!.server).toMatchObject({ projectCode: "ACQ" });
    detachSrv1(true);
    expect((await servers.getServerTaskInfo(TASK))!.server).toMatchObject({
      code: "SRV-1",
      projectCode: "STW",
    });
  });

  it("server invisibile (R-G5): niente stato dell'accesso, e nessun «deleted»", async () => {
    detachSrv1();
    as("p-marco");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info.server).toBeNull();
    expect(info.fix).toBeNull();
    expect(info.serverGone).toBe(false);
  });

  it("R-G5: spostato in un progetto che Sara non vede, poi cancellato → per Sara resta «A server you can't see»", async () => {
    const aud = state.projects.find((p) => p.code === "AUD")!.id;
    expect(visibleProjectIds("p-sara").has(ACQ)).toBe(true);
    expect(visibleProjectIds("p-sara").has(aud)).toBe(false);
    detachSrv1();
    state.environments
      .find((e) => e.projectId === aud && e.kind === "production")!
      .servers.push({ repositoryId: null, serverCode: "SRV-1", reportedSha: null, reportedAt: null });
    as("p-sara");
    const before = (await servers.getServerTaskInfo(TASK))!;
    expect(before).toMatchObject({ server: null, serverGone: false });
    as("p-roberta");
    await servers.deleteServer("SRV-1");
    as("p-sara");
    const after = (await servers.getServerTaskInfo(TASK))!;
    expect(after).toMatchObject({ server: null, serverGone: false });
    // Chi lo vedeva (Roberta vede AUD) legge «deleted».
    as("p-roberta");
    expect((await servers.getServerTaskInfo(TASK))!.serverGone).toBe(true);
  });

  it("R-G5: orfano e poi cancellato → nessun «deleted» a chi vede solo il progetto della task", async () => {
    detachSrv1();
    as("p-roberta");
    await servers.deleteServer("SRV-1");
    as("p-marco");
    expect((await servers.getServerTaskInfo(TASK))!).toMatchObject({
      server: null,
      serverGone: false,
    });
  });

  it("server cancellato: serverGone a chi vede il progetto della task", async () => {
    as("p-roberta");
    await servers.deleteServer("SRV-1");
    as("p-marco");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info.server).toBeNull();
    expect(info.serverGone).toBe(true);
    expect(info.fix).toBeNull();
  });

  it("segue la correzione: piano da approvare, approvato, fatto — coi concetti della vista", async () => {
    const c = await started("p-marco");
    as("p-marco");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info).toMatchObject({
      state: "plan_awaiting",
      startBlock: "run_live",
      fixConversationId: c.id,
      fix: {
        status: "awaiting_approval",
        steps: [{ index: 0, ...RESTART_IMPORT, status: "waiting" }],
        approval: null,
        canRequestPlan: false,
        canApprove: false,
      },
    });
    as("p-laura");
    expect((await servers.getServerTaskInfo(TASK))!.fix!.canApprove).toBe(true);
    await approved(c, "p-laura");
    as("p-marco");
    const done = (await servers.getServerTaskInfo(TASK))!.fix!;
    expect(done).toMatchObject({
      status: "done",
      steps: [{ index: 0, status: "done" }],
      approval: { byId: "p-laura", at: expect.any(String) },
      canStop: false,
    });
    // Il registro: le letture via agente e l'azione che cambia, chiesti da chi ha avviato.
    expect(done.commands.map((x) => [x.kind, x.via, x.action, x.requestedById])).toEqual([
      ["read", "agent", "container.state", "p-marco"],
      ["change", "agent", "container.restart", "p-marco"],
      ["read", "agent", "container.state", "p-marco"],
    ]);
    expect(done.commands[1]!.approvalId).toBe(plans(c.id).at(-1)!.id);
  });
});

describe("RF 2: nessuna chiave privata negli eventi, nelle letture, negli avvisi", () => {
  it("dopo avvio, approvazione, controllo e revoca", async () => {
    const secrets = () => __privateValuesForTest().flatMap((x) => x.values);
    const seen = new Set<string>(secrets());
    const leaks = async () => {
      for (const s of secrets()) seen.add(s);
      as("p-roberta");
      const dump = JSON.stringify({
        events: state.conversations.map((c) => eventsOf(c.id)),
        conversations: state.conversations,
        notifications: await listNotifications(),
        info: await servers.getServerTaskInfo(TASK),
        server: await servers.getServer("SRV-1"),
        tasks: [...state.tasksById.values()],
      });
      expect(dump).not.toContain("PRIVATE KEY");
      for (const s of seen) expect(dump.includes(s), "segreto nel dump").toBe(false);
    };
    const c = await started("p-roberta");
    await leaks();
    await approved(c, "p-roberta");
    await leaks();
    const again = await started("p-marco");
    await leaks();
    as("p-roberta");
    await servers.revokeSshAccess("SRV-1");
    await whenFixesIdle();
    await leaks();
    // La revoca dell'SSH non tocca la correzione, che passa dall'agente.
    expect(session(again.id).state).toBe("awaiting_approval");
  });
});

describe("errori e ripristino", () => {
  it("failNext → la scrittura fallisce, nessuna sessione", async () => {
    as("p-roberta");
    failNext("startServerFix");
    expect(await message(servers.startServerFix(TASK))).not.toBe("ok");
    expect(fixSessions()).toEqual([]);
  });

  it("resetApi a metà del piano: niente scrive nello stato nuovo", async () => {
    setStreamLatency(20);
    as("p-roberta");
    await servers.startServerFix(TASK);
    await expect
      .poll(() => fixSessions().flatMap((c) => actions(c.id, "server.read")).length, FAST)
      .toBeGreaterThan(0);
    resetApi();
    setLatency(0);
    await sleep(120);
    expect(fixSessions()).toEqual([]);
    expect(state.serverAccess.get("SRV-1")!.lastUse?.ref.kind).toBe("analysis");
  });

  it("resetApi rimette l'esito simulato del controllo", async () => {
    as("p-roberta");
    await servers.simulateFixCheck("SRV-1", "not_resolved");
    resetApi();
    expect(state.fixCheckNext.size).toBe(0);
  });
});
