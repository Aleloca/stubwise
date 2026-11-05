import { beforeEach, describe, expect, it } from "vitest";
import {
  changelog,
  claude,
  confirmProposal,
  createConversation,
  getConversation,
  listNotifications,
  resetApi,
  runScript,
  sendMessage,
  setLatency,
  setStreamLatency,
} from "./api";
import { executeGroup } from "./claude/actions";
import { classOfGroup } from "./claude/classes";
import { setSessionPersonId } from "./session";
import {
  CLAUDE_ACTIONS,
  CLAUDE_ACTIVITY,
  CLAUDE_CHANGES,
  CLAUDE_SEED_IDS,
  HANDOVER_TASK,
  MOVE_TASK,
  SEED_MAX_SEQ,
} from "./seed/claudeActions";
import { CLOCK_START } from "./seed/dates";
import { PRODUCT_REVISIONS } from "./seed/productDocs";
import { nextSeq, state } from "./store";
import type { ConversationEvent } from "./types";

// Il seme delle azioni di Claude (area 10a, Task 7): due conversazioni di
// Giulia nate dal riquadro e la notifica di Marco. Le scene con Marco stanno
// in OLV (Marco non è in MKX, ruling del controller (pre-flight), P3).

const GIULIA = "p-giulia";
const MARCO = "p-marco";
const ROBERTA = "p-roberta";
const MKX = "prj-mkx";
const { move, brief } = CLAUDE_SEED_IDS;

const as = (personId: string) => setSessionPersonId(personId);

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});

describe("le conversazioni di Giulia nate dal riquadro", () => {
  it("sono private di Giulia e le vede solo lei", async () => {
    for (const id of [move.conversation, brief.conversation]) {
      const c = state.conversations.find((x) => x.id === id)!;
      expect(c).toMatchObject({ kind: "free", ownerId: GIULIA, visibility: "private" });
      as(GIULIA);
      expect(await getConversation(id)).not.toBeNull();
      as(MARCO);
      expect(await getConversation(id)).toBeNull();
      as(ROBERTA);
      expect(await getConversation(id)).toBeNull();
    }
  });

  it("per Giulia «Annulla» è `undone` su entrambi i gruppi, con chi e quando", async () => {
    as(GIULIA);
    for (const [id, group, undoneAt] of [
      [move.conversation, move.group, "10:34"],
      [brief.conversation, brief.group, "09:58"],
    ] as const) {
      const detail = (await getConversation(id))!;
      expect(detail.undo?.[group]).toMatchObject({ state: "undone", byName: "Giulia Ferri" });
      expect(detail.undo?.[group]).toMatchObject({ at: expect.stringContaining(undoneAt) });
    }
  });

  it("la prima è un'azione di classe A senza scheda, la seconda una scheda B con due azioni", async () => {
    as(GIULIA);
    const first = (await getConversation(move.conversation))!.events;
    expect(first.map((e) => e.type)).toEqual(["user", "assistant", "executed"]);
    const executed = first.find((e): e is Extract<ConversationEvent, { type: "executed" }> => e.type === "executed")!;
    expect(executed).toMatchObject({ status: "done", groupId: move.group });
    expect(executed.actions.map((a) => a.fn)).toEqual(["planTask"]);
    expect(CLAUDE_ACTIONS.filter((r) => r.groupId === move.group).map((r) => r.cls)).toEqual(["A"]);

    const second = (await getConversation(brief.conversation))!.events;
    const proposal = second.find((e): e is Extract<ConversationEvent, { type: "proposal" }> => e.type === "proposal")!;
    expect(proposal).toMatchObject({ status: "confirmed", cls: "B", groupId: brief.group });
    expect(proposal.actions.map((a) => a.fn)).toEqual(["planTask", "saveProjectAutomations"]);
    expect(CLAUDE_ACTIONS.filter((r) => r.groupId === brief.group).map((r) => r.cls)).toEqual(["B", "B"]);
  });

  it("l'«Annulla» ha rimesso tutto com'era: task, assegnatario e interruttore sono quelli del seme", () => {
    expect(state.tasksById.get(MOVE_TASK.id)).toMatchObject({
      assigneeId: GIULIA,
      plannedWeek: MOVE_TASK.from,
    });
    expect(state.tasksById.get(HANDOVER_TASK.id)).toMatchObject({
      assigneeId: GIULIA,
      plannedWeek: HANDOVER_TASK.week,
    });
    expect(state.projectSettings.get(MKX)!.switches.weeklyBrief).toBe(false);
    // Il registro dice lo stesso: l'ultima voce sull'interruttore è «Off».
    const last = state.changelog.filter((e) => e.kind === "project.switch_changed" && e.projectId === MKX).at(-1)!;
    expect(last.after).toBe("off");
  });

  it("non si annulla due volte", async () => {
    as(GIULIA);
    expect(await claude.undoClaudeActions(brief.conversation, brief.group)).toEqual({
      ok: false,
      error: "already_undone",
    });
  });
});

