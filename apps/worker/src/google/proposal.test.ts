import { randomUUID } from "node:crypto";
import {
  calendarEvents as calendarEventsTable,
  emailMessages,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCalendarProposalEvent,
  buildEmailProposalEvent,
  calendarDayUrl,
  gmailThreadUrl,
  googleProposalEventSchema,
  publishProposal,
  MAX_PROPOSAL_OPTIONS,
} from "./proposal.js";

/**
 * FASE D (fase 6, Task 10): da una riga trattata alla proposta in inbox.
 *
 * Due metà con due rischi diversi, e i test li seguono separati:
 *
 *  1. **La costruzione** è pura, e il suo rischio è il DISALLINEAMENTO fra
 *     `options` e `actions` — che non dà nessun errore, fa eseguire l'azione
 *     sbagliata su una conferma data in buona fede. Ogni test che costruisce un
 *     evento riconta le due liste.
 *  2. **La pubblicazione** tocca due tabelle e deve farlo INSIEME. Il suo
 *     rischio sono i due mezzi stati: una notifica senza la riga marcata (una
 *     card nuova a ogni tick sulla stessa email) e una riga marcata senza
 *     notifica (una proposta che non esiste e che nessuno ripescherà). Si
 *     verificano su un Postgres vero, perché è la transazione a garantirli.
 */

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let db: Db;

const MAILBOX = "operatore@acme.com";

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(calendarEventsTable);
  await db.delete(emailMessages);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
  await db.delete(notifications);
  await db.delete(projects);
  await db.delete(users);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.stop();
});

// ---------------------------------------------------------------------------
// Fixture pure
// ---------------------------------------------------------------------------

const PROJECT_A = "aa11bb22-1111-4222-8333-444455556666";
const PROJECT_B = "bb22cc33-2222-4333-8444-555566667777";
const TICKET_ID = "cc33dd44-3333-4444-8555-666677778888";

const NAMES = new Map([
  [PROJECT_A, "negozio-web"],
  [PROJECT_B, "portale-clienti"],
]);

/** Una riga `email_messages` classificata, nella forma che il builder legge. */
function emailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    threadId: "18f3a9c0d1e2f345",
    fromAddress: "laura@cliente.test",
    fromName: "Laura",
    subject: "Export degli ordini in CSV",
    receivedAt: new Date("2026-09-07T08:14:00.000Z"),
    projectId: PROJECT_A,
    candidateProjectIds: [] as string[],
    classification: {
      signal: "request",
      summary: "Laura chiede l'export CSV.",
      recommendedIndex: 0,
      proposals: [
        {
          type: "create_backlog_item",
          projectId: PROJECT_A,
          title: "Export CSV dello storico ordini",
          consequence: "Entra nel backlog di discovery.",
        },
      ],
    } as Record<string, unknown>,
    ...overrides,
  };
}

function buildEmail(overrides: Record<string, unknown> = {}) {
  return buildEmailProposalEvent({
    lang: "it",
    message: emailRow(overrides),
    mailboxEmail: MAILBOX,
    projectNames: NAMES,
  });
}

// ---------------------------------------------------------------------------
// Costruzione — posta
// ---------------------------------------------------------------------------

