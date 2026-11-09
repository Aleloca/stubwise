import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID } from "./fakeServer";
import {
  getPersonalHome,
  listDepartmentHomes,
  listDepartmentRoles,
  markDepartmentHomeSeen,
  resetPersonalHome,
  setDepartmentHome,
  setPersonalHome,
} from "./home";
import { getSessionPerson } from "./session";

// La Home a blocchi della build app (integrazione area 2, fetta 3, Task L):
// le Home dei reparti e quella personale vengono dal server, e la si risolve
// con la stessa `resolveHome` di `@stubwise/shared` che usa il server.

const GENERAL = "66666666-6666-4666-8666-666666666666";
const SALES = "77777777-7777-4777-8777-777777777777";
const FILTER = "88888888-8888-4888-8888-888888888888";
const AT = "2026-11-01T09:00:00.000Z";

const meHome = (over: Record<string, unknown> = {}) => ({
  blocks: [{ kind: "decide" }, { kind: "myWeek" }],
  departmentChanged: [],
  newBlocks: [],
  departmentIds: [SALES],
  departmentHomes: [],
  personal: null,
  ...over,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le Home dal server", () => {
  it("le Home di tutti i reparti, anche di quelli che non sono miei; un reparto senza Home sua non c'è", async () => {
    const { seen } = installFakeServer({
      "GET /api/departments": {
        body: [
          { id: GENERAL, name: "General", colorToken: "--dept-1", isDefault: true },
          { id: SALES, name: "Sales", colorToken: "--dept-2", isDefault: false },
        ],
      },
      [`GET /api/departments/${GENERAL}/home`]: {
        body: { departmentId: GENERAL, blocks: [{ kind: "decide" }, { kind: "myWeek" }], updatedAt: null },
      },
      [`GET /api/departments/${SALES}/home`]: {
        body: {
          departmentId: SALES,
          blocks: [{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }, { kind: "filter", filterId: FILTER }],
          updatedAt: AT,
        },
      },
    });
    expect(await listDepartmentHomes()).toEqual([
      {
        departmentId: SALES,
        blocks: [{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }, { kind: "filter", filterId: FILTER }],
        updatedAt: AT,
      },
    ]);
    expect(seen.filter((r) => r.path.endsWith("/home"))).toHaveLength(2);
  });

  it("un blocco di un tipo che questa app non conosce si ignora", async () => {
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/me/home": {
        body: meHome({
          personal: {
            blocks: [{ kind: "decide" }, { kind: "myWeek" }, { kind: "__future__" }, { kind: "myTasks" }],
            seenDepartmentUpdates: { [SALES]: AT },
          },
        }),
      },
    });
    await getSessionPerson();
    expect(await getPersonalHome()).toEqual({
      personId: ME_ID,
      blocks: [{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }],
      seenDepartmentUpdates: { [SALES]: AT },
    });
  });

  it("senza Home personale: null", async () => {
    installFakeServer({ "GET /api/me/home": { body: meHome() } });
    expect(await getPersonalHome()).toBeNull();
  });

  it("salvare la Home personale manda i blocchi e risponde con quella normalizzata dal server", async () => {
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me() },
      "PUT /api/me/home": {
        body: meHome({
          personal: { blocks: [{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }], seenDepartmentUpdates: {} },
        }),
      },
    });
    await getSessionPerson();
    const saved = await setPersonalHome([{ kind: "myTasks" }, { kind: "myTasks" }]);
    expect(seen.at(-1)).toMatchObject({ method: "PUT", body: { blocks: [{ kind: "myTasks" }, { kind: "myTasks" }] } });
    expect(saved.blocks).toEqual([{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }]);
  });

  it("ripristina, novità viste, Home di un reparto", async () => {
    const { seen } = installFakeServer({
      "DELETE /api/me/home": { status: 204 },
      [`POST /api/me/home/seen/${SALES}`]: { status: 204 },
      [`PUT /api/departments/${SALES}/home`]: {
        body: { departmentId: SALES, blocks: [{ kind: "decide" }, { kind: "myWeek" }], updatedAt: AT },
      },
    });
    await resetPersonalHome();
    await markDepartmentHomeSeen(SALES);
    await setDepartmentHome(SALES, [{ kind: "decide" }, { kind: "myWeek" }]);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /api/me/home",
      `POST /api/me/home/seen/${SALES}`,
      `PUT /api/departments/${SALES}/home`,
    ]);
  });

  it("una Home di reparto con un filtro privato: il rifiuto del server arriva così com'è", async () => {
    installFakeServer({
      [`PUT /api/departments/${SALES}/home`]: {
        status: 400,
        body: { code: "filter_not_public", message: "A department Home can only show public filters" },
      },
    });
    await expect(setDepartmentHome(SALES, [{ kind: "filter", filterId: FILTER }])).rejects.toMatchObject({
      status: 400,
      code: "filter_not_public",
    });
  });

  it("i ruoli di reparto: tutti, o quelli di una persona", async () => {
    const OTHER = "55555555-5555-4555-8555-555555555555";
    installFakeServer({
      "GET /api/departments/roles": {
        body: [
          { departmentId: SALES, userId: ME_ID, permissions: ["department.home.manage"] },
          { departmentId: GENERAL, userId: OTHER, permissions: ["department.home.manage"] },
        ],
      },
    });
    expect(await listDepartmentRoles(ME_ID)).toEqual([
      { personId: ME_ID, departmentId: SALES, permissions: ["department.home.manage"] },
    ]);
    expect(await listDepartmentRoles()).toHaveLength(2);
  });
});