describe("la notifica di Marco", () => {
  it("la legge con viaClaude e «Undone by» di Giulia", async () => {
    as(MARCO);
    const n = (await listNotifications()).find((x) => x.id === CLAUDE_SEED_IDS.notification)!;
    expect(n).toMatchObject({
      kind: "task.assigned",
      objectCode: HANDOVER_TASK.code,
      viaClaude: { personId: GIULIA, actionId: brief.plan },
      undoneByName: "Giulia Ferri",
    });
  });

  it("non arriva a Giulia, che se l'è assegnata da sola solo in apparenza", async () => {
    as(GIULIA);
    expect((await listNotifications()).some((x) => x.id === CLAUDE_SEED_IDS.notification)).toBe(false);
  });
});

describe("il registro", () => {
  it("Giulia (Change log di MKX) e Roberta trovano le due voci col filtro via claude", async () => {
    as(GIULIA);
    const mine = await changelog.listProjectChanges(MKX, { via: "claude" });
    expect(mine).toHaveLength(2);
    as(ROBERTA);
    const admin = await changelog.listChanges({ via: "claude" });
    expect(admin).toHaveLength(2);
    // La più recente è l'inverso, che rimanda alla voce annullata.
    const [undo, original] = admin;
    expect(original).toMatchObject({ kind: "project.switch_changed", before: "on", after: "off", undoOf: null });
    expect(undo).toMatchObject({ before: "off", after: "on", undoOf: original!.id });
    for (const e of admin) expect(e).toMatchObject({ actorId: GIULIA, via: "claude" });
  });
});

