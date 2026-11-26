import { randomBytes } from "node:crypto";
import { projectStatuses, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import {
  isoWeekToMonday,
  mondayToIsoWeek,
  taskInPeriod,
  taskListResponseSchema,
  type FieldPeriod,
  type RelativePeriod,
} from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { serverToday } from "../services/task-view.js";
import { seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Parità dei periodi (integrazione area 2, fetta 3): la query SQL di
 * `/api/tasks` dà le stesse task di `taskInPeriod` di `@stubwise/shared` —
 * la regola che usa `matches` del finto — applicato alle viste che il server
 * stesso restituisce, per ogni campo e ogni periodo del prototipo. Le date
 * stanno attorno ai bordi (oggi, −6/−7, −29/−30, inizio e fine mese, la
 * settimana prossima), relative all'oggi vero del server.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const PRESETS: RelativePeriod[] = ["last7", "last30", "thisWeek", "nextWeek", "thisMonth", "lastMonth"];

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let today: string;

const DAY_MS = 86_400_000;
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  today = serverToday();
  const [y, m] = today.split("-").map(Number) as [number, number];
  const firstOfMonth = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastOfLastMonth = shift(firstOfMonth, -1);
  const firstOfLastMonth = `${lastOfLastMonth.slice(0, 7)}-01`;
  const monday = isoWeekToMonday(mondayToIsoWeek(shift(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() || 7) - 1))));
  const days = [
    today,
    shift(today, -6),
    shift(today, -7),
    shift(today, -29),
    shift(today, -30),
    firstOfMonth,
    lastOfLastMonth,
    firstOfLastMonth,
    shift(firstOfLastMonth, -1),
    shift(monday, 7),
    shift(monday, 13),
    shift(monday, 14),
    shift(monday, -1),
  ];
  const [closed] = await testDb.db
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Done")));
  let number = 0;
  for (const day of days) {
    const plannedMonday = isoWeekToMonday(mondayToIsoWeek(shift(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() || 7) - 1))));
    for (const isClosed of [false, true]) {
      number += 1;
      const [row] = await testDb.db
        .insert(tickets)
        .values({
          projectId,
          number,
          title: `P${number}`,
          type: "bug",
          priority: "medium",
          source: "manual",
          createdAt: new Date(`${day}T12:00:00Z`),
          dueDate: day,
          plannedWeek: plannedMonday,
          ...(isClosed ? { statusId: closed!.id } : {}),
        })
        .returning({ id: tickets.id });
      // La chiusura la data il trigger con now(): qui si fissa il giorno.
      if (isClosed) await testDb.db.update(tickets).set({ closedAt: new Date(`${day}T12:00:00Z`) }).where(eq(tickets.id, row!.id));
    }
  }
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function listIds(query: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/tasks?projectIds=${projectId}${query}`,
    headers: { cookie: users.adminCookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return taskListResponseSchema.parse(res.json()).items;
}

describe("parità dei periodi: /api/tasks ↔ taskInPeriod", () => {
  it("ogni campo, ogni periodo relativo e uno assoluto danno le stesse task", async () => {
    const all = await listIds("");
    expect(all.length).toBe(26);
    const periods: FieldPeriod[] = [];
    for (const field of ["created", "closed", "due", "plannedWeek"] as const) {
      for (const preset of PRESETS) periods.push({ field, kind: "relative", preset });
      periods.push({ field, kind: "absolute", from: shift(today, -10), to: shift(today, 3) });
    }
    for (const period of periods) {
      const query =
        period.kind === "relative"
          ? `&periodField=${period.field}&periodPreset=${period.preset}`
          : `&periodField=${period.field}&periodFrom=${period.from}&periodTo=${period.to}`;
      const fromServer = (await listIds(query)).map((t) => t.id).sort();
      const fromRule = all.filter((t) => taskInPeriod(t, period, today)).map((t) => t.id).sort();
      expect(fromServer, JSON.stringify(period)).toEqual(fromRule);
    }
  });
});
