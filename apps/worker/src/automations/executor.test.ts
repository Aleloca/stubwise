import { randomUUID } from "node:crypto";
import {
  automationEffects,
  automationEvents,
  automationRunInputs,
  automationRunLog,
  automationRuns,
  automations,
  automationVersions,
  backlogItemRequesters,
  backlogItems,
  backlogJobs,
  milestones,
  notifications,
  projectMembers,
  projects,
  roles,
  tickets,
  users,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AutomationFlow, Step } from "@stubwise/shared";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { effectKey, executeEffect } from "./effects.js";
import { executeDueRuns, INPUT_RETENTION_DAYS, pruneConsumedInputs, releaseClaim, RUN_LEASE_MS } from "./executor.js";

/**
 * L'ESECUTORE (area 7, F1): le esecuzioni dovute avanzano col motore puro, gli
 * effetti si fanno coi permessi del proprietario (ricontrollati a ogni
 * effetto), una volta sola per passo (idempotenza), con l'origine che ferma la
 * catena; un'approvazione aspetta chi può darla (e lo avvisa), e senza
 * nessuno fallisce; la pausa sospende al confine del passo; il lease tiene
 * fuori un secondo worker.
 */

let t: TestDb;
let projectId: string;
let code: string;
let ownerId: string;
let otherId: string;
let seq = 1;

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
beforeEach(async () => {
  ({ projectId } = await seedRepository(t.db));
  code = `E${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  await t.db.update(projects).set({ code }).where(eq(projects.id, projectId));
  ownerId = await person("Olga Proprietaria");
  otherId = await person("Bruno Membro");
  await member(ownerId, "project_lead");
  await member(otherId, "developer");
});
afterAll(async () => {
  await t?.stop();
});

async function person(name: string) {
  return (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member", displayName: name }).returning())[0]!.id;
}
async function member(userId: string, presetKey: string) {
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, presetKey));
  await t.db
    .insert(projectMembers)
    .values({ projectId, userId, roleId: role!.id })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { roleId: role!.id } });
}

const auto = { mode: "auto" } as const;
const task = (over: Partial<Extract<Step, { kind: "createTask" }>> = {}): Step => ({
  id: `t${seq++}`,
  kind: "createTask",
  title: "Onboarding {{task.titolo}}",
  description: "Da fare",
  assignee: null,
  dueInDays: null,
  project: { mode: "own" },
  milestoneRef: null,
  approval: auto,
  ...over,
});

async function runOf(steps: Step[], over: { status?: "active" | "paused" } = {}) {
  const n = seq++;
  const flow: AutomationFlow = { trigger: { kind: "manual" }, steps, titleTemplate: "Run" };
  const [a] = await t.db
    .insert(automations)
    .values({ code: `${code}-A${n}`, seq: n, name: `Auto ${n}`, projectId, ownerId, status: over.status ?? "active", activeSince: new Date() })
    .returning();
  await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date(), publishedBy: ownerId });
  const [run] = await t.db
    .insert(automationRuns)
    .values({ automationId: a!.id, n: 1, version: 1, title: "Run", origin: "manual", event: { task: { titolo: "Rossi" } }, projectIds: [projectId] })
    .returning();
  return { automation: a!, run: run! };
}

const reload = async (id: string) => (await t.db.select().from(automationRuns).where(eq(automationRuns.id, id)))[0]!;
const logOf = (id: string) => t.db.select().from(automationRunLog).where(eq(automationRunLog.runId, id)).orderBy(asc(automationRunLog.seq));
const ticketsOfRun = (id: string) => t.db.select().from(tickets).where(eq(tickets.automationRunId, id));
const cardsOf = (userId: string, kind: string) =>
  t.db.select().from(notifications).where(eq(notifications.userId, userId)).then((rows) => rows.filter((r) => r.kind === kind));
const exec = () => executeDueRuns({ db: t.db });

describe("executeDueRuns", () => {
  it("un passo automatico crea la task come la crea una persona: col proprietario, l'origine e il codice nel registro; l'esecuzione finisce", async () => {
    const { run } = await runOf([task()]);
    expect(await exec()).toBe(1);
    const after = await reload(run.id);
    expect(after).toMatchObject({ status: "done", pending: null, claimedAt: null });
    const [created] = await ticketsOfRun(run.id);
    expect(created).toMatchObject({ title: "Onboarding Rossi", source: "automation", requestedByUserId: ownerId, projectId });
    const log = await logOf(run.id);
    expect(log.some((e) => e.kind === "createTask" && e.outcome === "ok")).toBe(true);
    expect(JSON.stringify(log.map((e) => e.effects))).toContain(`${code}-${created!.number}`);
    // L'evento della task porta l'esecuzione d'origine (la catena).
    const [event] = await t.db.select().from(automationEvents).where(eq(automationEvents.objectId, created!.id));
    expect(event!.originRunId).toBe(run.id);
  });

  it("idempotenza: lo stesso effetto rifatto non crea una seconda task", async () => {
    const { automation, run } = await runOf([task()]);
    const eff = { kind: "createTask" as const, stepId: "x", path: "0", args: { title: "Una", description: "", assignee: null, dueInDays: null, milestoneCode: null }, projectTarget: { mode: "own" as const } };
    const env = { db: t.db, runId: run.id, runNumber: 1, automation: { id: automation.id, code: automation.code, name: automation.name, projectId, ownerId }, now: new Date().toISOString() };
    const first = (await executeEffect(eff, env)) as { input: { codes: string[] } };
    const second = (await executeEffect(eff, env)) as { input: unknown };
    expect(second.input).toEqual({ kind: "effect_result", ok: true, codes: first.input.codes });
    expect(await ticketsOfRun(run.id)).toHaveLength(1);
    expect(await t.db.select().from(automationEffects).where(eq(automationEffects.idempotencyKey, effectKey(run.id, "0")))).toHaveLength(1);
  });

  it("un'approvazione: l'esecuzione aspetta chi la può dare (e lo avvisa); approvata dalla coda, riparte e crea la task", async () => {
    const { run } = await runOf([task({ approval: { mode: "ask", who: { owner: true } } })]);
    await exec();
    const waiting = await reload(run.id);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.pending).toMatchObject({ approverIds: [ownerId], path: "0", round: 0 });
    expect(await ticketsOfRun(run.id)).toEqual([]);
    expect(await cardsOf(ownerId, "automation.approval")).toHaveLength(1);
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { kind: "approved", path: "0", byId: ownerId }, byId: ownerId });
    await exec();
    expect((await reload(run.id)).status).toBe("done");
    expect(await ticketsOfRun(run.id)).toHaveLength(1);
    expect((await logOf(run.id)).find((e) => e.outcome === "approved")?.byId).toBe(ownerId);
    expect((await t.db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, run.id)))[0]!.consumedAt).toBeInstanceOf(Date);
  });

  it("difesa in profondità: correzioni non ammesse scritte direttamente nella coda non arrivano al motore; l'esecuzione resta in attesa e una correzione valida passa", async () => {
    const { run } = await runOf([task({ approval: { mode: "ask", who: { owner: true } } })]);
    await exec();
    expect((await reload(run.id)).status).toBe("waiting_approval");
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { kind: "approved", path: "0", byId: ownerId, edited: { progetto: "altro" } }, byId: ownerId });
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { kind: "approved", path: "0", byId: ownerId, edited: { titolo: 42 } }, byId: ownerId });
    const lines: string[] = [];
    await executeDueRuns({ db: t.db, log: (m) => lines.push(m) });
    expect((await reload(run.id)).status).toBe("waiting_approval");
    expect(await ticketsOfRun(run.id)).toEqual([]);
    expect(lines.filter((l) => l.includes("edited"))).toHaveLength(2);
    expect((await t.db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, run.id))).every((r) => r.consumedAt instanceof Date)).toBe(true);
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { kind: "approved", path: "0", byId: ownerId, edited: { titolo: "Corretto" } }, byId: ownerId });
    await exec();
    expect((await reload(run.id)).status).toBe("done");
    expect((await ticketsOfRun(run.id))[0]!.title).toBe("Corretto");
  });

  it("review F1, M1: il registro, la run e gli avvisi di un passo si scrivono INSIEME; un guasto a metà non lascia righe del registro senza la run", async () => {
    const { run } = await runOf([task({ approval: { mode: "ask", who: { owner: true } } })]);
    // Il guasto DOPO la riga del registro: l'aggiornamento della run che entra in attesa.
    await t.db.execute(sql`create or replace function stubwise_test_boom() returns trigger as $$ begin if new.status = 'waiting_approval' then raise exception 'boom'; end if; return new; end $$ language plpgsql`);
    await t.db.execute(sql`create trigger stubwise_test_boom before update on automation_runs for each row execute function stubwise_test_boom()`);
    try {
      await exec();
    } finally {
      await t.db.execute(sql`drop trigger stubwise_test_boom on automation_runs`);
    }
    // Niente di quel passo è rimasto: né la riga «in attesa», né l'avviso.
    expect((await logOf(run.id)).filter((e) => e.outcome === "waiting")).toEqual([]);
    expect(await cardsOf(ownerId, "automation.approval")).toEqual([]);
    // L'esecuzione è fallita per intero, col suo errore e la sua riga: lo stato e il registro dicono la stessa cosa.
    const after = await reload(run.id);
    expect(after).toMatchObject({ status: "failed", error: "internal_error" });
    expect((await logOf(run.id)).map((e) => e.seq)).toEqual((await logOf(run.id)).map((_, i) => i + 1));
  });

  it("R-J11: un ruolo che nessuno ha nel progetto → fallisce con no_approver, e il proprietario lo sa", async () => {
    const { run } = await runOf([task({ approval: { mode: "ask", who: { projectRole: "viewer" } } })]);
    await exec();
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "no_approver" });
    expect(await cardsOf(ownerId, "automation.failed")).toHaveLength(1);
    expect(await ticketsOfRun(run.id)).toEqual([]);
  });

  it("R-J8: una persona indicata che non vede il progetto non approva: nessuno può → no_approver", async () => {
    const stranger = await person("Esterno");
    const { run } = await runOf([task({ approval: { mode: "ask", who: { personId: stranger } } })]);
    await exec();
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "no_approver" });
    expect(await cardsOf(stranger, "automation.approval")).toEqual([]);
  });

  it("un approvatore per ruolo: chi ha il ruolo nel progetto, e solo lui", async () => {
    const { run } = await runOf([task({ approval: { mode: "ask", who: { projectRole: "developer" } } })]);
    await exec();
    expect((await reload(run.id)).pending).toMatchObject({ approverIds: [otherId] });
    expect(await cardsOf(otherId, "automation.approval")).toHaveLength(1);
  });

  it("i permessi del proprietario si ricontrollano a ogni effetto: senza tickets.create → permission_lost, nessuna task, avviso al proprietario", async () => {
    const { run } = await runOf([task()]);
    await member(ownerId, "viewer");
    await exec();
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "permission_lost" });
    expect(await ticketsOfRun(run.id)).toEqual([]);
    expect(await cardsOf(ownerId, "automation.failed")).toHaveLength(1);
  });

  it("D5: con il permesso perso l'automazione va in pausa da sola (owner_lost_permission), col suo avviso; le altre esecuzioni non partono più", async () => {
    const { automation, run } = await runOf([task()]);
    await member(ownerId, "viewer");
    await exec();
    const [a] = await t.db.select().from(automations).where(eq(automations.id, automation.id));
    expect(a).toMatchObject({ status: "paused", pausedReason: "owner_lost_permission", pausedBy: null, activeSince: null });
    expect(a!.pausedAt).toBeInstanceOf(Date);
    expect(await cardsOf(ownerId, "automation.paused")).toHaveLength(1);
    expect((await reload(run.id)).status).toBe("failed");
  });

  it("in pausa: l'esecuzione si sospende PRIMA dell'effetto, che resta da fare", async () => {
    const { run } = await runOf([task()], { status: "paused" });
    await exec();
    expect((await reload(run.id)).status).toBe("suspended");
    expect(await ticketsOfRun(run.id)).toEqual([]);
  });

  it("traguardo, poi task nel traguardo; una richiesta del proprietario; un avviso a una persona che vede il progetto", async () => {
    const ms: Step = { id: "m1", kind: "createMilestone", name: "Avvio {{task.titolo}}", dueInDays: 7, project: { mode: "own" }, approval: auto };
    const req: Step = { id: "r1", kind: "createRequest", title: "Serve il contratto", description: "Per {{task.titolo}}", project: { mode: "own" }, approval: auto };
    const tell: Step = { id: "n1", kind: "notify", who: { personId: otherId }, text: "Pronto {{task.titolo}}", approval: auto };
    const { run } = await runOf([ms, task({ milestoneRef: "m1" }), req, tell]);
    await exec();
    expect((await reload(run.id)).status).toBe("done");
    const [m] = await t.db.select().from(milestones).where(eq(milestones.automationRunId, run.id));
    expect(m!.name).toBe("Avvio Rossi");
    const [created] = await ticketsOfRun(run.id);
    expect(created!.milestoneId).toBe(m!.id);
    const [item] = await t.db.select().from(backlogItems).where(eq(backlogItems.automationRunId, run.id));
    expect(item).toMatchObject({ title: "Serve il contratto", document: "Per Rossi" });
    expect(await t.db.select().from(backlogItemRequesters).where(eq(backlogItemRequesters.itemId, item!.id))).toEqual([expect.objectContaining({ userId: ownerId })]);
    // P3 = a: una richiesta creata da un'automazione non avvia lavoro AI (nessun job di stima).
    expect((await t.db.select().from(backlogJobs)).filter((j) => (j.payload as { itemId?: string }).itemId === item!.id)).toEqual([]);
    const cards = await cardsOf(otherId, "automation.notify");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.event).toMatchObject({ message: "Pronto Rossi", runId: run.id });
  });

  it("una condizione sceglie il ramo", async () => {
    const branch: Step = {
      id: "c1",
      kind: "condition",
      when: { left: { ref: "task.titolo" }, op: "is", right: { value: "Rossi" } },
      then: [task({ title: "Sì" })],
      else: [task({ title: "No" })],
    };
    const { run } = await runOf([branch]);
    await exec();
    expect((await ticketsOfRun(run.id)).map((x) => x.title)).toEqual(["Sì"]);
  });

  it("il lease: un'esecuzione presa da un altro worker non si tocca finché non scade", async () => {
    const { run } = await runOf([task()]);
    const now = new Date();
    await t.db.update(automationRuns).set({ claimedAt: now, claimedBy: "altro" }).where(eq(automationRuns.id, run.id));
    await executeDueRuns({ db: t.db, now: () => now });
    expect(await ticketsOfRun(run.id)).toEqual([]);
    await executeDueRuns({ db: t.db, now: () => new Date(now.getTime() + RUN_LEASE_MS + 1000) });
    expect(await ticketsOfRun(run.id)).toHaveLength(1);
  });

  it("review F1, M2: la lease è breve (al più 5′), e un worker rilascia solo la presa che è sua", async () => {
    expect(RUN_LEASE_MS).toBeLessThanOrEqual(5 * 60_000);
    const { run } = await runOf([task()]);
    // Un altro worker l'ha ripresa (la mia lease era scaduta): il mio rilascio non la tocca.
    await t.db.update(automationRuns).set({ claimedAt: new Date(), claimedBy: "altro:1" }).where(eq(automationRuns.id, run.id));
    await releaseClaim(t.db, run.id, "mio:1");
    expect(await reload(run.id)).toMatchObject({ claimedBy: "altro:1" });
    await releaseClaim(t.db, run.id, "altro:1");
    expect(await reload(run.id)).toMatchObject({ claimedBy: null, claimedAt: null });
    // Due giri di fila senza `workerId`: prese con gettoni diversi, mai lo stesso nome per tutti.
    await executeDueRuns({ db: t.db });
    expect((await reload(run.id)).claimedBy).toBeNull();
  });

  it("review F1, M6: gli input consumati da più di 7 giorni si tolgono; quelli recenti o non consumati restano", async () => {
    const { run } = await runOf([task({ approval: { mode: "ask", who: { owner: true } } })]);
    const old = new Date(Date.now() - (INPUT_RETENTION_DAYS + 1) * 86_400_000);
    const [gone] = await t.db.insert(automationRunInputs).values({ runId: run.id, input: { control: "skip", byId: ownerId }, byId: ownerId, consumedAt: old }).returning();
    const [recent] = await t.db.insert(automationRunInputs).values({ runId: run.id, input: { control: "skip", byId: ownerId }, byId: ownerId, consumedAt: new Date() }).returning();
    await pruneConsumedInputs(t.db);
    const ids = (await t.db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, run.id))).map((r) => r.id);
    expect(ids).toContain(recent!.id);
    expect(ids).not.toContain(gone!.id);
  });

  describe("gli input di controllo dalla coda (il server non muove il motore)", () => {
    const control = (runId: string, op: string) => t.db.insert(automationRunInputs).values({ runId, input: { control: op, byId: ownerId }, byId: ownerId });

    it("Annulla: l'esecuzione si chiude come annullata, con la riga di chi; ciò che c'è resta", async () => {
      const { run } = await runOf([task({ approval: { mode: "ask", who: { owner: true } } })]);
      await exec();
      await control(run.id, "cancel");
      await exec();
      expect(await reload(run.id)).toMatchObject({ status: "cancelled", error: "cancelled", pending: null });
      expect((await logOf(run.id)).at(-1)).toMatchObject({ outcome: "cancelled", byId: ownerId });
    });

    it("Riprova: il passo fallito si rifà (rimesso il permesso, crea la task); Salta: si va al passo dopo", async () => {
      const { automation, run } = await runOf([task({ title: "Prima" }), task({ title: "Dopo" })]);
      await member(ownerId, "viewer");
      await exec();
      expect((await reload(run.id)).status).toBe("failed");
      await member(ownerId, "project_lead");
      await t.db.update(automations).set({ status: "active", pausedReason: null, pausedAt: null, activeSince: new Date() }).where(eq(automations.id, automation.id));
      await control(run.id, "retry");
      await exec();
      expect((await ticketsOfRun(run.id)).map((x) => x.title).sort()).toEqual(["Dopo", "Prima"]);
      expect((await logOf(run.id)).some((e) => e.outcome === "retried" && e.byId === ownerId)).toBe(true);

      const second = await runOf([task({ title: "Uno" }), task({ title: "Due" })]);
      await member(ownerId, "viewer");
      await exec();
      await member(ownerId, "project_lead");
      await t.db.update(automations).set({ status: "active", activeSince: new Date() }).where(eq(automations.id, second.automation.id));
      await control(second.run.id, "skip");
      await exec();
      expect((await ticketsOfRun(second.run.id)).map((x) => x.title)).toEqual(["Due"]);
      expect((await reload(second.run.id)).status).toBe("done");
    });

    it("la pausa sospende un'esecuzione ferma su un'approvazione; la riaccensione la riprende dov'era", async () => {
      const { automation, run } = await runOf([task({ approval: { mode: "ask", who: { owner: true } } })]);
      await exec();
      await t.db.update(automations).set({ status: "paused" }).where(eq(automations.id, automation.id));
      await control(run.id, "suspend");
      await exec();
      expect((await reload(run.id)).status).toBe("suspended");
      await t.db.update(automations).set({ status: "active" }).where(eq(automations.id, automation.id));
      await control(run.id, "resume");
      await exec();
      const back = await reload(run.id);
      expect(back.status).toBe("waiting_approval");
      expect((await logOf(run.id)).map((e) => e.outcome)).toContain("resumed");
      // Torna ALL'attesa di prima, senza rifare il passo: chi approva non riceve una seconda card.
      expect(await cardsOf(ownerId, "automation.approval")).toHaveLength(1);
    });
  });
});
