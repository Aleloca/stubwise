import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isReadCommand } from "../../domain/servers/commands";
import { fixCommandsBeforeApproval } from "../../domain/servers/fixGate";
import {
  decidePlan,
  failNext,
  listNotifications,
  preApprovePlan,
  releases,
  resetApi,
  servers,
  setLatency,
  startRun,
  stop,
  stopAndSend,
} from "../api";
import { createTaskAs } from "../api-mutations";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import {
  conversationPermissions,
  eventsOf,
  setStreamLatency,
  state,
  visibleProjectIds,
} from "../store";
import type { Conversation, ConversationEvent } from "../types";
import { can, viewerFor } from "../viewer";
import { whenFixesIdle } from "./fix";
import { __privateValuesForTest } from "./secrets";

// La correzione di un server da una task (area 8b, RF 1 e RF 2). Le
// asserzioni stanno sullo STATO — sessioni, eventi, `fixCommandsBeforeApproval`,
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
    expect(actions(c.id, "server.fix")).toEqual([]);
    // Prima del piano Claude legge, e solo con comandi di lettura.
    const reads = actions(c.id, "server.read");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(isReadCommand(r.input!), r.input).toBe(true);
    expect(state.serverAccess.get("SRV-1")!.lastUse.read?.ref).toEqual({
      kind: "task",
      taskId: TASK,
    });
    expect(conversationPermissions("p-roberta", c).canDecidePlan).toBe(true);
    expect(conversationPermissions("p-roberta", c).canPreApprovePlan).toBe(false);
    expect(conversationPermissions("p-roberta", c).planBlockedReason).toBeNull();

    await approved(c, "p-roberta");
    const fixes = actions(c.id, "server.fix");
    expect(fixes.map((a) => a.input)).toEqual([
      "sudo docker update --memory 2g --memory-swap 2g portale-import",
      "sudo docker restart portale-import",
    ]);
    expect(fixes.every((a) => a.state === "done")).toBe(true);
    expect(plans(c.id).at(-1)).toMatchObject({ status: "approved", decidedById: "p-roberta" });
    expect(state.serverAccess.get("SRV-1")!.lastUse.fix?.ref).toEqual({
      kind: "task",
      taskId: TASK,
    });
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
    expect(actions(c.id, "server.fix").length).toBe(2);
    expect(plans(c.id).at(-1)).toMatchObject({ status: "approved", decidedById: "p-laura" });
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
    await decidePlan(c.id, "reject", "Don't cap the memory, only restart.");
    await whenFixesIdle();
    expect(plans(c.id).map((p) => p.status)).toEqual(["rejected", "pending"]);
    expect(plans(c.id)[1]!.planText).toContain("Don't cap the memory, only restart.");
    expect(session(c.id).state).toBe("awaiting_approval");
    expect(actions(c.id, "server.fix")).toEqual([]);
    await approved(c, "p-roberta");
    expect(actions(c.id, "server.fix").length).toBe(2);
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

