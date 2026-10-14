import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessionInputs, agentSessions, backlogItems, backlogRefineSessions, users, type Db } from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import { AGENT_SESSION_INPUT_CHANNEL, BACKLOG_REFINE_CLOSED_CHANNEL } from "@stubwise/shared";
import {
  closeRefineSession,
  closeRefineSessionForItem,
  loadRefineSessionView,
  reopenRefineSessionIfClosed,
  startRefineSession,
} from "./backlog-refine.js";

let t: TestDb;
let db: Db;
let member: { id: string; role: "member" };
beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  const [u] = await db.insert(users).values({ email: "m@x.test", passwordHash: "x", role: "member" }).returning();
  member = { id: u!.id, role: "member" };
}, 120_000);
afterAll(async () => t.stop());

const refineOf = async (itemId: string) =>
  (await db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId)))[0];

describe("startRefineSession", () => {
  it("un member crea la sessione: agent_sessions backlog_refine legata alla voce, riga attiva, nessun input senza messaggio", async () => {
    const { itemId, projectId } = await seedBacklogItem(db, { title: "Export" });
    const res = await startRefineSession(db, member, itemId);
    expect(res).toMatchObject({ ok: true, inputId: null });
    if (!res.ok) throw new Error();
    const [s] = await db.select().from(agentSessions).where(eq(agentSessions.id, res.agentSessionId));
    expect(s).toMatchObject({
      kind: "backlog_refine",
      ownerKey: `backlog_refine:${itemId}`,
      backlogItemId: itemId,
      projectId,
      title: "Export",
    });
    expect(await refineOf(itemId)).toMatchObject({
      status: "active",
      startedByUserId: member.id,
      agentSessionId: res.agentSessionId,
    });
    expect(
      await db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, res.agentSessionId)),
    ).toHaveLength(0);
  });

  it("col messaggio: input pending dell'autore e NOTIFY sul canale degli input", async () => {
    const { itemId } = await seedBacklogItem(db);
    const notified: string[] = [];
    const sub = await t.client.listen(AGENT_SESSION_INPUT_CHANNEL, (p) => notified.push(p));
    const res = await startRefineSession(db, member, itemId, "partiamo");
    if (!res.ok) throw new Error();
    const [input] = await db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, res.inputId!));
    expect(input).toMatchObject({ text: "partiamo", status: "pending", authorUserId: member.id });
    await new Promise((r) => setTimeout(r, 200));
    expect(notified.map((p) => JSON.parse(p).sessionId)).toContain(res.agentSessionId);
    await sub.unlisten();
  });

  it("una sola sessione per voce: il secondo avvio riapre la STESSA, chiusa compresa", async () => {
    const { itemId } = await seedBacklogItem(db);
    const a = await startRefineSession(db, member, itemId);
    await closeRefineSession(db, member, itemId);
    const b = await startRefineSession(db, member, itemId);
    expect(b.ok && a.ok && b.agentSessionId === a.agentSessionId).toBe(true);
    expect(await refineOf(itemId)).toMatchObject({ status: "active", closedAt: null, closedReason: null });
  });

  it("voce convertita o archiviata: item_closed e nessuna riga; voce inesistente: not_found", async () => {
    for (const status of ["converted", "archived"] as const) {
      const { itemId } = await seedBacklogItem(db, { status });
      expect(await startRefineSession(db, member, itemId, "x")).toEqual({ ok: false, error: "item_closed" });
      expect(await refineOf(itemId)).toBeUndefined();
    }
    expect(await startRefineSession(db, member, "7f1c2a1e-0000-4000-8000-0000000000ff")).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("chiusura", () => {
  it("«Chiudi»: closed/user, pending → undelivered, NOTIFY di chiusura; idempotente", async () => {
    const { itemId } = await seedBacklogItem(db);
    const res = await startRefineSession(db, member, itemId, "in coda");
    if (!res.ok) throw new Error();
    const closed: string[] = [];
    const sub = await t.client.listen(BACKLOG_REFINE_CLOSED_CHANNEL, (p) => closed.push(p));
    expect(await closeRefineSession(db, member, itemId)).toEqual({ ok: true });
    expect(await closeRefineSession(db, member, itemId)).toEqual({ ok: true });
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "user" });
    const [input] = await db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, res.inputId!));
    expect(input).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    await new Promise((r) => setTimeout(r, 200));
    // Una sola: la seconda chiusura non chiude niente.
    expect(closed.map((p) => JSON.parse(p).agentSessionId)).toEqual([res.agentSessionId]);
    await sub.unlisten();
  });

  it("voce senza sessione: ok; voce inesistente: not_found", async () => {
    const { itemId } = await seedBacklogItem(db);
    expect(await closeRefineSession(db, member, itemId)).toEqual({ ok: true });
    expect(await closeRefineSession(db, member, "7f1c2a1e-0000-4000-8000-0000000000ff")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("closeRefineSessionForItem: item_closed, e da lì reopen risponde item_closed", async () => {
    const { itemId } = await seedBacklogItem(db);
    const res = await startRefineSession(db, member, itemId);
    if (!res.ok) throw new Error();
    await db.transaction(async (tx) => {
      await tx.update(backlogItems).set({ status: "archived" }).where(eq(backlogItems.id, itemId));
      await closeRefineSessionForItem(tx, itemId);
    });
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "item_closed" });
    expect(await db.transaction((tx) => reopenRefineSessionIfClosed(tx, res.agentSessionId))).toBe("item_closed");
    expect((await refineOf(itemId))!.status).toBe("closed");
  });

  it("reopen: riapre una sessione chiusa su voce aperta e tocca l'attività; not_refine per gli altri kind", async () => {
    const { itemId } = await seedBacklogItem(db);
    const res = await startRefineSession(db, member, itemId);
    if (!res.ok) throw new Error();
    await closeRefineSession(db, member, itemId);
    const before = (await refineOf(itemId))!.lastActivityAt;
    await new Promise((r) => setTimeout(r, 20));
    expect(await db.transaction((tx) => reopenRefineSessionIfClosed(tx, res.agentSessionId))).toBe("active");
    const after = (await refineOf(itemId))!;
    expect(after).toMatchObject({ status: "active", closedAt: null, closedReason: null });
    expect(after.lastActivityAt.getTime()).toBeGreaterThan(before.getTime());
    // Già attiva: resta attiva e l'attività avanza comunque.
    await new Promise((r) => setTimeout(r, 20));
    expect(await db.transaction((tx) => reopenRefineSessionIfClosed(tx, res.agentSessionId))).toBe("active");
    expect((await refineOf(itemId))!.lastActivityAt.getTime()).toBeGreaterThan(after.lastActivityAt.getTime());
    const [other] = await db
      .insert(agentSessions)
      .values({ ownerKey: `ai_job:${itemId}`, kind: "ai_job", title: "t" })
      .returning();
    expect(await db.transaction((tx) => reopenRefineSessionIfClosed(tx, other!.id))).toBe("not_refine");
  });

  it("loadRefineSessionView: null senza sessione, la vista con closedReason", async () => {
    const { itemId } = await seedBacklogItem(db);
    expect(await loadRefineSessionView(db, itemId)).toBeNull();
    const res = await startRefineSession(db, member, itemId);
    await closeRefineSession(db, member, itemId);
    expect(await loadRefineSessionView(db, itemId)).toMatchObject({
      agentSessionId: res.ok ? res.agentSessionId : "",
      status: "closed",
      closedReason: "user",
    });
  });
});
