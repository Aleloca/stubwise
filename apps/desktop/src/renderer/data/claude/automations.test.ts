import { beforeEach, describe, expect, it } from "vitest";
import { evaluate, lookup } from "../../domain/automations/conditions";
import { automations, claude, createConversation, resetApi, setLatency } from "../api";
import { pickTrialExamples } from "../automations/examples";
import { trialAs } from "../automations/simulate";
import { happenings } from "../automations/sources";
import { createAutomationAs, deleteDraftAs, saveDraftAs } from "../automations/writes";
import type { ProposedAction } from "../model";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import type { AutomationFlow, Step } from "../types";
import { can, viewerFor } from "../viewer";
import { executeGroup, undoViewOf } from "./actions";
import { CLAUDE_CATALOG } from "./catalog";
import { classOf } from "./classes";

// Le bozze di automazione nel catalogo di Claude e la prova senza effetti
// (area 10b, Task 3). Claude crea, salva ed elimina BOZZE: mai accese, mai
// con un proprietario (maintainer); «Created by Claude» resta per sempre.
// La prova (`trialAs`) usa il motore della prova dell'area 7 e non scrive
// niente: nessuna task, notifica, esecuzione, email o voce del registro.
//
// Seme: Laura è Project Lead in ACQ (gestisce le automazioni), Sara è
// Contributor in ACQ (le vede, non le gestisce); Support ha membri che
// vedono ACQ. `req-acq-3` è urgente e dal supporto, `req-acq-4` no.

const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";
const SUPPORT = "dep-support";
const AUTO = { mode: "auto" } as const;

const as = (personId: string) => setSessionPersonId(personId);
const action = (fn: ProposedAction["fn"], args: Record<string, unknown>): ProposedAction => ({
  fn,
  args,
  summary: fn,
});

const URGENT_FILTER = {
  all: [
    { left: { ref: "richiesta.urgenza" }, op: "is" as const, right: { value: "high" } },
    { left: { ref: "richiesta.dal_supporto" }, op: "is" as const, right: { value: true } },
  ],
};

/** Lo scenario S1: richiesta urgente dal supporto → una task per Support e un avviso a Support. */
const urgentFlow = (extra: Step[] = []): AutomationFlow => ({
  trigger: { kind: "stubwise", event: "request_created", filter: URGENT_FILTER },
  titleTemplate: "{{richiesta.codice}}",
  steps: [
    {
      id: "t",
      kind: "createTask",
      title: "{{richiesta.titolo}}",
      description: "",
      assignee: { departmentId: SUPPORT },
      dueInDays: 1,
      project: { mode: "own" },
      milestoneRef: null,
      approval: AUTO,
    },
    {
      id: "n",
      kind: "notify",
      who: { departmentId: SUPPORT },
      text: "Nuova richiesta urgente",
      approval: AUTO,
    },
    ...extra,
  ],
});

/** Il passo email di Claude: «Chiede approvazione al proprietario». */
const askOwnerEmail: Step = {
  id: "e",
  kind: "sendEmail",
  to: "cliente@example.com",
  subject: "{{richiesta.titolo}}",
  body: "Ci stiamo lavorando.",
  attachRefs: [],
  approval: { mode: "ask", who: { owner: true } },
};

const example = (requestId: string) =>
  happenings({ kind: "request_created", requestId })[0]!.payload;

/** Chi riceverebbe l'avviso a Support in ACQ, calcolato a parte. */
const supportSeeingAcq = () =>
  state.access.departments
    .find((d) => d.departmentId === SUPPORT)!
    .memberIds.filter((m) => m !== "p-claude" && visibleProjectIds(m).has(ACQ));

/** Ciò che una prova non deve toccare (Global Constraints, area 7). */
const effects = () =>
  structuredClone({
    tasks: state.tasks,
    notifications: state.notifications,
    automationRuns: state.automationRuns,
    mailMessages: state.mailMessages,
    changelog: state.changelog,
  });

