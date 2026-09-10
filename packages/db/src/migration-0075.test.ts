import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
 * Verifica la migrazione 0075 (fase 9 — stato dei partecipanti e link
 * all'evento, design §6) sul suo caso critico, il BACKFILL: non è cosmetico.
 * In produzione ci sono 1553 righe in `calendar_events` con `attendees` come
 * `text[]` di sole email.
 *
 * Strategia (come migration-0074.test): si applica la catena FINO alla 0074
 * (calendar_events ancora con `attendees text[]`), si seminano righe
 * realistiche — con partecipanti, senza partecipanti, con `attendees = '{}'`
 * (il default precedente, non NULL) — e SOLO DOPO si esegue lo SQL reale
 * della 0075, asserendo l'esito.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig75-"));
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

async function applyMigration0075(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0075_calendar_attendee_status.sql"), "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Come il migratore reale: tutti gli statement in UNA transazione.
  await db.transaction(async (tx) => {
    for (const stmt of statements) {
      await tx.execute(sql.raw(stmt));
    }
  });
}

async function seedUser(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "users" ("email", "password_hash", "role")
    values (${"admin-" + crypto.randomUUID() + "@example.test"}, 'hash', 'admin')
    returning "id"
  `);
  return rows[0]!.id;
}

async function seedWorkspace(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "google_workspaces" ("name", "domains", "client_id", "client_secret_encrypted")
    values ('Acme', '{acme.test}', 'client-id', 'enc')
    returning "id"
  `);
  return rows[0]!.id;
}

async function seedAccount(db: Db, userId: string, workspaceId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "google_accounts" ("user_id", "workspace_id", "email", "google_sub", "refresh_token_encrypted")
    values (${userId}, ${workspaceId}, ${"user-" + crypto.randomUUID() + "@acme.test"}, ${crypto.randomUUID()}, 'enc')
    returning "id"
  `);
  return rows[0]!.id;
}

/** Riga di `calendar_events` con l'`attendees` VECCHIO (`text[]`), pre-0075. */
async function seedEvent(
  db: Db,
  accountId: string,
  googleEventId: string,
  attendees: string[],
): Promise<string> {
  // `postgres` interpola un array JS come ROW(...), non come array literal:
  // serve il literal Postgres `{"a","b"}` esplicito, con un cast.
  const attendeesLiteral = `{${attendees.map((a) => JSON.stringify(a)).join(",")}}`;
  const rows = await db.execute<{ id: string }>(sql`
    insert into "calendar_events" ("account_id", "google_event_id", "starts_at", "attendees", "fingerprint")
    values (${accountId}, ${googleEventId}, now(), ${attendeesLiteral}::text[], ${"2026-09-10 " + googleEventId})
    returning "id"
  `);
  return rows[0]!.id;
}

describe("migrazione 0075: stato dei partecipanti e link all'evento (fase 9)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  let accountId: string;
  let withAttendeesId: string;
  let emptyAttendeesId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    // 1) Catena fino alla 0074 (calendar_events.attendees ancora text[]).
    const folder = await migrationsFolderUpTo(75);
    await migrate(db, { migrationsFolder: folder });

    // 2) Semina lo stato pre-0075.
    const userId = await seedUser(db);
    const workspaceId = await seedWorkspace(db);
    accountId = await seedAccount(db, userId, workspaceId);

    // Caso reale: due partecipanti, nessuno stato conosciuto (non esisteva).
    withAttendeesId = await seedEvent(db, accountId, "e-con-partecipanti", [
      "ada@acme.test",
      "bob@acme.test",
    ]);
    // Caso reale altrettanto comune: `attendees = '{}'` (il DEFAULT
    // precedente, MAI NULL — la colonna era `text[] NOT NULL DEFAULT '{}'`).
    emptyAttendeesId = await seedEvent(db, accountId, "e-senza-partecipanti", []);

    // 3) Applica la 0075 sopra i dati seminati.
    await applyMigration0075(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("ogni email diventa un partecipante con responseStatus NULL (non ricostruibile)", async () => {
    const rows = await db.execute<{ attendees: unknown }>(sql`
      select "attendees" from "calendar_events" where "id" = ${withAttendeesId}
    `);
    expect(rows[0]!.attendees).toEqual([
      { email: "ada@acme.test", responseStatus: null },
      { email: "bob@acme.test", responseStatus: null },
    ]);
  });

  it("una riga con attendees = '{}' diventa '[]', non NULL", async () => {
    const rows = await db.execute<{ attendees: unknown }>(sql`
      select "attendees" from "calendar_events" where "id" = ${emptyAttendeesId}
    `);
    expect(rows[0]!.attendees).toEqual([]);
  });

  it("nessuna riga resta con attendees NULL (NOT NULL applicato con successo)", async () => {
    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from "calendar_events" where "attendees" is null
    `);
    expect(rows[0]!.count).toBe("0");
  });

  it("html_link esiste ed è NULL per le righe storiche (nessun backfill possibile)", async () => {
    const rows = await db.execute<{ html_link: string | null }>(sql`
      select "html_link" from "calendar_events" where "id" = ${withAttendeesId}
    `);
    expect(rows[0]!.html_link).toBeNull();
  });

  it("un evento nuovo può scrivere il vero responseStatus", async () => {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "calendar_events" ("account_id", "google_event_id", "starts_at", "attendees", "fingerprint", "html_link")
      values (
        ${accountId}, 'e-nuovo', now(),
        ${JSON.stringify([{ email: "cliente@cliente.test", responseStatus: "accepted" }])}::jsonb,
        '2026-09-10 e-nuovo',
        'https://calendar.google.test/e-nuovo'
      )
      returning "id"
    `);
    const [row] = await db.execute<{ attendees: unknown; html_link: string }>(sql`
      select "attendees", "html_link" from "calendar_events" where "id" = ${rows[0]!.id}
    `);
    expect(row!.attendees).toEqual([{ email: "cliente@cliente.test", responseStatus: "accepted" }]);
    expect(row!.html_link).toBe("https://calendar.google.test/e-nuovo");
  });
});
