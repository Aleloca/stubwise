import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { adminDepartments, forgetLoadedDepartmentsForTest } from "./departments";
import { countTasks } from "./tasks";

const GENERAL = "66666666-6666-4666-8666-666666666666";
const SALES = "77777777-7777-4777-8777-777777777777";
const GENERAL_ID = "66666666-6666-4666-8666-666666666666";
const departments = [
  { id: GENERAL, name: "General", colorToken: "--dept-1", isDefault: true },
  { id: SALES, name: "Sales", colorToken: "--dept-2", isDefault: false },
];

beforeEach(() => {
  setAppClientForTests(null);
  forgetLoadedDepartmentsForTest();
});
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

  it("F8: l'anteprima della bozza la calcola il server (F8-2 = a): reach, notGivable, missingToAdd, missing", async () => {
    const { seen } = installFakeServer({
      [`POST /api/departments/${SALES}/preview`]: {
        body: {
          reach: "anywhere",
          notGivable: ["plans.approve"],
          missingToAdd: { [ME_ID]: ["support.manage"] },
          missing: [],
        },
      },
    });
    const draft = { memberIds: [ME_ID], projectPermissions: ["tickets.create"] };
    expect(await adminDepartments.previewDepartment!(SALES, draft)).toEqual({
      reach: "anywhere",
      notGivable: ["plans.approve"],
      missingToAdd: { [ME_ID]: ["support.manage"] },
      missing: [],
    });
    const sent = seen.find((r) => r.path === `/api/departments/${SALES}/preview`)!;
    expect(sent.method).toBe("POST");
    expect(sent.body).toEqual(draft);
  });

  it("F8: i rifiuti del salvataggio nelle parole del prototipo (riconferma, escalation, ultimo gestore, permesso, persona)", async () => {
    const patch = `PATCH /api/departments/${SALES}`;
    const save = () =>
      adminDepartments.saveDepartment!(SALES, {
        memberIds: [ME_ID],
        homeManagerIds: [],
        projectPermissions: [],
      });
    const cases: [number, Record<string, unknown>, unknown][] = [
      [403, { code: "reauth_required" }, { ok: false, error: "reauth_required" }],
      [403, { code: "escalation", permission: "plans.approve", missing: ["plans.approve"] }, { ok: false, error: "escalation", missing: ["plans.approve"] }],
      [409, { code: "last_manager", projectId: "p1", projectCode: "ACQ" }, { ok: false, error: "invalid", reason: "last_members_manager" }],
      [400, { code: "invalid_permission", permission: "x" }, { ok: false, error: "invalid", reason: "permission" }],
      [400, { code: "not_a_person" }, { ok: false, error: "invalid", reason: "person" }],
      [403, { code: "forbidden" }, { ok: false, error: "forbidden" }],
    ];
    for (const [status, body, want] of cases) {
      installFakeServer({
        "GET /api/departments/roles": { body: [] },
        [patch]: { status, body: { message: "x", ...body } },
      });
      expect(await save(), String(body.code)).toEqual(want);
    }
  });

  it("F8: eliminare un reparto che lascerebbe un progetto senza gestore: last_members_manager", async () => {
    installFakeServer({
      [`DELETE /api/departments/${SALES}`]: { status: 409, body: { code: "last_manager", message: "x", projectId: "p1" } },
    });
    expect(await adminDepartments.deleteDepartment!(SALES, null)).toEqual({
      ok: false,
      error: "invalid",
      reason: "last_members_manager",
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

  it("salvare il pannello manda nome, colore e membri, poi i responsabili della Home; i permessi no se il reparto non è stato letto (F8)", async () => {
    const { seen } = installFakeServer({
      "GET /api/departments/roles": { body: [] },
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
      "GET /api/departments/roles",
      `PUT /api/departments/${SALES}/roles`,
    ]);
    expect(seen[0]!.body).toEqual({ memberIds: [ME_ID] });
    // Senza riconferma (decisione del maintainer): il corpo è solo l'elenco dei ruoli.
    expect(seen[2]!.body).toEqual({ roles: [{ userId: ME_ID, permissions: ["department.home.manage"] }] });
  });

  it("F8: l'elenco dà i permessi del reparto; il salvataggio li manda solo se la bozza li CAMBIA rispetto al letto", async () => {
    const withPerms = [departments[0], { ...departments[1], projectPermissions: ["support.manage"] }];
    const { seen } = installFakeServer({
      "GET /api/departments": { body: withPerms },
      "GET /api/people": { body: [] },
      "GET /api/departments/roles": { body: [] },
      [`PATCH /api/departments/${SALES}`]: { body: withPerms[1] },
      [`PUT /api/departments/${SALES}/roles`]: { body: [] },
    });
    const rows = await adminDepartments.listDepartments!();
    expect(rows.find((d) => d.id === SALES)!.projectPermissions).toEqual(["support.manage"]);
    const patches = () => seen.filter((r) => r.method === "PATCH").map((r) => r.body);
    // Invariati: il PATCH non li nomina (una sessione con dati vecchi non li cancella).
    await adminDepartments.saveDepartment!(SALES, {
      memberIds: [ME_ID],
      homeManagerIds: [],
      projectPermissions: ["support.manage"],
    });
    expect(patches().at(-1)).toEqual({ memberIds: [ME_ID] });
    // Cambiati: l'insieme intero, come lo vuole il server.
    await adminDepartments.saveDepartment!(SALES, {
      memberIds: [ME_ID],
      homeManagerIds: [],
      projectPermissions: ["support.manage", "drive.upload", "drive.upload"],
    });
    expect(patches().at(-1)).toEqual({
      memberIds: [ME_ID],
      projectPermissions: ["support.manage", "drive.upload"],
    });
  });

  it("F8: un elenco senza il campo (server di prima): una bozza vuota non nomina i permessi", async () => {
    const { seen } = installFakeServer({
      "GET /api/departments": { body: departments },
      "GET /api/people": { body: [] },
      "GET /api/departments/roles": { body: [] },
      [`PATCH /api/departments/${SALES}`]: { body: departments[1] },
      [`PUT /api/departments/${SALES}/roles`]: { body: [] },
    });
    await adminDepartments.listDepartments!();
    await adminDepartments.saveDepartment!(SALES, { memberIds: [ME_ID], homeManagerIds: [], projectPermissions: [] });
    expect(seen.find((r) => r.method === "PATCH")!.body).toEqual({ memberIds: [ME_ID] });
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

  it("i ruoli si fondono con quelli letti: un permesso di reparto sconosciuto resta", async () => {
    const OTHER = "55555555-5555-4555-8555-555555555555";
    const { seen } = installFakeServer({
      "GET /api/departments/roles": {
        body: [
          { departmentId: SALES, userId: OTHER, permissions: ["department.home.manage", "department.future"] },
          { departmentId: SALES, userId: ME_ID, permissions: ["department.future"] },
          { departmentId: GENERAL_ID, userId: OTHER, permissions: ["department.home.manage"] },
        ],
      },
      [`PATCH /api/departments/${SALES}`]: { body: departments[1] },
      [`PUT /api/departments/${SALES}/roles`]: { body: [] },
    });
    await adminDepartments.saveDepartment!(SALES, { memberIds: [ME_ID, OTHER], homeManagerIds: [ME_ID], projectPermissions: [] });
    expect(seen.at(-1)!.body).toEqual({
      roles: [
        { userId: OTHER, permissions: ["department.future"] },
        { userId: ME_ID, permissions: ["department.future", "department.home.manage"] },
      ],
    });
  });

  it("se i ruoli non si salvano dopo i membri lo dice; riprovando si riscrivono solo i ruoli", async () => {
    let fail = true;
    const { seen } = installFakeServer({
      "GET /api/departments/roles": { body: [] },
      [`PATCH /api/departments/${SALES}`]: { body: departments[1] },
      [`PUT /api/departments/${SALES}/roles`]: () =>
        fail ? { status: 500, body: { code: "internal", message: "x" } } : { body: [] },
    });
    const draft = { memberIds: [ME_ID], homeManagerIds: [ME_ID], projectPermissions: [] };
    expect(await adminDepartments.saveDepartment!(SALES, draft)).toEqual({
      ok: false,
      error: "invalid",
      reason: "roles_not_saved",
    });
    fail = false;
    seen.length = 0;
    expect(await adminDepartments.saveDepartment!(SALES, draft)).toEqual({ ok: true });
    expect(seen.map((r) => r.method)).toEqual(["GET", "PUT"]);
  });
});
