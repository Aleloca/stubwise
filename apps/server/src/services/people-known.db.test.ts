import { randomUUID } from "node:crypto";
import { changeLog, chatChannelMembers, chatChannels, chatMessages, projectMembers, projects, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hiddenFor, peopleKnownTo } from "./people-known.js";

/**
 * `peopleKnownTo` sul DB (registro, A11 r.1414; revisione del lotto 2, I4):
 * ogni via per cui una persona è conosciuta, e il costo. Si verificano SOLO i
 * candidati della risposta, con un numero di query che non cresce con i
 * messaggi o i membri dell'istanza; senza candidati, nessuna query.
 */
let t: TestDb;
let db: Db;
beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
}, 120_000);
afterAll(async () => {
  await t.stop();
});

const person = async (over: Partial<typeof users.$inferInsert> = {}) =>
  (await db.insert(users).values({ email: `p-${randomUUID().slice(0, 8)}@x.it`, passwordHash: "x", role: "member", ...over }).returning({ id: users.id }))[0]!.id;
const roleId = async () => (await db.select({ id: roles.id }).from(roles).where(eq(roles.scope, "project")).limit(1))[0]!.id;
const viewerOf = (id: string) => ({ id, instancePermissions: new Set<never>() });

/** Il db con un contatore delle query (come `chat-n1.test.ts`). */
function counting(target: Db): { db: Db; count: () => number } {
  let n = 0;
  const counted = new Set(["select", "selectDistinct", "execute", "insert", "update", "delete"]);
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && counted.has(prop)) {
        return (...args: unknown[]) => {
          n += 1;
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(obj);
    },
  });
  return { db: proxy, count: () => n };
}

describe("peopleKnownTo sui candidati", () => {
  it("conosce: i membri dei suoi progetti (archiviati compresi), gli ex membri, Claude, i membri e gli autori dei canali che legge; non lo sconosciuto", async () => {
    const role = await roleId();
    const viewer = await person();
    const { projectId } = await seedRepository(db);
    const { projectId: archivedId } = await seedRepository(db);
    await db.update(projects).set({ archivedAt: new Date() } as never).where(eq(projects.id, archivedId));
    const coMember = await person();
    const archivedMember = await person();
    const formerMember = await person();
    const claude = (await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true)))[0]?.id ?? (await person({ isAgent: true }));
    const channelMember = await person();
    const channelAuthor = await person();
    const stranger = await person();
    await db.insert(projectMembers).values([
      { projectId, userId: viewer, roleId: role },
      { projectId, userId: coMember, roleId: role },
      { projectId: archivedId, userId: viewer, roleId: role },
      { projectId: archivedId, userId: archivedMember, roleId: role },
    ]);
    await db.insert(changeLog).values({ type: "member.removed", projectId, subjectKind: "member", subjectId: formerMember, actorKind: "system", actorEmail: "system", data: {} } as never);
    const [general] = await db.insert(chatChannels).values({ projectId: null, kind: "general", visibility: "open", name: `g-${randomUUID().slice(0, 6)}`, isGeneral: false } as never).returning({ id: chatChannels.id });
    await db.insert(chatChannelMembers).values({ channelId: general!.id, userId: channelMember } as never);
    await db.insert(chatMessages).values({ channelId: general!.id, authorId: channelAuthor, body: "ciao" } as never);

    const all = [coMember, archivedMember, formerMember, claude, channelMember, channelAuthor, stranger];
    const known = await peopleKnownTo(db, viewerOf(viewer), all);
    expect(known).not.toBe("all");
    for (const id of [viewer, coMember, archivedMember, formerMember, claude, channelMember, channelAuthor]) expect((known as Set<string>).has(id), id).toBe(true);
    expect((known as Set<string>).has(stranger)).toBe(false);
    // Solo i candidati: una persona conosciuta ma non chiesta non c'è.
    expect([...(await peopleKnownTo(db, viewerOf(viewer), [stranger]))]).toEqual([viewer]);
  });

  it("il costo: senza candidati nessuna query; coi candidati un numero fisso, che non cresce coi messaggi dell'istanza", async () => {
    const viewer = await person();
    const others = await Promise.all(Array.from({ length: 5 }, () => person()));
    const none = counting(db);
    await peopleKnownTo(none.db, viewerOf(viewer), []);
    await peopleKnownTo(none.db, viewerOf(viewer), [viewer]);
    expect(none.count()).toBe(0);
    const few = counting(db);
    await peopleKnownTo(few.db, viewerOf(viewer), others.slice(0, 1));
    const many = counting(db);
    await peopleKnownTo(many.db, viewerOf(viewer), others);
    expect(many.count()).toBe(few.count());
    expect(many.count()).toBeLessThanOrEqual(4);
  });

  it("`hiddenFor`: una persona già verificata per lo stesso «chi guarda» non si verifica di nuovo, e la numerazione resta una", async () => {
    const viewer = viewerOf(await person());
    const [a, b] = [await person(), await person()];
    const c = counting(db);
    const first = await hiddenFor(c.db, viewer, [a]);
    const afterFirst = c.count();
    const second = await hiddenFor(c.db, viewer, [a, b]);
    expect(second).toBe(first);
    expect(first.person(a)).toBe("hidden-1");
    expect(first.person(b)).toBe("hidden-2");
    const third = c.count();
    await hiddenFor(c.db, viewer, [a, b]);
    expect(c.count()).toBe(third);
    expect(afterFirst).toBeGreaterThan(0);
  });
});
