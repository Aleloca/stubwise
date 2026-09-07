import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  agentRuns,
  aiJobs,
  calendarEvents,
  emailMessages,
  googleAccounts,
  googleWorkspaces,
  notificationSettings,
  notifications,
  oauthStates,
  projectEmailRoutes,
  projects,
  users,
} from "./schema.js";
import { expectSqlState, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0069 (fase 6 — Gmail e Calendar) applicata su un Postgres reale:
 * le sei tabelle nuove coi loro vincoli, l'owner `email_message_id` di
 * `agent_runs`, il toggle webhook del kind nuovo e il valore enum
 * `google.proposal` inseribile in `notifications`.
 *
 * Sono i vincoli che il codice delle fasi successive dà per veri senza
 * ricontrollarli: l'unique `(account_id, gmail_message_id)` è l'idempotenza del
 * poller (`onConflictDoNothing`), il `num_nonnulls(...) = 1` di `agent_runs` è
 * ciò che rende un run di classificazione contabilizzabile come i fix, e i
 * CHECK testuali sono l'unica difesa degli stati (nessuno di essi è un enum
 * Postgres, per non trascinare una migrazione a sé a ogni valore nuovo).
 */
describe("schema: Gmail e Calendar (fase 6)", () => {
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

  async function seedWorkspace(): Promise<string> {
    const [workspace] = await db
      .insert(googleWorkspaces)
      .values({
        name: "Acme",
        domains: ["acme.test"],
        clientId: "123.apps.googleusercontent.com",
        clientSecretEncrypted: "blob-cifrato",
      })
      .returning();
    return workspace!.id;
  }

  async function seedAccount(
    values: Partial<typeof googleAccounts.$inferInsert> = {},
  ): Promise<string> {
    const [account] = await db
      .insert(googleAccounts)
      .values({
        userId: values.userId ?? (await seedUser()),
        workspaceId: values.workspaceId ?? (await seedWorkspace()),
        email: values.email ?? `casella-${randomUUID()}@acme.test`,
        googleSub: values.googleSub ?? randomUUID(),
        refreshTokenEncrypted: "blob-cifrato",
        scopes: values.scopes ?? ["openid", "email"],
        ...values,
      })
      .returning();
    return account!.id;
  }

  async function seedMessage(
    accountId: string,
    values: Partial<typeof emailMessages.$inferInsert> = {},
  ): Promise<string> {
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId,
        gmailMessageId: values.gmailMessageId ?? randomUUID(),
        threadId: values.threadId ?? randomUUID(),
        fromAddress: values.fromAddress ?? "cliente@acme.test",
        receivedAt: values.receivedAt ?? new Date(),
        ...values,
      })
      .returning();
    return message!.id;
  }

  describe("google_workspaces e google_accounts", () => {
    it("la casella nasce attiva, senza cursori e con zero tentativi", async () => {
      const accountId = await seedAccount();

      const [account] = await db
        .select()
        .from(googleAccounts)
        .where(eq(googleAccounts.id, accountId));
      expect(account?.proposalsEnabled).toBe(true);
      expect(account?.syncAttempts).toBe(0);
      expect(account?.gmailHistoryId).toBeNull();
      expect(account?.calendarSyncToken).toBeNull();
      expect(account?.disabledAt).toBeNull();
      // `next_sync_at` valorizzato: la casella appena collegata è già dovuta al
      // primo tick, senza che il poller debba trattare il null come "adesso".
      expect(account?.nextSyncAt).toBeInstanceOf(Date);
    });

    it("la stessa email non si collega due volte", async () => {
      const email = `casella-${randomUUID()}@acme.test`;
      await seedAccount({ email });

      await expectSqlState(seedAccount({ email }), "23505");
    });

    it("un Workspace con caselle collegate non si cancella (RESTRICT)", async () => {
      const workspaceId = await seedWorkspace();
      await seedAccount({ workspaceId });

      await expectSqlState(
        db.execute(sql`delete from google_workspaces where id = ${workspaceId}`),
        "23503",
      );
    });

    it("cancellare l'utente si porta via le sue caselle (CASCADE)", async () => {
      const userId = await seedUser();
      const accountId = await seedAccount({ userId });

      await db.execute(sql`delete from users where id = ${userId}`);

      const rows = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
      expect(rows).toEqual([]);
    });

    it("un motivo di disabilitazione fuori dalla lista è rifiutato dal CHECK", async () => {
      await expectSqlState(
        seedAccount({
          disabledAt: new Date(),
          disabledReason: "boh" as "revoked",
        }),
        "23514",
      );
    });
  });

  describe("oauth_states", () => {
    it("il nonce è unico: uno state non si riusa", async () => {
      const nonce = randomUUID();
      const userId = await seedUser();
      const workspaceId = await seedWorkspace();
      const expiresAt = new Date(Date.now() + 600_000);
      await db.insert(oauthStates).values({ nonce, userId, workspaceId, expiresAt });

      await expectSqlState(
        db.insert(oauthStates).values({ nonce, userId, workspaceId, expiresAt }),
        "23505",
      );
    });

    it("nasce non consumato", async () => {
      const [row] = await db
        .insert(oauthStates)
        .values({
          nonce: randomUUID(),
          userId: await seedUser(),
          workspaceId: await seedWorkspace(),
          expiresAt: new Date(Date.now() + 600_000),
        })
        .returning();
      expect(row?.consumedAt).toBeNull();
    });
  });

  describe("project_email_routes", () => {
    it("la stessa regola non entra due volte nello stesso progetto", async () => {
      const projectId = await seedProject();
      await db
        .insert(projectEmailRoutes)
        .values({ projectId, kind: "sender_domain", value: "acme.test" });

      await expectSqlState(
        db
          .insert(projectEmailRoutes)
          .values({ projectId, kind: "sender_domain", value: "acme.test" }),
        "23505",
      );
    });

    it("lo stesso valore con un kind diverso è un'altra regola", async () => {
      const projectId = await seedProject();
      await db
        .insert(projectEmailRoutes)
        .values({ projectId, kind: "keyword", value: "fattura" });
      await db
        .insert(projectEmailRoutes)
        .values({ projectId, kind: "gmail_label", value: "fattura" });

      const rows = await db
        .select()
        .from(projectEmailRoutes)
        .where(eq(projectEmailRoutes.projectId, projectId));
      expect(rows).toHaveLength(2);
    });

    it("un kind di regola fuori dalla lista è rifiutato dal CHECK", async () => {
      const projectId = await seedProject();

      await expectSqlState(
        db
          .insert(projectEmailRoutes)
          .values({ projectId, kind: "mittente" as "sender_domain", value: "acme.test" }),
        "23514",
      );
    });
  });

  describe("email_messages", () => {
    it("nasce in stato `new`, senza segnale né esito", async () => {
      const accountId = await seedAccount();
      const messageId = await seedMessage(accountId);

      const [message] = await db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.id, messageId));
      expect(message?.status).toBe("new");
      expect(message?.signal).toBeNull();
      expect(message?.classification).toBeNull();
      expect(message?.outcome).toBeNull();
      expect(message?.projectId).toBeNull();
      expect(message?.labels).toEqual([]);
      expect(message?.toAddresses).toEqual([]);
      expect(message?.candidateProjectIds).toEqual([]);
    });

    it("lo stesso messaggio Gmail non entra due volte per la stessa casella", async () => {
      const accountId = await seedAccount();
      const gmailMessageId = "18f3a9c0d1e2f345";
      await seedMessage(accountId, { gmailMessageId });

      await expectSqlState(seedMessage(accountId, { gmailMessageId }), "23505");
    });

    it("lo stesso id Gmail su un'altra casella è un altro messaggio", async () => {
      const gmailMessageId = `gmail-${randomUUID()}`;
      await seedMessage(await seedAccount(), { gmailMessageId });
      await seedMessage(await seedAccount(), { gmailMessageId });

      const rows = await db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.gmailMessageId, gmailMessageId));
      expect(rows).toHaveLength(2);
    });

    it("uno stato fuori dalla lista è rifiutato dal CHECK", async () => {
      const accountId = await seedAccount();

      await expectSqlState(
        seedMessage(accountId, { status: "spedito" as "new" }),
        "23514",
      );
    });

    it("un segnale fuori dalla lista è rifiutato dal CHECK", async () => {
      const accountId = await seedAccount();

      await expectSqlState(
        seedMessage(accountId, { signal: "urgenza" as "decision" }),
        "23514",
      );
    });

    it("cancellare il progetto lascia vivo il messaggio (SET NULL)", async () => {
      const projectId = await seedProject();
      const messageId = await seedMessage(await seedAccount(), { projectId });

      await db.execute(sql`delete from projects where id = ${projectId}`);

      const [message] = await db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.id, messageId));
      expect(message).toBeTruthy();
      expect(message?.projectId).toBeNull();
    });

    it("cancellare la casella si porta via i suoi messaggi (CASCADE)", async () => {
      const accountId = await seedAccount();
      const messageId = await seedMessage(accountId);

      await db.execute(sql`delete from google_accounts where id = ${accountId}`);

      const rows = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
      expect(rows).toEqual([]);
    });
  });

  describe("calendar_events", () => {
    it("lo stesso evento Google non entra due volte per la stessa casella", async () => {
      const accountId = await seedAccount();
      const values = {
        accountId,
        googleEventId: "evento-google-1",
        title: "Kickoff",
        startsAt: new Date(),
        fingerprint: "2026-09-07|kickoff",
      };
      await db.insert(calendarEvents).values(values);

      await expectSqlState(db.insert(calendarEvents).values(values), "23505");
    });

    it("nasce non tutto-il-giorno, senza partecipanti né esito", async () => {
      const [event] = await db
        .insert(calendarEvents)
        .values({
          accountId: await seedAccount(),
          googleEventId: randomUUID(),
          startsAt: new Date(),
          fingerprint: "2026-09-07|kickoff",
        })
        .returning();
      expect(event?.allDay).toBe(false);
      expect(event?.attendees).toEqual([]);
      expect(event?.outcome).toBeNull();
      expect(event?.projectId).toBeNull();
    });

    it("uno stato fuori dalla lista di Google è rifiutato dal CHECK", async () => {
      await expectSqlState(
        db.insert(calendarEvents).values({
          accountId: await seedAccount(),
          googleEventId: randomUUID(),
          startsAt: new Date(),
          fingerprint: "2026-09-07|kickoff",
          status: "rinviato" as "confirmed",
        }),
        "23514",
      );
    });
  });

  describe("agent_runs: la posta è un owner come il job e la review", () => {
    it("accetta un run col solo email_message_id, in fase email_classify", async () => {
      const messageId = await seedMessage(await seedAccount());

      const [run] = await db
        .insert(agentRuns)
        .values({
          emailMessageId: messageId,
          phase: "email_classify",
          model: "haiku",
          inputTokens: 1200,
          outputTokens: 300,
        })
        .returning();

      expect(run?.emailMessageId).toBe(messageId);
      expect(run?.jobId).toBeNull();
      expect(run?.prReviewId).toBeNull();
    });

    it("rifiuta un run con due owner", async () => {
      const { ticketId } = await seedTicket(db);
      const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
      const messageId = await seedMessage(await seedAccount());

      await expectSqlState(
        db.insert(agentRuns).values({
          jobId: job!.id,
          emailMessageId: messageId,
          phase: "email_classify",
          model: "haiku",
        }),
        "23514",
      );
    });

    it("rifiuta un run senza owner", async () => {
      await expectSqlState(
        db.insert(agentRuns).values({ phase: "email_classify", model: "haiku" }),
        "23514",
      );
    });

    it("cancellare il messaggio si porta via i suoi run (CASCADE)", async () => {
      // CASCADE e non SET NULL: con `num_nonnulls(...) = 1` un run orfano
      // violerebbe il check, e la retention dei messaggi non potrebbe cancellare
      // nulla. Stesso comportamento degli altri due owner.
      const messageId = await seedMessage(await seedAccount());
      const [run] = await db
        .insert(agentRuns)
        .values({ emailMessageId: messageId, phase: "email_classify", model: "haiku" })
        .returning();

      await db.execute(sql`delete from email_messages where id = ${messageId}`);

      const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
      expect(rows).toEqual([]);
    });
  });

  describe("il kind google.proposal", () => {
    it("il toggle webhook nasce a true", async () => {
      const [settings] = await db.select().from(notificationSettings);
      expect(settings?.notifyGoogleProposal).toBe(true);
    });

    it("è inseribile in notifications", async () => {
      const userId = await seedUser();

      const [row] = await db
        .insert(notifications)
        .values({
          kind: "google.proposal",
          userId,
          event: {
            kind: "google.proposal",
            proposalId: randomUUID(),
            source: "email",
          },
        })
        .returning();

      expect(row?.kind).toBe("google.proposal");
    });

    it("l'indice sulle proposte serve la ricerca per proposalId", async () => {
      // Il claim delle proposte (`propagateHandled` su `event->>'proposalId'`)
      // è l'unica lettura per cui questo indice esiste: se un domani sparisse,
      // quella query tornerebbe a scandire tutta l'inbox.
      const rows = await db.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes
        where tablename = 'notifications' and indexname = 'notifications_proposal_id_idx'
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toContain("proposalId");
    });
  });
});
