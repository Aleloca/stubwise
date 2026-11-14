import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { PRESET_ROLES } from "@stubwise/shared";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";

/**
 * Verifica la migrazione 0097 (22 ott 2026): ruoli, membri di progetto e
 * conversione degli utenti esistenti, con `users.role` che resta come colonna
 * DERIVATA dal ruolo d'istanza.
 *
 * Strategia (come migration-0095.test): catena FINO alla 0096, dati seminati,
 * poi lo SQL reale della 0097 in una transazione sola. Un secondo database
 * nello stesso container copre l'istanza senza progetti.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig97-"));
  await cp(DRIZZLE_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const dropped = journal.entries.filter((e) => e.idx >= stopBeforeIdx);
  journal.entries = journal.entries.filter((e) => e.idx < stopBeforeIdx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await Promise.all(dropped.map((e) => rm(path.join(dir, `${e.tag}.sql`), { force: true })));
  return dir;
}

async function applyMigration0097(db: Db): Promise<void> {
  await applyStatements(
    db,
    await readFile(path.join(DRIZZLE_DIR, "0097_roles_and_members.sql"), "utf8"),
  );
}

async function applyStatements(db: Db, raw: string): Promise<void> {
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.transaction(async (tx) => {
    for (const stmt of statements) {
      await tx.execute(sql.raw(stmt));
    }
  });
}

/**
 * Solo gli `UPDATE "roles"` di una migrazione che fa anche altro (le tabelle
 * che crea non esistono nella catena di questo test): i permessi nuovi dati ai
 * preset, e ai ruoli che li contenevano.
 */
async function applyRoleUpdates(db: Db, file: string): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, file), "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.includes('UPDATE "roles"'));
  if (statements.length === 0) throw new Error(`${file}: nessun UPDATE "roles"`);
  await db.transaction(async (tx) => {
    for (const stmt of statements) await tx.execute(sql.raw(stmt));
  });
}

async function insertUser(db: Db, email: string, role: "admin" | "member"): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "users" ("email", "password_hash", "role")
    values (${email}, 'h', ${role}) returning "id"
  `);
  return rows[0]!.id;
}

async function insertProject(db: Db, name: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "projects" ("name", "slug", "ingestion_key")
    values (${name}, ${"p-" + crypto.randomUUID()}, ${crypto.randomUUID()}) returning "id"
  `);
  return rows[0]!.id;
}