const automation = (id: string) => state.automations.find((a) => a.id === id);

/** Una conversazione di Laura e il gruppo eseguito come dal riquadro (classe A). */
async function createdByClaude(args: Record<string, unknown> = {}) {
  as(LAURA);
  const cid = (await createConversation()).id;
  const done = executeGroup(
    LAURA,
    cid,
    [
      action("createAutomation", {
        name: "Richieste urgenti",
        projectId: ACQ,
        flow: urgentFlow(),
        ...args,
      }),
    ],
    "A",
  );
  if (!done.ok) throw new Error(`not done: ${done.code}`);
  const id = state.claudeActions.find((r) => r.groupId === done.groupId)!.objects[0]! as {
    kind: "automation";
    id: string;
  };
  return { cid, groupId: done.groupId, id: id.id, code: done.objectCodes[0] };
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  as(LAURA);
});

// --- le forme sincrone --------------------------------------------------------------

/** Lo stato delle automazioni e delle scritture segnate: ciò che queste scritture toccano. */
const digest = () => JSON.stringify({ a: state.automations, w: state.objectWrites });

type Outcome = { verdict: string; state: string };

async function publicOutcome(who: string, call: () => Promise<unknown>): Promise<Outcome> {
  as(who);
  try {
    await call();
    return { verdict: "ok", state: digest() };
  } catch (error) {
    return { verdict: (error as Error).message, state: digest() };
  }
}

function syncOutcome(call: () => unknown): Outcome {
  let value: unknown;
  try {
    value = call();
  } catch (error) {
    return { verdict: (error as Error).message, state: digest() };
  }
  expect(value instanceof Promise).toBe(false);
  return { verdict: "ok", state: digest() };
}

interface Case {
  name: string;
  who: string;
  prep?: () => Promise<Record<string, string>>;
  pub: (ctx: Record<string, string>) => Promise<unknown>;
  sync: (me: string, ctx: Record<string, string>) => unknown;
  expected: string;
}

async function fresh(c: Case): Promise<Record<string, string>> {
  resetApi();
  setLatency(0);
  as(LAURA);
  const ctx = (await c.prep?.()) ?? {};
  as(c.who);
  return ctx;
}

/** Una bozza di Laura in ACQ, salvata una volta: `rev` è quello letto. */
async function lauraDraft(): Promise<{ id: string; rev: string }> {
  const a = await automations.createAutomation({ name: "Urgenti", projectId: ACQ });
  await automations.saveDraft(a.id, urgentFlow());
  return { id: a.id, rev: String(automation(a.id)!.versions.at(-1)!.rev) };
}

/** Un progetto che `personId` non vede. */
const unseenBy = (personId: string) =>
  [...state.projectsById.keys()].find((id) => !visibleProjectIds(personId).has(id))!;

/** Qualcuno che non vede ACQ (né le sue automazioni). */
const outsiderOfAcq = () =>
  PEOPLE.find((p) => !p.isClaude && !visibleProjectIds(p.id).has(ACQ))!.id;

