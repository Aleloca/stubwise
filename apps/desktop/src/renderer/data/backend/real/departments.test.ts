import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { adminDepartments } from "./departments";
import { countTasks } from "./tasks";

const GENERAL = "66666666-6666-4666-8666-666666666666";
const SALES = "77777777-7777-4777-8777-777777777777";
const departments = [
  { id: GENERAL, name: "General", colorToken: "--dept-1", isDefault: true },
  { id: SALES, name: "Sales", colorToken: "--dept-2", isDefault: false },
];

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("Reparti nella build app", () => {
  it("i membri vengono dai reparti delle persone; l'elenco non scarica le task", async () => {
    const { seen } = installFakeServer({
      "GET /api/departments": { body: departments },
      "GET /api/people": {
        body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [SALES], email: "ada@example.com" }],
      },
      "GET /api/departments/roles": { body: [] },
    });
    const rows = await adminDepartments.listDepartments!();
    expect(rows.map((d) => [d.name, d.memberIds, d.projectPermissions])).toEqual([
      ["General", [], []],
      ["Sales", [ME_ID], []],
    ]);
    expect(seen.some((r) => r.path.startsWith("/api/tasks"))).toBe(false);
  });

  it("il conteggio delle task di un reparto: filtrato, con «troncato», e un errore resta un errore", async () => {
    installFakeServer({
      "GET /api/tasks": ({ path }) =>
        path.includes(SALES)
          ? { body: { items: [{}, {}], truncated: true } }
          : { status: 500, body: { code: "internal", message: "x" } },
    });
    expect(await countTasks({ departmentIds: [SALES] })).toEqual({ count: 2, truncated: true });
    await expect(countTasks({ departmentIds: [GENERAL] })).rejects.toThrow();
  });

  it("il reparto di ripiego non si elimina: il rifiuto ha il suo motivo", async () => {
    installFakeServer({
      [`DELETE /api/departments/${GENERAL}`]: { status: 400, body: { code: "department_is_default", message: "x" } },
    });
    expect(await adminDepartments.deleteDepartment!(GENERAL, null)).toEqual({
      ok: false,
      error: "invalid",
      reason: "default_department",
    });
  });

  it("senza departments.manage: forbidden; un nome già usato: name_taken", async () => {
    installFakeServer({
      "POST /api/departments": { status: 403, body: { code: "forbidden", message: "x" } },
      [`PATCH /api/departments/${SALES}`]: { status: 409, body: { code: "department_name_taken", message: "x" } },
    });
    expect(await adminDepartments.createDepartment!({ name: "Ops", colorToken: "--dept-3" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await adminDepartments.updateDepartment!(SALES, { name: "General" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "name_taken",
    });
  });

  it("salvare il pannello manda nome, colore e membri, poi i responsabili della Home; mai i permessi", async () => {
    const { seen } = installFakeServer({
      [`PATCH /api/departments/${SALES}`]: { body: departments[1] },
      [`PUT /api/departments/${SALES}/roles`]: {
        body: [{ departmentId: SALES, userId: ME_ID, permissions: ["department.home.manage"] }],
      },
    });
    expect(
      await adminDepartments.saveDepartment!(SALES, {
        memberIds: [ME_ID, ME_ID],
        homeManagerIds: [ME_ID, ME_ID],
        projectPermissions: ["drive.upload"],
      }),
    ).toEqual({ ok: true });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `PATCH /api/departments/${SALES}`,
      `PUT /api/departments/${SALES}/roles`,
    ]);
    expect(seen[0]!.body).toEqual({ memberIds: [ME_ID] });
    // Senza riconferma (decisione del maintainer): il corpo è solo l'elenco dei ruoli.
    expect(seen[1]!.body).toEqual({ roles: [{ userId: ME_ID, permissions: ["department.home.manage"] }] });
  });

  it("i responsabili della Home vengono dai ruoli di reparto", async () => {
    installFakeServer({
      "GET /api/departments": { body: departments },
      "GET /api/people": {
        body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [SALES], email: "ada@example.com" }],
      },
      "GET /api/departments/roles": {
        body: [{ departmentId: SALES, userId: ME_ID, permissions: ["department.home.manage"] }],
      },
    });
    const rows = await adminDepartments.listDepartments!();
    expect(rows.map((d) => [d.name, d.homeManagerIds])).toEqual([
      ["General", []],
      ["Sales", [ME_ID]],
    ]);
  });
});
