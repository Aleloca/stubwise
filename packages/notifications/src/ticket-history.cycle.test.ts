import { prCorrections, users, type Db } from "@stubwise/db";
import { seedTicket, seedTicketRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoRoundsInCurrentSeries, derivePrCycle } from "./pr-correction-cycle.js";
import { buildTicketHistory, type HistoryCorrectionRow } from "./ticket-history.js";

/**
 * Test di ACCORDO NEGATIVO fra la storia del ticket e il ciclo della PR, su un
 * Postgres vero: il `round` della storia (numero d'ordine della correzione
 * sulla PR) e `cycle.round` (`autoRoundsInCurrentSeries`, i giri AUTOMATICI
 * dopo l'ultima richiesta umana) NON sono lo stesso numero, e questo test
 * esiste perché nessuno li «unifichi».
 *
 * La condizione è quella vera del difetto, non una che lo rende banale: tre
 * correzioni con una richiesta UMANA in mezzo — automatica, umana,
 * automatica. Con tre correzioni tutte umane (il ticket #1) il ciclo vale 0 e
 * il confronto non distinguerebbe nemmeno una storia che contasse le sole
 * automatiche; qui invece il ciclo vale 1, una numerazione «dei soli giri
 * automatici» darebbe 2 alla terza, una «della tornata corrente» darebbe 1, e
 * solo l'ordinale per PR dà 3.
 */

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb.stop();
});

const at = (min: number) => new Date(Date.UTC(2026, 9, 2, 10, min));

describe("storia del ticket vs ciclo della PR", () => {
  it("automatica, umana, automatica: il ciclo dice 1, la storia numera 1, 2, 3", async () => {
    const { ticketId, repositoryId } = await seedTicket(db);
    const prUrl = "https://github.com/acme/r/pull/10";
    await seedTicketRepository(db, { ticketId, repositoryId, prUrl, prNumber: 10 });
    const [human] = await db
      .insert(users)
      .values({ email: "ale@stubwise.test", passwordHash: "x", role: "member" })
      .returning({ id: users.id });

    const seeded: Array<[string, "review" | "stubwise", number]> = [
      ["auto-1", "review", 1],
      ["human", "stubwise", 2],
      ["auto-2", "review", 3],
    ];
    const ids = new Map<string, string>();
    for (const [name, trigger, min] of seeded) {
      const [row] = await db
        .insert(prCorrections)
        .values({
          ticketId,
          repositoryId,
          prNumber: 10,
          trigger,
          status: "done",
          requestedByUserId: trigger === "stubwise" ? human!.id : null,
          createdAt: at(min),
          updatedAt: at(min),
        })
        .returning({ id: prCorrections.id });
      ids.set(name, row!.id);
    }

    // Il ciclo, come lo calcola il server per la riga della PR.
    expect(await autoRoundsInCurrentSeries(db, { repositoryId, prNumber: 10 })).toBe(1);
    const cycle = await derivePrCycle(db, { ticketId, repositoryId });
    expect(cycle?.round).toBe(1);

    // La storia, dalle STESSE righe lette dal DB.
    const rows = await db
      .select({
        id: prCorrections.id,
        repositoryId: prCorrections.repositoryId,
        prNumber: prCorrections.prNumber,
        trigger: prCorrections.trigger,
        status: prCorrections.status,
        createdAt: prCorrections.createdAt,
        updatedAt: prCorrections.updatedAt,
        userEmail: users.email,
        providerLogin: prCorrections.requestedByProviderLogin,
      })
      .from(prCorrections)
      .leftJoin(users, eq(users.id, prCorrections.requestedByUserId))
      .where(eq(prCorrections.ticketId, ticketId));
    const corrections: HistoryCorrectionRow[] = rows;
    const { events } = buildTicketHistory(
      {
        jobs: [],
        questions: [],
        decisions: [],
        reviews: [],
        corrections,
        statusEvents: [],
        prUrls: [{ repositoryId, prNumber: 10, prUrl }],
      },
      { limit: 200 },
    );
    const roundOf = (name: string) =>
      events.find((e) => e.id === `changes_requested:${ids.get(name)}`)?.round;
    expect([roundOf("auto-1"), roundOf("human"), roundOf("auto-2")]).toEqual([1, 2, 3]);
    // Il punto del test: sulla correzione più recente i due numeri divergono.
    expect(roundOf("auto-2")).not.toBe(cycle?.round);
  });
});