const CASES: Case[] = [
  {
    name: "createAutomation: riuscita",
    who: LAURA,
    pub: () =>
      automations.createAutomation({ name: "Urgenti", projectId: ACQ, flow: urgentFlow() }),
    sync: (me) => createAutomationAs(me, { name: "Urgenti", projectId: ACQ, flow: urgentFlow() }),
    expected: "ok",
  },
  {
    name: "createAutomation: forbidden (Sara vede ACQ, non gestisce)",
    who: SARA,
    pub: () =>
      automations.createAutomation({ name: "Urgenti", projectId: ACQ, flow: urgentFlow() }),
    sync: (me) => createAutomationAs(me, { name: "Urgenti", projectId: ACQ, flow: urgentFlow() }),
    expected: "forbidden",
  },
  {
    name: "createAutomation: not_found (un progetto che Laura non vede)",
    who: LAURA,
    pub: () =>
      automations.createAutomation({
        name: "Urgenti",
        projectId: unseenBy(LAURA),
        flow: urgentFlow(),
      }),
    sync: (me) =>
      createAutomationAs(me, { name: "Urgenti", projectId: unseenBy(me), flow: urgentFlow() }),
    expected: "not_found",
  },
  {
    name: "saveDraft: riuscita",
    who: LAURA,
    prep: lauraDraft,
    pub: (ctx) => automations.saveDraft(ctx.id!, urgentFlow([askOwnerEmail])),
    sync: (me, ctx) => saveDraftAs(me, ctx.id!, urgentFlow([askOwnerEmail])),
    expected: "ok",
  },
  {
    name: "saveDraft: forbidden",
    who: SARA,
    prep: lauraDraft,
    pub: (ctx) => automations.saveDraft(ctx.id!, urgentFlow([askOwnerEmail])),
    sync: (me, ctx) => saveDraftAs(me, ctx.id!, urgentFlow([askOwnerEmail])),
    expected: "forbidden",
  },
  {
    name: "saveDraft: not_found",
    who: "outsider",
    prep: lauraDraft,
    pub: (ctx) => automations.saveDraft(ctx.id!, urgentFlow([askOwnerEmail])),
    sync: (me, ctx) => saveDraftAs(me, ctx.id!, urgentFlow([askOwnerEmail])),
    expected: "not_found",
  },
  {
    name: "saveDraft: invalid: stale (Roberta salva su una bozza che non ha letto)",
    who: "p-roberta",
    prep: lauraDraft,
    pub: (ctx) => automations.saveDraft(ctx.id!, urgentFlow(), {}, { expected: -1 }),
    sync: (me, ctx) => saveDraftAs(me, ctx.id!, urgentFlow(), {}, { expected: -1 }),
    expected: "invalid: stale",
  },
  {
    name: "deleteDraft: riuscita",
    who: LAURA,
    prep: lauraDraft,
    pub: (ctx) => automations.deleteDraft(ctx.id!),
    sync: (me, ctx) => deleteDraftAs(me, ctx.id!),
    expected: "ok",
  },
  {
    name: "deleteDraft: forbidden",
    who: SARA,
    prep: lauraDraft,
    pub: (ctx) => automations.deleteDraft(ctx.id!),
    sync: (me, ctx) => deleteDraftAs(me, ctx.id!),
    expected: "forbidden",
  },
  {
    name: "deleteDraft: invalid: stale",
    who: "p-roberta",
    prep: lauraDraft,
    pub: (ctx) => automations.deleteDraft(ctx.id!, { expected: -1 }),
    sync: (me, ctx) => deleteDraftAs(me, ctx.id!, { expected: -1 }),
    expected: "invalid: stale",
  },
];

describe("le forme `…As` delle scritture delle bozze", () => {
  it("le premesse del seme: Laura gestisce in ACQ, Sara no", () => {
    expect(can(viewerFor(LAURA), "automations.manage", ACQ)).toBe(true);
    expect(visibleProjectIds(SARA).has(ACQ)).toBe(true);
    expect(can(viewerFor(SARA), "automations.manage", ACQ)).toBe(false);
  });

  it.each(CASES)("$name: stesso esito e stesso stato, e nessuna Promise", async (c) => {
    const who = () => (c.who === "outsider" ? outsiderOfAcq() : c.who);
    let ctx = await fresh(c);
    const pub = await publicOutcome(who(), () => c.pub(ctx));
    ctx = await fresh(c);
    const sync = syncOutcome(() => c.sync(who(), ctx));
    expect(pub.verdict).toBe(c.expected);
    expect(sync).toEqual(pub);
  });
});

// --- il catalogo --------------------------------------------------------------------

