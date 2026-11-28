import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";

/**
 * Migrazione 0246 (R3 del ritiro del web vecchio, la pulizia dei dati;
 * `docs/plans/2026-11-28-ritiro-web-vecchio-piano.md` §1.1 e §3): via le
 * consegne Slack e `saved_views` (le colonne Slack restano, per il rollback a
 * R2: le toglie la 0247); il token degli inviti
 * diventa `sha256` esadecimale, sul posto, insieme alle due tabelle che lo
 * referenziano.
 *
 * Catena fino alla 0245 con dati «di prima» (scritti in SQL: lo schema
 * TypeScript quelle colonne non le ha più), poi la 0246 sullo stesso DB.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");
const IDX = 246;

type Journal = { entries: { idx: number; when: number; tag: string }[] };

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig246-"));
  await cp(DRIZZLE_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  const dropped = journal.entries.filter((e) => e.idx >= stopBeforeIdx);
  journal.entries = journal.entries.filter((e) => e.idx < stopBeforeIdx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await Promise.all(dropped.map((e) => rm(path.join(dir, `${e.tag}.sql`), { force: true })));
  return dir;
}

/** L'hash del token, come lo calcola il server (`hashInviteToken`). */
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("migrazione 0246: via le consegne Slack e saved_views, il token degli inviti come hash", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  const tokenA = `tok-${randomUUID()}`;
  const tokenB = `tok-${randomUUID()}`;
  let userId: string;
  let projectId: string;
  let workspaceId: string;

  const columns = async (table: string) =>
    (await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = ${table}`)).map((r) => r.column_name);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17").withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" }).start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(IDX) });

    // Un utente con Slack collegato, un invito Slack con progetto e workspace,
    // un secondo invito nudo, una vista salvata, consegne Slack e non.
    userId = (
      await db.execute<{ id: string }>(sql`
        insert into "users" ("email", "password_hash", "slack_user_id", "slack_avatar_url", "notify_slack_dm")
        values (${`u-${randomUUID()}@example.com`}, 'x', 'U123', 'https://avatars.slack-edge.com/a.png', true) returning "id"`)
    )[0]!.id;
    projectId = (
      await db.execute<{ id: string }>(sql`insert into "projects" ("name", "slug", "ingestion_key") values ('Alfa', 'alfa', ${randomUUID()}) returning "id"`)
    )[0]!.id;
    workspaceId = (
      await db.execute<{ id: string }>(sql`insert into "workspaces" ("name", "color_token") values ('Vendite', '--dept-1') returning "id"`)
    )[0]!.id;
    const projectRole = (await db.execute<{ id: string }>(sql`select "id" from "roles" where "scope" = 'project' limit 1`))[0]!.id;
    await db.execute(sql`
      insert into "invites" ("token", "email", "expires_at", "slack_user_id", "slack_avatar_url")
      values (${tokenA}, 'a@example.com', now() + interval '7 days', 'U999', 'https://avatars.slack-edge.com/b.png'),
             (${tokenB}, 'b@example.com', now() + interval '7 days', null, null)`);
    await db.execute(sql`insert into "invite_projects" ("invite_token", "project_id", "role_id") values (${tokenA}, ${projectId}, ${projectRole})`);
    await db.execute(sql`insert into "invite_workspaces" ("invite_token", "workspace_id", "role_id") values (${tokenA}, ${workspaceId}, ${projectRole})`);
    await db.execute(sql`insert into "saved_views" ("owner_id", "name", "filters") values (${userId}, 'Le mie', '{}'::jsonb)`);
    await db.execute(sql`update "instance_settings" set "slack_bot_token_encrypted" = 'blob', "slack_signing_secret_encrypted" = 'blob' where "id" = 1`);
    const notificationId = (
      await db.execute<{ id: string }>(sql`insert into "notifications" ("user_id", "kind", "event") values (${userId}, 'job.failed', '{"kind":"job.failed"}'::jsonb) returning "id"`)
    )[0]!.id;
    await db.execute(sql`
      insert into "notification_deliveries" ("notification_id", "channel", "status", "external_ref")
      values (${notificationId}, 'slack_dm', 'skipped', '1700000000.000100'), (${notificationId}, 'slack_update', 'pending', null), (${notificationId}, 'push', 'pending', null)`);

    // Fino alla 0246 compresa, non oltre: la 0247 (R3b) toglie le colonne che
    // qui devono ancora esserci.
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(IDX + 1) });
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("le colonne Slack ed `external_ref` RESTANO: il codice di R2 le nomina, e il rollback fino a R2 regge (le toglie la 0247)", async () => {
    const users = await columns("users");
    for (const c of ["slack_user_id", "slack_avatar_url", "notify_slack_dm"]) expect(users).toContain(c);
    const invites = await columns("invites");
    for (const c of ["slack_user_id", "slack_avatar_url"]) expect(invites).toContain(c);
    const instance = await columns("instance_settings");
    for (const c of ["slack_signing_secret_encrypted", "slack_bot_token_encrypted"]) expect(instance).toContain(c);
    expect(await columns("notification_deliveries")).toContain("external_ref");
    // L'utente resta, con i suoi dati.
    expect(await db.execute(sql`select "slack_user_id" from "users" where "id" = ${userId}`)).toEqual([{ slack_user_id: "U123" }]);
  });

  it("via le consegne Slack; le altre restano", async () => {
    const rows = await db.execute<{ channel: string }>(sql`select "channel"::text as channel from "notification_deliveries"`);
    expect(rows.map((r) => r.channel)).toEqual(["push"]);
  });

  it("via la tabella saved_views", async () => {
    expect(await db.execute(sql`select 1 from information_schema.tables where table_name = 'saved_views'`)).toHaveLength(0);
  });

  it("il token degli inviti è il suo sha256, nel padre e nei figli", async () => {
    const tokens = await db.execute<{ token: string; email: string }>(sql`select "token", "email" from "invites" order by "email"`);
    expect(tokens).toEqual([
      { token: sha256(tokenA), email: "a@example.com" },
      { token: sha256(tokenB), email: "b@example.com" },
    ]);
    expect(await db.execute(sql`select "invite_token" from "invite_projects"`)).toEqual([{ invite_token: sha256(tokenA) }]);
    expect(await db.execute(sql`select "invite_token" from "invite_workspaces"`)).toEqual([{ invite_token: sha256(tokenA) }]);
  });

  it("le chiavi esterne verso l'invito ci sono ancora, col loro cascade", async () => {
    const fks = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint where contype = 'f' and confrelid = 'invites'::regclass order by conname`);
    expect(fks.map((r) => r.conname)).toEqual(["invite_projects_invite_token_invites_token_fk", "invite_workspaces_invite_token_fkey"]);
    // Un figlio che punta a un token che non esiste è rifiutato.
    await expect(
      db.execute(sql`insert into "invite_projects" ("invite_token", "project_id", "role_id") select 'nessuno', ${projectId}, "role_id" from "invite_projects" limit 1`),
    ).rejects.toThrow();
    // Cancellare l'invito porta via i figli.
    await db.execute(sql`delete from "invites" where "token" = ${sha256(tokenA)}`);
    expect(await db.execute(sql`select 1 from "invite_projects"`)).toHaveLength(0);
    expect(await db.execute(sql`select 1 from "invite_workspaces"`)).toHaveLength(0);
  });
});
