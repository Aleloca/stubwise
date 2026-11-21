import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailMessages, emailProposals, productDocJobs, productPages } from "./schema.js";
import { seedEmailMessage, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0213 (21 nov 2026, revisione di F5): la coda della doc ricorda
 * il lavoro fatto (i fatti, le pagine già scritte, la sosta) e l'email entra
 * anche quando la proposta cambia progetto o il messaggio è ammesso DOPO;
 * una proposta scartata («Non fare nulla») non accoda.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const jobsOf = (sourceId: string) => t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, sourceId));

describe("0213", () => {
  it("le colonne nuove della coda, coi default", async () => {
    const { projectId } = await seedRepository(t.db);
    const [j] = await t.db.insert(productDocJobs).values({ projectId, sourceKind: "decision", sourceId: crypto.randomUUID() }).returning();
    expect(j).toMatchObject({ facts: null, pagesDone: [], notBefore: null, lastHeldReason: null, answeredAt: null });
    await expect(t.db.execute(sql`update product_doc_jobs set last_held_reason = 'stanco' where id = ${j!.id}`)).rejects.toThrow();
  });

  it("un'email entra alla proposta, al cambio di progetto e all'ammissione; una proposta scartata no", async () => {
    const { projectId } = await seedRepository(t.db);
    const { projectId: other } = await seedRepository(t.db);
    for (const p of [projectId, other]) await t.db.insert(productPages).values({ projectId: p, title: "D", blocks: [] });
    const late = await seedEmailMessage(t.db, {});
    await t.db.update(emailMessages).set({ admitted: false }).where(eq(emailMessages.id, late.messageId));
    const [prop] = await t.db.insert(emailProposals).values({ emailMessageId: late.messageId, projectId, status: "proposed", classification: {} }).returning();
    expect(await jobsOf(late.messageId)).toHaveLength(0);
    // Ammesso dopo: accoda per la proposta.
    await t.db.update(emailMessages).set({ admitted: true }).where(eq(emailMessages.id, late.messageId));
    expect((await jobsOf(late.messageId)).map((j) => j.projectId)).toEqual([projectId]);
    // Spostata su un altro progetto: accoda anche lì.
    await t.db.update(emailProposals).set({ projectId: other }).where(eq(emailProposals.id, prop!.id));
    expect((await jobsOf(late.messageId)).map((j) => j.projectId).sort()).toEqual([projectId, other].sort());
    // Scartata: niente.
    const ignored = await seedEmailMessage(t.db, {});
    await t.db.insert(emailProposals).values({ emailMessageId: ignored.messageId, projectId, status: "ignored", classification: {} });
    expect(await jobsOf(ignored.messageId)).toHaveLength(0);
  });
});
