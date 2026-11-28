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

  it("area 9, F5 e F6: i tipi della 9c sono ESATTAMENTE quelli del prototipo, tranne 10a (task.deleted)", async () => {
    const { readFileSync } = await import("node:fs");
    const proto = readFileSync(new URL("../../../apps/desktop/src/renderer/data/projectSettings/changeTypes.ts", import.meta.url), "utf8");
    // Nel prototipo `projects(...)` è una voce d'ISTANZA (gruppo `projects`, `instance.full_admin`), le altre di progetto.
    const entries = [...proto.matchAll(/^\s+(settings|tasks|repos|environments|widget|projects)\("([a-z_.]+)"\)/gm)].map((m) => ({ kind: m[2]!, scope: m[1] === "projects" ? "instance" : "project" }));
    const notF5 = new Set(["task.deleted"]);
    const expected = entries.filter((e) => !notF5.has(e.kind)).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(expected.length).toBeGreaterThan(20);
    const instanceKinds = new Set(expected.filter((e) => e.scope === "instance").map((e) => e.kind));
    const ours = CHANGE_LOG_TYPES.filter((t) => (t.scope === "project" && !t.kind.startsWith("member.") && !t.kind.startsWith("workspace.") && !t.kind.startsWith("queue.") && t.kind !== "job.retried") || instanceKinds.has(t.kind))
      .map((t) => ({ kind: t.kind, scope: t.scope }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    expect(ours).toEqual(expected);
    // `repository.deleted`: d'istanza (maintainer, 31 ott 2026, domanda 4 (b)).
    expect(CHANGE_LOG_TYPES.find((t) => t.kind === "repository.deleted")).toMatchObject({ scope: "instance", group: "projects", readPermission: "instance.full_admin" });
  });

  it("area 9, F6: archivio, riapertura, eliminazione e collegamento, con i gruppi e i lettori del prototipo", () => {
    for (const kind of ["project.archived", "project.reopened"]) {
      expect(CHANGE_LOG_TYPES.find((t) => t.kind === kind), kind).toMatchObject({ scope: "project", group: "project", readPermission: "project.settings.manage" });
    }
    expect(CHANGE_LOG_TYPES.find((t) => t.kind === "repository.linked")).toMatchObject({ scope: "project", group: "repositories", readPermission: "repos.manage" });
    expect(CHANGE_LOG_TYPES.find((t) => t.kind === "project.deleted")).toMatchObject({ scope: "instance", group: "projects", readPermission: "instance.full_admin" });
    const object = { type: "project", id: "x", label: "" };
    expect(CHANGE_DATA_SCHEMAS["project.deleted"]!.safeParse({ object }).success).toBe(false);
    expect(CHANGE_DATA_SCHEMAS["project.deleted"]!.safeParse({ object, params: { detachedRepositories: "2" } }).success).toBe(true);
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
