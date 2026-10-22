import {
  aiJobs,
  deviceTokens,
  notificationDeliveries,
  notifications,
  notificationSettings,
  projectFollows,
  projectMembers,
  roles,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleEvents, type NotificationEvent, type NotificationKind } from "./format.js";
import { publishNotification } from "./publish.js";

/**
 * Test di `publishNotification` su un Postgres reale (testcontainers): la
 * pubblicazione fa un fan-out su più tabelle (inbox + outbox) con CHECK di
 * coerenza lato DB, quindi un fake `Db` non direbbe granché. Il caso "config
 * webhook" resta invece coperto anche dai test a fake di `dispatch.test.ts`.
 */

describe("publishNotification", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  // Gli spy si ripristinano SEMPRE: un mockRestore in coda al test resta

  // montato se la prima asserzione fallisce, e il test dopo vede le sue

  // chiamate.

  afterEach(() => vi.restoreAllMocks());


  beforeEach(async () => {
    // Ogni test parte da zero utenti (gli admin sono destinatari di TUTTO:
    // lasciarli accumulare falserebbe i conteggi dei test successivi), inbox
    // vuota e webhook non configurato (default della riga seedata dalla
    // migrazione). Le notifiche cascatano con l'utente; le consegne webhook non
    // hanno un utente dietro, quindi si cancellano a parte.
    await db.delete(users);
    await db.delete(notificationDeliveries);
    await db.update(notificationSettings).set({ webhookUrl: null, notifyPrOpened: true });
  });

  /** Crea un utente col ruolo dato; email univoca per chiamata. */
  async function seedUser(opts: {
    role: "admin" | "member";
    slackUserId?: string | null;
    notifySlackDm?: boolean;
    notifyPush?: boolean;
  }): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `${randomUUID()}@example.com`,
        passwordHash: "hash-placeholder",
        role: opts.role,
        slackUserId: opts.slackUserId ?? null,
        notifySlackDm: opts.notifySlackDm ?? true,
        notifyPush: opts.notifyPush ?? true,
      })
      .returning();
    if (!row) throw new Error("insert dell'utente di test non ha restituito la riga");
    return row.id;
  }

  /**
   * Registra un device dell'app mobile per l'utente. Il token è CASUALE a ogni
   * chiamata, non una stringa fissa: è `unique` in tabella, e un valore
   * ripetuto renderebbe il test cieco al caso di due device dello stesso
   * utente.
   */
  async function seedDevice(
    userId: string,
    opts: {
      platform?: "ios" | "android";
      disabledReason?: "pat_revoked" | "invalid_token";
    } = {},
  ): Promise<void> {
    const disabled = opts.disabledReason !== undefined;
    await db.insert(deviceTokens).values({
      userId,
      platform: opts.platform ?? "ios",
      token: `tok-${randomUUID()}`,
      // `disabledAt` e `disabledReason` vivono e muoiono insieme: il CHECK
      // `device_tokens_disabled_chk` rifiuta una riga a metà.
      disabledAt: disabled ? new Date() : null,
      disabledReason: opts.disabledReason ?? null,
    });
  }

  /** Rende `userId` membro di `projectId` col ruolo preset di progetto `presetKey`. */
  async function joinProject(
    userId: string,
    projectId: string,
    presetKey = "legacy_member",
  ): Promise<void> {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, presetKey));
    if (!role) throw new Error(`preset ${presetKey} assente`);
    await db.insert(projectMembers).values({ userId, projectId, roleId: role.id });
  }

  /**
   * Scenario condiviso: un admin (full admin, membro implicito) con identità
   * Slack, un member che segue il progetto (senza Slack) e un member che non
   * lo segue. I due member sono membri del progetto come dopo la conversione
   * (`Legacy Member`): il routing manda gli eventi di progetto ai soli membri.
   */
  async function seedScenario() {
    const { projectId, ticketId } = await seedTicket(db);
    const adminId = await seedUser({ role: "admin", slackUserId: `U${randomUUID().slice(0, 8)}` });
    const followerId = await seedUser({ role: "member" });
    const outsiderId = await seedUser({ role: "member" });
    await joinProject(followerId, projectId);
    await joinProject(outsiderId, projectId);
    await db.insert(projectFollows).values({ userId: followerId, projectId });
    return { projectId, ticketId, adminId, followerId, outsiderId };
  }

  const prOpened: NotificationEvent = {
    kind: "job.pr_opened",
    ticketNumber: 1,
    ticketTitle: "Ticket di test",
    projectName: "Progetto di test",
    prUrl: "https://github.com/acme/repo/pull/1",
    ticketUrl: "https://stubwise.example.com/tickets/1",
    costUsd: 0.12,
  };

  const planReview: NotificationEvent = {
    kind: "job.plan_review",
    ticketNumber: 1,
    ticketTitle: "Ticket di test",
    projectName: "Progetto di test",
    ticketUrl: "https://stubwise.example.com/tickets/1",
  };

  const awaitingInput: NotificationEvent = {
    kind: "job.awaiting_input",
    ticketNumber: 1,
    ticketTitle: "Ticket di test",
    projectName: "Progetto di test",
    ticketUrl: "https://stubwise.example.com/tickets/1",
    questionId: "0f2a1c7d-1111-4222-8333-444455556666",
    round: 1,
    question: "Invalidare tutte le sessioni o solo quella corrente?",
    options: [{ label: "Tutte" }, { label: "Solo la corrente" }],
    allowFreeText: true,
  };

  const projectPulse: NotificationEvent = {
    kind: "project.pulse",
    pulseId: "5b7c2e10-1111-4222-8333-444455556666",
    projectName: "Progetto di test",
    projectUrl: "https://stubwise.example.com/projects/p1/backlog",
    idleDays: 5,
    question: "Nessun lavoro in corso da 5 giorni. Da quale proposta partiamo?",
    options: [{ label: "Export CSV" }, { label: "Filtro per stato" }],
    recommendedIndex: 0,
    allowFreeText: false,
    proposals: [
      {
        backlogItemId: "aa11bb22-1111-4222-8333-444455556666",
        title: "Export CSV",
        urgency: "high",
        effort: 2,
      },
      {
        backlogItemId: "cc33dd44-1111-4222-8333-444455556666",
        title: "Filtro per stato",
        urgency: "medium",
        effort: 1,
      },
    ],
  };

  const googleProposal: NotificationEvent = {
    kind: "google.proposal",
    proposalId: "9e4b1a72-1111-4222-8333-444455556666",
    source: "email",
    messageUrl: "https://mail.google.com/mail/u/laura%40acme.test/#all/18f3a9c0",
    projectName: "Progetto di test",
    signal: "request",
    from: "laura@cliente.test",
    subject: "Export degli ordini",
    receivedAt: "2026-09-07T08:14:00.000Z",
    question: "Come diamo seguito?",
    options: [{ label: "Apri una voce di backlog" }, { label: "Non fare nulla" }],
    actions: [
      {
        type: "create_backlog_item",
        projectId: "aa11bb22-1111-4222-8333-444455556666",
        title: "Export CSV",
      },
      { type: "ignore" },
    ],
    recommendedIndex: 0,
    allowFreeText: false,
  };

  it("scrive una notifica per admin e follower, con evento e riferimenti", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result.published).toBe(2);
    // 18 set 2026: gli id delle righe scritte ESCONO dalla publish, uno per
    // destinatario. È ciò che evita a chi le ha scritte di doverle ritrovare
    // cercandole nel jsonb — vedi il docblock di `publishNotification`.
    expect(result.notificationIds).toHaveLength(2);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId].sort());
    expect(rows.map((row) => row.userId)).not.toContain(outsiderId);
    for (const row of rows) {
      expect(row.kind).toBe("job.pr_opened");
      expect(row.status).toBe("open");
      expect(row.event).toEqual(prOpened);
      expect(row.projectId).toBe(projectId);
      expect(row.ticketId).toBe(ticketId);
      expect(row.jobId).toBeNull();
      expect(row.handledAt).toBeNull();
    }
  });

  it("include l'assegnatario del ticket anche se non segue il progetto", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    await db.update(tickets).set({ assigneeId: outsiderId }).where(eq(tickets.id, ticketId));

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result.published).toBe(3);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(3);
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId, outsiderId].sort());
  });

  it("crea una slack_dm solo per chi ha un'identità Slack, legata alla SUA notifica", async () => {
    const { projectId, ticketId, adminId } = await seedScenario();

    await publishNotification(db, prOpened, { projectId, ticketId });

    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery?.channel).toBe("slack_dm");
    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempts).toBe(0);
    expect(delivery?.event).toBeNull();
    const adminNotification = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, adminId));
    expect(delivery?.notificationId).toBe(adminNotification[0]?.id);
  });

  it("non crea la slack_dm per l'admin che ha disattivato i DM", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    await seedUser({
      role: "admin",
      slackUserId: `U${randomUUID().slice(0, 8)}`,
      notifySlackDm: false,
    });

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result.published).toBe(1);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(1);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });

  it("crea una push per chi ha un device attivo, legata alla SUA notifica", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    // Nessuna identità Slack: così l'unica consegna possibile è la push, e
    // l'asserzione sull'elenco dei canali non può passare per caso.
    const adminId = await seedUser({ role: "admin" });
    await seedDevice(adminId);

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result.published).toBe(1);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(1);
    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries.map((row) => row.channel)).toEqual(["push"]);
    const [delivery] = deliveries;
    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempts).toBe(0);
    // Consegna per DESTINATARIO: il payload sta sulla notifica, non sulla riga.
    expect(delivery?.event).toBeNull();
    const [adminNotification] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, adminId));
    expect(delivery?.notificationId).toBe(adminNotification?.id);
  });

  it.each(["pat_revoked", "invalid_token"] as const)(
    "non crea la push se l'unico device è disattivato, qualunque sia il motivo (%s)",
    async (disabledReason) => {
      const { projectId, ticketId } = await seedTicket(db);
      const adminId = await seedUser({ role: "admin" });
      await seedDevice(adminId, { disabledReason });

      const result = await publishNotification(db, prOpened, { projectId, ticketId });

      // La notifica in inbox nasce lo stesso: a mancare è solo il recapito.
      expect(result.published).toBe(1);
      // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
      // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
      expect(result.notificationIds).toHaveLength(1);
      expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
    },
  );

  it("non crea la push per chi ha spento le notifiche push", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const adminId = await seedUser({ role: "admin", notifyPush: false });
    await seedDevice(adminId);

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result.published).toBe(1);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(1);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });

  it("con più device attivi crea UNA sola push, e non al posto del DM Slack", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const adminId = await seedUser({
      role: "admin",
      slackUserId: `U${randomUUID().slice(0, 8)}`,
    });
    await seedDevice(adminId, { platform: "ios" });
    await seedDevice(adminId, { platform: "android" });

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result.published).toBe(1);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(1);
    const deliveries = await db.select().from(notificationDeliveries);
    // Una push (non due: il ventaglio sui token è del poller) e il DM Slack,
    // che il ramo push non deve aver mangiato.
    expect(deliveries.map((row) => row.channel).sort()).toEqual(["push", "slack_dm"]);
  });

  it("la push va solo al destinatario che ha il device, non a chi ne è senza", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const withDeviceId = await seedUser({ role: "admin" });
    await seedUser({ role: "admin" });
    await seedDevice(withDeviceId);

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    // Due destinatari, un solo device: se l'`exists` non fosse correlato
    // all'utente, il device di uno varrebbe come recapito anche per l'altro.
    expect(result.published).toBe(2);
    // 18 set 2026: gli id delle righe scritte ESCONO dalla publish, uno per
    // destinatario. È ciò che evita a chi le ha scritte di doverle ritrovare
    // cercandole nel jsonb — vedi il docblock di `publishNotification`.
    expect(result.notificationIds).toHaveLength(2);
    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries).toHaveLength(1);
    const [withDeviceNotification] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, withDeviceId));
    expect(deliveries[0]?.notificationId).toBe(withDeviceNotification?.id);
  });

  it("crea una sola consegna webhook per evento quando il webhook è configurato", async () => {
    const { projectId, ticketId } = await seedScenario();
    await db.update(notificationSettings).set({ webhookUrl: "https://hooks.example.com/abc" });

    await publishNotification(db, prOpened, { projectId, ticketId });

    const webhooks = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.channel, "webhook"));
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.notificationId).toBeNull();
    expect(webhooks[0]?.event).toEqual(prOpened);
    expect(webhooks[0]?.status).toBe("pending");
  });

  it("non crea la consegna webhook se il toggle del kind è spento", async () => {
    const { projectId, ticketId } = await seedScenario();
    await db
      .update(notificationSettings)
      .set({ webhookUrl: "https://hooks.example.com/abc", notifyPrOpened: false });

    await publishNotification(db, prOpened, { projectId, ticketId });

    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channel, "webhook")),
    ).toHaveLength(0);
  });

  it("non crea la consegna webhook senza URL configurato", async () => {
    const { projectId, ticketId } = await seedScenario();

    await publishNotification(db, prOpened, { projectId, ticketId });

    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channel, "webhook")),
    ).toHaveLength(0);
  });

  it("manda job.plan_review ai soli admin, non ai follower", async () => {
    const { projectId, ticketId, adminId } = await seedScenario();

    const result = await publishNotification(db, planReview, { projectId, ticketId });

    expect(result.published).toBe(1);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(1);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(adminId);
    expect(rows[0]?.kind).toBe("job.plan_review");
  });

  it("manda job.awaiting_input al richiedente e agli admin, con inbox e consegne", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId, requestedByUserId: outsiderId })
      .returning();
    if (!job) throw new Error("insert del job di test non ha restituito la riga");
    await db.update(notificationSettings).set({ webhookUrl: "https://hooks.example.com/abc" });

    const result = await publishNotification(db, awaitingInput, {
      projectId,
      ticketId,
      jobId: job.id,
    });

    // Admin + richiedente. Il follower del progetto NON riceve la domanda:
    // rispondere è una decisione, non un aggiornamento di avanzamento.
    expect(result.published).toBe(2);
    // 18 set 2026: gli id delle righe scritte ESCONO dalla publish, uno per
    // destinatario. È ciò che evita a chi le ha scritte di doverle ritrovare
    // cercandole nel jsonb — vedi il docblock di `publishNotification`.
    expect(result.notificationIds).toHaveLength(2);
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, outsiderId].sort());
    expect(rows.map((row) => row.userId)).not.toContain(followerId);
    for (const row of rows) {
      expect(row.kind).toBe("job.awaiting_input");
      expect(row.event).toEqual(awaitingInput);
      expect(row.jobId).toBe(job.id);
    }
    // Outbox: il DM Slack del solo admin (l'unico con identità Slack) e la
    // consegna webhook d'istanza, che il toggle `notifyAwaitingInput` consente.
    const deliveries = await db.select().from(notificationDeliveries);
    const slackDm = deliveries.filter((row) => row.channel === "slack_dm");
    expect(slackDm).toHaveLength(1);
    expect(deliveries.filter((row) => row.channel === "webhook")).toHaveLength(1);
  });

  it("senza richiedente (automazione) job.awaiting_input resta ai soli admin", async () => {
    const { projectId, ticketId, adminId } = await seedScenario();
    const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
    if (!job) throw new Error("insert del job di test non ha restituito la riga");

    const result = await publishNotification(db, awaitingInput, {
      projectId,
      ticketId,
      jobId: job.id,
    });

    expect(result.published).toBe(1);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(1);
    const rows = await db.select().from(notifications);
    expect(rows[0]?.userId).toBe(adminId);
  });

  it("manda project.pulse ad admin e follower, senza ticket né job dietro", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    // L'outsider è ASSEGNATARIO del ticket del progetto: il pulse non è ancorato
    // a nessun ticket, quindi non deve raggiungerlo per quella via.
    await db.update(tickets).set({ assigneeId: outsiderId }).where(eq(tickets.id, ticketId));

    const result = await publishNotification(db, projectPulse, { projectId });

    expect(result.published).toBe(2);
    // 18 set 2026: gli id delle righe scritte ESCONO dalla publish, uno per
    // destinatario. È ciò che evita a chi le ha scritte di doverle ritrovare
    // cercandole nel jsonb — vedi il docblock di `publishNotification`.
    expect(result.notificationIds).toHaveLength(2);
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId].sort());
    expect(rows.map((row) => row.userId)).not.toContain(outsiderId);
    for (const row of rows) {
      expect(row.kind).toBe("project.pulse");
      expect(row.event).toEqual(projectPulse);
      expect(row.projectId).toBe(projectId);
      expect(row.ticketId).toBeNull();
      expect(row.jobId).toBeNull();
    }
  });

  it("manda google.proposal SOLO al proprietario della casella, mai agli admin", async () => {
    // ⚠️ L'INVARIANTE DI PRIVACY DELLA FASE 6, verificata dove ha effetto: non
    // basta che `recipientsFor` lo dica (lo copre `routing.test.ts`), perché
    // qui in mezzo c'è `resolveRoutingContext` — che per ogni altro pubblico
    // CARICA gli admin. Se un domani quel ramo cadesse nel default, gli admin
    // si vedrebbero comparire in inbox la posta di un collega e nessun test
    // puro se ne accorgerebbe.
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    await db.update(tickets).set({ assigneeId: followerId }).where(eq(tickets.id, ticketId));

    const result = await publishNotification(db, googleProposal, {
      projectId,
      mailboxOwnerUserId: outsiderId,
    });

    expect(result.published).toBe(1);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(1);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(outsiderId);
    expect(rows.map((row) => row.userId)).not.toContain(adminId);
    expect(rows.map((row) => row.userId)).not.toContain(followerId);
    expect(rows[0]?.kind).toBe("google.proposal");
    expect(rows[0]?.event).toEqual(googleProposal);
    expect(rows[0]?.projectId).toBe(projectId);
    expect(rows[0]?.ticketId).toBeNull();
    expect(rows[0]?.jobId).toBeNull();
  });

  it("senza proprietario risolto la proposta non raggiunge NESSUNO", async () => {
    // Il degrado giusto: meglio nessuna notifica che una alla persona
    // sbagliata. Con gli admin in tabella, un ramo che li caricasse "per non
    // perdere l'evento" si vedrebbe qui.
    await seedScenario();

    expect(await publishNotification(db, googleProposal, {})).toEqual({ published: 0, notificationIds: [] });
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("google.proposal non genera MAI una consegna webhook, anche col webhook configurato e il toggle acceso", async () => {
    // Task 4 (fase 6, fix di review): il webhook d'istanza è un canale
    // condiviso (in prod un canale Slack/Discord dell'intero team) — vederci
    // comparire `from`/`subject`/`question` della casella di un collega
    // contraddirebbe l'unico destinatario dell'audience `mailbox_owner`. La
    // guardia vince ANCHE col toggle esplicitamente acceso: non è un default,
    // è privacy by construction.
    const { projectId, outsiderId } = await seedScenario();
    await db
      .update(notificationSettings)
      .set({ webhookUrl: "https://hooks.example.com/abc", notifyGoogleProposal: true });

    const result = await publishNotification(db, googleProposal, {
      projectId,
      mailboxOwnerUserId: outsiderId,
    });

    // Il proprietario della casella riceve comunque la sua notifica in inbox:
    // la guardia esclude SOLO il webhook, non le altre vie di consegna.
    expect(result.published).toBe(1);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(1);
    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channel, "webhook")),
    ).toHaveLength(0);
  });

  it("google.proposal con 0 destinatari e webhook configurato: zero delivery IN ASSOLUTO, non solo zero webhook", async () => {
    // Prima del fix, `withWebhook` restava vero anche con `recipients.length
    // === 0`: la riga in inbox non nasceva, ma la consegna webhook sì —
    // esattamente il caso "0 destinatari" del finding. Qui verifichiamo che
    // non nasca NESSUNA riga, in nessuna tabella dell'outbox.
    await seedScenario();
    await db
      .update(notificationSettings)
      .set({ webhookUrl: "https://hooks.example.com/abc", notifyGoogleProposal: true });

    const result = await publishNotification(db, googleProposal, {});

    expect(result).toEqual({ published: 0, notificationIds: [] });
    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });

  it("inserisce DENTRO la transazione ricevuta (il rollback annulla tutto)", async () => {
    const { projectId, ticketId } = await seedScenario();

    await expect(
      db.transaction(async (tx) => {
        const result = await publishNotification(tx, prOpened, { projectId, ticketId });
        expect(result.published).toBe(2);
    // 18 set 2026: gli id delle righe scritte ESCONO dalla publish, uno per
    // destinatario. È ciò che evita a chi le ha scritte di doverle ritrovare
    // cercandole nel jsonb — vedi il docblock di `publishNotification`.
    expect(result.notificationIds).toHaveLength(2);
        throw new Error("rollback voluto");
      }),
    ).rejects.toThrow("rollback voluto");

    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });

  it("non lancia mai: con un db rotto restituisce { published: 0 }, ma LOGGA", async () => {
    const broken = {
      transaction() {
        throw new Error("connessione persa");
      },
      select() {
        throw new Error("connessione persa");
      },
      insert() {
        throw new Error("connessione persa");
      },
    } as unknown as Db;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(publishNotification(broken, prOpened, {})).resolves.toEqual({ published: 0, notificationIds: [] });

    // Il valore di ritorno non lo guarda nessun chiamante: il log è l'UNICA
    // traccia che la notifica è sparita, e deve dire quale kind e perché.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, error] = warn.mock.calls[0] ?? [];
    expect(message).toContain("job.pr_opened");
    expect(message).toContain("nessuna riga scritta");
    expect((error as Error).message).toBe("connessione persa");
  });

  it("su errore SQL non aborta la transazione del chiamante (savepoint annidato)", async () => {
    const { ticketId } = await seedScenario();
    // Progetto inesistente: l'insert nell'inbox viola la FK su project_id. Il
    // fallimento deve restare confinato al savepoint di publishNotification.
    const projectIdFantasma = randomUUID();
    const emailDopo = `${randomUUID()}@example.com`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await db.transaction(async (tx) => {
      const result = await publishNotification(tx, prOpened, {
        projectId: projectIdFantasma,
        ticketId,
      });
      expect(result).toEqual({ published: 0, notificationIds: [] });
      // La transazione del chiamante è ancora usabile: se il savepoint non ci
      // fosse, qui Postgres risponderebbe "current transaction is aborted".
      await tx
        .insert(users)
        .values({ email: emailDopo, passwordHash: "hash-placeholder", role: "member" });
    });

    // Il commit del chiamante è andato a buon fine...
    expect(await db.select().from(users).where(eq(users.email, emailDopo))).toHaveLength(1);
    // ...e la pubblicazione fallita non ha lasciato righe parziali.
    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
    // Anche su un errore SQL vero (non solo con un db finto) resta il log:
    // è tutto ciò che distingue "niente da notificare" da "notifica persa".
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("instrada verso chi ha richiesto il job e ancora le notifiche al job", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId, requestedByUserId: outsiderId })
      .returning();
    if (!job) throw new Error("insert del job di test non ha restituito la riga");

    const result = await publishNotification(db, prOpened, { projectId, ticketId, jobId: job.id });

    expect(result.published).toBe(3);
    // Gli id delle righe scritte escono dalla publish (18 set 2026): uno per
    // destinatario. È ciò che evita a chi le ha scritte di ritrovarle cercandole.
    expect(result.notificationIds).toHaveLength(3);
    const rows = await db.select().from(notifications);
    // L'outsider non segue il progetto e non è assegnatario: arriva solo perché
    // ha lanciato lui il job.
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId, outsiderId].sort());
    for (const row of rows) {
      expect(row.jobId).toBe(job.id);
    }
  });

  it("senza projectId il progetto è quello del ticket: follower e filtro dei membri valgono", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    await db.update(tickets).set({ assigneeId: outsiderId }).where(eq(tickets.id, ticketId));

    const result = await publishNotification(db, prOpened, { ticketId });

    expect(result.published).toBe(3);
    // 18 set 2026: gli id delle righe scritte ESCONO dalla publish, uno per
    // destinatario. È ciò che evita a chi le ha scritte di doverle ritrovare
    // cercandole nel jsonb — vedi il docblock di `publishNotification`.
    expect(result.notificationIds).toHaveLength(3);
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId, outsiderId].sort());
    for (const row of rows) {
      // La colonna prende il progetto del ticket: è quella che il filtro a
      // lettura guarda.
      expect(row.projectId).toBe(projectId);
      expect(row.ticketId).toBe(ticketId);
    }
  });

  it("scrive comunque la consegna webhook quando non c'è nessun destinatario", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    await db.update(notificationSettings).set({ webhookUrl: "https://hooks.example.com/abc" });

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result).toEqual({ published: 0, notificationIds: [] });
    expect(await db.select().from(notifications)).toHaveLength(0);
    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.channel).toBe("webhook");
    expect(deliveries[0]?.notificationId).toBeNull();
    expect(deliveries[0]?.event).toEqual(prOpened);
  });

  it("non scrive nulla se non ci sono destinatari né webhook configurato", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const memberId = await seedUser({ role: "member" });

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result).toEqual({ published: 0, notificationIds: [] });
    expect(
      await db.select().from(notifications).where(inArray(notifications.userId, [memberId])),
    ).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });
  /**
   * Destinatari per PERMESSO DI PROGETTO (design permessi, «Notifiche»): i
   * deciders sono chi ha il permesso pertinente nel progetto più i full admin,
   * e ogni destinatario di un evento di progetto deve VEDERE il progetto.
   */
  describe("destinatari per permesso di progetto", () => {
    function sample(kind: NotificationKind): NotificationEvent {
      const event = sampleEvents("https://stubwise.example.com").find((e) => e.kind === kind);
      if (!event) throw new Error(`nessun evento d'esempio per ${kind}`);
      return event;
    }

    async function recipientsOf(): Promise<string[]> {
      return (await db.select({ userId: notifications.userId }).from(notifications))
        .map((row) => row.userId)
        .sort();
    }

    it("un follower NON membro non riceve ticket.created (il follow resta, non produce nulla)", async () => {
      const { projectId, ticketId } = await seedTicket(db);
      const adminId = await seedUser({ role: "admin" });
      const exFollower = await seedUser({ role: "member" });
      await db.insert(projectFollows).values({ userId: exFollower, projectId });

      await publishNotification(db, sample("ticket.created"), { projectId, ticketId });

      expect(await recipientsOf()).toEqual([adminId]);
    });

    it("un full admin NON membro riceve le notifiche rivolte ai membri", async () => {
      const { projectId, ticketId } = await seedTicket(db);
      const adminId = await seedUser({ role: "admin" });
      const followerId = await seedUser({ role: "member" });
      await joinProject(followerId, projectId, "viewer");
      await db.insert(projectFollows).values({ userId: followerId, projectId });

      await publishNotification(db, prOpened, { projectId, ticketId });

      expect(await recipientsOf()).toEqual([adminId, followerId].sort());
      const [admin] = await db
        .select({ id: projectMembers.userId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, adminId));
      expect(admin).toBeUndefined();
    });

    it("job.plan_review: un Developer no, un Project Lead (non full admin) sì", async () => {
      const { projectId, ticketId } = await seedTicket(db);
      const adminId = await seedUser({ role: "admin" });
      const developerId = await seedUser({ role: "member" });
      const leadId = await seedUser({ role: "member" });
      await joinProject(developerId, projectId, "developer");
      await joinProject(leadId, projectId, "project_lead");
      // Un Project Lead di un ALTRO progetto non è un decider di questo.
      const other = await seedTicket(db);
      const otherLeadId = await seedUser({ role: "member" });
      await joinProject(otherLeadId, other.projectId, "project_lead");

      await publishNotification(db, planReview, { projectId, ticketId });

      expect(await recipientsOf()).toEqual([adminId, leadId].sort());
    });

    it("il richiedente rimosso non riceve job.awaiting_input, i deciders sì (non resta orfana)", async () => {
      const { projectId, ticketId } = await seedTicket(db);
      const adminId = await seedUser({ role: "admin" });
      const leadId = await seedUser({ role: "member" });
      await joinProject(leadId, projectId, "project_lead");
      const requesterId = await seedUser({ role: "member" });
      const developerId = await seedUser({ role: "member" });
      await joinProject(developerId, projectId, "developer");
      // Il richiedente HA lanciato il job, ma non è (più) membro.
      const [job] = await db
        .insert(aiJobs)
        .values({ ticketId, requestedByUserId: requesterId })
        .returning();

      await publishNotification(db, awaitingInput, { projectId, ticketId, jobId: job!.id });

      expect(await recipientsOf()).toEqual([adminId, leadId].sort());

      // Controprova: membro (anche solo Contributor), la riceve.
      await db.delete(notifications);
      await joinProject(requesterId, projectId, "contributor");
      await publishNotification(db, awaitingInput, { projectId, ticketId, jobId: job!.id });
      expect(await recipientsOf()).toEqual([adminId, leadId, requesterId].sort());
    });

    it("un membro rimosso non riceve NULLA: né la card, né la push, né il DM", async () => {
      const { projectId, ticketId } = await seedTicket(db);
      const removedId = await seedUser({
        role: "member",
        slackUserId: `U${randomUUID().slice(0, 8)}`,
      });
      await seedDevice(removedId);
      await db.insert(projectFollows).values({ userId: removedId, projectId });
      await db.update(tickets).set({ assigneeId: removedId }).where(eq(tickets.id, ticketId));

      const result = await publishNotification(db, prOpened, { projectId, ticketId });

      expect(result.published).toBe(0);
      expect(await db.select().from(notifications)).toHaveLength(0);
      expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
    });

    it("google.proposal va SOLO al proprietario, anche se non vede il progetto", async () => {
      const { projectId } = await seedTicket(db);
      await seedUser({ role: "admin" });
      const ownerId = await seedUser({ role: "member" });

      await publishNotification(db, googleProposal, { projectId, mailboxOwnerUserId: ownerId });

      expect(await recipientsOf()).toEqual([ownerId]);
    });

    it("request.created va a chi gestisce i membri del progetto (+ full admin)", async () => {
      const { projectId, ticketId } = await seedTicket(db);
      const adminId = await seedUser({ role: "admin" });
      const leadId = await seedUser({ role: "member" });
      const legacyId = await seedUser({ role: "member" });
      await joinProject(leadId, projectId, "project_lead");
      await joinProject(legacyId, projectId, "legacy_member");

      await publishNotification(db, sample("request.created"), { projectId, ticketId });

      expect(await recipientsOf()).toEqual([adminId, leadId].sort());
    });

    it("monitor.alert va a chi ha monitor.manage nell'istanza (+ full admin), non agli User", async () => {
      const adminId = await seedUser({ role: "admin" });
      await seedUser({ role: "member" });
      const [opsRole] = await db
        .insert(roles)
        .values({ name: `Ops ${randomUUID()}`, scope: "instance", permissions: ["monitor.manage"] })
        .returning();
      const opsId = await seedUser({ role: "member" });
      await db.update(users).set({ instanceRoleId: opsRole!.id }).where(eq(users.id, opsId));

      await publishNotification(db, sample("monitor.alert"), {});

      expect(await recipientsOf()).toEqual([adminId, opsId].sort());
    });
  });
});