describe("buildEmailProposalEvent", () => {
  it("una opzione per proposta, «Non fare nulla» SEMPRE ultima, azioni allineate", () => {
    const event = buildEmail();
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("google.proposal");
    expect(event?.source).toBe("email");
    expect(event?.signal).toBe("request");
    expect(event?.allowFreeText).toBe(false);
    expect(event?.options).toHaveLength(2);
    // L'INVARIANTE, asserita e non sperata.
    expect(event?.actions).toHaveLength(event?.options.length ?? -1);
    expect(event?.actions[0]).toEqual({
      type: "create_backlog_item",
      projectId: PROJECT_A,
      title: "Export CSV dello storico ordini",
    });
    expect(event?.actions.at(-1)).toEqual({ type: "ignore" });
    // La `consequence` è l'unico pezzo di testo della card che scrive il
    // modello: l'etichetta viene da un template.
    expect(event?.options[0]?.consequence).toBe("Entra nel backlog di discovery.");
    expect(event?.options[0]?.label).toContain("Export CSV dello storico ordini");
    // Il progetto risolto entra nell'evento col NOME, non con l'id: la card
    // deve poterlo scrivere senza un'altra query.
    expect(event?.projectName).toBe("negozio-web");
    expect(event?.receivedAt).toBe("2026-09-07T08:14:00.000Z");
  });

  it("il link porta al THREAD dentro la casella giusta", () => {
    // `u/<email>` e non `u/0`: l'indice numerico è la posizione dell'account
    // nel browser di chi clicca, quindi porterebbe chi ha più account Google
    // sulla casella sbagliata. `#all` perché una email trattata è archiviata.
    expect(buildEmail()?.messageUrl).toBe(
      `https://mail.google.com/mail/u/${encodeURIComponent(MAILBOX)}/#all/18f3a9c0d1e2f345`,
    );
    expect(gmailThreadUrl("a+b@acme.test", "t1")).toBe(
      "https://mail.google.com/mail/u/a%2Bb%40acme.test/#all/t1",
    );
  });

  it("una proposta senza il referente che serve a eseguirla NON diventa opzione", () => {
    // `create_backlog_item` senza titolo non è confermabile: eseguirla non
    // produrrebbe niente. Ricontrollato QUI e non solo alla classificazione,
    // perché il jsonb può venire da una versione precedente del codice.
    const event = buildEmail({
      classification: {
        signal: "request",
        recommendedIndex: 0,
        proposals: [
          { type: "create_backlog_item", projectId: PROJECT_A, consequence: "…" },
          {
            type: "comment_ticket",
            ticketId: TICKET_ID,
            ticketNumber: 42,
            body: "Rispondiamo a Laura.",
            consequence: "Il ticket riceve un commento.",
          },
        ],
      },
    });
    expect(event?.options).toHaveLength(2);
    expect(event?.actions).toHaveLength(2);
    expect(event?.actions[0]).toEqual({
      type: "comment_ticket",
      ticketId: TICKET_ID,
      body: "Rispondiamo a Laura.",
    });
    expect(event?.options[0]?.label).toContain("#42");
  });

  it("`recommendedIndex` viene RIMAPPATO sulle proposte sopravvissute", () => {
    // La consigliata era la seconda; la prima cade. Copiare l'indice com'era
    // evidenzierebbe «Non fare nulla», cioè esattamente l'opposto.
    const event = buildEmail({
      classification: {
        signal: "request",
        recommendedIndex: 1,
        proposals: [
          { type: "update_ticket", consequence: "…" },
          {
            type: "create_milestone",
            projectId: PROJECT_A,
            name: "Export entro il 30/09",
            dueDate: "2026-09-30T00:00:00.000Z",
            consequence: "Nasce una milestone.",
          },
        ],
      },
    });
    expect(event?.recommendedIndex).toBe(0);
    expect(event?.actions[0]?.type).toBe("create_milestone");
  });

  it("un `recommendedIndex` oltre la fine ricade su 0, mai fuori dalle opzioni", () => {
    const event = buildEmail({
      classification: { ...(emailRow().classification as object), recommendedIndex: 7 },
    });
    expect(event?.recommendedIndex).toBe(0);
    expect(googleProposalEventSchema.safeParse(event).success).toBe(true);
  });

  it("nessuna proposta eseguibile → nessun evento (non una card che chiede di archiviare)", () => {
    expect(
      buildEmail({ classification: { signal: "none", recommendedIndex: 0, proposals: [] } }),
    ).toBeNull();
    // Anche il jsonb assente o marcio: non c'è niente da proporre.
    expect(buildEmail({ classification: null })).toBeNull();
    expect(buildEmail({ classification: { proposals: "boh" } })).toBeNull();
  });

  it("progetto AMBIGUO → un'opzione «Riguarda …» per candidato", () => {
    // È l'unica domanda che le altre azioni non risolvono: senza progetto certo
    // non si sa nemmeno su cosa aprire una voce. Confermarla riassegna il
    // messaggio e lo rimanda alla classificazione.
    const event = buildEmail({
      projectId: null,
      candidateProjectIds: [PROJECT_A, PROJECT_B],
      classification: { signal: "request", recommendedIndex: 0, proposals: [] },
    });
    expect(event?.options).toHaveLength(3);
    expect(event?.actions).toEqual([
      { type: "choose_project", projectId: PROJECT_A },
      { type: "choose_project", projectId: PROJECT_B },
      { type: "ignore" },
    ]);
    expect(event?.options[0]?.label).toContain("negozio-web");
    // Nessun progetto risolto: la card non ne nomina uno che non c'è.
    expect(event?.projectName).toBeUndefined();
  });

  it("un solo candidato NON è un'ambiguità: nessuna opzione da scegliere", () => {
    // Con un candidato solo il routing lo avrebbe risolto: chiederlo sarebbe
    // rumore su una domanda già risposta.
    expect(
      buildEmail({
        projectId: null,
        candidateProjectIds: [PROJECT_A],
        classification: { signal: "request", recommendedIndex: 0, proposals: [] },
      }),
    ).toBeNull();
  });

  it("le opzioni attive si fermano al tetto, e «Non fare nulla» resta comunque", () => {
    // Il tetto non è estetico: i bottoni di un DM Slack della domanda sono al
    // massimo quattro, e l'ultimo lo prende sempre «Non fare nulla».
    const proposals = Array.from({ length: 6 }, (_, index) => ({
      type: "create_backlog_item",
      projectId: PROJECT_A,
      title: `Voce ${index}`,
      consequence: "…",
    }));
    const event = buildEmail({
      classification: { signal: "request", recommendedIndex: 0, proposals },
    });
    expect(event?.options).toHaveLength(MAX_PROPOSAL_OPTIONS + 1);
    expect(event?.actions).toHaveLength(MAX_PROPOSAL_OPTIONS + 1);
    expect(event?.actions.at(-1)).toEqual({ type: "ignore" });
  });
});

