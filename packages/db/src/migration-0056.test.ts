import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";

/**
 * Verifica la migrazione 0056 (personal access token): applica l'INTERA catena
 * di migrazioni su un DB pulito e asserisce che la tabella
 * `personal_access_tokens` esista con tutte le sue colonne, il vincolo unique su
 * `token_hash` e la FK cascade verso `users`.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

describe("migrazione 0056: personal_access_tokens", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    await migrate(db, { migrationsFolder: DRIZZLE_DIR });
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("crea la tabella personal_access_tokens con tutte le colonne", async () => {
    const rows = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name = 'personal_access_tokens' order by column_name
    `);
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "user_id",
        "name",
        "token_hash",
        "last_used_at",
        "expires_at",
        "created_at",
      ]),
    );
  });

  it("token_hash è unique", async () => {
    // Serve un utente esistente per la FK.
    const userRows = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values (${"pat-" + crypto.randomUUID() + "@example.com"}, 'x', 'member')
      returning "id"
    `);
    const userId = userRows[0]!.id;
    const hash = crypto.randomUUID();

    await db.execute(sql`
      insert into "personal_access_tokens" ("user_id", "name", "token_hash")
      values (${userId}, 'tok', ${hash})
    `);

    await expect(
      db.execute(sql`
        insert into "personal_access_tokens" ("user_id", "name", "token_hash")
        values (${userId}, 'dup', ${hash})
      `),
    ).rejects.toThrow();
  });

  it("la FK verso users è ON DELETE CASCADE", async () => {
    const userRows = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values (${"pat-" + crypto.randomUUID() + "@example.com"}, 'x', 'member')
      returning "id"
    `);
    const userId = userRows[0]!.id;

    await db.execute(sql`
      insert into "personal_access_tokens" ("user_id", "name", "token_hash")
      values (${userId}, 'tok', ${crypto.randomUUID()})
    `);

    await db.execute(sql`delete from "users" where "id" = ${userId}`);

    const remaining = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from "personal_access_tokens"
      where "user_id" = ${userId}
    `);
    expect(remaining[0]!.count).toBe("0");
  });
});
