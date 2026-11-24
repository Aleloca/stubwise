import { randomUUID } from "node:crypto";
import { projectMemberPermissions, projectMembers, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * «You'd lose» (rimandi, lotto 5): `POST /api/roles/:id/viewer-loses` dice
 * cosa perderebbe DAVVERO chi guarda salvando il ruolo coi permessi dati —
 * la regola del prototipo (`viewerLosesIf`): i permessi effettivi prima e
 * dopo, all'istanza e nei suoi progetti; ciò che resta da un'altra fonte non
 * è perso.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

async function viewer() {
  const [inst] = await t.db.insert(roles).values({ name: `Ruoli ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: ["roles.manage", "users.invite"] }).returning({ id: roles.id });
  const [proj] = await t.db.insert(roles).values({ name: `Prog ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["tickets.view_all", "tickets.edit", "docs.edit"] }).returning({ id: roles.id });
  const [u] = await t.db.insert(users).values({ email: `vl-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member", instanceRoleId: inst!.id }).returning({ id: users.id });
  const { projectId } = await seedRepository(t.db);
  await t.db.insert(projectMembers).values({ projectId, userId: u!.id, roleId: proj!.id });
  // `tickets.edit` gli arriva ANCHE da una concessione personale.
  await t.db.insert(projectMemberPermissions).values({ projectId, userId: u!.id, permission: "tickets.edit" } as never);
  return { cookie: await fullSessionCookie(app, u!.id), instanceRole: inst!.id, projectRole: proj!.id };
}
const loses = async (cookie: string, roleId: string, permissions: string[]) => {
  const res = await app.inject({ method: "POST", url: `/api/roles/${roleId}/viewer-loses`, headers: { cookie }, payload: { permissions } });
  return { status: res.statusCode, lost: (res.json() as { lost?: string[] }).lost };
};

describe("POST /api/roles/:id/viewer-loses", () => {
  it("il ruolo d'istanza: si perde ciò che si toglie; quello di progetto: ciò che non arriva da altre fonti", async () => {
    const v = await viewer();
    expect(await loses(v.cookie, v.instanceRole, ["roles.manage"])).toEqual({ status: 200, lost: ["users.invite"] });
    // `tickets.edit` resta dalla concessione personale; `docs.edit` no.
    expect(await loses(v.cookie, v.projectRole, ["tickets.view_all"])).toEqual({ status: 200, lost: ["docs.edit"] });
    // Nessun permesso tolto: niente.
    expect(await loses(v.cookie, v.projectRole, ["tickets.view_all", "tickets.edit", "docs.edit"])).toEqual({ status: 200, lost: [] });
  });

  it("un ruolo che chi guarda non ha: non perde niente; un ruolo che non c'è: 404", async () => {
    const v = await viewer();
    const other = await viewer();
    expect(await loses(v.cookie, other.projectRole, [])).toEqual({ status: 200, lost: [] });
    expect((await loses(v.cookie, randomUUID(), [])).status).toBe(404);
  });
});
