import { randomBytes, randomUUID } from "node:crypto";
import {
  calendarEvents,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projectEmailRoutes,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { GoogleApiError, type GoogleCalendarEvent } from "@stubwise/google";
import type { GoogleAccountCredentials } from "@stubwise/google/credentials";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildMilestoneProposal,
  calendarWindow,
  CALENDAR_LOOKBACK_DAYS,
  CALENDAR_WINDOW_DAYS,
  computeFingerprint,
  eventToRouting,
  isReadyForProposal,
  resolveCalendarProjectId,
  routeEvent,
} from "./calendar.js";
import { pollGoogleOnce, type CalendarClient, type GmailClient, type GooglePollerDeps } from "./poller.js";

/**
 * FASE 3 del tick delle caselle Google (fase 6, Task 9): il calendario.
 *
 * Il file presidia tre cose che il resto del poller non copre:
 *
 *  1. **Il pre-filtro senza AI.** Un evento entra in perimetro per i domini
 *     dei partecipanti o per una parola chiave nel TITOLO, e diventa
 *     candidato a una proposta solo se il progetto è UNO. In parità la riga
 *     esiste ma non è candidata — la stessa regola della posta.
 *  2. **Il non-riproporre.** L'impronta giorno+titolo è ciò che rende «lo
 *     stesso appuntamento» un invito ricreato con un id nuovo e una riunione
 *     spostata di qualche ora: in nessuno dei due casi nasce una seconda
 *     proposta.
 *  3. **I DUE cursori.** Un guasto del calendario mette la casella in backoff
 *     ma NON annulla il cursore che Gmail si è appena guadagnato: è la
 *     ragione per cui `applySuccess` non scrive più i cursori.
 */

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let db: Db;

const ENCRYPTION_KEY = randomBytes(32);
const MAILBOX = "operatore@acme.com";

/** Un partecipante SENZA stato di risposta noto (fase 9, Task 2). */
function att(email: string): { email: string; responseStatus: null } {
  return { email, responseStatus: null };
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(calendarEvents);
  await db.delete(notifications);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
  await db.delete(projectEmailRoutes);
  await db.delete(projects);
  await db.delete(users);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.stop();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function seedProject(name: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({
      name,
      slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      ingestionKey: randomUUID(),
    })
    .returning({ id: projects.id });
  return row!.id;
}

async function seedAccount(
  overrides: Partial<typeof googleAccounts.$inferInsert> = {},
): Promise<typeof googleAccounts.$inferSelect> {
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
      nextSyncAt: new Date(Date.now() - 60_000),
      ...overrides,
    })
    .returning();
  return account!;
}

function credentialsFor(account: typeof googleAccounts.$inferSelect): GoogleAccountCredentials {
  return {
    accountId: account.id,
    userId: account.userId,
    workspaceId: account.workspaceId,
    email: account.email,
    googleSub: account.googleSub,
    refreshToken: "refresh",
    clientId: "client-id",
    clientSecret: "client-secret",
    domains: ["acme.com"],
    scopes: [],
    proposalsEnabled: account.proposalsEnabled,
    gmailHistoryId: account.gmailHistoryId,
    calendarSyncToken: account.calendarSyncToken,
    disabledAt: account.disabledAt,
  };
}

/** Un evento normalizzato come lo restituisce `@stubwise/google`. */
function event(input: Partial<GoogleCalendarEvent> & { id: string }): GoogleCalendarEvent {
  return {
    status: "confirmed",
    title: "Revisione portale",
    description: null,
    allDay: false,
    startsAt: new Date("2026-10-12T09:00:00.000Z"),
    endsAt: new Date("2026-10-12T10:00:00.000Z"),
    attendees: [att("cliente@cliente.com"), att(MAILBOX)],
    organizer: MAILBOX,
    htmlLink: null,
    updatedAt: null,
    recurringEventId: null,
    originalStartTime: null,
    ...input,
  };
}

