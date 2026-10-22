import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roles, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { assertFullAdminRemains, RoleRuleError } from "./roles.js";

/**
 * La guardia «resta un full admin» sotto CONCORRENZA, orchestrata a mano: due
 * transazioni declassano ciascuna un admin diverso e controllano PRIMA che
 * l'altra confermi. Senza il lock della guardia entrambi i conteggi vedono
 * l'altro admin ancora lì e l'istanza resta senza full admin; con il lock il
 * secondo conteggio aspetta il commit del primo e lo vede.
 */

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("assertFullAdminRemains", () => {
  it("due declassamenti concorrenti degli ultimi due admin: uno solo passa", async () => {
    const db = testDb.db;
    const [a, b] = await db
      .insert(users)
      .values([
        { email: "race-a@example.com", passwordHash: "x", role: "admin" },
        { email: "race-b@example.com", passwordHash: "x", role: "admin" },
      ])
      .returning({ id: users.id });
    const [userRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.presetKey, "user"));

    const bothUpdated = { a: deferred(), b: deferred() };
    const firstChecked = deferred();
    const secondChecked = deferred();

    const first = db.transaction(async (tx) => {
      await tx.update(users).set({ instanceRoleId: userRole!.id }).where(eq(users.id, a!.id));
      bothUpdated.a.resolve();
      await bothUpdated.b.promise;
      await assertFullAdminRemains(tx);
      firstChecked.resolve();
      // Con il lock il secondo controllo non arriva finché questa non
      // conferma: si aspetta un poco, poi si conferma comunque.
      await Promise.race([secondChecked.promise, pause(300)]);
    });
    const second = db.transaction(async (tx) => {
      await tx.update(users).set({ instanceRoleId: userRole!.id }).where(eq(users.id, b!.id));
      bothUpdated.b.resolve();
      await bothUpdated.a.promise;
      await firstChecked.promise;
      try {
        await assertFullAdminRemains(tx);
      } finally {
        secondChecked.resolve();
      }
    });

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1].status).toBe("rejected");
    const reason = (outcomes[1] as PromiseRejectedResult).reason as RoleRuleError;
    expect(reason).toBeInstanceOf(RoleRuleError);
    expect(reason.code).toBe("last_full_admin");

    const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    expect(admins).toHaveLength(1);
  });
});
