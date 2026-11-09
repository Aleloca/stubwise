import { randomBytes } from "node:crypto";
import { pinnedTaskFilters, taskFilters, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { parseCriteria, savedFilterViewSchema, taskListResponseSchema, type SavedFilterView } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * I filtri salvati dell'app nuova (integrazione area 2, fetta 3): i miei e i
 * pubblici; un privato d'altri risponde come uno che non esiste; modifica ed
 * eliminazione all'autore o a un full admin; i fissati sono personali, e un
 * filtro eliminato sparisce dai fissati di tutti.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let other: { id: string; headers: { cookie: string } };
let projectId: string;
let hiddenProjectId: string;
let n = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
  other = await createUserWithSession(app, "altro@example.com");
  ({ projectId } = await seedRepository(testDb.db));
  ({ projectId: hiddenProjectId } = await seedRepository(testDb.db));
  await addMember(app, projectId, users.memberId);
  await addMember(app, projectId, other.id);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const body = (over: Record<string, unknown> = {}) => ({
  name: "Le mie urgenti",
  visibility: "private",
  criteria: { priorities: ["urgent"] },
  view: "list",
  groupBy: "none",
  ...over,
});

async function create(cookie: string, over: Record<string, unknown> = {}): Promise<SavedFilterView> {
  const res = await call("POST", "/api/filters", cookie, body(over));
  expect(res.statusCode, res.body).toBe(201);
  return savedFilterViewSchema.parse(res.json());
}

const listOf = async (cookie: string) => {
  const res = await call("GET", "/api/filters", cookie);
  expect(res.statusCode, res.body).toBe(200);
  return z.array(savedFilterViewSchema).parse(res.json());
};

const pinnedOf = async (cookie: string) => {
  const res = await call("GET", "/api/me/pinned-filters", cookie);
  expect(res.statusCode, res.body).toBe(200);
  return z.array(z.uuid()).parse(res.json());
};

describe("filtri salvati", () => {
  it("l'elenco ha i miei e i pubblici, compresi i cinque di esempio; non i privati d'altri", async () => {
    const mine = await create(users.memberCookie);
    const othersPublic = await create(other.headers.cookie, { name: "Pubblico d'altri", visibility: "public" });
    const othersPrivate = await create(other.headers.cookie, { name: "Privato d'altri" });
    const list = await listOf(users.memberCookie);
    const ids = list.map((f) => f.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(othersPublic.id);
    expect(ids).not.toContain(othersPrivate.id);
    expect(list.filter((f) => f.ownerId === null).map((f) => f.name).sort()).toEqual([
      "Closed this month",
      "No estimate",
      "Open",
      "Stalled",
      "Unassigned",
    ]);
    // canEdit lo calcola il server: il mio sì, quello d'altri e gli esempi no.
    expect(list.find((f) => f.id === mine.id)!.canEdit).toBe(true);
    expect(list.find((f) => f.id === othersPublic.id)!.canEdit).toBe(false);
    expect(list.find((f) => f.name === "Open")!.canEdit).toBe(false);
    // Per un full admin gli esempi sono modificabili; il privato d'altri resta invisibile.
    const adminList = await listOf(users.adminCookie);
    expect(adminList.find((f) => f.name === "Open")!.canEdit).toBe(true);
    expect(adminList.some((f) => f.id === othersPrivate.id)).toBe(false);
  });

  it("un filtro privato d'altri risponde 404, anche a un full admin; il mio si legge", async () => {
    const hidden = await create(other.headers.cookie);
    expect((await call("GET", `/api/filters/${hidden.id}`, users.memberCookie)).statusCode).toBe(404);
    expect((await call("GET", `/api/filters/${hidden.id}`, users.adminCookie)).statusCode).toBe(404);
    const res = await call("GET", `/api/filters/${hidden.id}`, other.headers.cookie);
    expect(res.statusCode).toBe(200);
    expect(savedFilterViewSchema.parse(res.json())).toMatchObject({
      name: "Le mie urgenti",
      ownerId: other.id,
      criteria: { priorities: ["urgent"] },
    });
  });

  it("creare: il nome si accorcia, un nome vuoto o criteri sbagliati → 400", async () => {
    const f = await create(users.memberCookie, { name: "  Spazi  " });
    expect(f).toMatchObject({ name: "Spazi", ownerId: users.memberId, visibility: "private" });
    expect((await call("POST", "/api/filters", users.memberCookie, body({ name: "   " }))).statusCode).toBe(400);
    expect(
      (await call("POST", "/api/filters", users.memberCookie, body({ criteria: { families: ["boh"] } }))).statusCode,
    ).toBe(400);
    expect((await call("POST", "/api/filters", users.memberCookie, body({ view: "grid" }))).statusCode).toBe(400);
  });

  it("modificare ed eliminare: l'autore o un full admin; un altro → 403; un privato d'altri → 404", async () => {
    const pub = await create(other.headers.cookie, { name: "Di altro", visibility: "public" });
    expect((await call("PATCH", `/api/filters/${pub.id}`, users.memberCookie, { name: "Mio" })).statusCode).toBe(403);
    expect((await call("DELETE", `/api/filters/${pub.id}`, users.memberCookie)).statusCode).toBe(403);
    const patched = await call("PATCH", `/api/filters/${pub.id}`, other.headers.cookie, {
      name: "Rinominato",
      groupBy: "assignee",
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(savedFilterViewSchema.parse(patched.json())).toMatchObject({
      name: "Rinominato",
      groupBy: "assignee",
      criteria: { priorities: ["urgent"] },
    });
    expect((await call("PATCH", `/api/filters/${pub.id}`, other.headers.cookie, { name: "" })).statusCode).toBe(400);
    // Un full admin modifica un filtro di esempio, e uno pubblico d'altri.
    const open = (await listOf(users.adminCookie)).find((f) => f.name === "Open")!;
    expect((await call("PATCH", `/api/filters/${open.id}`, users.adminCookie, { groupBy: "project" })).statusCode).toBe(
      200,
    );
    expect((await call("PATCH", `/api/filters/${open.id}`, users.memberCookie, { groupBy: "none" })).statusCode).toBe(
      403,
    );
    expect((await call("DELETE", `/api/filters/${pub.id}`, users.adminCookie)).statusCode).toBe(204);
    expect((await call("GET", `/api/filters/${pub.id}`, other.headers.cookie)).statusCode).toBe(404);
    const priv = await create(other.headers.cookie);
    expect((await call("PATCH", `/api/filters/${priv.id}`, users.adminCookie, { name: "X" })).statusCode).toBe(404);
    expect((await call("DELETE", `/api/filters/${priv.id}`, users.memberCookie)).statusCode).toBe(404);
  });

  it("fissati: personali e in ordine; un filtro reso privato sparisce dai fissati altrui; eliminarlo lo toglie a tutti", async () => {
    const a = await create(other.headers.cookie, { name: "A", visibility: "public" });
    const b = await create(users.memberCookie, { name: "B" });
    const open = (await listOf(users.memberCookie)).find((f) => f.name === "Open")!;
    for (const id of [b.id, a.id, open.id, a.id]) {
      expect((await call("PUT", `/api/me/pinned-filters/${id}`, users.memberCookie)).statusCode).toBe(204);
    }
    expect(await pinnedOf(users.memberCookie)).toEqual([b.id, a.id, open.id]);
    expect(await pinnedOf(other.headers.cookie)).toEqual([]);
    // Un privato d'altri non si fissa.
    const priv = await create(other.headers.cookie, { name: "Privato" });
    expect((await call("PUT", `/api/me/pinned-filters/${priv.id}`, users.memberCookie)).statusCode).toBe(404);
    // Reso privato dal suo autore: non lo vedo più fra i miei fissati.
    expect((await call("PATCH", `/api/filters/${a.id}`, other.headers.cookie, { visibility: "private" })).statusCode).toBe(
      200,
    );
    expect(await pinnedOf(users.memberCookie)).toEqual([b.id, open.id]);
    // Tornato pubblico, ricompare al suo posto.
    await call("PATCH", `/api/filters/${a.id}`, other.headers.cookie, { visibility: "public" });
    expect(await pinnedOf(users.memberCookie)).toEqual([b.id, a.id, open.id]);
    // Eliminato dall'autore: sparisce dai fissati di tutti.
    expect((await call("DELETE", `/api/filters/${a.id}`, other.headers.cookie)).statusCode).toBe(204);
    expect(await pinnedOf(users.memberCookie)).toEqual([b.id, open.id]);
    expect((await call("DELETE", `/api/me/pinned-filters/${open.id}`, users.memberCookie)).statusCode).toBe(204);
    expect((await call("DELETE", `/api/me/pinned-filters/${open.id}`, users.memberCookie)).statusCode).toBe(204);
    expect(await pinnedOf(users.memberCookie)).toEqual([b.id]);
  });

  it("un filtro pubblico mostra a ciascuno solo le task che vede già, anche nel conteggio", async () => {
    const pub = await create(users.adminCookie, {
      name: "Urgenti di tutti",
      visibility: "public",
      criteria: { priorities: ["urgent"], text: "filtro-pubblico" },
    });
    const insert = async (pid: string) => {
      n += 1;
      const [row] = await testDb.db
        .insert(tickets)
        .values({
          projectId: pid,
          number: 1000 + n,
          title: `filtro-pubblico ${n}`,
          type: "bug",
          priority: "urgent",
          source: "manual",
        })
        .returning({ id: tickets.id });
      return row!.id;
    };
    const visible = await insert(projectId);
    const hidden = await insert(hiddenProjectId);
    const f = savedFilterViewSchema.parse((await call("GET", `/api/filters/${pub.id}`, users.memberCookie)).json());
    const criteria = parseCriteria(f.criteria)!;
    const query = `priorities=${criteria.priorities!.join(",")}&text=${encodeURIComponent(criteria.text!)}`;
    const asMember = taskListResponseSchema.parse((await call("GET", `/api/tasks?${query}`, users.memberCookie)).json());
    expect(asMember.items.map((t) => t.id)).toEqual([visible]);
    const asAdmin = taskListResponseSchema.parse((await call("GET", `/api/tasks?${query}`, users.adminCookie)).json());
    expect(asAdmin.items.map((t) => t.id).sort()).toEqual([visible, hidden].sort());
  });

  it("senza sessione → 401; un id che non è un uuid → 400", async () => {
    expect((await app.inject({ method: "GET", url: "/api/filters" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me/pinned-filters" })).statusCode).toBe(401);
    expect((await call("GET", "/api/filters/abc", users.memberCookie)).statusCode).toBe(400);
  });

  it("un filtro con criteri vecchi nel DB si legge lo stesso: si tiene ciò che ha la forma giusta", async () => {
    const f = await create(users.memberCookie);
    await testDb.db
      .update(taskFilters)
      .set({ criteria: { families: ["todo", "boh"], vecchia: 1 } })
      .where(eq(taskFilters.id, f.id));
    const res = await call("GET", `/api/filters/${f.id}`, users.memberCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(savedFilterViewSchema.parse(res.json()).criteria).toEqual({ families: ["todo"] });
  });

  it("un tetto di 200 filtri per persona → 400 too_many_filters (fix fetta 3)", async () => {
    const heavy = await createUserWithSession(app, "tanti@example.com");
    await testDb.db.insert(taskFilters).values(
      Array.from({ length: 200 }, (_, i) => ({
        ownerId: heavy.id,
        name: `F${i}`,
        visibility: "private" as const,
        criteria: {},
        view: "list" as const,
        groupBy: "none" as const,
      })),
    );
    const res = await call("POST", "/api/filters", heavy.headers.cookie, body());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "too_many_filters" });
  });

  it("pin concorrenti: posizioni distinte, nell'ordine in cui sono arrivati (fix fetta 3)", async () => {
    const racer = await createUserWithSession(app, "corsa@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await create(racer.headers.cookie, { name: `R${i}` })).id);
    await Promise.all(ids.map((id) => call("PUT", `/api/me/pinned-filters/${id}`, racer.headers.cookie)));
    const rows = await testDb.db
      .select({ position: pinnedTaskFilters.position })
      .from(pinnedTaskFilters)
      .where(eq(pinnedTaskFilters.userId, racer.id));
    expect(new Set(rows.map((r) => r.position)).size).toBe(6);
  });
});

