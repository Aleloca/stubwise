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

  it("area 9, F4: la coda di un progetto — pausa, ripresa, rilancio — di progetto, letti da chi gestisce il progetto", () => {
    for (const kind of ["queue.paused", "queue.resumed", "job.retried"]) {
      expect(CHANGE_LOG_TYPES.find((t) => t.kind === kind), kind).toMatchObject({ scope: "project", group: "queue", readPermission: "project.settings.manage" });
    }
    expect(INSTANCE_PERMISSIONS).toContain("instance.status.view");
  });

  it("area 9, F5: i tipi della 9c sono ESATTAMENTE quelli del prototipo, tranne F6 (archivio, eliminazione) e 10a (task.deleted)", async () => {
    const { readFileSync } = await import("node:fs");
    const proto = readFileSync(new URL("../../../apps/desktop/src/renderer/data/projectSettings/changeTypes.ts", import.meta.url), "utf8");
    const kinds = [...proto.matchAll(/^\s+(?:settings|tasks|repos|environments|widget|projects)\("([a-z_.]+)"\)/gm)].map((m) => m[1]!);
    const notF5 = new Set(["project.archived", "project.reopened", "project.deleted", "repository.linked", "task.deleted"]);
    const expected = kinds.filter((k) => !notF5.has(k)).sort();
    expect(expected.length).toBeGreaterThan(20);
    const ours = CHANGE_LOG_TYPES.filter((t) => t.scope === "project" && !t.kind.startsWith("member.") && !t.kind.startsWith("queue.") && t.kind !== "job.retried").map((t) => t.kind).sort();
    expect(ours).toEqual(expected);
  });

  it("area 9, F5: i params obbligatori della 9c; il nome della variabile è `variable` (K-3), mai `key`", () => {
    const object = { type: "env_file", id: "x", label: "test" };
    expect(CHANGE_DATA_SCHEMAS["env_var.set"]!.safeParse({ object, params: { environment: "test", repository: "web" } }).success).toBe(false);
    expect(CHANGE_DATA_SCHEMAS["env_var.set"]!.safeParse({ object, params: { environment: "test", repository: "web", variable: "API_URL" } }).success).toBe(true);
    expect(CHANGE_DATA_SCHEMAS["env_file.imported"]!.safeParse({ object, params: { environment: "test", repository: "web" } }).success).toBe(false);
    expect(CHANGE_DATA_SCHEMAS["project.switch_changed"]!.safeParse({ object }).success).toBe(false);
    expect(CHANGE_DATA_SCHEMAS["repository.updated"]!.safeParse({ object, params: { field: "name" } }).success).toBe(true);
    expect(CHANGE_LOG_TYPES.find((t) => t.kind === "env_var.set")).toMatchObject({ scope: "project", group: "repositories", readPermission: "repos.manage" });
    expect(CHANGE_LOG_TYPES.find((t) => t.kind === "widget.created")).toMatchObject({ readPermission: "widget.manage" });
    expect(CHANGE_LOG_TYPES.find((t) => t.kind === "project.renamed")).toMatchObject({ group: "project", readPermission: "project.settings.manage" });
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
