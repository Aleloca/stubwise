import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectMembers, projects, roles, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import {
  effectiveInstancePermissions,
  INSTANCE_PERMISSIONS,
  type InstancePermission,
} from "@stubwise/shared";
import { assertFullAdminRemains, deleteUser, putProjectMember, RoleRuleError } from "./roles.js";

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

/**
 * Eliminazione di un utente: nessuna rotta la espone (ruling R27), ma la
 * guardia e la protezione del bersaglio valgono già nel servizio.
 */
describe("deleteUser", () => {
  async function ruleError(p: Promise<unknown>): Promise<RoleRuleError> {
    try {
      await p;
    } catch (error) {
      if (error instanceof RoleRuleError) return error;
      throw error;
    }
    throw new Error("doveva fallire");
  }

  async function seed(email: string, role: "admin" | "member"): Promise<string> {
    const [row] = await testDb.db
      .insert(users)
      .values({ email, passwordHash: "x", role })
      .returning({ id: users.id });
    return row!.id;
  }

  async function exists(id: string): Promise<boolean> {
    const rows = await testDb.db.select({ id: users.id }).from(users).where(eq(users.id, id));
    return rows.length === 1;
  }

  const fullAdmin = (id: string) => ({
    id,
    instancePermissions: new Set<InstancePermission>(INSTANCE_PERMISSIONS),
  });

  it("eliminare l'ultimo full admin → 409 last_full_admin, utente ancora lì", async () => {
    // Una sessione con permessi ormai scaduti (il suo ruolo nel DB non è più
    // Admin): è l'unico modo in cui un full admin elimina l'ultimo full admin,
    // e la guardia lo ferma dentro la transazione.
    const db = testDb.db;
    await db.update(users).set({ role: "member" }).where(eq(users.role, "admin"));
    const only = await seed("only-admin@example.com", "admin");
    const stale = await seed("stale-session@example.com", "member");
    const error = await ruleError(deleteUser(db, fullAdmin(stale), only));
    expect(error.code).toBe("last_full_admin");
    expect(await exists(only)).toBe(true);
  });

  it("R28: chi ha solo users.manage non elimina un full admin → 403, utente ancora lì", async () => {
    const admin = await seed("victim-admin@example.com", "admin");
    const actor = {
      id: await seed("users-manager@example.com", "member"),
      instancePermissions: effectiveInstancePermissions(["users.manage"]),
    };
    const error = await ruleError(deleteUser(testDb.db, actor, admin));
    expect(error.status).toBe(403);
    expect(error.code).toBe("target_above");
    expect(await exists(admin)).toBe(true);
  });

  it("non sé stessi (400); un utente qualunque sì", async () => {
    const actorId = await seed("deleter@example.com", "admin");
    expect((await ruleError(deleteUser(testDb.db, fullAdmin(actorId), actorId))).code).toBe(
      "cannot_delete_self",
    );
    const victim = await seed("victim@example.com", "member");
    await deleteUser(testDb.db, fullAdmin(actorId), victim);
    expect(await exists(victim)).toBe(false);
  });
});

describe("putProjectMember sotto concorrenza", () => {
  it("un ruolo eliminato mentre lo si assegna → 404 role_not_found, non un 500", async () => {
    const db = testDb.db;
    const [project] = await db
      .insert(projects)
      .values({ name: "Race", slug: "race-project", ingestionKey: "race-key" })
      .returning({ id: projects.id });
    const [user] = await db
      .insert(users)
      .values({ email: "race-member@example.com", passwordHash: "x", role: "member" })
      .returning({ id: users.id });
    const [role] = await db
      .insert(roles)
      .values({ name: "Doomed", scope: "project", permissions: ["docs.view"] })
      .returning({ id: roles.id });
    const actor = {
      id: user!.id,
      instancePermissions: new Set<InstancePermission>(INSTANCE_PERMISSIONS),
    };

    const locked = deferred();
    let assignment: Promise<unknown> | undefined;
    // Una «eliminazione» in corso: il ruolo è bloccato, l'assegnazione aspetta
    // sul FOR SHARE; quando l'eliminazione conferma, la riga non c'è più.
    await db.transaction(async (tx) => {
      await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, role!.id)).for("update");
      locked.resolve();
      assignment = putProjectMember(db, actor, new Set(), project!.id, user!.id, role!.id).then(
        () => null,
        (error: unknown) => error,
      );
      await pause(200);
      await tx.delete(roles).where(eq(roles.id, role!.id));
    });
    await locked.promise;
    const error = (await assignment) as RoleRuleError;
    expect(error).toBeInstanceOf(RoleRuleError);
    expect(error.code).toBe("role_not_found");
    const rows = await db.select().from(projectMembers).where(eq(projectMembers.userId, user!.id));
    expect(rows).toEqual([]);
  });
});