describe("createAutomation dal catalogo", () => {
  it("Laura in ACQ: `ACQ-A<n>`, bozza spenta, senza proprietario, «Created by Claude»", async () => {
    const { id, code } = await createdByClaude();
    const a = automation(id)!;
    expect(code).toMatch(/^ACQ-A\d+$/);
    expect(a).toMatchObject({
      code,
      projectId: ACQ,
      status: "draft",
      ownerId: null,
      createdById: LAURA,
      createdVia: "claude",
    });
  });

  it('con `ownerId` o `status: "active"` negli argomenti esce lo stesso spenta', async () => {
    const { id } = await createdByClaude({ ownerId: LAURA, status: "active" });
    expect(automation(id)).toMatchObject({ status: "draft", ownerId: null });
    expect(automation(id)!.versions.every((v) => v.publishedAt === null)).toBe(true);
  });

  it("creata a mano non porta il segno di Claude", async () => {
    const a = await automations.createAutomation({ name: "A mano", projectId: ACQ });
    expect(automation(a.id)!.createdVia).toBeUndefined();
  });

  it("un flusso con problemi: `invalid: flow`, niente nasce", async () => {
    const before = state.automations.length;
    const seq = new Map(state.automationCodeSeq);
    const broken = { ...urgentFlow(), steps: [] };
    expect(() =>
      CLAUDE_CATALOG.createAutomation.run(LAURA, { name: "X", projectId: ACQ, flow: broken }),
    ).toThrow("invalid: flow");
    expect(state.automations).toHaveLength(before);
    expect(state.automationCodeSeq).toEqual(seq);
    as(LAURA);
    const cid = (await createConversation()).id;
    const result = executeGroup(
      LAURA,
      cid,
      [action("createAutomation", { name: "X", projectId: ACQ, flow: broken })],
      "A",
    );
    expect(result).toMatchObject({ ok: false, index: 0, code: "invalid" });
    expect(state.automations).toHaveLength(before);
  });

  it("un'automazione generale (`projectId: null`) è `invalid: project` (P3)", () => {
    const before = state.automations.length;
    expect(() =>
      CLAUDE_CATALOG.createAutomation.run("p-roberta", {
        name: "X",
        projectId: null,
        flow: urgentFlow(),
      }),
    ).toThrow("invalid: project");
    expect(state.automations).toHaveLength(before);
  });

  it("Sara non gestisce le automazioni di ACQ: `forbidden`, niente nasce", () => {
    const before = state.automations.length;
    expect(() =>
      CLAUDE_CATALOG.createAutomation.run(SARA, { name: "X", projectId: ACQ, flow: urgentFlow() }),
    ).toThrow("forbidden");
    expect(state.automations).toHaveLength(before);
  });
});

describe("le classi delle voci delle bozze", () => {
  it("creare e salvare una bozza sono A senza motivi; eliminarla è B, `irreversible`", async () => {
    const { id } = await lauraDraft();
    expect(
      classOf(LAURA, action("createAutomation", { name: "X", projectId: ACQ, flow: urgentFlow() })),
    ).toEqual({ cls: "A", reasons: [] });
    expect(classOf(LAURA, action("saveAutomationDraft", { id, flow: urgentFlow() }))).toEqual({
      cls: "A",
      reasons: [],
    });
    expect(classOf(LAURA, action("deleteAutomationDraft", { id }))).toEqual({
      cls: "B",
      reasons: [{ kind: "irreversible" }],
    });
  });
});

describe("saveAutomationDraft dal catalogo", () => {
  it("l'inverso rimette il flusso, il nome e la descrizione di prima", async () => {
    const { id } = await lauraDraft();
    const before = structuredClone(automation(id)!);
    const run = CLAUDE_CATALOG.saveAutomationDraft.run(LAURA, {
      id,
      flow: urgentFlow([askOwnerEmail]),
      meta: { name: "Urgentissime", description: "Con l'email" },
    });
    expect(automation(id)!.versions.at(-1)!.flow.steps).toHaveLength(3);
    expect(run.inverse!.fn).toBe("saveAutomationDraft");
    CLAUDE_CATALOG[run.inverse!.fn].run(LAURA, run.inverse!.args);
    const after = automation(id)!;
    expect(after.versions.at(-1)!.flow).toEqual(before.versions.at(-1)!.flow);
    expect({ name: after.name, description: after.description }).toEqual({
      name: before.name,
      description: before.description,
    });
    expect(run.objects).toEqual([{ kind: "automation", id }]);
  });
});

