import { beforeEach, describe, expect, it } from "vitest";
import {
  addComment,
  claude,
  confirmProposal,
  createConversation,
  getConversation,
  getTaskByCode,
  listNotifications,
  projectSettings,
  resetApi,
  runScript,
  sendMessage,
  setLatency,
  setStreamLatency,
  setVisibility,
} from "../api";
import { markReauthenticated, REAUTH_GRACE_MINUTES } from "../auth/reauth";
import type { ProposedAction } from "../model";
import { setSessionPersonId } from "../session";
import { advanceNow, now, state } from "../store";
import type { ConversationEvent } from "../types";
import { revokeProjectPermission } from "../viewer";

// «Annulla» di un gruppo di azioni di Claude (area 10a, Task 5; Review
// Focus 2). Solo chi l'ha chiesta; tutto o niente; il «com'era» guarda le
// scritture venute DOPO (per `seq`, non per `at`: l'orologio è fermo), e
// aprire o leggere non è scrivere. Le scene con Marco stanno in OLV (Marco
// Developer, Giulia Project Lead, nessun iscritto né automazione su
// `task_created`), non in MKX, dove Marco non c'è (P3).

const GIULIA = "p-giulia";
const MARCO = "p-marco";
const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const OLV = "prj-olv";
const LMR = "prj-lmr";
const STW = "prj-stw";

const as = (personId: string) => setSessionPersonId(personId);
const eventsOf = (id: string): ConversationEvent[] => state.conversationEvents.get(id) ?? [];
type Executed = Extract<ConversationEvent, { type: "executed" }>;
type Proposal = Extract<ConversationEvent, { type: "proposal" }>;

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});

/** Giulia crea «Prova» in OLV dal riquadro: classe A, eseguita all'invio. */
async function createdByClaude(): Promise<{
  cid: string;
  groupId: string;
  taskId: string;
  code: string;
}> {
  as(GIULIA);
  const cid = (await createConversation()).id;
  await sendMessage(cid, { text: 'crea "Prova" in OLV' });
  const row = eventsOf(cid).find((e): e is Executed => e.type === "executed")!;
  expect(row.status).toBe("done");
  const task = state.tasks.find((t) => t.projectId === OLV && t.title === "Prova")!;
  return { cid, groupId: row.groupId, taskId: task.id, code: task.code };
}

/** Una scheda confermata da `personId`: il suo gruppo. */
async function confirmed(
  personId: string,
  actions: ProposedAction[],
): Promise<{ cid: string; groupId: string }> {
  as(personId);
  const cid = (await createConversation()).id;
  await runScript(cid, [
    {
      step: "event",
      event: {
        type: "proposal",
        proposalId: "prop-test",
        requesterId: personId,
        actions,
        status: "open",
      },
    },
  ]);
  expect(await confirmProposal(cid, "prop-test")).toMatchObject({ status: "confirmed" });
  const p = eventsOf(cid).find((e): e is Proposal => e.type === "proposal")!;
  expect(p.groupId).toBeDefined();
  return { cid, groupId: p.groupId! };
}

const undoOf = async (cid: string, groupId: string) =>
  (await getConversation(cid))!.undo?.[groupId];

describe("«Annulla» della task creata", () => {
  it("la task non c'è più, voce `task.deleted` col segno, e `undo` diventa `undone` per Giulia", async () => {
    const { cid, groupId, taskId, code } = await createdByClaude();
    expect(await undoOf(cid, groupId)).toEqual({ state: "available", needsReauth: false });
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    expect(state.tasksById.has(taskId)).toBe(false);
    expect(await getTaskByCode(code)).toBeNull();
    const entry = state.changelog.find((e) => e.kind === "task.deleted" && e.object.id === taskId);
    expect(entry).toMatchObject({ actorId: GIULIA, via: "claude" });
    // La creazione non scrive voci nel registro: non c'è una voce da
    // annullare a cui puntare (Task 3: `undoOf` resta assente).
    expect(entry!.undoOf).toBeUndefined();
    expect(state.claudeActions[0]!.undone).toEqual({ at: now(), byId: GIULIA });
    expect(await undoOf(cid, groupId)).toEqual({
      state: "undone",
      byName: "Giulia Ferri",
      at: now(),
    });
  });

  it("Marco l'ha commentata prima: `changed_after` con «Marco Bellini» e il codice, niente cambia", async () => {
    const { cid, groupId, taskId, code } = await createdByClaude();
    as(MARCO);
    await addComment(taskId, "Ci penso io");
    as(GIULIA);
    const expected = { state: "changed_after", byName: "Marco Bellini", code };
    expect(await undoOf(cid, groupId)).toEqual(expected);
    const tasks = structuredClone(state.tasks);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({
      ok: false,
      error: "changed_after",
      byName: "Marco Bellini",
      code,
    });
    expect(state.tasks).toEqual(tasks);
    expect(state.claudeActions[0]!.undone).toBeNull();
  });

  it("Marco l'ha solo aperta: si annulla (aprire non è scrivere)", async () => {
    const { cid, groupId, taskId, code } = await createdByClaude();
    as(MARCO);
    expect(await getTaskByCode(code)).not.toBeNull();
    as(GIULIA);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    expect(state.tasksById.has(taskId)).toBe(false);
  });

  it("solo chi l'ha chiesta: un'altra persona riceve `not_yours`; due volte è `already_undone`", async () => {
    const { cid, groupId, taskId } = await createdByClaude();
    await setVisibility(cid, "public", { confirmedProjectIds: [OLV] });
    as(MARCO);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: false, error: "not_yours" });
    expect(state.tasksById.has(taskId)).toBe(true);
    as(GIULIA);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({
      ok: false,
      error: "already_undone",
    });
  });

  it("l'inverso rifiutato perché la task è occupata: `busy` con le ragioni, niente cambia", async () => {
    // Una PR aperta occupa la task solo in un progetto con repository (STW):
    // la apre la piattaforma, che non è una scrittura sulla task.
    const { cid, groupId } = await confirmed(ROBERTA, [
      { fn: "createTask", args: { projectId: STW, title: "Con PR" }, summary: "Create" },
    ]);
    const taskId = state.tasks.find((t) => t.projectId === STW && t.title === "Con PR")!.id;
    state.pullRequests.push({
      id: "pr-test",
      projectId: STW,
      taskId,
      kind: "pr_opened",
      at: now(),
      number: 42,
      repo: "acme/stubwise",
    });
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({
      ok: false,
      error: "busy",
      reasons: [{ kind: "open_pr", repo: "acme/stubwise", number: 42 }],
    });
    expect(state.tasksById.has(taskId)).toBe(true);
    expect(state.claudeActions[0]!.undone).toBeNull();
  });
});

