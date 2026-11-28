import { randomUUID } from "node:crypto";
import { projectMembers, projects, roles, users, workspaceMembers, workspaceProjects, workspaces, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attendeeProjects } from "./calendar-guess.js";
import { eventInviteeIds } from "./calendar-shared.js";
import { loadCandidateProjects } from "./classify-v2.js";

/**
 * Workspace, lotto 2, gruppo 5 (D17, `docs/plans/2026-11-27-workspace-piano.md`):
 * posta e calendario contano le persone di workspace come membri, e gli admin
 * IMPLICITI restano fuori dove lo erano. Wanda è nella workspace «Clienti»
 * (che contiene Farmacia); Ada è una full admin che non c'entra.
 */

let testDb: TestDb;
let db: Db;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);
afterAll(async () => {
  await testDb?.stop();
});

async function person(name: string, role: "admin" | "member" = "member") {
  const [u] = await db.insert(users).values({ email: `${name}-${randomUUID()}@acme.test`, passwordHash: "x", role, displayName: name }).returning();
  return u!;
}
async function seed() {
  const [p] = await db.insert(projects).values({ name: `Farmacia ${randomUUID().slice(0, 6)}`, slug: `far-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
  const wanda = await person("Wanda");
  const owner = await person("Olivia");
  const ada = await person("Ada", "admin");
  const [viewer] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "viewer"));
  const [w] = await db.insert(workspaces).values({ name: "Clienti", colorToken: "--dept-1" }).returning();
  await db.insert(workspaceProjects).values({ workspaceId: w!.id, projectId: p!.id });
  await db.insert(workspaceMembers).values({ workspaceId: w!.id, userId: wanda.id, roleId: viewer!.id });
  await db.insert(projectMembers).values({ projectId: p!.id, userId: owner.id, roleId: viewer!.id });
  return { projectId: p!.id, wanda, owner, ada };
}

describe("D17: la posta", () => {
  it("loadCandidateProjects: il progetto della workspace è candidato per Wanda, e lei è fra i suoi membri", async () => {
    const { projectId, wanda } = await seed();
    const candidates = await loadCandidateProjects(db, [wanda.id]);
    const mine = candidates.find((c) => c.id === projectId);
    expect(mine).toBeDefined();
    expect(mine!.members.map((m) => m.id)).toContain(wanda.id);
  });

  it("un full admin che non c'entra non porta candidati (resta fuori come prima)", async () => {
    const { projectId, ada } = await seed();
    expect((await loadCandidateProjects(db, [ada.id])).map((c) => c.id)).not.toContain(projectId);
  });
});

describe("D17: il calendario", () => {
  it("attendeeProjects: un evento con Wanda fra gli invitati porta il progetto della workspace", async () => {
    const { projectId, wanda, owner } = await seed();
    const map = await attendeeProjects(db, [{ id: "ev1", attendees: [{ email: wanda.email }], organizer: null }], owner.id);
    expect(map.get("ev1")).toContain(projectId);
  });

  it("eventInviteeIds: Wanda (di workspace) riceve la proposta condivisa; Ada, admin non membro, no", async () => {
    const { projectId, wanda, owner, ada } = await seed();
    const ids = await eventInviteeIds(db, {
      attendees: [
        { email: wanda.email, responseStatus: "accepted" },
        { email: ada.email, responseStatus: "accepted" },
      ],
      mailboxOwnerUserId: owner.id,
      projectId,
    });
    expect(ids).toContain(wanda.id);
    expect(ids).not.toContain(ada.id);
  });
});