// --- «Annulla» e il «com'era» ------------------------------------------------------

describe("«Annulla» della bozza creata da Claude", () => {
  it("l'automazione non c'è più", async () => {
    const { cid, groupId, id } = await createdByClaude();
    expect(undoViewOf(LAURA, groupId)).toEqual({ state: "available", needsReauth: false });
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    expect(automation(id)).toBeUndefined();
  });

  it("dopo un salvataggio di Laura a mano: `changed_after` con «Laura Costa», e la bozza resta", async () => {
    const { cid, groupId, id, code } = await createdByClaude();
    await automations.saveDraft(id, urgentFlow([askOwnerEmail]));
    const expected = { state: "changed_after", byName: "Laura Costa", code };
    expect(undoViewOf(LAURA, groupId)).toEqual(expected);
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({
      ok: false,
      error: "changed_after",
      byName: "Laura Costa",
      code,
    });
    expect(automation(id)!.versions.at(-1)!.flow.steps).toHaveLength(3);
  });

  it("dopo che Laura l'ha accesa: `changed_after`, e l'automazione resta accesa", async () => {
    const { cid, groupId, id, code } = await createdByClaude();
    await automations.activate(id);
    expect(automation(id)!.status).toBe("active");
    expect(undoViewOf(LAURA, groupId)).toEqual({
      state: "changed_after",
      byName: "Laura Costa",
      code,
    });
    expect(await claude.undoClaudeActions(cid, groupId)).toMatchObject({
      ok: false,
      error: "changed_after",
    });
    expect(automation(id)).toMatchObject({
      status: "active",
      ownerId: LAURA,
      createdVia: "claude",
    });
  });

  it("ogni scrittura a mano conta: rinomina, pausa, eliminazione della bozza", async () => {
    for (const write of [
      (id: string) => automations.renameAutomation(id, { name: "Altro nome" }),
      async (id: string) => {
        await automations.activate(id);
        await automations.pause(id);
      },
      (id: string) => automations.deleteDraft(id),
    ]) {
      resetApi();
      setLatency(0);
      const { groupId, id } = await createdByClaude();
      await write(id);
      expect(undoViewOf(LAURA, groupId).state).toBe("changed_after");
    }
  });

  it("ogni scrittura che cambia un'automazione si segna, col segno di Claude solo dentro il gruppo", async () => {
    const { id } = await createdByClaude();
    const writes = () => state.objectWrites.filter((w) => w.kind === "automation" && w.id === id);
    const [created] = writes();
    expect(created).toMatchObject({ byId: LAURA, claudeActionId: expect.any(String) });
    // Senza email fino a «publish»: la casella di Laura è scaduta nel seme.
    const steps: [string, () => Promise<unknown>][] = [
      ["saveDraft", () => automations.saveDraft(id, urgentFlow())],
      ["renameAutomation", () => automations.renameAutomation(id, { name: "Altro" })],
      ["activate", () => automations.activate(id)],
      ["pause", () => automations.pause(id)],
      ["activate di nuovo", () => automations.activate(id)],
      ["saveDraft su un'accesa", () => automations.saveDraft(id, urgentFlow())],
      ["publish", () => automations.publish(id)],
      ["saveDraft", () => automations.saveDraft(id, urgentFlow([askOwnerEmail]))],
      ["deleteDraft", () => automations.deleteDraft(id)],
    ];
    for (const [name, write] of steps) {
      const before = writes().length;
      await write();
      expect(writes().length, name).toBe(before + 1);
      expect(writes().at(-1), name).toEqual({
        kind: "automation",
        id,
        seq: expect.any(Number),
        byId: LAURA,
      });
    }
  });
});

