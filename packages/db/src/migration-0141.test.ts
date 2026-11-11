import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backlogItems,
  chatChannels,
  chatMessageAttachments,
  chatMessages,
  milestones,
  projectBriefs,
  projectStatuses,
  ticketRepositories,
  tickets,
} from "./schema.js";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0141 (11 nov 2026, area 4, fetta 4): gli eventi dei progetti nei
 * canali e gli allegati dei messaggi. Gli eventi li scrive un TRIGGER per
 * ogni fonte (`chat_publish_event`), come il «general» della 0135: un
 * messaggio `system` in ogni canale di progetto non archiviato che pubblica
 * quell'evento, col riferimento all'oggetto e il corpo vuoto.
 */

let t: TestDb;
let projectId: string;
let repositoryId: string;
let general: string;
let all: string;
let archived: string;
let closedStatus: string;
let otherClosedStatus: string;
let todoStatus: string;
let ticketNumber = 100;

const EVERY = ["release_page", "pr_opened", "pr_merged", "milestone_reached", "brief_ready", "request_new", "task_closed"];

beforeAll(async () => {
  t = await startTestDb();
  ({ projectId, repositoryId } = await seedRepository(t.db));
  const [g] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  general = g!.id;
  const [a] = await t.db
    .insert(chatChannels)
    .values({ projectId, kind: "project", name: "tutto", publishedEvents: EVERY })
    .returning({ id: chatChannels.id });
  all = a!.id;
  const [z] = await t.db
    .insert(chatChannels)
    .values({ projectId, kind: "project", name: "vecchio", publishedEvents: EVERY, archivedAt: new Date() })
    .returning({ id: chatChannels.id });
  archived = z!.id;
  const statuses = await t.db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId)).orderBy(asc(projectStatuses.position));
  todoStatus = statuses.find((s) => s.family === "todo")!.id;
  [closedStatus, otherClosedStatus] = statuses.filter((s) => s.family === "closed").map((s) => s.id) as [string, string];
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function eventsIn(channelId: string, refId?: string) {
  return t.db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), eq(chatMessages.kind, "system"), refId ? eq(chatMessages.eventRefId, refId) : undefined))
    .orderBy(asc(chatMessages.createdAt));
}
async function newTicket(): Promise<string> {
  return (await seedTicket(t.db, { projectId, repositoryId, number: ++ticketNumber })).ticketId;
}

