import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { adminDepartments } from "./departments";

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
  it("i membri vengono dai reparti delle persone, le task dal filtro per reparto", async () => {
    installFakeServer({
      "GET /api/departments": { body: departments },
      "GET /api/people": {
        body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [SALES], email: "ada@example.com" }],
      },
      "GET /api/tasks": ({ path }) => ({
        body: { items: path.includes(SALES) ? [{}, {}] : [], truncated: false },
      }),
    });
    const rows = await adminDepartments.listDepartments!();
    expect(rows.map((d) => [d.name, d.memberIds, d.taskCount, d.projectPermissions])).toEqual([
      ["General", [], 0, []],
      ["Sales", [ME_ID], 2, []],
    ]);
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

  it("salvare il pannello manda nome, colore e membri, mai Home né permessi", async () => {
    const { seen } = installFakeServer({ [`PATCH /api/departments/${SALES}`]: { body: departments[1] } });
    expect(
      await adminDepartments.saveDepartment!(SALES, {
        memberIds: [ME_ID, ME_ID],
        homeManagerIds: [ME_ID],
        projectPermissions: ["drive.upload"],
      }),
    ).toEqual({ ok: true });
    expect(seen[0]!.body).toEqual({ memberIds: [ME_ID] });
  });
});