/** Gmail finto MINIMALE: qui la fase 1 non deve fare niente e non deve rompersi. */
function quietGmail(setup: { historyError?: unknown } = {}): GmailClient & { calls: string[] } {
  const calls: string[] = [];
  const client = {
    calls,
    refreshAccessToken: async () => {
      calls.push("refresh");
      return {
        accessToken: "at",
        expiresInSeconds: 3600,
        refreshToken: null,
        scopes: [],
        tokenType: "Bearer",
        idToken: null,
      };
    },
    listHistory: async () => {
      calls.push("history");
      if (setup.historyError) throw setup.historyError;
      return { addedMessageIds: [], historyId: "2000", nextPageToken: null };
    },
    listMessages: async () => {
      calls.push("list");
      return { messageIds: [], nextPageToken: null };
    },
    getMessageMetadata: async () => {
      throw new Error("non previsto");
    },
    getMessageFull: async () => {
      throw new Error("non previsto");
    },
  };
  return client as unknown as GmailClient & { calls: string[] };
}

interface ListEventsCall {
  syncToken?: string | null;
  timeMin?: Date | null;
  timeMax?: Date | null;
  showDeleted?: boolean;
  pageToken?: string | null;
}

/**
 * Calendar finto: risponde con una CODA di pagine, così si può simulare sia il
 * 410 sia la paginazione. Registra ogni chiamata per verificare che la
 * finestra e il `syncToken` siano quelli attesi.
 */
function fakeCalendar(
  pages: (
    | { events: GoogleCalendarEvent[]; nextPageToken?: string | null; nextSyncToken?: string | null }
    | { error: unknown }
  )[],
): CalendarClient & { calls: ListEventsCall[] } {
  const calls: ListEventsCall[] = [];
  const queue = [...pages];
  const client = {
    calls,
    listEvents: async (input: ListEventsCall) => {
      calls.push(input);
      const next = queue.shift() ?? { events: [], nextPageToken: null, nextSyncToken: null };
      if ("error" in next) throw next.error;
      return {
        events: next.events,
        nextPageToken: next.nextPageToken ?? null,
        nextSyncToken: next.nextSyncToken ?? null,
      };
    },
  };
  return client as unknown as CalendarClient & { calls: ListEventsCall[] };
}

function deps(
  account: typeof googleAccounts.$inferSelect,
  calendar: CalendarClient,
  overrides: Partial<GooglePollerDeps> = {},
): GooglePollerDeps {
  return {
    db,
    encryptionKey: ENCRYPTION_KEY,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    gmail: quietGmail(),
    calendar,
    loadCredentials: async () => credentialsFor(account),
    intervalMinutes: 5,
    retentionDays: 90,
    lang: "it",
    // ⚠️ FASE 4 SPENTA di default in questo file, e non per comodità: dal Task
    // 10 il tick PUBBLICA le righe pronte nello stesso giro, quindi
    // `isReadyForProposal` — che è ciò che quasi tutti i test qui osservano —
    // tornerebbe `false` un istante dopo, e sui sintomi non si distinguerebbe
    // «la fase 3 non l'ha resa candidata» da «la fase 4 se l'è presa». Il
    // PASSAGGIO fra le due fasi ha un test suo qui sotto, che il flag lo
    // riaccende apposta.
    proposeMaxPerTick: 0,
    ...overrides,
  };
}

async function rows(): Promise<(typeof calendarEvents.$inferSelect)[]> {
  return db.select().from(calendarEvents).orderBy(calendarEvents.googleEventId);
}

async function reload(id: string): Promise<typeof googleAccounts.$inferSelect> {
  const [row] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, id));
  return row!;
}

// ---------------------------------------------------------------------------
// Parte pura
// ---------------------------------------------------------------------------