describe("0141 gli eventi dei progetti", () => {
  it("un traguardo chiuso: un messaggio di sistema nei canali che pubblicano l'evento, mai in un archiviato", async () => {
    const [m] = await t.db.insert(milestones).values({ projectId, name: "Beta" }).returning({ id: milestones.id });
    expect(await eventsIn(general, m!.id)).toHaveLength(0);
    await t.db.update(milestones).set({ status: "closed", closedAt: new Date() }).where(eq(milestones.id, m!.id));
    for (const channel of [general, all]) {
      const [e] = await eventsIn(channel, m!.id);
      expect(e).toMatchObject({ kind: "system", body: "", authorId: null, eventKind: "milestone_reached", eventRefKind: "milestone" });
    }
    expect(await eventsIn(archived, m!.id)).toHaveLength(0);
    // Un altro UPDATE su un traguardo già chiuso non ripubblica.
    await t.db.update(milestones).set({ name: "Beta 1" }).where(eq(milestones.id, m!.id));
    expect(await eventsIn(general, m!.id)).toHaveLength(1);
  });

  it("una task che entra nella famiglia «closed», da qualunque scrittura; fra due stati chiusi no", async () => {
    const id = await newTicket();
    await t.db.update(tickets).set({ statusId: closedStatus }).where(eq(tickets.id, id));
    expect(await eventsIn(all, id)).toMatchObject([{ eventKind: "task_closed", eventRefKind: "task" }]);
    // Il «general» non pubblica task_closed di default.
    expect(await eventsIn(general, id)).toHaveLength(0);
    await t.db.update(tickets).set({ statusId: otherClosedStatus }).where(eq(tickets.id, id));
    expect(await eventsIn(all, id)).toHaveLength(1);
    // Riaperta e richiusa: un evento nuovo.
    await t.db.update(tickets).set({ statusId: todoStatus }).where(eq(tickets.id, id));
    await t.db.update(tickets).set({ statusId: closedStatus }).where(eq(tickets.id, id));
    expect(await eventsIn(all, id)).toHaveLength(2);
    // Lo scrittore vecchio dell'enum (il trigger di sync sposta lo stato vero).
    const legacy = await newTicket();
    await t.db.update(tickets).set({ status: "done" }).where(eq(tickets.id, legacy));
    expect(await eventsIn(all, legacy)).toHaveLength(1);
  });

  it("una richiesta NUOVA pubblica; una fusa in una che c'è già no", async () => {
    const [r] = await t.db.insert(backlogItems).values({ projectId, title: "Export", source: "manual" }).returning({ id: backlogItems.id });
    expect(await eventsIn(all, r!.id)).toMatchObject([{ eventKind: "request_new", eventRefKind: "request" }]);
    const [merged] = await t.db
      .insert(backlogItems)
      .values({ projectId, title: "Export bis", source: "manual", mergedIntoId: r!.id })
      .returning({ id: backlogItems.id });
    expect(await eventsIn(all, merged!.id)).toHaveLength(0);
  });

  it("un brief settimanale pubblica quando è pronto con il testo, non quando nasce in coda", async () => {
    const [b] = await t.db
      .insert(projectBriefs)
      .values({ projectId, periodStart: "2026-11-02", periodEnd: "2026-11-08" })
      .returning({ id: projectBriefs.id });
    expect(await eventsIn(general, b!.id)).toHaveLength(0);
    await t.db.update(projectBriefs).set({ status: "running" }).where(eq(projectBriefs.id, b!.id));
    await t.db.update(projectBriefs).set({ status: "done", summary: "# Brief" }).where(eq(projectBriefs.id, b!.id));
    expect(await eventsIn(general, b!.id)).toMatchObject([{ eventKind: "brief_ready", eventRefKind: "brief" }]);
    // Un brief «done» senza testo (provider mancante) non è da leggere.
    const [empty] = await t.db
      .insert(projectBriefs)
      .values({ projectId, periodStart: "2026-10-26", periodEnd: "2026-11-01" })
      .returning({ id: projectBriefs.id });
    await t.db.update(projectBriefs).set({ status: "done" }).where(eq(projectBriefs.id, empty!.id));
    expect(await eventsIn(general, empty!.id)).toHaveLength(0);
  });

  it("la PR di una task: aperta quando nasce l'URL, mergiata quando lo stato diventa merged", async () => {
    const id = await newTicket();
    const [tr] = await t.db
      .insert(ticketRepositories)
      .values({ ticketId: id, repositoryId, branch: "stubwise/ticket-x" })
      .returning({ id: ticketRepositories.id });
    expect(await eventsIn(all, id)).toHaveLength(0);
    await t.db.update(ticketRepositories).set({ prUrl: "https://github.com/o/r/pull/7", prNumber: 7 }).where(eq(ticketRepositories.id, tr!.id));
    await t.db.update(ticketRepositories).set({ prState: "merged" }).where(eq(ticketRepositories.id, tr!.id));
    const events = await eventsIn(all, id);
    expect(events.map((e) => e.eventKind)).toEqual(["pr_opened", "pr_merged"]);
    expect(events.every((e) => e.eventRefKind === "task" && e.eventPrId === tr!.id)).toBe(true);
    // Una riga nata con la PR già aperta (l'adozione) pubblica subito.
    const adopted = await newTicket();
    await t.db.insert(ticketRepositories).values({ ticketId: adopted, repositoryId, branch: "b", prUrl: "https://github.com/o/r/pull/8", prNumber: 8 });
    expect((await eventsIn(all, adopted)).map((e) => e.eventKind)).toEqual(["pr_opened"]);
  });

  it("l'evento c'è solo su un messaggio di sistema, sull'elenco chiuso", async () => {
    await expect(
      t.db.insert(chatMessages).values({ channelId: general, body: "x", eventKind: "task_closed", eventRefKind: "task", eventRefId: projectId }),
    ).rejects.toThrow();
    await expect(
      t.db.insert(chatMessages).values({ channelId: general, body: "", kind: "system", eventKind: "boh" as never, eventRefKind: "task", eventRefId: projectId }),
    ).rejects.toThrow();
    await expect(
      t.db.insert(chatMessages).values({ channelId: general, body: "", kind: "system", eventKind: "task_closed", eventRefKind: "boh" as never, eventRefId: projectId }),
    ).rejects.toThrow();
  });

  it("una chiusura di massa: 200 task in un UPDATE sono 200 messaggi, in tempi da transazione", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(await newTicket());
    const started = performance.now();
    await t.db.update(tickets).set({ statusId: closedStatus }).where(inArray(tickets.id, ids));
    const elapsed = performance.now() - started;
    const [{ n }] = (await t.db.execute(
      sql`select count(*)::int as n from chat_messages where channel_id = ${all} and event_kind = 'task_closed' and event_ref_id = any(${sql.raw(`array[${ids.map((i) => `'${i}'::uuid`).join(",")}]`)})`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(200);
    console.log(`[0141] 200 task chiuse in un UPDATE: ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("0141 gli allegati dei messaggi", () => {
  it("in sospeso senza messaggio; legati, se ne vanno col messaggio; la chiave è unica", async () => {
    const [m] = await t.db.insert(chatMessages).values({ channelId: general, body: "con file" }).returning({ id: chatMessages.id });
    const [a] = await t.db
      .insert(chatMessageAttachments)
      .values({ channelId: general, uploaderId: null, filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 3, storageKey: "chat/x/1" })
      .returning();
    expect(a!.messageId).toBeNull();
    await t.db.update(chatMessageAttachments).set({ messageId: m!.id }).where(eq(chatMessageAttachments.id, a!.id));
    await expect(
      t.db.insert(chatMessageAttachments).values({ channelId: general, filename: "b.pdf", mimeType: "application/pdf", sizeBytes: 3, storageKey: "chat/x/1" }),
    ).rejects.toThrow();
    await t.db.delete(chatMessages).where(eq(chatMessages.id, m!.id));
    expect(await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, a!.id))).toHaveLength(0);
  });
});
