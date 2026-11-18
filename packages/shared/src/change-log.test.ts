import { describe, expect, it } from "vitest";
import { CHANGE_DATA_SCHEMAS, CHANGE_LOG_KINDS, CHANGE_LOG_TYPES, changeEntrySchema } from "./change-log.js";
import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "./permissions.js";
import { readerSchema } from "./reader.js";

/** Area 9, F2: il catalogo del registro, i suoi schemi e la lettura dai client. */
describe("il catalogo del registro delle modifiche", () => {
  it("ogni tipo è unico, ha il suo schema di `data`, e nient'altro ce l'ha", () => {
    expect(new Set(CHANGE_LOG_KINDS).size).toBe(CHANGE_LOG_KINDS.length);
    expect(Object.keys(CHANGE_DATA_SCHEMAS).sort()).toEqual([...CHANGE_LOG_KINDS].sort());
  });

  it("il `readPermission` è un permesso vero del suo livello", () => {
    for (const t of CHANGE_LOG_TYPES) {
      const catalog: readonly string[] = t.scope === "instance" ? INSTANCE_PERMISSIONS : PROJECT_PERMISSIONS;
      expect(catalog, t.kind).toContain(t.readPermission);
    }
    expect(INSTANCE_PERMISSIONS).toContain("changelog.view");
  });

  it("uno schema per tipo pretende i `params` che la sua frase nomina", () => {
    const object = { type: "member", id: "x", label: "Bea" };
    expect(CHANGE_DATA_SCHEMAS["member.permission_granted"]!.safeParse({ object }).success).toBe(false);
    expect(CHANGE_DATA_SCHEMAS["member.permission_granted"]!.safeParse({ object, params: { permission: "release.merge" } }).success).toBe(true);
    expect(CHANGE_DATA_SCHEMAS["role.created"]!.safeParse({ object }).success).toBe(true);
  });

  it("dai client: un tipo o un attore ignoti sono __unknown__, e i campi facoltativi hanno i default", () => {
    const parsed = readerSchema(changeEntrySchema).parse({
      id: "40000000-0000-4000-8000-000000000001",
      type: "server.paused",
      at: "2026-11-16T10:00:00.000Z",
      actor: { name: "Ada", kind: "robot" },
      scope: "instance",
      group: "queue",
      data: { object: { type: "server", id: "s", label: "S" } },
    });
    expect(parsed.type).toBe("__unknown__");
    expect(parsed.actor.kind).toBe("__unknown__");
    expect(parsed).toMatchObject({ projectId: null, projectCode: null, objectDeleted: false, data: { before: null, after: null, params: {} } });
  });
});