describe("impronta e proposta (funzioni pure)", () => {
  it("la finestra copre 30 giorni indietro e 60 avanti (fase 9, Task 1)", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const { timeMin, timeMax } = calendarWindow(now);

    const backDays = (now.getTime() - timeMin.getTime()) / 86_400_000;
    const forwardDays = (timeMax.getTime() - now.getTime()) / 86_400_000;
    expect(backDays).toBe(CALENDAR_LOOKBACK_DAYS);
    expect(forwardDays).toBe(CALENDAR_WINDOW_DAYS);
  });

  it("l'impronta è giorno + titolo normalizzato, non l'orario", () => {
    const morning = computeFingerprint("  Revisione   Portale ", new Date("2026-10-12T09:00:00Z"));
    const evening = computeFingerprint("revisione portale", new Date("2026-10-12T18:30:00Z"));
    const nextDay = computeFingerprint("Revisione portale", new Date("2026-10-13T09:00:00Z"));

    expect(morning).toBe(evening);
    expect(nextDay).not.toBe(morning);
  });

  it("il routing legge organizzatore e partecipanti, mai le etichette", () => {
    const routing = eventToRouting(event({ id: "e1" }));

    expect(routing.fromAddress).toBe(MAILBOX);
    expect(routing.toAddresses).toEqual(["cliente@cliente.com", MAILBOX]);
    expect(routing.subject).toBe("Revisione portale");
    // Un evento non ha etichette Gmail: una regola `gmail_label` non combacia
    // mai, ed è il comportamento voluto.
    expect(routing.labels).toEqual([]);
    expect(routing.text).toBeUndefined();
  });

  it("una regola gmail_label non fa entrare un evento in perimetro", () => {
    const result = routeEvent(event({ id: "e1" }), [
      { projectId: "p1", kind: "gmail_label", value: "revisione portale" },
    ]);

    expect(result.inScope).toBe(false);
  });

  it("la proposta è «<titolo> entro il <data>», e manca se manca il titolo", () => {
    const startsAt = new Date("2026-10-12T09:00:00Z");

    expect(buildMilestoneProposal("it", { title: "Revisione portale", startsAt })).toEqual({
      name: "Revisione portale entro il 2026-10-12",
      dueDate: "2026-10-12",
    });
    expect(buildMilestoneProposal("it", { title: "   ", startsAt })).toBeNull();
    expect(buildMilestoneProposal("it", { title: "x", startsAt: null })).toBeNull();
  });

  it("è pronta per una proposta solo la riga aperta con un progetto certo", () => {
    const open = {
      status: "confirmed",
      projectId: "p1",
      proposalNotificationId: null,
      outcome: null,
    };

    expect(isReadyForProposal(open)).toBe(true);
    expect(isReadyForProposal({ ...open, projectId: null })).toBe(false);
    expect(isReadyForProposal({ ...open, status: "cancelled" })).toBe(false);
    expect(isReadyForProposal({ ...open, proposalNotificationId: "n1" })).toBe(false);
    expect(isReadyForProposal({ ...open, outcome: { type: "cancelled" } })).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Fase 7b (Task 4): un'occorrenza di SERIE ha un cancello in più.
  // -------------------------------------------------------------------------

  describe("isReadyForProposal — cancello di serie (fase 7b)", () => {
    const now = new Date("2026-09-09T00:00:00.000Z");
    const openSeriesRow = {
      status: "confirmed",
      projectId: "p1",
      proposalNotificationId: null,
      outcome: null,
      recurringEventId: "serie-1",
      startsAt: new Date("2026-09-11T00:00:00.000Z"), // fra 2 giorni
    };

    it("una serie MAI configurata (nessun contesto passato) non è mai pronta", () => {
      expect(isReadyForProposal(openSeriesRow)).toBe(false);
    });

    it("una serie configurata ma SPENTA non è mai pronta", () => {
      expect(
        isReadyForProposal(openSeriesRow, {
          now,
          series: { enabled: false, leadDays: 2, action: "milestone", auto: false, projectId: "p1" },
        }),
      ).toBe(false);
    });

    it("serie accesa, lead_days: 2 — niente a 5 giorni, pronta a 2", () => {
      const context = {
        now,
        series: { enabled: true, leadDays: 2, action: "milestone" as const, auto: false, projectId: "p1" },
      };
      expect(
        isReadyForProposal({ ...openSeriesRow, startsAt: new Date("2026-09-14T00:00:00.000Z") }, context),
      ).toBe(false); // fra 5 giorni
      expect(
        isReadyForProposal({ ...openSeriesRow, startsAt: new Date("2026-09-11T00:00:00.000Z") }, context),
      ).toBe(true); // fra 2 giorni
    });

    it("un'occorrenza già passata non propone", () => {
      expect(
        isReadyForProposal(
          { ...openSeriesRow, startsAt: new Date("2026-09-08T00:00:00.000Z") },
          { now, series: { enabled: true, leadDays: 2, action: "milestone", auto: false, projectId: "p1" } },
        ),
      ).toBe(false);
    });

    // "Una proposta alla volta per serie" NON è un cancello di
    // `isReadyForProposal`: vive nel propose phase del poller (NOT EXISTS +
    // dedup per-tick, vedi `poller.test.ts`), non qui — fix di review, vedi
    // il docblock di `CalendarSeriesProposalContext`.

    it("un evento SINGOLO (recurringEventId null) ignora il contesto di serie: comportamento invariato", () => {
      expect(
        isReadyForProposal(
          { ...openSeriesRow, recurringEventId: null, startsAt: new Date("2035-01-01T00:00:00.000Z") },
          { now, series: null },
        ),
      ).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Fix di review: il progetto di un'occorrenza di serie è quello FISSATO
    // sulla serie, mai quello ri-dedotto dal routing su quella riga — il
    // finding che conta di questo giro.
    // -----------------------------------------------------------------------

    it("serie accesa con progetto fissato P: pronta anche se il routing su QUESTA riga ha risolto Q", () => {
      const rowRoutedToQ = { ...openSeriesRow, projectId: "q-diverso" };
      const context = {
        now,
        series: { enabled: true, leadDays: 2, action: "milestone" as const, auto: false, projectId: "p-fissato" },
      };
      expect(isReadyForProposal(rowRoutedToQ, context)).toBe(true);
      // Non basta essere "pronta": deve essere pronta sul progetto GIUSTO.
      expect(resolveCalendarProjectId(rowRoutedToQ, context)).toBe("p-fissato");
    });

    it("serie accesa con progetto fissato P: pronta anche se il routing su questa riga non ha risolto NULLA", () => {
      const rowUnrouted = { ...openSeriesRow, projectId: null };
      const context = {
        now,
        series: { enabled: true, leadDays: 2, action: "milestone" as const, auto: false, projectId: "p-fissato" },
      };
      expect(isReadyForProposal(rowUnrouted, context)).toBe(true);
      expect(resolveCalendarProjectId(rowUnrouted, context)).toBe("p-fissato");
    });

    it("serie accesa ma senza progetto fissato (non dovrebbe succedere: enabled:true lo richiede) — mai pronta, mai un fallback sul routing", () => {
      const context = {
        now,
        series: { enabled: true, leadDays: 2, action: "milestone" as const, auto: false, projectId: null },
      };
      // `openSeriesRow.projectId` è "p1", non nullo: se ci fosse un fallback
      // sul routing questo tornerebbe pronta. Non deve.
      expect(isReadyForProposal(openSeriesRow, context)).toBe(false);
      expect(resolveCalendarProjectId(openSeriesRow, context)).toBeNull();
    });

    it("un evento SINGOLO usa sempre il progetto ri-dedotto dal routing sulla riga, mai un contesto di serie", () => {
      const singleRow = { ...openSeriesRow, recurringEventId: null, projectId: "q-routing" };
      expect(resolveCalendarProjectId(singleRow)).toBe("q-routing");
      expect(
        resolveCalendarProjectId(singleRow, {
          now,
          series: { enabled: true, leadDays: 2, action: "milestone", auto: false, projectId: "p-fissato" },
        }),
      ).toBe("q-routing");
    });
  });
});

// ---------------------------------------------------------------------------
// Fase 3 dentro il tick
// ---------------------------------------------------------------------------

describe("pre-filtro degli eventi", () => {
  it("un partecipante del dominio di una regola risolve il progetto", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();
    const calendar = fakeCalendar([{ events: [event({ id: "e1" })], nextSyncToken: "tok-1" }]);

    const stats = await pollGoogleOnce(deps(account, calendar));

    expect(stats).toMatchObject({ calendarEvents: 1, calendarReady: 1, calendarCancelled: 0 });
    const [row] = await rows();
    expect(row).toMatchObject({
      accountId: account.id,
      googleEventId: "e1",
      title: "Revisione portale",
      allDay: false,
      attendees: [att("cliente@cliente.com"), att(MAILBOX)],
      organizer: MAILBOX,
      status: "confirmed",
      projectId,
      proposalNotificationId: null,
      outcome: null,
      fingerprint: "2026-10-12 revisione portale",
    });
    expect(isReadyForProposal(row!)).toBe(true);
    // Il cursore del calendario è avanzato, quello di Gmail è affare suo.
    expect((await reload(account.id)).calendarSyncToken).toBe("tok-1");
  });

  it("lo stato di risposta e il link diretto si scrivono (fase 9, Task 2)", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();
    const calendar = fakeCalendar([
      {
        events: [
          event({
            id: "e1",
            attendees: [
              { email: "cliente@cliente.com", responseStatus: "accepted" },
              { email: MAILBOX, responseStatus: "needsAction" },
            ],
            htmlLink: "https://calendar.google.test/e1",
          }),
        ],
        nextSyncToken: "tok-1",
      },
    ]);

    await pollGoogleOnce(deps(account, calendar));

    const [row] = await rows();
    expect(row!.attendees).toEqual([
      { email: "cliente@cliente.com", responseStatus: "accepted" },
      { email: MAILBOX, responseStatus: "needsAction" },
    ]);
    expect(row!.htmlLink).toBe("https://calendar.google.test/e1");
    // L'attribuzione continua a leggere solo l'email, invariata.
    expect(row!.projectId).toBe(projectId);
  });

  it("una parola chiave nel titolo basta a risolvere il progetto", async () => {
    const projectId = await seedProject("Acme");
    await db.insert(projectEmailRoutes).values({ projectId, kind: "keyword", value: "portale" });
    const account = await seedAccount();
    const calendar = fakeCalendar([
      {
        events: [event({ id: "e1", attendees: [att("esterno@altro.example")], organizer: null })],
        nextSyncToken: "tok-1",
      },
    ]);

    await pollGoogleOnce(deps(account, calendar));

    const [row] = await rows();
    expect(row!.projectId).toBe(projectId);
    expect(isReadyForProposal(row!)).toBe(true);
  });

  it("un evento di tre settimane fa viene scritto, uno di sei mesi fa no (fase 9, Task 1)", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();
    const now = new Date("2026-09-10T12:00:00Z");
    const threeWeeksAgo = new Date("2026-08-20T09:00:00Z"); // dentro i 30 gg indietro
    const sixMonthsAgo = new Date("2026-03-10T09:00:00Z"); // fuori
    const calendar = fakeCalendar([
      {
        events: [
          event({ id: "recente", startsAt: threeWeeksAgo }),
          event({ id: "vecchio", startsAt: sixMonthsAgo }),
        ],
        nextSyncToken: "tok-1",
      },
    ]);

    const stats = await pollGoogleOnce(deps(account, calendar, { now: () => now }));

    expect(stats).toMatchObject({ calendarEvents: 1, calendarReady: 1 });
    const all = await rows();
    expect(all.map((r) => r.googleEventId)).toEqual(["recente"]);
  });

  it("un evento che nessuna regola riconosce non produce nessuna riga", async () => {
    await seedProject("Acme");
    const account = await seedAccount();
    const calendar = fakeCalendar([
      { events: [event({ id: "e1", title: "Dentista", attendees: [], organizer: null })] },
    ]);

    const stats = await pollGoogleOnce(deps(account, calendar));

    expect(stats.calendarEvents).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("in parità fra due progetti la riga esiste ma NON è candidata", async () => {
    const first = await seedProject("Alfa");
    const second = await seedProject("Beta");
    await db.insert(projectEmailRoutes).values([
      { projectId: first, kind: "sender_domain", value: "cliente.com" },
      { projectId: second, kind: "keyword", value: "portale" },
    ]);
    const account = await seedAccount();
    const calendar = fakeCalendar([{ events: [event({ id: "e1" })], nextSyncToken: "tok-1" }]);

    const stats = await pollGoogleOnce(deps(account, calendar));

    expect(stats).toMatchObject({ calendarEvents: 1, calendarReady: 0 });
    const [row] = await rows();
    expect(row!.projectId).toBeNull();
    expect(isReadyForProposal(row!)).toBe(false);
  });
});

describe("non riproporre lo stesso appuntamento", () => {
  it("stesso giorno e stesso titolo sotto un ID nuovo: riga duplicata, non candidata", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();

    const first = fakeCalendar([{ events: [event({ id: "e1" })], nextSyncToken: "tok-1" }]);
    expect((await pollGoogleOnce(deps(account, first))).calendarReady).toBe(1);

    // L'invito viene cancellato e ricreato: id nuovo, stesso giorno, stesso
    // titolo, orario diverso.
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const second = fakeCalendar([
      {
        events: [event({ id: "e2", startsAt: new Date("2026-10-12T15:00:00.000Z") })],
        nextSyncToken: "tok-2",
      },
    ]);
    const stats = await pollGoogleOnce(deps(await reload(account.id), second));

    expect(stats).toMatchObject({ calendarEvents: 1, calendarReady: 0 });
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[1]!.outcome).toEqual({ type: "duplicate", ofGoogleEventId: "e1" });
    expect(isReadyForProposal(all[1]!)).toBe(false);
    // La prima resta candidata: è lei l'appuntamento da proporre.
    expect(isReadyForProposal(all[0]!)).toBe(true);
  });

  it("due eventi con la stessa impronta nello STESSO giro: una sola candidata", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();
    const calendar = fakeCalendar([
      {
        events: [
          event({ id: "e1" }),
          event({ id: "e2", startsAt: new Date("2026-10-12T16:00:00.000Z") }),
        ],
        nextSyncToken: "tok-1",
      },
    ]);

    const stats = await pollGoogleOnce(deps(account, calendar));

    expect(stats).toMatchObject({ calendarEvents: 2, calendarReady: 1 });
    expect((await rows()).filter((row) => isReadyForProposal(row))).toHaveLength(1);
  });

  it("stesso evento spostato di qualche ora: dati freschi, nessuna riga nuova", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();

    const first = fakeCalendar([{ events: [event({ id: "e1" })], nextSyncToken: "tok-1" }]);
    await pollGoogleOnce(deps(account, first));

    // La fase D ha pubblicato la proposta: la riga non è più candidata.
    const [notification] = await db
      .insert(notifications)
      .values({ userId: account.userId, kind: "google.proposal", event: {} })
      .returning({ id: notifications.id });
    await db
      .update(calendarEvents)
      .set({ proposalNotificationId: notification!.id })
      .where(eq(calendarEvents.googleEventId, "e1"));

    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const second = fakeCalendar([
      {
        events: [
          event({
            id: "e1",
            startsAt: new Date("2026-10-12T15:00:00.000Z"),
            endsAt: new Date("2026-10-12T16:00:00.000Z"),
            attendees: [att("cliente@cliente.com"), att(MAILBOX), att("nuovo@cliente.com")],
          }),
        ],
        nextSyncToken: "tok-2",
      },
    ]);
    const stats = await pollGoogleOnce(deps(await reload(account.id), second));

    expect(stats).toMatchObject({ calendarEvents: 1, calendarReady: 0 });
    const all = await rows();
    expect(all).toHaveLength(1);
    // Dati freschi…
    expect(all[0]!.startsAt.toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(all[0]!.attendees.map((a) => a.email)).toContain("nuovo@cliente.com");
    // …ma la proposta già pubblicata non si tocca: nessuna seconda proposta.
    expect(all[0]!.proposalNotificationId).toBe(notification!.id);
    expect(isReadyForProposal(all[0]!)).toBe(false);
  });
});