describe("«Annulla» di una scheda", () => {
  const archive = (projectId: string): ProposedAction => ({
    fn: "archiveProject",
    args: { projectId },
    summary: `Archive ${projectId}`,
  });

  it("due progetti archiviati in una scheda, Roberta ne riapre uno: `changed_after`, l'altro resta archiviato", async () => {
    const { cid, groupId } = await confirmed(GIULIA, [archive(OLV), archive(LMR)]);
    as(ROBERTA);
    expect(await projectSettings.reopenProject(OLV)).toMatchObject({ ok: true });
    as(GIULIA);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({
      ok: false,
      error: "changed_after",
      byName: "Roberta Fontana",
      code: "OLV",
    });
    expect(state.projectsById.get(LMR)!.archived).toMatchObject({ byId: GIULIA });
    expect(state.projectsById.get(OLV)!.archived).toBeNull();
  });

  it("Giulia ha perso `project.settings.manage`: `forbidden` col «Who?» della voce", async () => {
    const { cid, groupId } = await confirmed(GIULIA, [archive(OLV)]);
    revokeProjectPermission(GIULIA, OLV, "project.settings.manage" as never);
    as(GIULIA);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({
      ok: false,
      error: "forbidden",
      whoAction: "manageProjectSettings",
      projectId: OLV,
    });
    expect(state.projectsById.get(OLV)!.archived).toMatchObject({ byId: GIULIA });
  });

  it("l'inverso chiede il codice e la grazia è scaduta: `reauth_required`, poi con il codice riesce", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    const { cid, groupId } = await confirmed(ROBERTA, [
      {
        fn: "addMember",
        args: { projectId: OLV, personId: LAURA, roleId: "role-developer" },
        summary: "Add Laura",
      },
    ]);
    expect(await undoOf(cid, groupId)).toEqual({ state: "available", needsReauth: false });
    advanceNow((REAUTH_GRACE_MINUTES + 1) * 60_000);
    expect(await undoOf(cid, groupId)).toEqual({ state: "available", needsReauth: true });
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(state.projectsById.get(OLV)!.memberIds).toContain(LAURA);
    markReauthenticated(ROBERTA);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    expect(state.projectsById.get(OLV)!.memberIds).not.toContain(LAURA);
  });

  it("planTask verso Marco annullato: la sua notifica dice «Undone by Giulia Ferri», e non ne riceve un'altra", async () => {
    const task = state.tasks.find(
      (t) => t.projectId === OLV && t.assigneeId === GIULIA && t.plannedWeek !== "2026-W47",
    )!;
    const { cid, groupId } = await confirmed(GIULIA, [
      {
        fn: "planTask",
        args: { id: task.id, plan: { assigneeId: MARCO, week: "2026-W47" } },
        summary: "Plan",
      },
    ]);
    as(MARCO);
    const mine = (await listNotifications()).filter((n) => n.objectCode === task.code);
    const assigned = mine.filter((n) => n.kind === "task.assigned");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.undoneByName).toBeNull();
    as(GIULIA);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    expect(state.tasksById.get(task.id)!.assigneeId).toBe(GIULIA);
    as(MARCO);
    const after = (await listNotifications()).filter((n) => n.objectCode === task.code);
    expect(after).toHaveLength(mine.length);
    expect(after.find((n) => n.kind === "task.assigned")!.undoneByName).toBe("Giulia Ferri");
  });
});

describe("`undo` letto da un altro", () => {
  it("in una pubblica di Giulia, Marco legge ogni `undo` come `not_yours`, senza nomi né codici", async () => {
    const { cid, groupId, code } = await createdByClaude();
    as(MARCO);
    await addComment(state.tasks.find((t) => t.code === code)!.id, "Visto");
    as(GIULIA);
    await setVisibility(cid, "public", { confirmedProjectIds: [OLV] });
    as(MARCO);
    const undo = (await getConversation(cid))!.undo ?? {};
    expect(undo).toEqual({ [groupId]: { state: "not_yours" } });
    const text = JSON.stringify(undo).toLowerCase();
    for (const secret of ["marco", "giulia", code.toLowerCase(), "olv"])
      expect(text).not.toContain(secret);
  });
});
