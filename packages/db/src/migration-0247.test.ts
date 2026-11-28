import { randomUUID } from "node:crypto";
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
 * Migrazione 0247 (R3b del ritiro del web vecchio, il passo finale;
 * `docs/plans/2026-11-28-ritiro-web-vecchio-piano.md` §1.1 e §3): via le
 * colonne Slack di utenti, inviti e istanza, `external_ref` delle consegne, e
 * l'enum `delivery_channel` ricreato senza `slack_dm` e `slack_update`.
 *
 * Catena fino alla 0246 con righe vere (consegne `webhook`, `push` e una
 * `slack_dm` rimasta, utenti e inviti con Slack), poi la 0247 sullo stesso DB.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");
const IDX = 247;

type Journal = { entries: { idx: number; when: number; tag: string }[] };

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig247-"));
  await cp(DRIZZLE_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  const dropped = journal.entries.filter((e) => e.idx >= stopBeforeIdx);
  journal.entries = journal.entries.filter((e) => e.idx < stopBeforeIdx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await Promise.all(dropped.map((e) => rm(path.join(dir, `${e.tag}.sql`), { force: true })));
  return dir;
}

describe("migrazione 0247: via le colonne Slack e i canali Slack dell'enum", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let userId: string;
  let notificationId: string;
  let webhookId: string;

  const columns = async (table: string) =>
    (await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = ${table}`)).map((r) => r.column_name);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17").withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" }).start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(IDX) });

    userId = (
      await db.execute<{ id: string }>(sql`
        insert into "users" ("email", "password_hash", "slack_user_id", "slack_avatar_url", "notify_slack_dm")
        values (${`u-${randomUUID()}@example.com`}, 'x', 'U123', 'https://avatars.slack-edge.com/a.png', true) returning "id"`)
    )[0]!.id;
    await db.execute(sql`
      insert into "invites" ("token", "email", "expires_at", "slack_user_id", "slack_avatar_url")
      values (${"a".repeat(64)}, 'a@example.com', now() + interval '7 days', 'U999', 'https://avatars.slack-edge.com/b.png')`);
    await db.execute(sql`update "instance_settings" set "slack_bot_token_encrypted" = 'blob', "slack_signing_secret_encrypted" = 'blob' where "id" = 1`);
    notificationId = (
      await db.execute<{ id: string }>(sql`insert into "notifications" ("user_id", "kind", "event") values (${userId}, 'job.failed', '{"kind":"job.failed"}'::jsonb) returning "id"`)
    )[0]!.id;
    webhookId = (
      await db.execute<{ id: string }>(sql`insert into "notification_deliveries" ("channel", "event", "status") values ('webhook', '{"kind":"job.failed"}'::jsonb, 'sent') returning "id"`)
    )[0]!.id;
    // Una push e una consegna Slack RIMASTA dopo la 0246 (un worker di prima
    // che l'ha scritta fra le due migrazioni): la 0247 la deve togliere, o il
    // cambio di tipo della colonna fallirebbe.
    await db.execute(sql`
      insert into "notification_deliveries" ("notification_id", "channel", "status", "external_ref")
      values (${notificationId}, 'push', 'pending', null), (${notificationId}, 'slack_dm', 'sent', 'D1|1700000000.000100')`);

    await migrate(db, { migrationsFolder: DRIZZLE_DIR });
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("via le colonne Slack di utenti, inviti e istanza; i dati delle righe restano", async () => {
    const users = await columns("users");
    for (const c of ["slack_user_id", "slack_avatar_url", "notify_slack_dm"]) expect(users).not.toContain(c);
    expect(users).toContain("notify_push");
    const invites = await columns("invites");
    for (const c of ["slack_user_id", "slack_avatar_url"]) expect(invites).not.toContain(c);
    const instance = await columns("instance_settings");
    for (const c of ["slack_signing_secret_encrypted", "slack_bot_token_encrypted"]) expect(instance).not.toContain(c);
    expect(await db.execute(sql`select 1 from "users" where "id" = ${userId}`)).toHaveLength(1);
    expect(await db.execute(sql`select "email" from "invites"`)).toEqual([{ email: "a@example.com" }]);
  });

  it("via `external_ref`, e la consegna Slack rimasta; webhook e push restano con lo stesso id", async () => {
    expect(await columns("notification_deliveries")).not.toContain("external_ref");
    const rows = await db.execute<{ id: string; channel: string }>(sql`select "id", "channel"::text as channel from "notification_deliveries" order by "channel"`);
    expect(rows.map((r) => r.channel)).toEqual(["push", "webhook"]);
    expect(rows.find((r) => r.channel === "webhook")!.id).toBe(webhookId);
  });

  it("l'enum dei canali è ricreato con i soli `webhook` e `push`, col suo nome", async () => {
    const values = await db.execute<{ v: string }>(sql`select unnest(enum_range(null::delivery_channel))::text as v`);
    expect(values.map((r) => r.v)).toEqual(["webhook", "push"]);
    expect(await db.execute(sql`select 1 from pg_type where typname = 'delivery_channel_old'`)).toHaveLength(0);
    const type = await db.execute<{ udt_name: string }>(sql`
      select udt_name from information_schema.columns where table_name = 'notification_deliveries' and column_name = 'channel'`);
    expect(type).toEqual([{ udt_name: "delivery_channel" }]);
    // Un canale Slack non si scrive più.
    await expect(db.execute(sql`insert into "notification_deliveries" ("notification_id", "channel") values (${notificationId}, 'slack_dm')`)).rejects.toThrow();
  });

  it("i due CHECK sulla forma della consegna ci sono ancora, e mordono", async () => {
    const checks = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint where conrelid = 'notification_deliveries'::regclass and contype = 'c' order by conname`);
    expect(checks.map((r) => r.conname)).toEqual(
      expect.arrayContaining(["notification_deliveries_channel_shape_chk", "notification_deliveries_webhook_event_chk"]),
    );
    // Una push senza notifica viola la forma; un webhook senza evento pure.
    await expect(db.execute(sql`insert into "notification_deliveries" ("channel") values ('push')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into "notification_deliveries" ("channel") values ('webhook')`)).rejects.toThrow();
    // Le due forme giuste passano.
    await db.execute(sql`insert into "notification_deliveries" ("channel", "event") values ('webhook', '{"kind":"job.failed"}'::jsonb)`);
    await db.execute(sql`insert into "notification_deliveries" ("notification_id", "channel") values (${notificationId}, 'push')`);
  });
});