describe("coerenza degli ordini e delle date", () => {
  it("ogni `seq` del seme è distinto, ≤ SEED_MAX_SEQ, e quelli nuovi vengono dopo", () => {
    const seqs = [
      ...CLAUDE_ACTIVITY.map((a) => a.seq!),
      ...CLAUDE_CHANGES.filter((c) => c.seq !== undefined).map((c) => c.seq!),
      ...CLAUDE_ACTIONS.map((r) => r.seq),
    ];
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs)).toBe(SEED_MAX_SEQ);
    // Dall'area 11a lo store parte dal massimo dei `seq` del seme di Claude e
    // di quello del Prodotto (ruling P4).
    expect(nextSeq()).toBe(Math.max(SEED_MAX_SEQ, ...PRODUCT_REVISIONS.map((r) => r.lastSeq)) + 1);
  });

  it("l'ordine dei `seq` segue quello dei fatti: esecuzione, riga dell'azione, «Annulla»", () => {
    const seq = (id: string) => [...CLAUDE_ACTIVITY, ...CLAUDE_CHANGES].find((x) => x.id === id)!.seq!;
    const rec = (id: string) => CLAUDE_ACTIONS.find((r) => r.id === id)!.seq;
    expect(seq("act-seed-claude-1")).toBeLessThan(rec(move.action));
    expect(rec(move.action)).toBeLessThan(seq("act-seed-claude-2"));
    expect(seq("act-seed-claude-3")).toBeLessThan(seq("chg-seed-claude-1"));
    expect(seq("chg-seed-claude-1")).toBeLessThan(rec(brief.plan));
    expect(rec(brief.switch)).toBeLessThan(seq("chg-seed-claude-2"));
    expect(seq("chg-seed-claude-2")).toBeLessThan(seq("act-seed-claude-4"));
  });

  it("le date stanno negli ultimi 7 giorni, mai dopo CLOCK_START, e l'annullo dopo l'esecuzione", () => {
    const week = Date.parse(CLOCK_START) - 7 * 86_400_000;
    const times = [
      ...CLAUDE_ACTIONS.flatMap((r) => [r.at, r.undone!.at]),
      ...CLAUDE_ACTIVITY.map((a) => a.at),
      ...CLAUDE_CHANGES.map((c) => c.at),
      state.notifications.find((n) => n.id === CLAUDE_SEED_IDS.notification)!.createdAt,
    ];
    for (const t of times) {
      expect(Date.parse(t)).toBeGreaterThanOrEqual(week);
      expect(Date.parse(t)).toBeLessThanOrEqual(Date.parse(CLOCK_START));
    }
    for (const r of CLAUDE_ACTIONS) expect(Date.parse(r.undone!.at)).toBeGreaterThan(Date.parse(r.at));
  });

  it("lastActivityAt di ogni task toccata dal seme è ≥ la sua attività più recente", () => {
    const touched = new Set(CLAUDE_ACTIVITY.map((a) => a.taskId));
    for (const id of touched) {
      const latest = CLAUDE_ACTIVITY.filter((a) => a.taskId === id)
        .map((a) => a.at)
        .sort()
        .at(-1)!;
      expect(state.tasksById.get(id)!.lastActivityAt >= latest, id).toBe(true);
    }
  });

  it("ogni conversazione, azione e riga rimanda a un id che esiste", () => {
    for (const r of CLAUDE_ACTIONS) {
      expect(state.conversations.some((c) => c.id === r.conversationId)).toBe(true);
      for (const o of r.objects) if (o.kind === "task") expect(state.tasksById.has(o.id)).toBe(true);
    }
    for (const a of CLAUDE_ACTIVITY) expect(state.tasksById.has(a.taskId)).toBe(true);
  });
});

