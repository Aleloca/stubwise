import { randomUUID } from "node:crypto";
import { automationRuns, automations, automationScheduleFires, automationVersions, projectMembers, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AutomationFlow } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireSchedules } from "./schedules.js";

/**
 * GLI INIZI A ORARIO (area 7, F2, S7): una volta per giorno locale
 * (Europe/Rome), per vincolo; il 31 in un mese di 30 giorni cade il 30; in
 * pausa non scatta, e riaccesa non recupera.
 */

let t: TestDb;
let projectId: string;
let ownerId: string;
let seq = 1;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  ({ projectId } = await seedRepository(t.db));
  ownerId = (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id;
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "project_lead"));
  await t.db.insert(projectMembers).values({ projectId, userId: ownerId, roleId: role!.id });
});

async function scheduled(rule: string, status: "active" | "paused" = "active") {
  const n = seq++;
  const flow: AutomationFlow = { trigger: { kind: "schedule", rule }, steps: [], titleTemplate: "Del {{avvio.data}}" };
  const [a] = await t.db.insert(automations).values({ code: `S${n}-A${n}`, seq: n, name: `S${n}`, projectId, ownerId, status, activeSince: new Date("2026-01-01") }).returning();
  await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date("2026-01-01"), publishedBy: ownerId });
  return a!;
}
const runsOf = (id: string) => t.db.select().from(automationRuns).where(eq(automationRuns.automationId, id));

describe("fireSchedules", () => {
  it("ogni giorno alle 9 (Roma): prima delle 9 niente; dopo, UNA esecuzione anche con due giri insieme", async () => {
    const a = await scheduled("FREQ=DAILY;BYHOUR=9");
    expect(await fireSchedules(t.db, new Date("2026-11-13T07:30:00Z"))).toBe(0); // 08:30 a Roma
    const at = new Date("2026-11-13T08:30:00Z"); // 09:30 a Roma
    await Promise.all([fireSchedules(t.db, at), fireSchedules(t.db, at)]);
    await fireSchedules(t.db, at);
    const runs = await runsOf(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ origin: "schedule", status: "running", title: "Del 2026-11-13", event: { avvio: { data: "2026-11-13" } } });
    expect(await t.db.select().from(automationScheduleFires).where(eq(automationScheduleFires.automationId, a.id))).toEqual([expect.objectContaining({ localDate: "2026-11-13", runId: runs[0]!.id })]);
    // Il giorno dopo, di nuovo.
    await fireSchedules(t.db, new Date("2026-11-14T08:30:00Z"));
    expect(await runsOf(a.id)).toHaveLength(2);
  });

  it("il giorno locale è quello di Roma: alle 23:30 UTC del 13 a Roma è già il 14", async () => {
    const a = await scheduled("FREQ=DAILY;BYHOUR=0");
    await fireSchedules(t.db, new Date("2026-11-13T23:30:00Z"));
    expect((await runsOf(a.id))[0]!.event).toEqual({ avvio: { data: "2026-11-14" } });
  });

  it("ogni mese il 31: a novembre scatta il 30, non il 29", async () => {
    const a = await scheduled("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9");
    await fireSchedules(t.db, new Date("2026-11-29T10:00:00Z"));
    expect(await runsOf(a.id)).toHaveLength(0);
    await fireSchedules(t.db, new Date("2026-11-30T10:00:00Z"));
    expect(await runsOf(a.id)).toHaveLength(1);
  });

  it("in pausa non scatta; riaccesa scatta solo per oggi, senza recuperare i giorni persi", async () => {
    const a = await scheduled("FREQ=DAILY;BYHOUR=9", "paused");
    await fireSchedules(t.db, new Date("2026-11-13T10:00:00Z"));
    expect(await runsOf(a.id)).toHaveLength(0);
    await t.db.update(automations).set({ status: "active" }).where(eq(automations.id, a.id));
    await fireSchedules(t.db, new Date("2026-11-15T10:00:00Z"));
    const fires = await t.db.select().from(automationScheduleFires).where(eq(automationScheduleFires.automationId, a.id));
    expect(fires.map((f) => f.localDate)).toEqual(["2026-11-15"]);
  });

  it("review F2, M2: un'automazione che fa lanciare non blocca gli orari delle altre (si logga e si va avanti)", async () => {
    const broken = await scheduled("FREQ=DAILY;BYHOUR=9");
    await t.db.update(automationVersions).set({ flow: { trigger: { kind: "schedule", rule: 5 }, steps: [], titleTemplate: "x" } as never }).where(eq(automationVersions.automationId, broken.id));
    const fine = await scheduled("FREQ=DAILY;BYHOUR=9");
    const lines: string[] = [];
    await fireSchedules(t.db, new Date("2026-11-20T10:00:00Z"), (m) => lines.push(m));
    expect(await runsOf(fine.id)).toHaveLength(1);
    expect(lines.some((l) => l.includes(broken.code))).toBe(true);
  });
});