// ---------------------------------------------------------------------------
// Costruzione — calendario
// ---------------------------------------------------------------------------

/** Una riga `calendar_events` pronta per una proposta. */
function calendarRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    title: "Consegna al cliente",
    startsAt: new Date("2026-09-30T09:00:00.000Z"),
    organizer: "pm@acme.com",
    status: "confirmed" as string | null,
    projectId: PROJECT_A as string | null,
    proposalNotificationId: null as string | null,
    outcome: null as Record<string, unknown> | null,
    ...overrides,
  };
}

function buildCalendar(overrides: Record<string, unknown> = {}) {
  return buildCalendarProposalEvent({
    lang: "it",
    event: calendarRow(overrides),
    mailboxEmail: MAILBOX,
    projectNames: NAMES,
  });
}

describe("buildCalendarProposalEvent", () => {
  it("una sola opzione (la milestone) più «Non fare nulla», consigliata la prima", () => {
    const event = buildCalendar();
    expect(event?.source).toBe("calendar");
    // Il segnale è sempre `deadline`: è esattamente ciò che un appuntamento è,
    // e qui non gira nessun modello che possa dire altro.
    expect(event?.signal).toBe("deadline");
    expect(event?.options).toHaveLength(2);
    expect(event?.actions).toHaveLength(2);
    expect(event?.actions[0]).toEqual({
      type: "create_milestone",
      projectId: PROJECT_A,
      name: "Consegna al cliente entro il 2026-09-30",
      dueDate: "2026-09-30",
    });
    expect(event?.actions[1]).toEqual({ type: "ignore" });
    expect(event?.recommendedIndex).toBe(0);
    expect(event?.from).toBe("pm@acme.com");
    expect(event?.projectName).toBe("negozio-web");
  });

  it("il link porta alla GIORNATA dell'appuntamento nel calendario della casella", () => {
    // Non è il permalink dell'evento, e non può esserlo: `htmlLink` non ha una
    // colonna in `calendar_events`, e la proposta si pubblica leggendo la riga.
    expect(buildCalendar()?.messageUrl).toBe(
      `https://calendar.google.com/calendar/u/${encodeURIComponent(MAILBOX)}/r/day/2026/9/30`,
    );
    expect(calendarDayUrl("a@b.test", new Date("2026-01-05T23:30:00.000Z"))).toContain(
      "/r/day/2026/1/5",
    );
  });

  it("il cancello di `isReadyForProposal` vale anche qui, non solo nella query", () => {
    // È il contratto fra la fase 3 e questa: un chiamante nuovo non deve poterlo
    // aggirare scrivendosi una `where` sua.
    expect(buildCalendar({ status: "cancelled" })).toBeNull();
    expect(buildCalendar({ projectId: null })).toBeNull();
    expect(buildCalendar({ proposalNotificationId: randomUUID() })).toBeNull();
    expect(buildCalendar({ outcome: { type: "duplicate" } })).toBeNull();
    // Senza titolo non c'è una milestone che qualcuno confermerebbe con un tap.
    expect(buildCalendar({ title: "  " })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Il cancello prima della publish
// ---------------------------------------------------------------------------

describe("googleProposalEventSchema", () => {
  it("rifiuta un evento con azioni e opzioni di lunghezza diversa", () => {
    const event = buildEmail();
    if (!event) throw new Error("evento non costruito");
    expect(
      googleProposalEventSchema.safeParse({ ...event, actions: event.actions.slice(0, 1) }).success,
    ).toBe(false);
  });

  it("rifiuta un `recommendedIndex` fuori dalle opzioni", () => {
    const event = buildEmail();
    if (!event) throw new Error("evento non costruito");
    expect(googleProposalEventSchema.safeParse({ ...event, recommendedIndex: 9 }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Pubblicazione (Postgres vero)
// ---------------------------------------------------------------------------

async function seedOwner(): Promise<{ userId: string; accountId: string; projectId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `u-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  const [workspace] = await db
    .insert(googleWorkspaces)
    .values({
      name: "Acme",
      domains: ["acme.com"],
      clientId: "client-id",
      clientSecretEncrypted: "blob",
    })
    .returning({ id: googleWorkspaces.id });
  const [account] = await db
    .insert(googleAccounts)
    .values({
      userId: user!.id,
      workspaceId: workspace!.id,
      email: MAILBOX,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: "blob",
    })
    .returning({ id: googleAccounts.id });
  const [project] = await db
    .insert(projects)
    .values({
      name: "negozio-web",
      slug: `negozio-${randomUUID().slice(0, 8)}`,
      ingestionKey: randomUUID(),
    })
    .returning({ id: projects.id });
  return { userId: user!.id, accountId: account!.id, projectId: project!.id };
}

async function seedClassifiedMessage(accountId: string, projectId: string): Promise<string> {
  const [row] = await db
    .insert(emailMessages)
    .values({
      accountId,
      gmailMessageId: `m-${randomUUID()}`,
      threadId: `t-${randomUUID()}`,
      fromAddress: "laura@cliente.test",
      receivedAt: new Date("2026-09-07T08:14:00.000Z"),
      projectId,
      status: "classified",
    })
    .returning({ id: emailMessages.id });
  return row!.id;
}

/** L'evento da pubblicare per quella riga, col progetto seedato. */
function eventFor(projectId: string) {
  const event = buildEmailProposalEvent({
    lang: "it",
    message: emailRow({
      projectId,
      classification: {
        signal: "request",
        recommendedIndex: 0,
        proposals: [
          {
            type: "create_backlog_item",
            projectId,
            title: "Export CSV",
            consequence: "Entra nel backlog.",
          },
        ],
      },
    }),
    mailboxEmail: MAILBOX,
    projectNames: new Map([[projectId, "negozio-web"]]),
  });
  if (!event) throw new Error("evento non costruito");
  return event;
}

describe("publishProposal", () => {
  it("notifica e chiusura della riga nascono INSIEME, e la notifica è del solo proprietario", async () => {
    const { userId, accountId, projectId } = await seedOwner();
    const messageId = await seedClassifiedMessage(accountId, projectId);
    const event = eventFor(projectId);

    const result = await publishProposal(db, {
      event,
      source: "email",
      rowId: messageId,
      mailboxOwnerUserId: userId,
      projectId,
    });

    expect(result.ok).toBe(true);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userId);
    expect(rows[0]?.kind).toBe("google.proposal");
    const [message] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    expect(message?.status).toBe("proposed");
    // ⚠️ Il legame nei due sensi: la riga sa quale card la rappresenta, e la
    // card è quella appena scritta. Senza, la fase D non saprebbe più quale
    // messaggio chiudere quando qualcuno conferma.
    expect(message?.proposalNotificationId).toBe(rows[0]?.id);
  });

  it("una seconda pubblicazione non passa, e NON lascia una notifica orfana", async () => {
    // È la corsa vera: due tick (o due worker) sulla stessa riga. Il claim è
    // l'ultima scrittura della transazione proprio perché il perdente si porti
    // via anche la propria notifica invece di lasciarne una in inbox.
    const { userId, accountId, projectId } = await seedOwner();
    const messageId = await seedClassifiedMessage(accountId, projectId);

    expect((await publishProposal(db, {
      event: eventFor(projectId),
      source: "email",
      rowId: messageId,
      mailboxOwnerUserId: userId,
      projectId,
    })).ok).toBe(true);

    const second = await publishProposal(db, {
      event: eventFor(projectId),
      source: "email",
      rowId: messageId,
      mailboxOwnerUserId: userId,
      projectId,
    });

    expect(second).toEqual({ ok: false, reason: "not_claimable" });
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("nessun destinatario → nessuna scrittura, e la riga resta riproponibile", async () => {
    const { accountId, projectId } = await seedOwner();
    const messageId = await seedClassifiedMessage(accountId, projectId);

    const result = await publishProposal(db, {
      event: eventFor(projectId),
      source: "email",
      rowId: messageId,
      mailboxOwnerUserId: randomUUID(),
      projectId,
      // `publishNotification` è best-effort: su un proprietario inesistente
      // inghiotte e torna 0. Marcare comunque la riga `proposed` la
      // renderebbe una proposta che non esiste, e nessuno la ripescherebbe.
      publish: async () => ({ published: 0 }),
    });

    expect(result).toEqual({ ok: false, reason: "no_recipients" });
    expect(await db.select().from(notifications)).toHaveLength(0);
    const [message] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    expect(message?.status).toBe("classified");
    expect(message?.proposalNotificationId).toBeNull();
  });

  it("un evento disallineato non viene pubblicato affatto", async () => {
    const { userId, accountId, projectId } = await seedOwner();
    const messageId = await seedClassifiedMessage(accountId, projectId);
    const event = eventFor(projectId);

    const result = await publishProposal(db, {
      event: { ...event, actions: event.actions.slice(0, 1) },
      source: "email",
      rowId: messageId,
      mailboxOwnerUserId: userId,
      projectId,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_event" });
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("sul calendario marca `proposal_notification_id` nella stessa transazione", async () => {
    const { userId, accountId, projectId } = await seedOwner();
    const [row] = await db
      .insert(calendarEventsTable)
      .values({
        accountId,
        googleEventId: `e-${randomUUID()}`,
        title: "Consegna al cliente",
        startsAt: new Date("2026-09-30T09:00:00.000Z"),
        organizer: "pm@acme.com",
        status: "confirmed",
        projectId,
        fingerprint: "2026-09-30 consegna al cliente",
      })
      .returning({ id: calendarEventsTable.id });

    const event = buildCalendarProposalEvent({
      lang: "it",
      event: calendarRow({ id: row!.id, projectId }),
      mailboxEmail: MAILBOX,
      projectNames: new Map([[projectId, "negozio-web"]]),
    });
    if (!event) throw new Error("evento di calendario non costruito");

    const result = await publishProposal(db, {
      event,
      source: "calendar",
      rowId: row!.id,
      mailboxOwnerUserId: userId,
      projectId,
    });

    expect(result.ok).toBe(true);
    const [after] = await db
      .select()
      .from(calendarEventsTable)
      .where(eq(calendarEventsTable.id, row!.id));
    const [notification] = await db.select().from(notifications);
    expect(after?.proposalNotificationId).toBe(notification?.id);
    // L'appuntamento non ha un esito: quello lo scrive chi ESEGUE la proposta.
    expect(after?.outcome).toBeNull();
  });
});
