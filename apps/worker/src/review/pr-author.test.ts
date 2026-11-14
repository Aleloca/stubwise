import { randomUUID } from "node:crypto";
import { gitIdentities, tickets, users } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prAuthorMandatory } from "./pr-author.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});
const person = async () => (await t.db.insert(users).values({ email: `p-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id;

describe("prAuthorMandatory (area 8, F2, S4)", () => {
  it("PR di Stubwise: l'autore della task del SUO ticket", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const { ticketId } = await seedTicket(t.db, { projectId, repositoryId, number: 7 });
    const author = await person();
    await t.db.update(tickets).set({ requestedByUserId: author }).where(eq(tickets.id, ticketId));
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 7, branch: "stubwise/ticket-7", headAuthorEmail: null })).toEqual([{ userId: author, reason: "pr_author" }]);
    // Il branch di un ALTRO ticket non è suo.
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 8, branch: "stubwise/ticket-7", headAuthorEmail: null })).toEqual([]);
  });

  it("PR di un collega: l'email del commit di testa collegata a un membro (senza maiuscole); non collegata → nessuno", async () => {
    const { projectId } = await seedRepository(t.db);
    const colleague = await person();
    await t.db.insert(gitIdentities).values({ userId: colleague, email: "marta@acme.it" });
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 3, branch: "feature/x", headAuthorEmail: "Marta@Acme.it" })).toEqual([{ userId: colleague, reason: "pr_author" }]);
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 3, branch: "feature/x", headAuthorEmail: "chi@boh.it" })).toEqual([]);
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 3, branch: "feature/x", headAuthorEmail: null })).toEqual([]);
  });
});
