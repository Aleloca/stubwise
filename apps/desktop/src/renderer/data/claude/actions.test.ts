import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  automations,
  chat,
  confirmProposal,
  createConversation,
  getConversation,
  resetApi,
  runScript,
  sendMessage,
  setLatency,
  setStreamLatency,
  stop,
} from "../api";
import { markReauthenticated } from "../auth/reauth";
import type { ProposedAction } from "../model";
import { CLAUDE_ACTIONS } from "../seed/claudeActions";
import { setSessionPersonId } from "../session";
import { now, state } from "../store";
import type { ConversationEvent } from "../types";
import { classOfGroup } from "./classes";

/** Le azioni di Claude scritte dalla sessione di prova: quelle del seme (area 10a, Task 7) restano fuori. */
const sessionActions = () => state.claudeActions.slice(CLAUDE_ACTIONS.length);

// Eseguire per classe (area 10a, Task 5): nella conversazione libera
// un'azione A parte all'invio e lascia una riga `executed` e una riga in
// `state.claudeActions`; una B o una C resta una scheda, e la C chiede la
// riconferma senza consumarla. @Claude nella Chat resta tutto proposte.
//
// Seme: Giulia è Project Lead in MKX e OLV, Contributor in AUD, dove Matteo
// segue le task nuove; Roberta è full admin.

// La corsa «automazione accesa fra il calcolo e l'esecuzione» si prova
// dentro la prima chiamata di `classOfGroup` (quella di `ctx.classify`):
// fra `respond` e `runScript` non c'è un'attesa (ruling del controller
// (pre-flight), P26). Fuori da quel test la funzione è quella vera.
vi.mock("./classes", async (importOriginal) => {
  const real = await importOriginal<typeof import("./classes")>();
  return { ...real, classOfGroup: vi.fn(real.classOfGroup) };
});
const realClasses = await vi.importActual<typeof import("./classes")>("./classes");

const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const MATTEO = "p-matteo";
const MKX = "prj-mkx";
const AUD = "prj-aud";
const OLV = "prj-olv";

const as = (personId: string) => setSessionPersonId(personId);
const eventsOf = (id: string): ConversationEvent[] => state.conversationEvents.get(id) ?? [];
type Executed = Extract<ConversationEvent, { type: "executed" }>;
type Proposal = Extract<ConversationEvent, { type: "proposal" }>;
const executedOf = (id: string) => eventsOf(id).filter((e): e is Executed => e.type === "executed");
const proposalsOf = (id: string) =>
  eventsOf(id).filter((e): e is Proposal => e.type === "proposal");
const tasksTitled = (projectId: string, title: string) =>
  state.tasks.filter((t) => t.projectId === projectId && t.title === title);

/** Una conversazione libera di `personId` con un messaggio, a turno finito. */
async function said(personId: string, text: string, id?: string): Promise<string> {
  as(personId);
  const cid = id ?? (await createConversation()).id;
  await sendMessage(cid, { text });
  return cid;
}

/** Mette una proposta nel flusso, come farebbe Claude. */
async function propose(
  conversationId: string,
  requesterId: string,
  actions: ProposedAction[],
  proposalId = "prop-test",
): Promise<void> {
  await runScript(conversationId, [
    {
      step: "event",
      event: { type: "proposal", proposalId, requesterId, actions, status: "open" },
    },
  ]);
}

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
  vi.mocked(classOfGroup).mockImplementation(realClasses.classOfGroup);
});