// --- la prova di Claude -------------------------------------------------------------

describe("trialAs: la prova senza effetti", () => {
  it("le premesse del seme: `req-acq-3` passa il filtro, `req-acq-4` no", () => {
    const passes = (p: Record<string, unknown>) => evaluate(URGENT_FILTER, (k) => lookup(p, k));
    expect(passes(example("req-acq-3"))).toBe(true);
    expect(passes(example("req-acq-4"))).toBe(false);
  });

  it("con la richiesta urgente: `done`, una task e un avviso per membro di Support che vede ACQ", () => {
    const a = createAutomationAs(LAURA, { name: "Urgenti", projectId: ACQ, flow: urgentFlow() });
    const before = effects();
    const out = trialAs(LAURA, a.id, example("req-acq-3"));
    expect(out).toEqual({
      simId: expect.any(String),
      status: "done",
      tasks: 1,
      notifications: supportSeeingAcq().length,
      emails: 0,
      requests: 0,
      milestones: 0,
      approverId: null,
      stoppedAtClaude: false,
    });
    expect(supportSeeingAcq().length).toBeGreaterThan(0);
    expect(effects()).toEqual(before);
    // Come la prova a mano: finita bene, la bozza è provata.
    const v = automation(a.id)!.versions.at(-1)!;
    expect(v.testedRev).toBe(v.rev ?? null);
  });

  it("con la richiesta non urgente: `filtered_out`, nessun conteggio, niente cambia", () => {
    const a = createAutomationAs(LAURA, { name: "Urgenti", projectId: ACQ, flow: urgentFlow() });
    const before = effects();
    const out = trialAs(LAURA, a.id, example("req-acq-4"));
    expect(out).toMatchObject({
      status: "filtered_out",
      tasks: 0,
      notifications: 0,
      emails: 0,
      approverId: null,
      stoppedAtClaude: false,
    });
    expect(effects()).toEqual(before);
    expect(automation(a.id)!.versions.at(-1)!.testedRev).toBeUndefined();
  });

  it("con l'email che chiede approvazione al proprietario: si ferma per chi prova, non approva", () => {
    const a = createAutomationAs(LAURA, {
      name: "Urgenti",
      projectId: ACQ,
      flow: urgentFlow([askOwnerEmail]),
    });
    const before = effects();
    const out = trialAs(LAURA, a.id, example("req-acq-3"));
    expect(out).toMatchObject({
      status: "waiting_approval",
      tasks: 1,
      notifications: supportSeeingAcq().length,
      emails: 0,
      approverId: LAURA,
      stoppedAtClaude: false,
    });
    expect(effects()).toEqual(before);
    expect(automation(a.id)!.versions.at(-1)!.testedRev).toBeUndefined();
  });

  it("su un passo di Claude si ferma senza eseguirlo", () => {
    const claudeStep: Step = {
      id: "c",
      kind: "claude",
      instruction: "Leggi la richiesta e dimmi se è un bug.",
      inputs: ["richiesta.titolo"],
      outcomes: ["bug", "altro"],
      fields: [],
      branches: {},
    };
    const flow = urgentFlow();
    flow.steps = [claudeStep, ...flow.steps];
    const a = createAutomationAs(LAURA, { name: "Urgenti", projectId: ACQ, flow });
    const before = effects();
    const out = trialAs(LAURA, a.id, example("req-acq-3"));
    expect(out).toMatchObject({ status: "running", stoppedAtClaude: true, tasks: 0 });
    expect(effects()).toEqual(before);
  });

  it("chi non gestisce non prova: `forbidden`", () => {
    const a = createAutomationAs(LAURA, { name: "Urgenti", projectId: ACQ, flow: urgentFlow() });
    expect(() => trialAs(SARA, a.id, example("req-acq-3"))).toThrow("forbidden");
  });
});

