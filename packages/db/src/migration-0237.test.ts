import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeLog, comments, decisionRequests, projectDecisions, ticketEvents, users, VIA_CLIENT_SETTING } from "./schema.js";
import { expectSqlState, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0237 (26 nov 2026, D4 della parità MCP): `via_client` su
 * commenti, storia del ticket, richieste di decisione e registro delle
 * modifiche, di DEFAULT dalla variabile di transazione `stubwise.via_client`
 * che il server imposta per una richiesta dell'MCP («via Claude Code»). Solo
 * `claude_code` o null; il registro resta append-only.
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const entry = () => ({ actorEmail: "a@example.com", actorKind: "user" as const, type: "project.renamed", subjectKind: "project", subjectId: randomUUID() });

describe("migrazione 0237", () => {
  it("le cinque colonne prendono la variabile di transazione; fuori, o azzerata, sono null", async () => {
    const { ticketId, projectId } = await seedTicket(t.db, { number: 237 });
    const [u] = await t.db.insert(users).values({ email: `v-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    const write = () =>
      Promise.all([
        t.db.insert(comments).values({ ticketId, authorType: "user", authorId: u!.id, body: "x" }).returning({ v: comments.viaClient }),
        t.db.insert(ticketEvents).values({ ticketId, actorId: u!.id, kind: "title_changed" }).returning({ v: ticketEvents.viaClient }),
        t.db.insert(decisionRequests).values({ ticketId, askedByUserId: u!.id, askedOfUserId: u!.id, question: "?" }).returning({ v: decisionRequests.viaClient }),
        t.db.insert(changeLog).values(entry()).returning({ v: changeLog.viaClient }),
        t.db.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: `manual:${randomUUID()}`, title: "t", decision: "d" }).returning({ v: projectDecisions.viaClient }),
      ]);
    const inside = await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${VIA_CLIENT_SETTING}, 'claude_code', true)`);
      return Promise.all([
        tx.insert(comments).values({ ticketId, authorType: "user", authorId: u!.id, body: "y" }).returning({ v: comments.viaClient }),
        tx.insert(ticketEvents).values({ ticketId, actorId: u!.id, kind: "title_changed" }).returning({ v: ticketEvents.viaClient }),
        tx.insert(decisionRequests).values({ ticketId, askedByUserId: u!.id, askedOfUserId: u!.id, question: "?" }).returning({ v: decisionRequests.viaClient }),
        tx.insert(changeLog).values(entry()).returning({ v: changeLog.viaClient }),
        tx.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: `manual:${randomUUID()}`, title: "t", decision: "d" }).returning({ v: projectDecisions.viaClient }),
      ]);
    });
    expect(inside.map((r) => r[0]!.v)).toEqual(["claude_code", "claude_code", "claude_code", "claude_code", "claude_code"]);
    expect((await write()).map((r) => r[0]!.v)).toEqual([null, null, null, null, null]);
    const cleared = await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${VIA_CLIENT_SETTING}, '', true)`);
      return tx.insert(changeLog).values(entry()).returning({ v: changeLog.viaClient });
    });
    expect(cleared[0]!.v).toBeNull();
  });

  it("un valore diverso da `claude_code` è rifiutato dal CHECK", async () => {
    await expectSqlState(t.db.insert(changeLog).values({ ...entry(), viaClient: "altro" as never }), "23514");
  });

  // La colonna entra anche nella tupla che un UPDATE ANNIDATO (l'azione di una FK) non può
  // cambiare: nessuna FK scrive `via_client`, quindi lì è difesa; qui si prova l'UPDATE diretto.
  it("il registro resta append-only: un UPDATE diretto che scrive `via_client` è rifiutato", async () => {
    const [row] = await t.db.insert(changeLog).values(entry()).returning();
    await expect(t.db.update(changeLog).set({ viaClient: "claude_code" }).where(eq(changeLog.id, row!.id))).rejects.toThrow();
  });
});