describe("classe A: parte all'invio", () => {
  it('Giulia, «crea "Prova" in MKX»: la task nasce subito, riga `executed` e riga A nel registro delle azioni', async () => {
    const cid = await said(GIULIA, 'crea "Prova" in MKX');
    const [task] = tasksTitled(MKX, "Prova");
    expect(task).toBeDefined();
    expect(task!.createdById).toBe(GIULIA);
    const [row] = executedOf(cid);
    expect(row).toMatchObject({ status: "done", resultCodes: [task!.code] });
    expect(row!.groupId).not.toBe("");
    // `pending` non arriva mai a chi legge.
    expect(executedOf(cid).some((e) => e.status === "pending")).toBe(false);
    expect(proposalsOf(cid)).toEqual([]);
    expect(sessionActions()).toEqual([
      expect.objectContaining({
        groupId: row!.groupId,
        conversationId: cid,
        personId: GIULIA,
        fn: "createTask",
        cls: "A",
        objects: [{ kind: "task", id: task!.id }],
        inverse: { fn: "deleteTask", args: { id: task!.id } },
        undone: null,
      }),
    ]);
  });

  it("stessa frase in AUD: nessuna task, una scheda aperta B con «Notifies Matteo Conti»", async () => {
    const cid = await said(GIULIA, 'crea "Prova" in AUD');
    expect(tasksTitled(AUD, "Prova")).toEqual([]);
    expect(executedOf(cid)).toEqual([]);
    expect(proposalsOf(cid)).toEqual([
      expect.objectContaining({
        status: "open",
        cls: "B",
        reasons: [{ kind: "notifies", personIds: [MATTEO], more: false }],
      }),
    ]);
    expect(sessionActions()).toEqual([]);
  });

  it("un'automazione su task_created si accende fra il calcolo e l'esecuzione: scheda col motivo, nessuna task", async () => {
    as(ROBERTA);
    const automation = await automations.createAutomation({
      name: "Su task_created",
      projectId: MKX,
      flow: {
        trigger: { kind: "stubwise", event: "task_created" },
        steps: [{ id: "w", kind: "wait", for: { days: 1 } }],
        titleTemplate: "{{task.codice}}",
      },
    });
    await automations.activate(automation.id);
    await automations.pause(automation.id);
    // La prima classe (quella di `ctx.classify`) è A; subito dopo
    // l'automazione torna attiva, e il ricalcolo di `freeTurn` la vede.
    vi.mocked(classOfGroup).mockImplementationOnce((me, actions) => {
      const cls = realClasses.classOfGroup(me, actions);
      expect(cls.cls).toBe("A");
      state.automations.find((a) => a.id === automation.id)!.status = "active";
      return cls;
    });
    const runsBefore = state.automationRuns.length;
    const cid = await said(GIULIA, 'crea "Prova" in MKX');
    expect(tasksTitled(MKX, "Prova")).toEqual([]);
    expect(state.automationRuns).toHaveLength(runsBefore);
    expect(executedOf(cid)).toEqual([]);
    expect(proposalsOf(cid)).toEqual([
      expect.objectContaining({
        status: "open",
        cls: "B",
        reasons: [{ kind: "automation", projectId: MKX }],
      }),
    ]);
    // Non è un «Didn't run»: Claude chiede prima, e non dice «fatto».
    const text = eventsOf(cid)
      .flatMap((e) => (e.type === "assistant" ? [e.text] : []))
      .join("\n");
    expect(text).toMatch(/^I'm asking first: it starts an automation in MKX\.$/m);
    expect(text).not.toMatch(/Done/);
    expect(sessionActions()).toEqual([]);
  });

  it("due azioni A di fila sulla stessa task: la prima diventa `changed_after` con Giulia, la seconda si annulla (P4)", async () => {
    const cid = await said(GIULIA, 'crea "Prova" in MKX');
    const [task] = tasksTitled(MKX, "Prova");
    const [first] = executedOf(cid);
    // La scrittura del gruppo stesso non conta.
    expect((await getConversation(cid))!.undo).toEqual({
      [first!.groupId]: { state: "available", needsReauth: false },
    });
    await said(GIULIA, `Plan ${task!.code} for W46`, cid);
    const second = executedOf(cid)[1]!;
    expect(second).toMatchObject({ status: "done", resultCodes: [task!.code] });
    expect(state.tasksById.get(task!.id)!.plannedWeek).toBe("2026-W46");
    // Tutte le scritture della sessione hanno lo stesso `at`: decide `seq`.
    expect(new Set(sessionActions().map((r) => r.at)).size).toBe(1);
    expect((await getConversation(cid))!.undo).toEqual({
      [first!.groupId]: { state: "changed_after", byName: "Giulia Ferri", code: task!.code },
      [second.groupId]: { state: "available", needsReauth: false },
    });
  });

  it("«Ferma» subito dopo l'esecuzione, mentre arriva «Done…»: la task c'è, e anche la sua riga con «Annulla»", async () => {
    // Con la latenza dello stream la frase arriva a pezzi: «Ferma» taglia i
    // passi che restano, ma non la riga di ciò che è già stato fatto.
    setStreamLatency(5);
    as(GIULIA);
    const cid = (await createConversation()).id;
    const sending = sendMessage(cid, { text: 'crea "Prova" in MKX' });
    while (sessionActions().length === 0) await new Promise((r) => setTimeout(r, 1));
    await stop(cid);
    await sending;
    const [task] = tasksTitled(MKX, "Prova");
    expect(task).toBeDefined();
    const [row] = executedOf(cid);
    expect(row).toMatchObject({ status: "done", resultCodes: [task!.code] });
    expect(row!.groupId).toBe(sessionActions()[0]!.groupId);
    expect((await getConversation(cid))!.undo).toEqual({
      [row!.groupId]: { state: "available", needsReauth: false },
    });
  });
});

describe("la Chat resta tutto proposte (area 4)", () => {
  it("@Claude con la stessa frase in MKX: una proposta, nessuna task, nessuna classe", async () => {
    as(GIULIA);
    const call = await chat.sendMessage("ch-announcements", {
      text: '@Claude crea "Prova" in MKX',
    });
    const reply = state.chatMessages.find((m) => m.threadOf === call.id && m.kind === "claude")!;
    await chat.whenClaudeIdle(reply.id);
    const events = state.chatMessages.find((m) => m.id === reply.id)!.claudeEvents ?? [];
    expect(events.some((e) => e.type === "executed")).toBe(false);
    const proposal = events.find((e): e is Proposal => e.type === "proposal");
    expect(proposal).toMatchObject({ status: "open", actions: [{ fn: "createTask" }] });
    expect(proposal!.cls).toBeUndefined();
    expect(tasksTitled(MKX, "Prova")).toEqual([]);
  });
});

describe("classi B e C: la scheda", () => {
  const addLaura: ProposedAction = {
    fn: "addMember",
    args: { projectId: OLV, personId: LAURA, roleId: "role-developer" },
    summary: "Add Laura to OLV",
  };

  it("C: addMember senza riconferma → `reauth_required`, la scheda resta aperta e nulla cambia; con la riconferma riesce", async () => {
    as(ROBERTA);
    const cid = (await createConversation()).id;
    await propose(cid, ROBERTA, [addLaura]);
    const members = structuredClone(state.projectsById.get(OLV)!.memberIds);
    expect(await confirmProposal(cid, "prop-test")).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(proposalsOf(cid)[0]!.status).toBe("open");
    expect(state.projectsById.get(OLV)!.memberIds).toEqual(members);
    expect(sessionActions()).toEqual([]);
    markReauthenticated(ROBERTA);
    // La scheda non era stata presa: la stessa conferma ora riesce.
    expect(await confirmProposal(cid, "prop-test")).toMatchObject({ status: "confirmed" });
    expect(state.projectsById.get(OLV)!.memberIds).toContain(LAURA);
    const [row] = sessionActions();
    expect(row).toMatchObject({ fn: "addMember", cls: "C", personId: ROBERTA });
    expect(proposalsOf(cid)[0]).toMatchObject({ status: "confirmed", groupId: row!.groupId });
  });

  it("la grazia di Roberta non vale per Laura", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    as(LAURA);
    const cid = (await createConversation()).id;
    await propose(cid, LAURA, [
      { ...addLaura, args: { projectId: "prj-stw", personId: "p-sara", roleId: "role-developer" } },
    ]);
    expect(await confirmProposal(cid, "prop-test")).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(proposalsOf(cid)[0]!.status).toBe("open");
  });

  it("C da `REAUTH_REQUIRED`, non dalla scrittura: saveStorage senza chiave nuova chiede lo stesso il codice", async () => {
    as(ROBERTA);
    const cid = (await createConversation()).id;
    const s = state.instance.storage;
    const before = structuredClone(s);
    await propose(cid, ROBERTA, [
      {
        fn: "saveStorage",
        args: {
          endpoint: s.endpoint,
          region: s.region,
          bucket: "stubwise-files-2",
          accessKeyId: s.accessKeyId,
        },
        summary: "Change the bucket",
      },
    ]);
    expect(await confirmProposal(cid, "prop-test")).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(state.instance.storage).toEqual(before);
  });

  it("una proposta con una `fn` fuori dal catalogo (`recordDecision`) confermata nel riquadro: `failed` con `invalid`, nessuna decisione", async () => {
    as(GIULIA);
    const cid = (await createConversation()).id;
    const log = structuredClone(state.decisionLog);
    await propose(cid, GIULIA, [
      {
        fn: "recordDecision",
        args: { projectId: MKX, title: "T", decision: "D", source: "manual" },
        summary: "Record a decision",
      },
    ]);
    const outcome = await confirmProposal(cid, "prop-test");
    expect(outcome).toMatchObject({ status: "failed" });
    expect(proposalsOf(cid)[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("no longer applies"),
    });
    expect(state.decisionLog).toEqual(log);
    expect(sessionActions()).toEqual([]);
  });

  it("coda di MKX in pausa (9b): una scheda startRun fa nascere la sessione in attesa; la conversazione risponde lo stesso", async () => {
    state.instance.queuePauses.push({ projectId: MKX, byId: ROBERTA, at: now() });
    as(GIULIA);
    const cid = (await createConversation()).id;
    await propose(cid, GIULIA, [
      { fn: "startRun", args: { taskId: "t-mkx-7" }, summary: "Start Claude on MKX-7" },
    ]);
    const outcome = await confirmProposal(cid, "prop-test");
    expect(outcome).toMatchObject({ status: "confirmed" });
    const [runId] = (outcome as { runConversationIds: string[] }).runConversationIds;
    const run = state.conversations.find((c) => c.id === runId)!;
    expect(run.waiting).not.toBeNull();
    expect(run.waiting).toBeDefined();
    await sendMessage(cid, { text: "Explain MKX-7" });
    const last = eventsOf(cid).at(-1);
    expect(eventsOf(cid).filter((e) => e.type === "assistant").length).toBeGreaterThan(0);
    expect(last).toBeDefined();
  });
});