describe("cancellazioni", () => {
  it("un evento cancellato chiude la riga con outcome `cancelled`, senza altro", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();

    await pollGoogleOnce(
      deps(account, fakeCalendar([{ events: [event({ id: "e1" })], nextSyncToken: "tok-1" }])),
    );

    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const stats = await pollGoogleOnce(
      deps(
        await reload(account.id),
        fakeCalendar([
          {
            events: [event({ id: "e1", status: "cancelled", title: "", attendees: [] })],
            nextSyncToken: "tok-2",
          },
        ]),
      ),
    );

    expect(stats).toMatchObject({ calendarCancelled: 1, calendarEvents: 0, calendarReady: 0 });
    const [row] = await rows();
    expect(row!.status).toBe("cancelled");
    expect(row!.outcome).toEqual({ type: "cancelled" });
    // Il progetto resta (è la storia della riga), ma non è più candidata.
    expect(row!.projectId).toBe(projectId);
    expect(isReadyForProposal(row!)).toBe(false);
  });

  it("un evento cancellato mai visto non crea nessuna riga", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();
    const calendar = fakeCalendar([
      { events: [event({ id: "mai-visto", status: "cancelled" })], nextSyncToken: "tok-1" },
    ]);

    const stats = await pollGoogleOnce(deps(account, calendar));

    expect(stats).toMatchObject({ calendarCancelled: 0, calendarEvents: 0 });
    expect(await rows()).toEqual([]);
  });
});