describe("RF 1: accesso revocato o non più usabile", () => {
  it("revoca con il piano in attesa → approvazione spenta col motivo, rifiutata, zero comandi; il rifiuto resta", async () => {
    const c = await started("p-roberta");
    as("p-roberta");
    await servers.revokeSshAccess("SRV-1");
    await whenFixesIdle();
    // In attesa resta ferma lì: l'approvazione si spegne, non la sessione.
    expect(session(c.id).state).toBe("awaiting_approval");
    const perms = conversationPermissions("p-roberta", session(c.id));
    expect(perms.canDecidePlan).toBe(false);
    expect(perms.planBlockedReason).toBe("fix_access_revoked");
    // Chi non può approvare non vede una ragione che non lo riguarda.
    expect(conversationPermissions("p-marco", session(c.id)).planBlockedReason).toBeNull();
    as("p-roberta");
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: fix_access");
    as("p-laura");
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: fix_access");
    expect(plans(c.id).map((p) => p.status)).toEqual(["pending"]);
    expect(allFixCommands()).toBe(0);
    // Ricollegato ma non verificato: un'altra ragione, sempre spenta.
    as("p-roberta");
    await servers.linkSshAccess("SRV-1");
    expect(conversationPermissions("p-roberta", session(c.id)).planBlockedReason).toBe(
      "fix_access_unverified",
    );
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: fix_access");
    // Il rifiuto resta possibile (shape: «Reject resta attivo»).
    await decidePlan(c.id, "reject");
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    expect(allFixCommands()).toBe(0);
  });

  it("revoca durante l'esecuzione → la sessione si ferma col motivo, nessun comando dopo", async () => {
    const c = await started("p-roberta");
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    await servers.revokeSshAccess("SRV-1");
    const atRevoke = actions(c.id, "server.fix").length;
    await whenFixesIdle();
    await sleep(80);
    expect(actions(c.id, "server.fix").length).toBe(atRevoke);
    expect(atRevoke).toBeLessThan(2);
    expect(actions(c.id, "server.fix").every((a) => a.state !== "running")).toBe(true);
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
    const last = phases(c.id).at(-1)!;
    expect(last).toMatchObject({ outcome: "stopped", reason: "fix_access_revoked" });
    expect(last.stoppedById).toBeUndefined();
    expect(checks(c.id)).toEqual([]);
    as("p-roberta");
    expect((await servers.getServerTaskInfo(TASK))!.state).toBe("stopped");
  });

  it("revoca mentre Claude legge per il piano → si ferma, nessun piano", async () => {
    setStreamLatency(20);
    as("p-roberta");
    const c = await servers.startServerFix(TASK);
    await expect.poll(() => actions(c.id, "server.read").length, FAST).toBeGreaterThan(0);
    await servers.revokeSshAccess("SRV-1");
    await whenFixesIdle();
    await sleep(80);
    expect(plans(c.id)).toEqual([]);
    expect(phases(c.id).at(-1)).toMatchObject({ reason: "fix_access_revoked" });
    expect(session(c.id).state).toBe("finished");
  });

  it("lettura che scrive durante l'esecuzione → si ferma, «non più usabile», nessun comando dopo", async () => {
    const c = await started("p-roberta");
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    await servers.simulateSshVerifyOutcome("SRV-1", "read_writes");
    await servers.verifySshAccess("SRV-1");
    const atVerify = actions(c.id, "server.fix").length;
    await whenFixesIdle();
    expect(actions(c.id, "server.fix").length).toBe(atVerify);
    expect(atVerify).toBeLessThan(2);
    expect(phases(c.id).at(-1)).toMatchObject({
      outcome: "stopped",
      reason: "fix_access_unusable",
    });
    expect(session(c.id)).toMatchObject({ state: "finished", outcome: "stopped" });
  });

  it("lettura che scrive con il piano in attesa → approvazione spenta (non verificato)", async () => {
    const c = await started("p-roberta");
    as("p-roberta");
    await servers.simulateSshVerifyOutcome("SRV-1", "read_writes");
    await servers.verifySshAccess("SRV-1");
    expect(conversationPermissions("p-roberta", session(c.id))).toMatchObject({
      canDecidePlan: false,
      planBlockedReason: "fix_access_unverified",
    });
    expect(await message(decidePlan(c.id, "approve"))).toBe("invalid: fix_access");
    // Verificato di nuovo, si approva.
    await servers.verifySshAccess("SRV-1");
    await approved(c, "p-roberta");
    expect(actions(c.id, "server.fix").length).toBe(2);
  });
});