async function roleIdByPreset(db: Db, presetKey: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    select "id" from "roles" where "preset_key" = ${presetKey}
  `);
  return rows[0]!.id;
}

async function userRow(db: Db, id: string): Promise<{ role: string; roleName: string }> {
  const rows = await db.execute<{ role: string; role_name: string }>(sql`
    select u."role"::text as "role", r."name" as "role_name"
    from "users" u join "roles" r on r."id" = u."instance_role_id"
    where u."id" = ${id}
  `);
  return { role: rows[0]!.role, roleName: rows[0]!.role_name };
}

async function membershipsOf(db: Db, userId: string): Promise<{ projectId: string; role: string }[]> {
  const rows = await db.execute<{ project_id: string; name: string }>(sql`
    select pm."project_id", r."name"
    from "project_members" pm join "roles" r on r."id" = pm."role_id"
    where pm."user_id" = ${userId}
    order by pm."project_id"
  `);
  return rows.map((r) => ({ projectId: r.project_id, role: r.name }));
}

async function dbError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; cause?: { message: string } };
    return err.cause?.message ?? err.message;
  }
  throw new Error("la query doveva fallire");
}

describe("migrazione 0097: ruoli, membri di progetto e conversione", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let emptyClient: { end: () => Promise<unknown> } | undefined;

  const admins: string[] = [];
  const members: string[] = [];
  const projectIds: string[] = [];
  let inviteToken: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(97) });

    admins.push(await insertUser(db, "a1@x.it", "admin"), await insertUser(db, "a2@x.it", "admin"));
    members.push(await insertUser(db, "m1@x.it", "member"), await insertUser(db, "m2@x.it", "member"));
    for (const name of ["P1", "P2", "P3"]) projectIds.push(await insertProject(db, name));
    projectIds.sort();
    inviteToken = crypto.randomUUID();
    await db.execute(sql`
      insert into "invites" ("token", "email", "expires_at")
      values (${inviteToken}, 'inv@x.it', now() + interval '7 days')
    `);

    await applyMigration0097(db);
  }, 180_000);

  afterAll(async () => {
    await emptyClient?.end();
    await client?.end();
    await container?.stop();
  });

  it("(a) gli admin diventano Admin, i member User e membri di tutti i progetti con Legacy Member", async () => {
    for (const id of admins) expect((await userRow(db, id)).roleName).toBe("Admin");
    for (const id of members) {
      expect((await userRow(db, id)).roleName).toBe("User");
      expect(await membershipsOf(db, id)).toEqual(
        projectIds.map((projectId) => ({ projectId, role: "Legacy Member" })),
      );
    }
  });

  it("(a) un progetto creato DOPO la migrazione non aggiunge membri: la conversione è una tantum", async () => {
    const later = await insertProject(db, "P4");
    for (const id of members) {
      expect((await membershipsOf(db, id)).map((m) => m.projectId)).not.toContain(later);
    }
  });

  it("(b) gli admin non hanno righe in project_members", async () => {
    for (const id of admins) expect(await membershipsOf(db, id)).toEqual([]);
  });

  it("(c) un invito pendente ha instance_role_id null", async () => {
    const rows = await db.execute<{ instance_role_id: string | null }>(sql`
      select "instance_role_id" from "invites" where "token" = ${inviteToken}
    `);
    expect(rows[0]!.instance_role_id).toBeNull();
  });

  it("(d) users.role è invariato dopo la migrazione", async () => {
    for (const id of admins) expect((await userRow(db, id)).role).toBe("admin");
    for (const id of members) expect((await userRow(db, id)).role).toBe("member");
  });

  it("(e) portare un member ad Admin porta role a admin", async () => {
    const id = await insertUser(db, "promo@x.it", "member");
    const adminRole = await roleIdByPreset(db, "admin");
    await db.execute(sql`update "users" set "instance_role_id" = ${adminRole} where "id" = ${id}`);
    expect(await userRow(db, id)).toEqual({ role: "admin", roleName: "Admin" });
  });

  it("(f) togliere instance.full_admin dal ruolo Admin riporta role a member per i suoi utenti (e rimetterlo lo riporta ad admin)", async () => {
    const adminRole = await roleIdByPreset(db, "admin");
    await db.transaction(async (tx) => {
      await tx.execute(sql`update "roles" set "permissions" = '{}' where "id" = ${adminRole}`);
      for (const id of admins) expect((await userRow(tx as unknown as Db, id)).role).toBe("member");
      await tx.execute(
        sql`update "roles" set "permissions" = '{instance.full_admin}' where "id" = ${adminRole}`,
      );
      for (const id of admins) expect((await userRow(tx as unknown as Db, id)).role).toBe("admin");
    });
  });

  it("(g) un ruolo di progetto non può essere il ruolo d'istanza", async () => {
    const legacy = await roleIdByPreset(db, "legacy_member");
    expect(
      await dbError(
        db.execute(sql`update "users" set "instance_role_id" = ${legacy} where "id" = ${members[0]!}`),
      ),
    ).toMatch(/non è un ruolo d'istanza/);
    expect((await userRow(db, members[0]!)).roleName).toBe("User");
  });

  it("(g) un ruolo d'istanza non può essere il ruolo di un membro di progetto", async () => {
    const userRole = await roleIdByPreset(db, "user");
    expect(
      await dbError(
        db.execute(sql`
          insert into "project_members" ("project_id", "user_id", "role_id")
          values (${projectIds[0]!}, ${admins[0]!}, ${userRole})
        `),
      ),
    ).toMatch(/non è un ruolo di progetto/);
  });

  it("(h) i preset hanno i nomi inglesi e le stesse chiavi di PRESET_ROLES", async () => {
    // Il catalogo di oggi comprende i permessi delle credenziali, che nel
    // preset `project_lead` entrano con la 0103 (non con la 0097): la parità
    // vale sulla catena 0097 + 0103 + 0114.
    await applyStatements(
      db,
      await readFile(path.join(DRIZZLE_DIR, "0103_credentials_permissions.sql"), "utf8"),
    );
    // E `planning.others` (fetta 2) nel solo `project_lead`, con la 0114.
    await applyStatements(
      db,
      await readFile(path.join(DRIZZLE_DIR, "0114_planning_permission.sql"), "utf8"),
    );
    // E `claude.public.view` nel preset User, con la 0133 (chat, fetta 5).
    await applyRoleUpdates(db, "0133_claude_public_conversations.sql");
    // E i permessi della Chat (area 4) a Lead, Developer e User, con la 0135.
    await applyRoleUpdates(db, "0135_chat_channels.sql");
    // E i permessi del Drive (area 5) a Lead, Developer, Contributor e Legacy Member, con la 0143.
    await applyRoleUpdates(db, "0143_drive_files.sql");
    // E `automations.manage` al solo Project Lead, con la 0169 (area 7).
    await applyRoleUpdates(db, "0169_automations.sql");
    // E `support.reply` a Lead, Developer e Legacy Member, con la 0179 (area 8, F3).
    await applyRoleUpdates(db, "0179_support.sql");
    const rows = await db.execute<{
      preset_key: string;
      name: string;
      scope: string;
      permissions: string[];
    }>(sql`
      select "preset_key", "name", "scope", "permissions"
      from "roles" where "preset_key" is not null order by "preset_key"
    `);
    const actual = rows.map((r) => ({
      key: r.preset_key,
      name: r.name,
      scope: r.scope,
      permissions: [...r.permissions].sort(),
    }));
    const expected = [...PRESET_ROLES]
      .map((r) => ({ key: r.key, name: r.name, scope: r.scope, permissions: [...r.permissions].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(actual).toEqual(expected);
  });

  it("un permesso nuovo dato a un preset va anche ai ruoli che lo contenevano (0133, decisione del maintainer)", async () => {
    const OLD_USER = ["monitor.view", "users.view_all", "git_accounts.view", "mail_admission.view"];
    const [above] = await db.execute<{ id: string }>(sql`
      insert into "roles" ("name", "scope", "permissions")
      values ('Gestore persone 0133', 'instance', ${sql.raw(`ARRAY[${[...OLD_USER, "users.manage"].map((p) => `'${p}'`).join(",")}]::text[]`)})
      returning "id"`);
    const [partial] = await db.execute<{ id: string }>(sql`
      insert into "roles" ("name", "scope", "permissions")
      values ('Solo monitor 0133', 'instance', ARRAY['monitor.view']::text[])
      returning "id"`);
    await applyRoleUpdates(db, "0133_claude_public_conversations.sql");
    const permsOf = async (id: string) =>
      (await db.execute<{ permissions: string[] }>(sql`select "permissions" from "roles" where "id" = ${id}`))[0]!.permissions;
    expect(await permsOf(above!.id)).toContain("claude.public.view");
    expect(await permsOf(partial!.id)).not.toContain("claude.public.view");
    // Idempotente: una seconda volta non duplica.
    await applyRoleUpdates(db, "0133_claude_public_conversations.sql");
    expect((await permsOf(above!.id)).filter((p) => p === "claude.public.view")).toHaveLength(1);
  });

  it("i permessi del Drive vanno anche ai ruoli che contenevano Lead, Developer, Contributor, Legacy Member (0143)", async () => {
    const presetPerms = async (key: string) =>
      (await db.execute<{ permissions: string[] }>(sql`select "permissions" from "roles" where "preset_key" = ${key}`))[0]!.permissions;
    const insertRole = async (name: string, perms: string[]) => {
      const [row] = await db.execute<{ id: string }>(sql`
        insert into "roles" ("name", "scope", "permissions")
        values (${name}, 'project', ${sql.raw(`ARRAY[${perms.map((p) => `'${p}'`).join(",") || "''"}]::text[]`)})
        returning "id"`);
      return row!.id;
    };
    const permsOf = async (id: string) =>
      (await db.execute<{ permissions: string[] }>(sql`select "permissions" from "roles" where "id" = ${id}`))[0]!.permissions;
    // Si riparte da «prima» della 0143: senza i drive.*.
    await db.execute(sql`update "roles" set "permissions" = array_remove(array_remove(array_remove("permissions", 'drive.upload'), 'drive.manage'), 'drive.history')`);
    const lead = (await presetPerms("project_lead")).filter((p) => p !== "");
    const contributor = (await presetPerms("contributor")).filter((p) => p !== "");
    const aboveLead = await insertRole("Sopra Lead 0143", [...lead]);
    const aboveContributor = await insertRole("Sopra Contributor 0143", [...contributor, "docs.edit"]);
    const partial = await insertRole("Parziale 0143", ["docs.view"]);
    await applyRoleUpdates(db, "0143_drive_files.sql");
    expect(await permsOf(aboveLead)).toEqual(expect.arrayContaining(["drive.upload", "drive.manage", "drive.history"]));
    expect(await permsOf(aboveContributor)).toContain("drive.upload");
    expect(await permsOf(aboveContributor)).not.toContain("drive.manage");
    expect(await permsOf(partial)).not.toContain("drive.upload");
    // I preset stessi, e il Viewer niente.
    expect(await presetPerms("viewer")).not.toContain("drive.upload");
    expect(await presetPerms("legacy_member")).toContain("drive.upload");
    await applyRoleUpdates(db, "0143_drive_files.sql");
    expect((await permsOf(aboveLead)).filter((p) => p === "drive.upload")).toHaveLength(1);
  });

  it("i permessi della Chat vanno anche ai ruoli che contenevano Lead, Developer, User (0135)", async () => {
    const presetPerms = async (key: string) =>
      (await db.execute<{ permissions: string[] }>(sql`select "permissions" from "roles" where "preset_key" = ${key}`))[0]!.permissions;
    const insertRole = async (name: string, scope: string, perms: string[]) => {
      const [row] = await db.execute<{ id: string }>(sql`
        insert into "roles" ("name", "scope", "permissions")
        values (${name}, ${scope}, ${sql.raw(`ARRAY[${perms.map((p) => `'${p}'`).join(",") || "''"}]::text[]`)})
        returning "id"`);
      return row!.id;
    };
    // Applicate già dal test dei preset: si tolgono i chat.* per ripartire da «prima».
    await db.execute(sql`update "roles" set "permissions" = array_remove(array_remove(array_remove("permissions", 'chat.channels.create'), 'chat.channels.manage'), 'chat.general.create')`);
    const lead = (await presetPerms("project_lead")).filter((p) => p !== "");
    const dev = (await presetPerms("developer")).filter((p) => p !== "");
    const user = (await presetPerms("user")).filter((p) => p !== "");
    const aboveLead = await insertRole("Sopra Lead 0135", "project", [...lead]);
    const aboveDev = await insertRole("Sopra Developer 0135", "project", [...dev, "planning.others"]);
    const partial = await insertRole("Parziale 0135", "project", ["docs.view"]);
    const aboveUser = await insertRole("Sopra User 0135", "instance", [...user, "users.manage"]);
    await applyRoleUpdates(db, "0135_chat_channels.sql");
    const permsOf = async (id: string) =>
      (await db.execute<{ permissions: string[] }>(sql`select "permissions" from "roles" where "id" = ${id}`))[0]!.permissions;
    expect(await permsOf(aboveLead)).toEqual(expect.arrayContaining(["chat.channels.create", "chat.channels.manage"]));
    expect(await permsOf(aboveDev)).toContain("chat.channels.create");
    expect(await permsOf(aboveDev)).not.toContain("chat.channels.manage");
    expect(await permsOf(partial)).not.toContain("chat.channels.create");
    expect(await permsOf(aboveUser)).toContain("chat.general.create");
    expect(await presetPerms("project_lead")).toEqual(expect.arrayContaining(["chat.channels.create", "chat.channels.manage"]));
    expect(await presetPerms("developer")).not.toContain("chat.channels.manage");
  });

  it("`support.reply` va anche ai ruoli che contenevano Lead, Developer o Legacy Member (0179)", async () => {
    const presetPerms = async (key: string) =>
      (await db.execute<{ permissions: string[] }>(sql`select "permissions" from "roles" where "preset_key" = ${key}`))[0]!.permissions;
    const insertRole = async (name: string, perms: string[]) => {
      const [row] = await db.execute<{ id: string }>(sql`
        insert into "roles" ("name", "scope", "permissions")
        values (${name}, 'project', ${sql.raw(`ARRAY[${perms.map((p) => `'${p}'`).join(",") || "''"}]::text[]`)})
        returning "id"`);
      return row!.id;
    };
    const permsOf = async (id: string) =>
      (await db.execute<{ permissions: string[] }>(sql`select "permissions" from "roles" where "id" = ${id}`))[0]!.permissions;
    // Si riparte da «prima» della 0179: senza `support.reply`.
    await db.execute(sql`update "roles" set "permissions" = array_remove("permissions", 'support.reply')`);
    const dev = (await presetPerms("developer")).filter((p) => p !== "");
    const legacy = (await presetPerms("legacy_member")).filter((p) => p !== "");
    const contributor = (await presetPerms("contributor")).filter((p) => p !== "");
    const aboveDev = await insertRole("Sopra Developer 0179", [...dev, "planning.others"]);
    const aboveLegacy = await insertRole("Sopra Legacy 0179", [...legacy]);
    const aboveContributor = await insertRole("Sopra Contributor 0179", [...contributor, "docs.edit"]);
    await applyRoleUpdates(db, "0179_support.sql");
    expect(await permsOf(aboveDev)).toContain("support.reply");
    expect(await permsOf(aboveLegacy)).toContain("support.reply");
    expect(await permsOf(aboveContributor)).not.toContain("support.reply");
    for (const key of ["project_lead", "developer", "legacy_member"]) expect(await presetPerms(key), key).toContain("support.reply");
    for (const key of ["contributor", "viewer"]) expect(await presetPerms(key), key).not.toContain("support.reply");
    // Idempotente: una seconda volta non lo duplica.
    await applyRoleUpdates(db, "0179_support.sql");
    expect((await permsOf(aboveDev)).filter((p) => p === "support.reply")).toHaveLength(1);
  });

  it("i nomi dei ruoli sono unici per tipo, senza distinguere maiuscole", async () => {
    expect(
      await dbError(db.execute(sql`insert into "roles" ("name", "scope") values ('admin', 'instance')`)),
    ).toMatch(/roles_scope_name_idx/);
    await db.execute(sql`insert into "roles" ("name", "scope") values ('admin', 'project')`);
  });

  it("il tipo di un ruolo non si cambia", async () => {
    const userRole = await roleIdByPreset(db, "user");
    expect(
      await dbError(db.execute(sql`update "roles" set "scope" = 'project' where "id" = ${userRole}`)),
    ).toMatch(/il tipo di un ruolo non si cambia/);
  });

  it("compatibilità: un utente inserito col solo role (scrittore vecchio) riceve il preset corrispondente", async () => {
    const a = await insertUser(db, "legacy-a@x.it", "admin");
    const m = await insertUser(db, "legacy-m@x.it", "member");
    expect(await userRow(db, a)).toEqual({ role: "admin", roleName: "Admin" });
    expect(await userRow(db, m)).toEqual({ role: "member", roleName: "User" });
    expect(await membershipsOf(db, m)).toEqual([]);
  });

  it("compatibilità: cambiare il solo role (scrittore vecchio) sposta il ruolo d'istanza sul preset", async () => {
    const id = await insertUser(db, "legacy-up@x.it", "member");
    await db.execute(sql`update "users" set "role" = 'admin' where "id" = ${id}`);
    expect(await userRow(db, id)).toEqual({ role: "admin", roleName: "Admin" });
    await db.execute(sql`update "users" set "role" = 'member' where "id" = ${id}`);
    expect(await userRow(db, id)).toEqual({ role: "member", roleName: "User" });
  });

  it("compatibilità: senza il preset, lo scrittore vecchio riceve un errore che lo dice", async () => {
    // Il preset `user` «sparisce» (preset_key tolta) dentro una transazione
    // annullata: lo stato condiviso dagli altri test resta intatto.
    const message = await dbError(
      db.transaction(async (tx) => {
        await tx.execute(sql`update "roles" set "preset_key" = null where "preset_key" = 'user'`);
        await tx.execute(sql`
          insert into "users" ("email", "password_hash", "role")
          values ('no-preset@x.it', 'h', 'member')
        `);
      }),
    );
    expect(message).toMatch(/manca il ruolo preset user/);
  });

  it("un ruolo assegnato non si elimina (RESTRICT); eliminare un progetto toglie i suoi membri", async () => {
    const legacy = await roleIdByPreset(db, "legacy_member");
    expect(await dbError(db.execute(sql`delete from "roles" where "id" = ${legacy}`))).toMatch(
      /project_members_role_id_roles_id_fk/,
    );
    const victim = projectIds[2]!;
    await db.execute(sql`delete from "projects" where "id" = ${victim}`);
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as "n" from "project_members" where "project_id" = ${victim}
    `);
    expect(rows[0]!.n).toBe(0);
  });

  it("(a) senza progetti: un member diventa User con zero appartenenze", async () => {
    await db.execute(sql.raw(`create database "empty_instance"`));
    const uri = new URL(container.getConnectionUri());
    uri.pathname = "/empty_instance";
    const handle = createDb(uri.toString());
    emptyClient = handle.client;
    const emptyDb = handle.db;
    await migrate(emptyDb, { migrationsFolder: await migrationsFolderUpTo(97) });
    const m = await insertUser(emptyDb, "solo@x.it", "member");
    await applyMigration0097(emptyDb);
    expect(await userRow(emptyDb, m)).toEqual({ role: "member", roleName: "User" });
    expect(await membershipsOf(emptyDb, m)).toEqual([]);
  }, 120_000);
});