describe("cursore del calendario", () => {
  it("il primo giro usa la finestra di 60 giorni, i successivi il syncToken", async () => {
    const account = await seedAccount();
    const calendar = fakeCalendar([{ events: [], nextSyncToken: "tok-1" }]);

    await pollGoogleOnce(deps(account, calendar));

    expect(calendar.calls).toHaveLength(1);
    const first = calendar.calls[0]!;
    expect(first.syncToken).toBeUndefined();
    // Task 6: `showDeleted` è acceso anche nel resync per finestra, non solo
    // in incrementale — così un evento cancellato fra l'ultimo sync valido e
    // un 410 non resta candidato per sempre (vedi il docblock di
    // `collectCalendarEvents` in poller.ts, e la describe dedicata in
    // poller.test.ts).
    expect(first.showDeleted).toBe(true);
    // Fase 9, Task 1: la finestra ora guarda anche indietro — lo span totale
    // è avanti + indietro, non solo CALENDAR_WINDOW_DAYS.
    const spanDays = (first.timeMax!.getTime() - first.timeMin!.getTime()) / 86_400_000;
    expect(Math.round(spanDays)).toBe(CALENDAR_WINDOW_DAYS + CALENDAR_LOOKBACK_DAYS);
    expect((await reload(account.id)).calendarSyncToken).toBe("tok-1");

    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const incremental = fakeCalendar([{ events: [], nextSyncToken: "tok-2" }]);
    await pollGoogleOnce(deps(await reload(account.id), incremental));

    expect(incremental.calls[0]).toMatchObject({ syncToken: "tok-1", showDeleted: true });
    expect(incremental.calls[0]!.timeMin).toBeUndefined();
    expect((await reload(account.id)).calendarSyncToken).toBe("tok-2");
  });

  it("410: azzera il token PRIMA del resync, poi riparte dalla finestra", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({ calendarSyncToken: "vecchio" });
    const calendar = fakeCalendar([
      {
        error: new GoogleApiError({
          api: "calendar.events.list",
          status: 410,
          code: "sync_token_expired",
          reason: "fullSyncRequired",
        }),
      },
      { events: [event({ id: "e1" })], nextSyncToken: "tok-nuovo" },
    ]);

    const stats = await pollGoogleOnce(deps(account, calendar));

    expect(calendar.calls[0]!.syncToken).toBe("vecchio");
    expect(calendar.calls[1]!.syncToken).toBeUndefined();
    expect(calendar.calls[1]!.timeMin).toBeInstanceOf(Date);
    expect(stats.calendarReady).toBe(1);
    const reloaded = await reload(account.id);
    expect(reloaded.calendarSyncToken).toBe("tok-nuovo");
    // Il 410 non è un errore della casella: nessun tentativo contato.
    expect(reloaded.syncAttempts).toBe(0);
    expect(reloaded.disabledAt).toBeNull();
  });

  it("410 seguito da un guasto: il token scaduto resta azzerato", async () => {
    const account = await seedAccount({ calendarSyncToken: "vecchio" });
    const calendar = fakeCalendar([
      {
        error: new GoogleApiError({
          api: "calendar.events.list",
          status: 410,
          code: "sync_token_expired",
          reason: "fullSyncRequired",
        }),
      },
      { error: new Error("connessione interrotta") },
    ]);

    await pollGoogleOnce(deps(account, calendar));

    const reloaded = await reload(account.id);
    // Il tick dopo NON ripaga il 410: riparte direttamente dalla finestra.
    expect(reloaded.calendarSyncToken).toBeNull();
    expect(reloaded.syncAttempts).toBe(1);
  });

  it("paginazione: il token si salva solo dall'ULTIMA pagina", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();
    const calendar = fakeCalendar([
      { events: [event({ id: "e1" })], nextPageToken: "p2" },
      {
        events: [event({ id: "e2", title: "Retro portale" })],
        nextSyncToken: "tok-finale",
      },
    ]);

    const stats = await pollGoogleOnce(deps(account, calendar));

    expect(calendar.calls).toHaveLength(2);
    expect(calendar.calls[1]!.pageToken).toBe("p2");
    expect(stats.calendarEvents).toBe(2);
    expect((await reload(account.id)).calendarSyncToken).toBe("tok-finale");
  });
});

