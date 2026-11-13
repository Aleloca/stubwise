import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { automationEvents, automationSourceEvents, automationSources, automations, clientProjectLinks, projects } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0174 (13 nov 2026, area 7, fetta 4): le generali (progetto null,
 * codici `AUT-<n>`), le sorgenti webhook, gli eventi recenti, i contatori del
 * tetto, la tabella cliente → progetto e l'evento `source_event` nell'outbox.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const source = () => ({ kind: "webhook" as const, name: "Ordini", secretHash: randomUUID().replace(/-/g, "") });

describe("migrazione 0174", () => {
  it("un'automazione generale non ha progetto, e i codici vengono dalla sequenza d'istanza", async () => {
    const r = await t.db.execute<{ n: string }>(sql`select nextval('automation_general_code_seq')::text as n`);
    const n = Number(r[0]!.n);
    const [a] = await t.db.insert(automations).values({ code: `AUT-${n}`, seq: n, name: "Generale", projectId: null }).returning();
    expect(a!.projectId).toBeNull();
    const r2 = await t.db.execute<{ n: string }>(sql`select nextval('automation_general_code_seq')::text as n`);
    expect(Number(r2[0]!.n)).toBe(n + 1);
  });

  it("il tetto scelto è positivo o null", async () => {
    const { projectId } = await seedRepository(t.db);
    await t.db.insert(automations).values({ code: `T${randomUUID().slice(0, 5)}-A1`, seq: 1, name: "A", projectId, webhookPerMinute: 10, webhookPerDay: null });
    await expectSqlState(t.db.insert(automations).values({ code: `T${randomUUID().slice(0, 5)}-A2`, seq: 2, name: "A", projectId, webhookPerMinute: 0 }), "23514");
  });

  it("una sorgente è solo un webhook, e il suo segreto (hash) è unico", async () => {
    const s = source();
    await t.db.insert(automationSources).values(s);
    await expectSqlState(t.db.insert(automationSources).values({ ...source(), secretHash: s.secretHash }), "23505");
    await expectSqlState(t.db.insert(automationSources).values({ ...source(), kind: "audin" as never }), "23514");
  });

  it("l'evento di una sorgente entra nell'outbox con la sola sorgente, e si deduplica per chiave", async () => {
    const [s] = await t.db.insert(automationSources).values(source()).returning();
    const key = `src:${s!.id}:abc`;
    await t.db.insert(automationEvents).values({ kind: "source_event", sourceId: s!.id, dedupeKey: key, payload: { a: 1 } });
    await expectSqlState(t.db.insert(automationEvents).values({ kind: "source_event", sourceId: s!.id, dedupeKey: key }), "23505");
    // Né progetto, né casella, né sorgente: il CHECK lo rifiuta.
    await expectSqlState(t.db.insert(automationEvents).values({ kind: "source_event" }), "23514");
  });

  it("gli eventi recenti hanno uno stato fra tre, e spariscono con la sorgente", async () => {
    const [s] = await t.db.insert(automationSources).values(source()).returning();
    await t.db.insert(automationSourceEvents).values({ sourceId: s!.id, status: "rejected", reason: "importo: number", payload: { importo: "x" } });
    await expectSqlState(t.db.insert(automationSourceEvents).values({ sourceId: s!.id, status: "maybe" as never }), "23514");
    await t.db.delete(automationSources).where(eq(automationSources.id, s!.id));
    expect(await t.db.select().from(automationSourceEvents).where(eq(automationSourceEvents.sourceId, s!.id))).toHaveLength(0);
  });

  it("la chiave del cliente è normalizzata (trim + lower), e la riga sparisce col progetto", async () => {
    const { projectId } = await seedRepository(t.db);
    await t.db.insert(clientProjectLinks).values({ clientKey: "acme.it", clientName: "Acme", projectId });
    await expectSqlState(t.db.insert(clientProjectLinks).values({ clientKey: "Acme.it", clientName: "Acme", projectId }), "23514");
    await expectSqlState(t.db.insert(clientProjectLinks).values({ clientKey: " x", clientName: "X", projectId }), "23514");
    await expectSqlState(t.db.insert(clientProjectLinks).values({ clientKey: "", clientName: "X", projectId }), "23514");
    await t.db.delete(projects).where(eq(projects.id, projectId));
    expect(await t.db.select().from(clientProjectLinks).where(eq(clientProjectLinks.clientKey, "acme.it"))).toHaveLength(0);
  });
});
