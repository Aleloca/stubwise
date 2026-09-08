import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  emailMessages,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projects,
  users,
} from "./schema.js";
import { expectSqlState, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0070 (fase 6b — proposte email per progetto): la tabella FIGLIA
 * `email_proposals` (una proposta per coppia messaggio/progetto), la colonna
 * `email_messages.scope_project_ids`, e il backfill che popola entrambe sui
 * dati già presenti — perché `email_messages` è una tabella già viva in
 * produzione dalla fase 6 (8 settembre 2026), non una tabella vuota.
 *
 * Due describe distinti:
 * - "schema" verifica i vincoli sulla catena di migrazioni COMPLETA (fino alla
 *   0070 inclusa), con `startTestDb()` come gli altri test di schema.
 * - "migrazione 0070: backfill" applica la catena fino alla 0069, semina righe
 *   `email_messages` COME SAREBBERO OGGI in produzione, e SOLO DOPO esegue lo
 *   SQL reale della 0070 — lo stesso schema di `migration-0041.test.ts` /
 *   `migration-0036.test.ts` — per provare che il backfill tratta
 *   correttamente dati preesistenti, non solo un DB vuoto.
 */
describe("schema: email_proposals (fase 6b)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedProject(): Promise<string> {
    const [project] = await db
      .insert(projects)
      .values({
        name: "Progetto di test",
        slug: `progetto-${randomUUID()}`,
        ingestionKey: randomUUID(),
      })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");
    return project.id;
  }

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email: `u-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();
    return user!.id;
  }

  async function seedAccount(): Promise<string> {
    const [workspace] = await db
      .insert(googleWorkspaces)
      .values({
        name: "Acme",
        domains: ["acme.test"],
        clientId: "123.apps.googleusercontent.com",
        clientSecretEncrypted: "blob-cifrato",
      })
      .returning();
    const [account] = await db
      .insert(googleAccounts)
      .values({
        userId: await seedUser(),
        workspaceId: workspace!.id,
        email: `casella-${randomUUID()}@acme.test`,
        googleSub: randomUUID(),
        refreshTokenEncrypted: "blob-cifrato",
      })
      .returning();
    return account!.id;
  }

  async function seedMessage(projectId?: string): Promise<string> {
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId: await seedAccount(),
        gmailMessageId: randomUUID(),
        threadId: randomUUID(),
        fromAddress: "cliente@acme.test",
        receivedAt: new Date(),
        ...(projectId ? { projectId } : {}),
      })
      .returning();
    return message!.id;
  }

  async function seedProposal(
    values: Partial<typeof emailProposals.$inferInsert> & {
      emailMessageId: string;
      projectId: string;
    },
  ) {
    return db
      .insert(emailProposals)
      .values({ classification: { summary: "x", proposals: [], recommendedIndex: null }, ...values })
      .returning();
  }

  it("nasce in stato `classified`, senza notifica né esito", async () => {
    const projectId = await seedProject();
    const messageId = await seedMessage(projectId);

    const [row] = await seedProposal({ emailMessageId: messageId, projectId });
    expect(row?.status).toBe("classified");
    expect(row?.proposalNotificationId).toBeNull();
    expect(row?.outcome).toBeNull();
    expect(row?.error).toBeNull();
  });

  it("la stessa coppia (messaggio, progetto) non entra due volte (unique)", async () => {
    const projectId = await seedProject();
    const messageId = await seedMessage(projectId);
    await seedProposal({ emailMessageId: messageId, projectId });

    await expectSqlState(seedProposal({ emailMessageId: messageId, projectId }), "23505");
  });

  it("lo stesso messaggio per DUE progetti diversi è ammesso (proposte indipendenti)", async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();
    const messageId = await seedMessage();
    await seedProposal({ emailMessageId: messageId, projectId: projectA });
    await seedProposal({ emailMessageId: messageId, projectId: projectB });

    const rows = await db
      .select()
      .from(emailProposals)
      .where(eq(emailProposals.emailMessageId, messageId));
    expect(rows).toHaveLength(2);
  });

  it("uno stato fuori dalla lista è rifiutato dal CHECK", async () => {
    const projectId = await seedProject();
    const messageId = await seedMessage(projectId);

    await expectSqlState(
      seedProposal({
        emailMessageId: messageId,
        projectId,
        status: "spedita" as "classified",
      }),
      "23514",
    );
  });

  it("cancellare il messaggio si porta via le sue proposte (CASCADE)", async () => {
    const projectId = await seedProject();
    const messageId = await seedMessage(projectId);
    const [row] = await seedProposal({ emailMessageId: messageId, projectId });

    await db.execute(sql`delete from email_messages where id = ${messageId}`);

    const rows = await db.select().from(emailProposals).where(eq(emailProposals.id, row!.id));
    expect(rows).toEqual([]);
  });

  it("cancellare il progetto si porta via le sue proposte (CASCADE)", async () => {
    const projectId = await seedProject();
    const messageId = await seedMessage(projectId);
    const [row] = await seedProposal({ emailMessageId: messageId, projectId });

    await db.execute(sql`delete from projects where id = ${projectId}`);

    const rows = await db.select().from(emailProposals).where(eq(emailProposals.id, row!.id));
    expect(rows).toEqual([]);
  });

  it("cancellare la notifica lascia viva la proposta (SET NULL)", async () => {
    const userId = await seedUser();
    const [notification] = await db
      .insert(notifications)
      .values({ userId, kind: "google.proposal", event: { kind: "google.proposal" } })
      .returning();
    const projectId = await seedProject();
    const messageId = await seedMessage(projectId);
    const [row] = await seedProposal({
      emailMessageId: messageId,
      projectId,
      proposalNotificationId: notification!.id,
    });

    await db.execute(sql`delete from notifications where id = ${notification!.id}`);

    const rows = await db.select().from(emailProposals).where(eq(emailProposals.id, row!.id));
    expect(rows[0]?.proposalNotificationId).toBeNull();
  });

  it("l'indice parziale del claim esiste e indicizza status/proposal_notification_id", async () => {
    // Come il claim analogo di `email_messages` (fase 6) e quello delle
    // proposte in `notifications`: verifichiamo l'indice via catalogo di
    // sistema, non un EXPLAIN — su una tabella di test minuscola il planner
    // può scegliere un seq scan a prescindere dall'indice, quindi l'EXPLAIN
    // non sarebbe un test stabile di "l'indice esiste ed è quello giusto".
    const rows = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where tablename = 'email_proposals' and indexname = 'email_proposals_claim_idx'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("email_message_id");
    expect(rows[0]?.indexdef.toLowerCase()).toContain("where");
    expect(rows[0]?.indexdef).toContain("classified");
    expect(rows[0]?.indexdef.toLowerCase()).toContain("proposal_notification_id");
  });

  it("il claim pesca solo le righe classificate e senza notifica", async () => {
    const projectId = await seedProject();
    const messageId1 = await seedMessage(projectId);
    const messageId2 = await seedMessage(projectId);
    const messageId3 = await seedMessage(projectId);
    const userId = await seedUser();
    const [notification] = await db
      .insert(notifications)
      .values({ userId, kind: "google.proposal", event: { kind: "google.proposal" } })
      .returning();

    await seedProposal({ emailMessageId: messageId1, projectId, status: "classified" });
    await seedProposal({
      emailMessageId: messageId2,
      projectId,
      status: "proposed",
      proposalNotificationId: notification!.id,
    });
    await seedProposal({ emailMessageId: messageId3, projectId, status: "ignored" });

    // Filtrato sui SOLI messaggi di questo test: la tabella non è isolata fra
    // test dello stesso describe (un solo container/beforeAll), quindi righe
    // `classified` senza notifica create da altri test resterebbero altrimenti
    // nell'esito e renderebbero l'asserzione dipendente dall'ordine di run.
    const claimable = await db.execute<{ email_message_id: string }>(sql`
      select email_message_id from email_proposals
      where status = 'classified' and proposal_notification_id is null
        and email_message_id in (${messageId1}, ${messageId2}, ${messageId3})
    `);
    expect(claimable.map((r) => r.email_message_id)).toEqual([messageId1]);
  });
});

/**
 * Backfill della 0070 su dati PREESISTENTI. Strategia identica a
 * `migration-0041.test.ts`: si applica la catena fino alla 0069 (che ha
 * creato `email_messages` senza `scope_project_ids` e senza `email_proposals`),
 * si seminano righe email COME SAREBBERO ARRIVATE dal poller/classificatore
 * della fase 6 già in produzione, e SOLO DOPO si esegue lo SQL reale della
 * 0070, asserendo l'esito sui dati vecchi.
 */
describe("migrazione 0070: backfill di email_proposals e scope_project_ids", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

  /**
   * Letterale array Postgres (`{"a","b"}`) da passare come parametro TESTO e
   * castare lato SQL (`::text[]`/`::uuid[]`). Passare un JS array direttamente
   * come parametro bindato (extended protocol) non lo serializza in un
   * letterale array valido — è la magia della propria tagged template di
   * `postgres.js`, non del binding generico che drizzle usa qui — quindi lo
   * costruiamo a mano.
   */
  function pgArrayLiteral(values: string[]): string {
    return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
  }

  async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "sw-mig70-"));
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

  async function applyMigration0070(): Promise<void> {
    const raw = await readFile(path.join(DRIZZLE_DIR, "0070_email_proposals.sql"), "utf8");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Come il migratore reale: tutti gli statement (DDL + backfill) in UNA
    // transazione.
    await db.transaction(async (tx) => {
      for (const stmt of statements) {
        await tx.execute(sql.raw(stmt));
      }
    });
  }

  async function seedProjectRaw(): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('P', ${"proj-" + randomUUID()}, ${randomUUID()})
      returning "id"
    `);
    return rows[0]!.id;
  }

  async function seedUserRaw(): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values (${`u-${randomUUID()}@example.com`}, 'x', 'member')
      returning "id"
    `);
    return rows[0]!.id;
  }

  async function seedWorkspaceRaw(): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "google_workspaces" ("name", "domains", "client_id", "client_secret_encrypted")
      values ('Acme', ${pgArrayLiteral(["acme.test"])}::text[], '123.apps.googleusercontent.com', 'blob-cifrato')
      returning "id"
    `);
    return rows[0]!.id;
  }

  async function seedAccountRaw(): Promise<string> {
    const userId = await seedUserRaw();
    const workspaceId = await seedWorkspaceRaw();
    const rows = await db.execute<{ id: string }>(sql`
      insert into "google_accounts" ("user_id", "workspace_id", "email", "google_sub", "refresh_token_encrypted")
      values (${userId}, ${workspaceId}, ${`casella-${randomUUID()}@acme.test`}, ${randomUUID()}, 'blob-cifrato')
      returning "id"
    `);
    return rows[0]!.id;
  }

  async function seedNotificationRaw(userId: string): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "notifications" ("user_id", "kind", "event")
      values (${userId}, 'google.proposal', '{}'::jsonb)
      returning "id"
    `);
    return rows[0]!.id;
  }

  /** Semina un `email_messages` esattamente come poteva esistere prima della 0070. */
  async function seedMessageRaw(values: {
    projectId?: string | null;
    candidateProjectIds?: string[];
    status: string;
    classification?: Record<string, unknown> | null;
    proposalNotificationId?: string | null;
  }): Promise<string> {
    const accountId = await seedAccountRaw();
    // La classification è passata come TESTO parametrizzato e castata a jsonb
    // lato SQL (mai concatenata a mano nella query): stesso pattern già in
    // uso in migration-0041.test.ts per un'altra colonna jsonb.
    const classificationJson =
      values.classification === undefined || values.classification === null
        ? null
        : JSON.stringify(values.classification);
    const rows = await db.execute<{ id: string }>(sql`
      insert into "email_messages"
        ("account_id", "gmail_message_id", "thread_id", "from_address", "received_at",
         "project_id", "candidate_project_ids", "status", "classification", "proposal_notification_id")
      values (
        ${accountId}, ${randomUUID()}, ${randomUUID()}, 'cliente@acme.test', now(),
        ${values.projectId ?? null}, ${pgArrayLiteral(values.candidateProjectIds ?? [])}::uuid[],
        ${values.status}, ${classificationJson}::jsonb, ${values.proposalNotificationId ?? null}
      )
      returning "id"
    `);
    return rows[0]!.id;
  }

  // Le righe seminate PRIMA della 0070 (stato "come sarebbe in produzione").
  let projectA: string;
  let projectB: string;
  let projectC: string;
  let userId: string;
  let notificationId: string;

  let classifiedWithProject: string; // → deve nascere una email_proposals figlia
  let proposedWithProject: string; // → deve nascere, eredita proposal_notification_id
  let ignoredWithProject: string; // → NESSUNA figlia (status fuori lista), ma scope popolato
  let newNoProject: string; // → NESSUNA figlia, scope vuoto
  let classifiedNoProjectCandidates: string; // → NESSUNA figlia (project_id null), scope = candidati
  let classifiedNullClassification: string; // → caso difensivo: status classified ma classification NULL

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    // 1) Catena fino alla 0069 (email_messages senza scope_project_ids, senza email_proposals).
    const folder = await migrationsFolderUpTo(70);
    await migrate(db, { migrationsFolder: folder });

    // 2) Semina lo stato "come sarebbe oggi in produzione".
    projectA = await seedProjectRaw();
    projectB = await seedProjectRaw();
    projectC = await seedProjectRaw();
    userId = await seedUserRaw();
    notificationId = await seedNotificationRaw(userId);

    classifiedWithProject = await seedMessageRaw({
      projectId: projectA,
      status: "classified",
      classification: { summary: "richiesta di preventivo", proposals: [{ title: "x" }] },
    });
    proposedWithProject = await seedMessageRaw({
      projectId: projectA,
      status: "proposed",
      classification: { summary: "bug riportato dal cliente", proposals: [{ title: "y" }] },
      proposalNotificationId: notificationId,
    });
    ignoredWithProject = await seedMessageRaw({
      projectId: projectA,
      status: "ignored",
      classification: { summary: "newsletter", proposals: [] },
    });
    newNoProject = await seedMessageRaw({ status: "new", projectId: null });
    classifiedNoProjectCandidates = await seedMessageRaw({
      projectId: null,
      candidateProjectIds: [projectB, projectC],
      status: "classified",
      classification: { summary: "ambiguo fra due progetti", proposals: [{ title: "z" }] },
    });
    // Caso difensivo: uno stato che nel codice applicativo non si presenta mai
    // (classification è scritta nella STESSA update dello status, vedi
    // apps/worker/src/google/classify.ts) ma che lo schema di email_messages
    // non impedisce da solo (classification è nullable). Il backfill non deve
    // fallire né inventare una classification: la riga resta senza figlia.
    classifiedNullClassification = await seedMessageRaw({
      projectId: projectA,
      status: "classified",
      classification: null,
    });

    // 3) Applica la 0070 (DDL + backfill) sopra i dati seminati.
    await applyMigration0070();
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("crea una email_proposals figlia per un messaggio classified con project_id", async () => {
    const rows = await db.execute<{
      email_message_id: string;
      project_id: string;
      status: string;
      classification: { summary: string };
      proposal_notification_id: string | null;
    }>(sql`
      select "email_message_id", "project_id", "status", "classification", "proposal_notification_id"
      from "email_proposals" where "email_message_id" = ${classifiedWithProject}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project_id).toBe(projectA);
    expect(rows[0]!.status).toBe("classified");
    expect(rows[0]!.classification.summary).toBe("richiesta di preventivo");
    expect(rows[0]!.proposal_notification_id).toBeNull();
  });

  it("crea una email_proposals figlia per un messaggio proposed, ereditando la notifica", async () => {
    const rows = await db.execute<{
      status: string;
      proposal_notification_id: string | null;
      classification: { summary: string };
    }>(sql`
      select "status", "proposal_notification_id", "classification"
      from "email_proposals" where "email_message_id" = ${proposedWithProject}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("proposed");
    expect(rows[0]!.proposal_notification_id).toBe(notificationId);
    expect(rows[0]!.classification.summary).toBe("bug riportato dal cliente");
  });

  it("NON crea una figlia per uno stato fuori dal backfill (new, ignored)", async () => {
    const rows = await db.execute<{ id: string }>(sql`
      select "id" from "email_proposals"
      where "email_message_id" in (${ignoredWithProject}, ${newNoProject})
    `);
    expect(rows).toEqual([]);
  });

  it("NON crea una figlia quando project_id è NULL, anche se classified", async () => {
    const rows = await db.execute<{ id: string }>(sql`
      select "id" from "email_proposals" where "email_message_id" = ${classifiedNoProjectCandidates}
    `);
    expect(rows).toEqual([]);
  });

  it("caso difensivo: classified con classification NULL non crea una figlia (e non fa fallire la migrazione)", async () => {
    const rows = await db.execute<{ id: string }>(sql`
      select "id" from "email_proposals" where "email_message_id" = ${classifiedNullClassification}
    `);
    expect(rows).toEqual([]);
  });

  it("scope_project_ids è popolato per OGNI riga esistente, non solo quelle diventate figlie", async () => {
    const rows = await db.execute<{ id: string; scope_project_ids: string[] }>(sql`
      select "id", "scope_project_ids" from "email_messages"
      where "id" in (${classifiedWithProject}, ${proposedWithProject}, ${ignoredWithProject},
                     ${newNoProject}, ${classifiedNoProjectCandidates}, ${classifiedNullClassification})
    `);
    const byId = new Map(rows.map((r) => [r.id, r.scope_project_ids]));

    // project_id risolto, nessun candidato: scope = [project_id].
    expect(byId.get(classifiedWithProject)).toEqual([projectA]);
    expect(byId.get(proposedWithProject)).toEqual([projectA]);
    expect(byId.get(ignoredWithProject)).toEqual([projectA]);
    // Nessun progetto risolto né candidato: scope vuoto.
    expect(byId.get(newNoProject)).toEqual([]);
    // project_id NULL, due candidati in parità: scope = i candidati.
    expect(byId.get(classifiedNoProjectCandidates)?.sort()).toEqual([projectB, projectC].sort());
    // La riga difensiva (classification NULL) ha comunque lo scope popolato:
    // il backfill di scope_project_ids è indipendente da quello delle proposte.
    expect(byId.get(classifiedNullClassification)).toEqual([projectA]);
  });

  it("il totale delle email_proposals nate dal backfill è esattamente due", async () => {
    const rows = await db.execute<{ count: string }>(sql`select count(*)::text as count from "email_proposals"`);
    expect(rows[0]!.count).toBe("2");
  });
});