// --- gli esempi della prova -----------------------------------------------------------

describe("pickTrialExamples", () => {
  const acqRequests = () =>
    state.requests
      .filter((r) => r.projectId === ACQ)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  const urgent = (r: { urgency: string; origin?: { kind: string } }) =>
    r.urgency === "high" && r.origin?.kind === "support";

  it("sceglie la richiesta vera più recente che passa, e quella che non passa", () => {
    const a = createAutomationAs(LAURA, { name: "Urgenti", projectId: ACQ, flow: urgentFlow() });
    const passing = acqRequests().find(urgent)!;
    const failing = acqRequests().find((r) => !urgent(r))!;
    const [pass, fail] = pickTrialExamples(LAURA, a.id, ["passes", "fails"]);
    expect(pass).toMatchObject({ written: false, event: example(passing.id) });
    expect(pass!.label).toEqual({
      key: "claude.trial.example",
      params: { code: passing.code, title: passing.title },
    });
    expect(fail).toMatchObject({ written: false, event: example(failing.id) });
  });

  it("senza richieste che passano scrive un evento coi campi dell'inizio, che passa", () => {
    const a = createAutomationAs(LAURA, { name: "Urgenti", projectId: ACQ, flow: urgentFlow() });
    for (const r of state.requests) r.urgency = "low";
    const [pass] = pickTrialExamples(LAURA, a.id, ["passes"]);
    expect(pass!.written).toBe(true);
    expect(pass!.label).toEqual({ key: "claude.trial.exampleWritten" });
    expect(evaluate(URGENT_FILTER, (k) => lookup(pass!.event, k))).toBe(true);
    const richiesta = pass!.event.richiesta as Record<string, unknown>;
    expect(Object.keys(richiesta).sort()).toEqual(
      [
        "codice",
        "titolo",
        "descrizione",
        "progetto",
        "richiedente",
        "urgenza",
        "dal_supporto",
      ].sort(),
    );
    expect(richiesta.progetto).toBe("ACQ");
    // Scritto per non passare, non passa.
    for (const r of state.requests) r.urgency = "high";
    for (const r of state.requests) r.origin = { kind: "support", conversationId: "x" };
    const [fail] = pickTrialExamples(LAURA, a.id, ["fails"]);
    expect(fail!.written).toBe(true);
    expect(evaluate(URGENT_FILTER, (k) => lookup(fail!.event, k))).toBe(false);
    // E la prova su quello scritto dice la stessa cosa.
    const before = effects();
    expect(trialAs(LAURA, a.id, pass!.event).status).toBe("done");
    expect(trialAs(LAURA, a.id, fail!.event).status).toBe("filtered_out");
    expect(effects()).toEqual(before);
  });

  it("un evento di un progetto che chi chiede non vede non viene mai scelto", () => {
    // Una generale (d'istanza) di Matteo: l'unico filtro che resta è ciò che vede.
    const MATTEO = "p-matteo";
    expect(can(viewerFor(MATTEO), "automations.manage")).toBe(true);
    const hidden = state.requests.find((r) => !visibleProjectIds(MATTEO).has(r.projectId))!;
    expect(hidden).toBeDefined();
    hidden.urgency = "high";
    hidden.origin = { kind: "support", conversationId: "x" };
    hidden.createdAt = "2999-01-01T00:00:00.000Z";
    const a = createAutomationAs(MATTEO, { name: "Urgenti", projectId: null, flow: urgentFlow() });
    for (const want of ["passes", "fails"] as const) {
      const [picked] = pickTrialExamples(MATTEO, a.id, [want]);
      expect((picked!.event.richiesta as { codice?: string }).codice).not.toBe(hidden.code);
      expect(JSON.stringify(picked)).not.toContain(hidden.title);
    }
  });
});
