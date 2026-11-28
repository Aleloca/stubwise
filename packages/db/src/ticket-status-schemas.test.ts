import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tickets } from "./schema.js";
import { roleInsert, seedRepository, startTestDb, type TestDb } from "./testing.js";
import { roleLiteral, roleUpdate, statusIdForRole, ticketRoleIn, ticketStatusSql } from "./ticket-status.js";

// I frammenti dei ruoli reggono TUTTI E DUE gli schemi: quello di oggi, con
// l'enum `ticket_status`, e quello dopo la 0245 di R3, che toglie il tipo e
// porta `legacy_status` e le funzioni a `text`. Dopo R3 si scende al massimo
// a R2 (deploy-log, «R3»), quindi l'immagine di R2 deve girare sul DB di
// dopo: il codice dei ruoli non nomina mai il tipo. Questo test gira su
// qualunque schema sia l'ultimo della catena: oggi quello di prima, dopo R3
// quello di dopo (il caso «prima» lo ripete il test della 0245).

const HERE = dirname(fileURLToPath(import.meta.url));

describe("i frammenti dei ruoli non nominano il tipo `ticket_status`", () => {
  it("ticket-status.ts e i ruoli di testing.ts: nessun cast al tipo dell'enum", () => {
    for (const file of ["ticket-status.ts", "testing.ts"]) {
      const code = readFileSync(join(HERE, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code, file).not.toMatch(/::\s*"?ticket_status"?/);
    }
  });

  it("roleLiteral: un letterale senza tipo, solo per i sei ruoli", () => {
    expect(() => roleLiteral("done' or '1'='1" as never)).toThrow();
    expect(() => roleLiteral("archived" as never)).toThrow(/ruolo sconosciuto/);
    // E i sei ruoli passano (il caso che rende vero il test sopra).
    for (const role of ["open", "triaged", "in_progress", "in_review", "done", "closed"] as const) expect(() => roleLiteral(role)).not.toThrow();
  });
});

describe("i ruoli sullo schema di oggi", () => {
  let t: TestDb;
  let projectId: string;
  let n = 500;

  beforeAll(async () => {
    t = await startTestDb();
    ({ projectId } = await seedRepository(t.db));
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  const newTicket = async (values: Record<string, unknown> = {}) =>
    (
      await t.db
        .insert(tickets)
        .values({ projectId, number: n++, title: "t", type: "bug", priority: "medium", source: "manual", ...values })
        .returning({ id: tickets.id })
    )[0]!.id;
  const statusOf = async (id: string) => (await t.db.select({ s: ticketStatusSql }).from(tickets).where(eq(tickets.id, id)))[0]!.s;

  it("roleUpdate e statusIdForRole spostano lo stato; ticketStatusSql lo deriva", async () => {
    const id = await newTicket();
    await t.db.update(tickets).set(roleUpdate("in_review")).where(eq(tickets.id, id));
    expect(await statusOf(id)).toBe("in_review");
    await t.db.update(tickets).set({ statusId: statusIdForRole("done") }).where(eq(tickets.id, id));
    expect(await statusOf(id)).toBe("done");
    await t.db.update(tickets).set(roleUpdate("triaged")).where(eq(tickets.id, id));
    expect(await statusOf(id)).toBe("triaged");
  });

  it("ticketRoleIn e roleInsert", async () => {
    const closed = await newTicket(roleInsert(projectId, "closed"));
    const triaged = await newTicket(roleInsert(projectId, "triaged"));
    const ids = async (roles: Parameters<typeof ticketRoleIn>[0]) =>
      (await t.db.select({ id: tickets.id }).from(tickets).where(ticketRoleIn(roles))).map((r) => r.id);
    expect(await ids(["done", "closed"])).toContain(closed);
    expect(await ids(["triaged"])).toEqual(expect.arrayContaining([triaged]));
    expect(await ids(["triaged"])).not.toContain(closed);
    expect(await ids(["open"])).not.toContain(triaged);
    expect(await statusOf(triaged)).toBe("triaged");
    const [row] = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from ${tickets} where ${ticketRoleIn(["done", "closed"])}`);
    expect(row!.n).toBeGreaterThan(0);
  });
});