describe("errori della fase 3 e i due cursori", () => {
  it("un guasto del calendario mette in backoff MA salva il cursore di Gmail", async () => {
    const account = await seedAccount({ gmailHistoryId: "1000" });
    const gmail = quietGmail();
    const calendar = fakeCalendar([{ error: new Error("connessione interrotta") }]);

    const stats = await pollGoogleOnce(deps(account, calendar, { gmail }));

    expect(stats.disabled).toBe(0);
    const reloaded = await reload(account.id);
    // Gmail è andata: il suo cursore è avanzato e NON è stato annullato dal
    // guasto della fase 3.
    expect(reloaded.gmailHistoryId).toBe("2000");
    // Il calendario no: backoff, e il giro non è "riuscito".
    expect(reloaded.syncAttempts).toBe(1);
    expect(reloaded.lastSyncAt).toBeNull();
    expect(reloaded.calendarSyncToken).toBeNull();
  });

  it("un errore FATALE del calendario disabilita la casella come uno di Gmail", async () => {
    const account = await seedAccount();
    const calendar = fakeCalendar([
      {
        error: new GoogleApiError({
          api: "calendar.events.list",
          status: 403,
          code: "insufficient_scope",
          reason: "insufficientPermissions",
        }),
      },
    ]);

    const stats = await pollGoogleOnce(deps(account, calendar));

    expect(stats.disabled).toBe(1);
    expect((await reload(account.id)).disabledReason).toBe("insufficient_scope");
  });
});