// Le righe del seme sono le stesse che le funzioni vere lasciano: si rifà il
// giro di Giulia (scheda B, poi «Annulla») e si confrontano.
describe("il seme è quello che le funzioni vere scrivono", () => {
  const strip = <T extends object>(row: T, ...drop: string[]) =>
    Object.fromEntries(
      Object.entries(row).filter(([k]) => !["id", "at", "seq", "claudeActionId", ...drop].includes(k)),
    );

  it("la scheda B della conversazione 2, confermata e annullata, lascia le stesse righe", async () => {
    as(GIULIA);
    // Il giro vero parte dal brief acceso (nel seme è spento dopo la voce di Roberta).
    state.projectSettings.get(MKX)!.switches.weeklyBrief = true;
    const before = {
      activity: state.activity.length,
      changes: state.changelog.length,
      notifications: state.notifications.length,
      actions: state.claudeActions.length,
    };
    const cid = (await createConversation()).id;
    const seeded = state.conversationEvents
      .get(brief.conversation)!
      .find((e): e is Extract<ConversationEvent, { type: "proposal" }> => e.type === "proposal")!;
    await runScript(cid, [
      {
        step: "event",
        event: {
          type: "proposal",
          proposalId: "prop-replay",
          requesterId: GIULIA,
          actions: seeded.actions,
          status: "open",
        },
      },
    ]);
    expect(await confirmProposal(cid, "prop-replay")).toMatchObject({ status: "confirmed" });
    const group = state.claudeActions.at(-1)!.groupId;
    // L'inverso del `planTask` avvisa Marco: «Annulla» passa da una scheda (I1).
    const undo = await claude.undoClaudeActions(cid, group);
    expect(undo).toMatchObject({ ok: true, proposalId: expect.any(String) });
    type Proposal = Extract<ConversationEvent, { type: "proposal" }>;
    const undoCardOf = (conversationId: string, groupId: string) =>
      state.conversationEvents
        .get(conversationId)!
        .find((e): e is Proposal => e.type === "proposal" && e.undoOf === groupId)!;
    const same = (p: Proposal) => ({
      requesterId: p.requesterId,
      actions: p.actions,
      cls: p.cls,
      reasons: p.reasons,
    });
    expect(same(undoCardOf(cid, group))).toEqual(same(undoCardOf(brief.conversation, brief.group)));
    expect(undoCardOf(brief.conversation, brief.group).status).toBe("confirmed");
    expect(await confirmProposal(cid, (undo as { proposalId: string }).proposalId)).toMatchObject({
      status: "confirmed",
    });

    const liveActivity = state.activity.slice(before.activity);
    const liveChanges = state.changelog.slice(before.changes);
    const liveRecords = state.claudeActions.slice(before.actions);
    expect(liveActivity.map((a) => strip(a))).toEqual(
      CLAUDE_ACTIVITY.filter((a) => a.taskId === HANDOVER_TASK.id).map((a) => strip(a)),
    );
    expect(liveChanges.map((c) => strip(c, "undoOf"))).toEqual(
      CLAUDE_CHANGES.filter((c) => c.via).map((c) => strip(c, "undoOf")),
    );
    expect(liveChanges[1]!.undoOf).toBe(liveChanges[0]!.id);
    expect(liveRecords.map((r) => strip(r, "groupId", "conversationId", "undone", "personId"))).toEqual(
      CLAUDE_ACTIONS.filter((r) => r.groupId === brief.group).map((r) =>
        strip(r, "groupId", "conversationId", "undone", "personId"),
      ),
    );
    const live = state.notifications.slice(before.notifications);
    // L'avviso dell'azione e quello dell'«Annulla» confermato dalla scheda (I1).
    expect(live).toHaveLength(2);
    const seeds = [CLAUDE_SEED_IDS.notification, CLAUDE_SEED_IDS.undoNotification].map(
      (id) => state.notifications.find((n) => n.id === id)!,
    );
    seeds.forEach((seed, i) => {
      expect(strip(live[i]!, "viaClaude", "createdAt")).toEqual(strip(seed, "viaClaude", "createdAt"));
      expect(live[i]!.viaClaude?.personId).toBe(seed.viaClaude?.personId);
    });
    void sendMessage;
  });

  it("l'azione di classe A della conversazione 1 lascia le stesse righe di attività", async () => {
    as(GIULIA);
    const before = { activity: state.activity.length, changes: state.changelog.length };
    const cid = (await createConversation()).id;
    const executed = state.conversationEvents
      .get(move.conversation)!
      .find((e): e is Extract<ConversationEvent, { type: "executed" }> => e.type === "executed")!;
    // La classe la calcola il livello dati adesso: A, quindi senza scheda.
    expect(classOfGroup(GIULIA, executed.actions).cls).toBe("A");
    const run = executeGroup(GIULIA, cid, executed.actions, "A");
    expect(run.ok).toBe(true);
    const group = state.claudeActions.at(-1)!.groupId;
    expect(await claude.undoClaudeActions(cid, group)).toEqual({ ok: true });
    expect(state.changelog).toHaveLength(before.changes);
    expect(state.activity.slice(before.activity).map((a) => strip(a))).toEqual(
      CLAUDE_ACTIVITY.filter((a) => a.taskId === MOVE_TASK.id).map((a) => strip(a)),
    );
  });
});
