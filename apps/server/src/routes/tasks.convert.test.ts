import { randomBytes } from "node:crypto";
import { backlogItemTickets, backlogItems, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedBacklogItem, seedRepository, startTestDb } from "@stubwise/db/testing";
import { requestToConvertViewSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";

/**
 * Fix della fetta 3: trasformare una richiesta in task (`POST /api/tasks` con
 * `requestId`) la segna `converted`, come nel prototipo e come
 * `POST /api/backlog/:id/convert`; così non torna in «Da decidere». Una voce
 * già archiviata non cambia stato. Vale il permesso della conversione di oggi:
 * `backlog.edit`.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let dev: { id: string; headers: { cookie: string } };
let contributor: { id: string; headers: { cookie: string } };

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  ({ projectId } = await seedRepository(testDb.db));
  dev = await createUserWithSession(app, "dev@example.com");
  contributor = await createUserWithSession(app, "contrib@example.com");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, contributor.id, "contributor");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const convert = (requestId: string, cookie: string, title = "Dalla richiesta") =>
  app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { cookie },
    payload: { projectId, title, type: "feature", requestId },
  });

const statusOf = async (id: string) =>
  (await testDb.db.select({ s: backlogItems.status }).from(backlogItems).where(eq(backlogItems.id, id)))[0]!.s;

describe("POST /api/tasks con requestId (fix fetta 3)", () => {
  it("dopo createTask con requestId la voce è converted e non compare in to-convert", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId, status: "ready" });
    const res = await convert(itemId, dev.headers.cookie);
    expect(res.statusCode, res.body).toBe(201);
    expect(await statusOf(itemId)).toBe("converted");
    const list = z
      .array(requestToConvertViewSchema)
      .parse((await app.inject({ method: "GET", url: "/api/requests/to-convert", headers: { cookie: dev.headers.cookie } })).json());
    expect(list.some((r) => r.id === itemId)).toBe(false);
  });

  it("una voce archived non cambia stato (la task nasce comunque, collegata)", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId, status: "archived" });
    const res = await convert(itemId, dev.headers.cookie, "Da archiviata");
    expect(res.statusCode, res.body).toBe(201);
    expect(await statusOf(itemId)).toBe("archived");
    expect(await testDb.db.select().from(backlogItemTickets).where(eq(backlogItemTickets.itemId, itemId))).toHaveLength(1);
  });

  it("senza backlog.edit (il permesso della conversione) → 403, niente task e voce invariata", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId, status: "new" });
    const res = await convert(itemId, contributor.headers.cookie, "Non mia da convertire");
    expect(res.statusCode).toBe(403);
    expect(await statusOf(itemId)).toBe("new");
    expect(await testDb.db.select().from(tickets).where(eq(tickets.title, "Non mia da convertire"))).toHaveLength(0);
    // Senza requestId il contributor crea una task come prima.
    expect(
      (await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { cookie: contributor.headers.cookie },
        payload: { projectId, title: "Sua", type: "bug" },
      })).statusCode,
    ).toBe(201);
  });
});
