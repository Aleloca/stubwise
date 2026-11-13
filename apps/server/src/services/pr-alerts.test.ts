import { randomUUID } from "node:crypto";
import { alertSubscriptions, notifications, projectMembers, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishPrOpened } from "./pr-alerts.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function subscriber(projectId: string): Promise<string> {
  const [u] = await t.db.insert(users).values({ email: `s-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "viewer"));
  await t.db.insert(projectMembers).values({ projectId, userId: u!.id, roleId: role!.id });
  await t.db.insert(alertSubscriptions).values({ userId: u!.id, projectId, alertType: "pr.opened", app: true, phone: false });
  return u!.id;
}
const cardsOf = async (userId: string) => (await t.db.select().from(notifications).where(eq(notifications.userId, userId))).filter((n) => n.kind === "pr.opened");

describe("pr.opened (area 8, F2, S4)", () => {
  it("una PR aperta: la card a chi si è iscritto col link al pannello; un `opened` ripetuto non ne crea un'altra", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const sub = await subscriber(projectId);
    const input = { repositoryId, prNumber: 12, prUrl: "https://github.com/acme/web/pull/12", title: "Filtri", sourceBranch: "feature/filtri" };
    await publishPrOpened(t.db, "https://s.example/", input);
    await publishPrOpened(t.db, "https://s.example/", input);
    const cards = await cardsOf(sub);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.event).toMatchObject({ prNumber: 12, url: expect.stringMatching(new RegExp(`/app/#/p/[A-Z0-9]+/releases\\?pr=${repositoryId}%2312$`)) });
  });

  it("le PR di Stubwise (`stubwise/…`) e le riaperture non avvisano", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const sub = await subscriber(projectId);
    await publishPrOpened(t.db, "https://s.example", { repositoryId, prNumber: 3, prUrl: "u", title: "x", sourceBranch: "stubwise/ticket-3" });
    await publishPrOpened(t.db, "https://s.example", { repositoryId, prNumber: 4, prUrl: "u", title: "x", sourceBranch: "feature/y", reopened: true });
    expect(await cardsOf(sub)).toEqual([]);
  });
});