// ---------------------------------------------------------------------------
// Il passaggio dalla fase 3 alla fase 4
// ---------------------------------------------------------------------------

/**
 * `isReadyForProposal` è il CONTRATTO fra le due fasi, e un contratto lo si
 * verifica dalle due parti: gli altri test di questo file guardano che la fase
 * 3 renda candidata la riga giusta (con la fase 4 spenta, vedi `deps`); questo
 * guarda che, riaccesa, la fase 4 la prenda davvero. Senza, tutta la fase 6
 * girerebbe a vuoto: righe pronte che nessuno vede mai.
 */
describe("dalla riga candidata alla proposta in inbox", () => {
  it("una riga pronta diventa una proposta nello STESSO giro", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount();
    const calendar = fakeCalendar([{ events: [event({ id: "e1" })], nextSyncToken: "tok-1" }]);

    const stats = await pollGoogleOnce(deps(account, calendar, { proposeMaxPerTick: 20 }));

    expect(stats).toMatchObject({ calendarReady: 1, proposed: 1 });
    const [row] = await rows();
    // Non è più candidata proprio perché è stata proposta: è il contratto che
    // si chiude, non una riga persa.
    expect(isReadyForProposal(row!)).toBe(false);
    const cards = await db.select().from(notifications);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe("google.proposal");
    // ⚠️ Audience `mailbox_owner`: la vede solo chi ha collegato la casella.
    expect(cards[0]?.userId).toBe(account.userId);
    expect(row!.proposalNotificationId).toBe(cards[0]?.id);
  });
});