describe("RF 1: fermare, e i percorsi che non usano l'accesso di correzione", () => {
  it("lo Stop di una persona → fermata da lei, nessun comando dopo", async () => {
    const c = await started("p-roberta");
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    await stop(c.id);
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
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info.state).toBe("stopped");
    expect(info.startBlock).toBeNull(); // «Start fix again»
  });

  it("«Ferma e scrivi» → si ferma e il piano si riscrive, di nuovo da approvare", async () => {
    const c = await started("p-roberta");
    setStreamLatency(20);
    as("p-roberta");
    await decidePlan(c.id, "approve");
    await expect.poll(() => actions(c.id, "server.fix").length, FAST).toBeGreaterThan(0);
    await stopAndSend(c.id, "Only restart, nothing else.");
    const atStop = actions(c.id, "server.fix").length;
    await whenFixesIdle();
    expect(actions(c.id, "server.fix").length).toBe(atStop);
    expect(plans(c.id).at(-1)).toMatchObject({ status: "pending" });
    expect(plans(c.id).at(-1)!.planText).toContain("Only restart, nothing else.");
    expect(session(c.id).state).toBe("awaiting_approval");
  });

  it("task senza serverRef → not_server_task; accesso in attesa del comando → fix_access_unverified", async () => {
    const plain = [...state.tasksById.values()].find(
      (t) => t.projectId === ACQ && !t.serverRef && t.closedAt === null,
    )!;
    as("p-roberta");
    expect(await message(servers.startServerFix(plain.id))).toBe("invalid: not_server_task");
    // SRV-3 (AUD): chiavi generate, mai verificate.
    const aud = state.projects.find((p) => p.code === "AUD")!;
    const t = createTaskAs(
      CLAUDE_ID,
      { projectId: aud.id, title: "SRV-3 in trouble", type: "bug" },
      { source: "server", serverRef: { serverCode: "SRV-3", episodeId: null } },
    );
    expect(await message(servers.startServerFix(t.id))).toBe("invalid: fix_access_unverified");
    // SRV-2 (STW): non collegato.
    const stw = state.projects.find((p) => p.code === "STW")!;
    const t2 = createTaskAs(
      CLAUDE_ID,
      { projectId: stw.id, title: "SRV-2 disk", type: "bug" },
      { source: "server", serverRef: { serverCode: "SRV-2", episodeId: null } },
    );
    expect(await message(servers.startServerFix(t2.id))).toBe("invalid: no_fix_access");
    expect(fixSessions()).toEqual([]);
  });

  it("una task invisibile risponde not_found prima del permesso; una correzione viva → run_live", async () => {
    as(outsider());
    expect(await message(servers.startServerFix("t-nope"))).toBe("not_found");
    await started("p-roberta");
    expect(await message(servers.startServerFix(TASK))).toBe("invalid: run_live");
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

  it("di base risolto; le letture del controllo sono di sola lettura", async () => {
    const c = await started("p-roberta");
    await approved(c, "p-roberta");
    expect(checks(c.id)[0]!.text).toMatch(/^Check after the fix: resolved/);
    for (const r of actions(c.id, "server.read"))
      expect(isReadCommand(r.input!), r.input).toBe(true);
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
  it("dice server, episodio, stato, blocco e accesso; null per una task senza serverRef", async () => {
    as("p-marco");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info.server).toEqual({ code: "SRV-1", name: expect.any(String) });
    expect(info.episode?.serverCode).toBe("SRV-1");
    expect(info.state).toBe("diagnosis_ready");
    expect(info.startBlock).toBeNull();
    expect(info.fixAccess).toBe("verified");
    expect(info.fixConversationId).toBeNull();
    as("p-laura");
    expect((await servers.getServerTaskInfo(TASK))!.startBlock).toBe("no_permission");
    const plain = [...state.tasksById.values()].find((t) => t.projectId === ACQ && !t.serverRef)!;
    expect(await servers.getServerTaskInfo(plain.id)).toBeNull();
    as(outsider());
    expect(await message(servers.getServerTaskInfo(TASK))).toBe("not_found");
  });

  it("segue la correzione: piano da approvare, in corso", async () => {
    const c = await started("p-marco");
    as("p-marco");
    const info = (await servers.getServerTaskInfo(TASK))!;
    expect(info).toMatchObject({
      state: "plan_awaiting",
      startBlock: "run_live",
      fixConversationId: c.id,
    });
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
    expect(state.serverAccess.get("SRV-1")!.lastUse.read?.ref.kind).toBe("analysis");
  });

  it("resetApi rimette l'esito simulato del controllo", async () => {
    as("p-roberta");
    await servers.simulateFixCheck("SRV-1", "not_resolved");
    resetApi();
    expect(state.fixCheckNext.size).toBe(0);
  });
});
