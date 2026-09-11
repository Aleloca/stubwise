import { randomBytes, randomUUID } from "node:crypto";
import {
  aiJobs,
  backlogItems,
  backlogJobs,
  calendarEvents,
  calendarSeries,
  emailMessages,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  instanceSettings,
  milestones,
  notifications,
  projectEmailRoutes,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  GoogleApiError,
  MAX_TEXT_LENGTH,
  TEXT_TRUNCATION_MARKER,
  type GoogleCalendarEvent,
} from "@stubwise/google";
import type { GoogleAccountCredentials } from "@stubwise/google/credentials";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions, AgentRunResult, AgentRunner } from "../agent/runner.js";
import {
  claimDueAccounts,
  pollGoogleOnce,
  pruneOldEmails,
  startGooglePoller,
  type CalendarClient,
  type GmailClient,
  type GooglePollerDeps,
} from "./poller.js";
import { GMAIL_MAX_SYNC_ATTEMPTS, GMAIL_RESYNC_MAX_MESSAGES, GMAIL_RESYNC_QUERY } from "./sync.js";

/**
 * POLLER GMAIL (fase 6, Task 7).
 *
 * Il client Google è FINTO a livello di funzioni (`GmailClient`), non di
 * `fetch`: l'HTTP — URL, header, normalizzazione degli errori — è già coperto
 * dai test di `@stubwise/google`, e rifarlo qui vorrebbe dire testare due volte
 * la stessa cosa e nessuna volta ciò che questo file presidia:
 *
 *  1. **La spesa.** Il pre-filtro deve tagliare PRIMA del corpo: un messaggio
 *     fuori perimetro non deve produrre nemmeno una `messages.get full`. Lo si
 *     verifica contando le chiamate al fake, non guardando il DB.
 *  2. **L'idempotenza.** Due giri sulla stessa history non scrivono due righe:
 *     è l'unique `(account_id, gmail_message_id)` + `onConflictDoNothing`.
 *  3. **La reazione all'errore.** Fatale = casella spenta subito e senza
 *     ritentativi; transitorio = backoff (e il `Retry-After` di Google vince
 *     sulla nostra formula). Sbagliare direzione costa in entrambi i sensi.
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
  await db.delete(notifications);
  await db.delete(emailProposals);
  await db.delete(emailMessages);
  await db.delete(calendarSeries);
  await db.delete(calendarEvents);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
  await db.delete(projectEmailRoutes);
  await db.delete(projects);
  await db.delete(users);
  // Singleton (id=1): senza questa riga un test che tocca l'ammissione
  // lascerebbe la configurazione sporca per quelli dopo.
  await db.delete(instanceSettings);
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
      ...overrides,
    })
    .returning();
  return account!;
}

/** Le credenziali che il poller userebbe: il decrypt vero non c'entra col tick. */
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

/** Un messaggio Gmail finto: header in minuscolo, come li normalizza il client. */
function message(input: {
  id: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  labels?: string[];
  body?: string;
  historyId?: string;
}) {
  const headers: Record<string, string> = {
    from: input.from ?? "Cliente <cliente@cliente.com>",
    to: input.to ?? MAILBOX,
    subject: input.subject ?? "Una richiesta",
  };
  // Il Cc è opzionale (fase 6c Task 2): assente per la maggior parte dei
  // test, che non lo esercitano — `parseAddressList` su un header mancante
  // torna comunque una lista vuota, comportamento invariato.
  if (input.cc !== undefined) headers.cc = input.cc;
  return {
    id: input.id,
    threadId: `thread-${input.id}`,
    labelIds: input.labels ?? ["INBOX"],
    snippet: "",
    historyId: input.historyId ?? null,
    internalDate: new Date("2026-09-07T08:00:00.000Z"),
    headers,
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from(input.body ?? "Ciao, mi servirebbe una mano.").toString("base64url") },
    },
  };
}

/** Client Google finto: registra ogni chiamata e risponde da una mappa. */
function fakeGmail(setup: {
  history?: { addedMessageIds: string[]; historyId: string | null } | (() => never);
  historyError?: unknown;
  listed?: string[];
  messages?: Record<string, ReturnType<typeof message>>;
  refreshError?: unknown;
  metadataError?: unknown;
}): GmailClient & { calls: string[]; listQueries: string[] } {
  const calls: string[] = [];
  const listQueries: string[] = [];
  const client = {
    calls,
    listQueries,
    refreshAccessToken: async () => {
      calls.push("refresh");
      if (setup.refreshError) throw setup.refreshError;
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
      const page = setup.history ?? { addedMessageIds: [], historyId: null };
      if (typeof page === "function") return page();
      return { ...page, nextPageToken: null };
    },
    listMessages: async (input: { q?: string }) => {
      calls.push("list");
      listQueries.push(input.q ?? "");
      return { messageIds: setup.listed ?? [], nextPageToken: null };
    },
    getMessageMetadata: async (input: { id: string }) => {
      calls.push(`metadata:${input.id}`);
      if (setup.metadataError) throw setup.metadataError;
      const found = setup.messages?.[input.id];
      if (!found) throw new Error(`messaggio ${input.id} non previsto dal fake`);
      // `format=metadata` NON restituisce il corpo: se il poller lo usasse
      // comunque, qui non lo troverebbe — ed è il punto.
      const withoutBody = { ...found };
      delete (withoutBody as { payload?: unknown }).payload;
      return withoutBody;
    },
    getMessageFull: async (input: { id: string }) => {
      calls.push(`full:${input.id}`);
      const found = setup.messages?.[input.id];
      if (!found) throw new Error(`messaggio ${input.id} non previsto dal fake`);
      return found;
    },
  };
  return client as unknown as GmailClient & { calls: string[]; listQueries: string[] };
}

/**
 * Calendar finto MUTO: la fase 3 ha il suo file di test
 * (`calendar.test.ts`), qui serve solo che non parli con la rete e non
 * sporchi le sequenze di chiamate che questi test verificano su `gmail.calls`.
 */
const quietCalendar: CalendarClient = {
  listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: null }),
};

function deps(
  account: typeof googleAccounts.$inferSelect,
  gmail: GmailClient,
  overrides: Partial<GooglePollerDeps> = {},
): GooglePollerDeps {
  return {
    db,
    encryptionKey: ENCRYPTION_KEY,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    gmail,
    calendar: quietCalendar,
    loadCredentials: async () => credentialsFor(account),
    intervalMinutes: 5,
    retentionDays: 90,
    ...overrides,
  };
}

async function reload(id: string): Promise<typeof googleAccounts.$inferSelect> {
  const [row] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, id));
  return row!;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

describe("claim delle caselle", () => {
  it("reclama solo le caselle dovute e sposta subito next_sync_at", async () => {
    const due = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const later = await seedAccount({
      email: `altra-${randomUUID()}@acme.com`,
      nextSyncAt: new Date(Date.now() + 3_600_000),
    });

    const claimed = await claimDueAccounts(db, 10, 5);

    expect(claimed.map((row) => row.id)).toEqual([due.id]);
    // Il claim PRE-SCHEDULA: la stessa casella non è più dovuta subito dopo.
    expect((await reload(due.id)).nextSyncAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(await claimDueAccounts(db, 10, 5)).toEqual([]);
    // La casella non dovuta non è stata toccata.
    expect((await reload(later.id)).nextSyncAt.getTime()).toBe(later.nextSyncAt.getTime());
  });

  it("pre-schedula col BACKOFF quando la casella ha già tentativi falliti", async () => {
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      syncAttempts: 4,
    });

    await claimDueAccounts(db, 10, 5);

    // 60s * 2^4 = 16 minuti, ben oltre l'intervallo nominale di 5.
    const next = (await reload(account.id)).nextSyncAt.getTime();
    expect(next).toBeGreaterThan(Date.now() + 15 * 60_000);
  });

  it("salta le caselle con le proposte spente e quelle disabilitate", async () => {
    await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000), proposalsEnabled: false });
    await seedAccount({
      email: `spenta-${randomUUID()}@acme.com`,
      nextSyncAt: new Date(Date.now() - 60_000),
      disabledAt: new Date(),
      disabledReason: "revoked",
    });

    expect(await claimDueAccounts(db, 10, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sincronizzazione e pre-filtro
// ---------------------------------------------------------------------------

describe("sincronizzazione Gmail", () => {
  it("non tocca una casella con proposals_enabled = false", async () => {
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      proposalsEnabled: false,
    });
    const gmail = fakeGmail({});

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.accounts).toBe(0);
    expect(gmail.calls).toEqual([]);
    expect((await reload(account.id)).lastSyncAt).toBeNull();
  });

  it("al primo giro (nessun cursore) fa il resync con newer_than:7d -from:me", async () => {
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const gmail = fakeGmail({ listed: [], messages: {} });

    await pollGoogleOnce(deps(account, gmail));

    expect(gmail.calls).toEqual(["refresh", "list"]);
    expect(gmail.listQueries).toEqual([GMAIL_RESYNC_QUERY]);
  });

  it("history scaduta (404) → ricade sul resync per query, senza contare un errore", async () => {
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      historyError: new GoogleApiError({
        api: "gmail.history.list",
        status: 404,
        code: "history_expired",
        reason: "notFound",
      }),
      listed: [],
    });

    await pollGoogleOnce(deps(account, gmail));

    expect(gmail.calls).toEqual(["refresh", "history", "list"]);
    expect(gmail.listQueries).toEqual([GMAIL_RESYNC_QUERY]);
    const reloaded = await reload(account.id);
    expect(reloaded.syncAttempts).toBe(0);
    expect(reloaded.disabledAt).toBeNull();
    expect(reloaded.lastSyncAt).not.toBeNull();
  });

  it("dopo un resync senza messaggi AZZERA il cursore scaduto, così il 404 non si ripaga", async () => {
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      historyError: new GoogleApiError({
        api: "gmail.history.list",
        status: 404,
        code: "history_expired",
        reason: "notFound",
      }),
      listed: [],
    });

    await pollGoogleOnce(deps(account, gmail));

    expect((await reload(account.id)).gmailHistoryId).toBeNull();
  });

  it("dopo un resync con messaggi il cursore riparte dal più recente", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const gmail = fakeGmail({
      listed: ["m1", "m2"],
      messages: {
        // Confronto NUMERICO, non lessicografico: "9999999999" < "10000000001".
        m1: message({ id: "m1", historyId: "10000000001" }),
        m2: message({ id: "m2", historyId: "9999999999" }),
      },
    });

    await pollGoogleOnce(deps(account, gmail));

    expect((await reload(account.id)).gmailHistoryId).toBe("10000000001");
  });

  it("scarta un messaggio spedito dalla casella stessa, senza scaricarne il corpo", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "acme.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      // Mandata DALLA casella: la regola sul dominio combacerebbe (il `To` è
      // interno), ma la posta in uscita non è una richiesta ricevuta.
      messages: { m1: message({ id: "m1", from: `Operatore <${MAILBOX}>`, to: "cliente@acme.com" }) },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(0);
    expect(gmail.calls).toEqual(["refresh", "history", "metadata:m1"]);
    expect(await db.select().from(emailMessages)).toEqual([]);
  });

  it("fuori perimetro: nessun download del corpo e nessuna riga", async () => {
    await seedProject("Acme");
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1", from: "news@spam.example" }) },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(0);
    // Nessun `full:m1`: è il pre-filtro che ha risparmiato la chiamata.
    expect(gmail.calls).toEqual(["refresh", "history", "metadata:m1"]);
    expect(await db.select().from(emailMessages)).toEqual([]);
  });

  it("in perimetro: scrive la riga col progetto risolto e il testo capato", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_address", value: "cliente@cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({
          id: "m1",
          from: '"Rossi, Mario" <cliente@cliente.com>',
          subject: "Serve il portale",
          body: "x".repeat(MAX_TEXT_LENGTH + 500),
        }),
      },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(1);
    expect(gmail.calls).toContain("full:m1");
    const [row] = await db.select().from(emailMessages);
    expect(row).toMatchObject({
      accountId: account.id,
      gmailMessageId: "m1",
      threadId: "thread-m1",
      fromAddress: "cliente@cliente.com",
      fromName: "Rossi, Mario",
      toAddresses: [MAILBOX],
      subject: "Serve il portale",
      labels: ["INBOX"],
      projectId,
      candidateProjectIds: [],
      scopeProjectIds: [projectId],
      status: "new",
    });
    expect(row!.textExcerpt).toHaveLength(MAX_TEXT_LENGTH);
    expect(row!.textExcerpt?.endsWith(TEXT_TRUNCATION_MARKER)).toBe(true);
    // Cursore avanzato, contatore azzerato.
    const reloaded = await reload(account.id);
    expect(reloaded.gmailHistoryId).toBe("1010");
    expect(reloaded.syncAttempts).toBe(0);
    expect(reloaded.lastSyncAt).not.toBeNull();
  });

  it("in parità fra due progetti lascia project_id nullo e registra i candidati", async () => {
    const first = await seedProject("Alfa");
    const second = await seedProject("Beta");
    await db.insert(projectEmailRoutes).values([
      { projectId: first, kind: "sender_domain", value: "cliente.com" },
      { projectId: second, kind: "keyword", value: "portale" },
    ]);
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1", subject: "Il portale non va" }) },
    });

    await pollGoogleOnce(deps(account, gmail));

    const [row] = await db.select().from(emailMessages);
    expect(row!.projectId).toBeNull();
    expect(row!.candidateProjectIds.sort()).toEqual([first, second].sort());
  });

  it("tre progetti in perimetro: scope_project_ids elenca tutti e tre, il vincitore ne soddisfa di più", async () => {
    const winner = await seedProject("Acme");
    const second = await seedProject("Beta");
    const third = await seedProject("Gamma");
    // winner: 2 regole soddisfatte; second e third: 1 ciascuno.
    await db.insert(projectEmailRoutes).values([
      { projectId: winner, kind: "sender_domain", value: "cliente.com" },
      { projectId: winner, kind: "keyword", value: "preventivo" },
      { projectId: second, kind: "keyword", value: "portale" },
      { projectId: third, kind: "keyword", value: "urgente" },
    ]);
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({
          id: "m1",
          from: "cliente@cliente.com",
          subject: "Preventivo portale urgente",
        }),
      },
    });

    await pollGoogleOnce(deps(account, gmail));

    const [row] = await db.select().from(emailMessages);
    expect(row!.projectId).toBe(winner);
    expect(row!.candidateProjectIds).toEqual([]);
    // Il valore persistito viene direttamente da `matchRoutes` (Task 2), non
    // solo dal vincitore: tutti e tre i progetti, col vincitore per primo
    // (conteggio 2 contro 1). L'ordine fra `second` e `third` (entrambi a 1)
    // dipende dal loro id — non lo prediciamo qui, lo verifica già
    // `email-routing.test.ts` — quindi si controlla solo l'insieme e la
    // posizione del vincitore.
    expect(row!.scopeProjectIds).toHaveLength(3);
    expect(row!.scopeProjectIds[0]).toBe(winner);
    expect(new Set(row!.scopeProjectIds)).toEqual(new Set([winner, second, third]));
  });

  it("rieseguire lo stesso giro non scrive righe nuove", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1" }) },
    });

    expect((await pollGoogleOnce(deps(account, gmail))).ingested).toBe(1);

    // Secondo giro: la casella è di nuovo dovuta, la history restituisce lo
    // stesso messaggio (è il caso di un cursore non avanzato).
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const again = await pollGoogleOnce(deps(await reload(account.id), gmail));

    expect(again.ingested).toBe(0);
    expect(await db.select().from(emailMessages)).toHaveLength(1);
    // Il messaggio già ingerito non viene nemmeno riletto da Gmail.
    expect(gmail.calls.filter((call) => call === "metadata:m1")).toHaveLength(1);
  });

  it("più di GMAIL_RESYNC_MAX_MESSAGES messaggi nuovi: il cursore resta al lotto processato, il tick dopo prende il resto", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });

    const total = GMAIL_RESYNC_MAX_MESSAGES + 50;
    const ids = Array.from({ length: total }, (_, i) => `m${i + 1}`);
    // `historyId` crescente nell'ordine in cui `history.list` li elenca: il
    // 200esimo (l'ultimo del lotto processato) è "2200".
    const messages = Object.fromEntries(
      ids.map((id, i) => [id, message({ id, historyId: String(2000 + i + 1) })]),
    );
    const gmail = fakeGmail({
      // Una SOLA pagina di `history.list` con più addedMessageIds di quanti il
      // tick ne processi: `page.historyId` è lo stato "adesso" della casella,
      // ben oltre il 200esimo messaggio effettivamente letto.
      history: { addedMessageIds: ids, historyId: "9999999" },
      messages,
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(GMAIL_RESYNC_MAX_MESSAGES);
    const reloaded = await reload(account.id);
    // NON "9999999" (lo stato adesso della casella): il cursore resta fermo
    // all'historyId del 200esimo messaggio EFFETTIVAMENTE processato.
    expect(reloaded.gmailHistoryId).toBe(String(2000 + GMAIL_RESYNC_MAX_MESSAGES));
    expect(reloaded.gmailHistoryId).not.toBe("9999999");

    // Il tick successivo: da quel cursore, la history (finta) restituisce solo
    // i 50 messaggi rimasti — esattamente ciò che Gmail farebbe con un
    // `startHistoryId` avanzato di così poco.
    const remainingIds = ids.slice(GMAIL_RESYNC_MAX_MESSAGES);
    const gmail2 = fakeGmail({
      history: { addedMessageIds: remainingIds, historyId: "9999999" },
      messages,
    });
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const stats2 = await pollGoogleOnce(deps(await reload(account.id), gmail2));

    expect(stats2.ingested).toBe(50);
    const rows = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.accountId, account.id));
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((row) => row.gmailMessageId)).size).toBe(total);
  });

  it("abort a metà lotto: il cursore resta all'ultimo messaggio inserito, la ripresa non duplica", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const messages = {
      m1: message({ id: "m1", historyId: "2001" }),
      m2: message({ id: "m2", historyId: "2002" }),
      m3: message({ id: "m3", historyId: "2003" }),
    };
    const controller = new AbortController();
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1", "m2", "m3"], historyId: "9999999" },
      messages,
    });
    // Interrompe DOPO che m1 è stato letto (e quindi inserito): il prossimo
    // giro del loop, su m2, trova il segnale già interrotto e si ferma prima
    // di leggerlo — come un riavvio del worker a metà lotto.
    const originalGetMessageMetadata = gmail.getMessageMetadata;
    gmail.getMessageMetadata = async (input: { accessToken: string; id: string }) => {
      const result = await originalGetMessageMetadata(input);
      if (input.id === "m1") controller.abort();
      return result;
    };

    const stats = await pollGoogleOnce({ ...deps(account, gmail), signal: controller.signal });

    expect(stats.ingested).toBe(1);
    const reloaded = await reload(account.id);
    // NON "9999999": il cursore resta all'historyId dell'unico messaggio
    // effettivamente inserito.
    expect(reloaded.gmailHistoryId).toBe("2001");
    const rowsAfterAbort = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.accountId, account.id));
    expect(rowsAfterAbort.map((row) => row.gmailMessageId)).toEqual(["m1"]);

    // La ripresa: nessun abort stavolta, la history (finta) mostra solo i due
    // messaggi rimasti — senza duplicare m1.
    const gmail2 = fakeGmail({
      history: { addedMessageIds: ["m2", "m3"], historyId: "9999999" },
      messages,
    });
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const stats2 = await pollGoogleOnce(deps(await reload(account.id), gmail2));

    expect(stats2.ingested).toBe(2);
    const allRows = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.accountId, account.id));
    expect(allRows.map((row) => row.gmailMessageId).sort()).toEqual(["m1", "m2", "m3"]);
  });
});

// ---------------------------------------------------------------------------
// Ammissione (fase 6c) — Task 3: il pre-filtro AMMETTE, non attribuisce più.
// ---------------------------------------------------------------------------

describe("ammissione (fase 6c)", () => {
  it("dominio Workspace REGISTRATO, senza nessuna regola di progetto: ingerito con scope_project_ids vuoto", async () => {
    // Nessun progetto, nessuna regola: prima di questa fase questo messaggio
    // sarebbe rimasto fuori perimetro e non sarebbe mai stato scaricato.
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      // Un collega sullo STESSO dominio Workspace (acme.com) della casella,
      // non la casella stessa: `isFromMailbox` non lo scarta.
      messages: { m1: message({ id: "m1", from: "collega@acme.com" }) },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(1);
    // Ammesso ⇒ il corpo viene scaricato, come per qualunque messaggio ammesso.
    expect(gmail.calls).toContain("full:m1");
    const [row] = await db.select().from(emailMessages);
    expect(row).toMatchObject({
      fromAddress: "collega@acme.com",
      // Nessuna regola di progetto combacia: perimetro vuoto, non "fuori".
      projectId: null,
      candidateProjectIds: [],
      scopeProjectIds: [],
      status: "new",
    });
  });

  it("un Workspace REGISTRATO ma SENZA nessuna casella collegata ammette comunque (query dedicata, non derivata dalle credenziali della casella)", async () => {
    // Se `workspaceDomains` venisse derivato solo dalle `GoogleAccountCredentials`
    // caricate per le caselle di questo tick, i domini di un Workspace SENZA
    // nessuna casella collegata non comparirebbero mai: `loadAllWorkspaceDomains`
    // interroga `google_workspaces` direttamente, non le caselle attive.
    await db.insert(googleWorkspaces).values({
      name: "Filiale",
      domains: ["filiale.acme.com"],
      clientId: "altro-client-id",
      clientSecretEncrypted: "blob",
    });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1", from: "socio@filiale.acme.com" }) },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(1);
  });

  it("regola di progetto che combacia AMMETTE anche con un'etichetta esclusa (Task 1, fase 6c): il corpo viene scaricato", async () => {
    // Decisione del maintainer (8 set 2026): una regola di progetto è una
    // scelta deliberata su un mittente preciso e ammette SEMPRE, esclusioni
    // comprese — le esclusioni servono a contenere l'ammissione LARGA per
    // dominio di lavoro, non a limitare quella MIRATA.
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({
          id: "m1",
          from: "cliente@cliente.com",
          labels: ["INBOX", "CATEGORY_PROMOTIONS"],
        }),
      },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(1);
    expect(gmail.calls).toContain("full:m1");
    const [row] = await db.select().from(emailMessages);
    expect(row).toMatchObject({ fromAddress: "cliente@cliente.com", projectId });
  });

  it("dominio Workspace SENZA regola di progetto che combaci + etichetta esclusa: NESSUN download (le esclusioni restano attive sull'ammissione larga)", async () => {
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({
          id: "m1",
          // Dominio Workspace della casella (acme.com), nessuna regola di
          // progetto configurata: qui l'ammissione passa SOLO dal dominio di
          // lavoro, dove le esclusioni si applicano.
          from: "collega@acme.com",
          labels: ["INBOX", "CATEGORY_PROMOTIONS"],
        }),
      },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(0);
    // Nessun `full:m1`: la deny label ha bloccato PRIMA del download, sui
    // soli metadati — è la garanzia di privacy/costo di questo task.
    expect(gmail.calls).toEqual(["refresh", "history", "metadata:m1"]);
    expect(await db.select().from(emailMessages)).toEqual([]);
  });

  it("interruttore admitWorkspaceDomains spento: un dominio Workspace senza regola NON ammette più (comportamento della fase 6)", async () => {
    await db.insert(instanceSettings).values({ id: 1, emailAdmitWorkspaceDomains: false });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      // Stesso messaggio del primo test di questo blocco: con l'interruttore
      // spento NON basta più il dominio Workspace, serve una regola.
      messages: { m1: message({ id: "m1", from: "collega@acme.com" }) },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(0);
    expect(gmail.calls).toEqual(["refresh", "history", "metadata:m1"]);
    expect(await db.select().from(emailMessages)).toEqual([]);
  });

  it("interruttore admitWorkspaceDomains spento MA una regola di progetto combacia: ammesso come prima", async () => {
    await db.insert(instanceSettings).values({ id: 1, emailAdmitWorkspaceDomains: false });
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1", from: "cliente@cliente.com" }) },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(1);
    const [row] = await db.select().from(emailMessages);
    expect(row!.projectId).toBe(projectId);
  });
});

// ---------------------------------------------------------------------------
// Ammissione (fase 6c) — Task 2: un secondo dominio di lavoro fra i
// destinatari ammette, `to` o `cc` indifferentemente — ESCLUSO il dominio
// della casella che riceve (`account.email`, passato come `receivingDomain`
// ad `admit()`). La tabella dei casi è quella del maintainer, verbatim.
//
// Questi test provano anche che il poller passa DAVVERO `receivingDomain` ad
// `admit`: se `runAccountTick`/`syncGmail` lo lasciassero vuoto (o sbagliato),
// il primo test qui sotto ammetterebbe per errore (il dominio della casella
// stessa, non escluso, comparirebbe come "secondo dominio di lavoro").
// ---------------------------------------------------------------------------

describe("ammissione (fase 6c, Task 2) — dominio di lavoro fra i destinatari", () => {
  /** Registra i due Workspace usati dalla tabella del maintainer. */
  async function seedFarmakomAndTheCove(): Promise<void> {
    await db.insert(googleWorkspaces).values([
      {
        name: "Farmakom",
        domains: ["farmakom.it"],
        clientId: "farmakom-client-id",
        clientSecretEncrypted: "blob",
      },
      {
        name: "The Cove",
        domains: ["thecove.it"],
        clientId: "thecove-client-id",
        clientSecretEncrypted: "blob",
      },
    ]);
  }

  it("cliente esterno → solo la casella ricevente (it@farmakom.it) fra i destinatari: NON ammessa (nessun secondo dominio di lavoro coinvolto)", async () => {
    await seedFarmakomAndTheCove();
    const account = await seedAccount({
      email: "it@farmakom.it",
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({ id: "m1", from: "cliente@esterno.org", to: "it@farmakom.it" }),
      },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(0);
    expect(await db.select().from(emailMessages)).toEqual([]);
  });

  it("cliente esterno → it@farmakom.it con a.locatelli@thecove.it IN COPIA: AMMESSA", async () => {
    await seedFarmakomAndTheCove();
    const account = await seedAccount({
      email: "it@farmakom.it",
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({
          id: "m1",
          from: "cliente@esterno.org",
          to: "it@farmakom.it",
          cc: "a.locatelli@thecove.it",
        }),
      },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(1);
    expect(gmail.calls).toContain("full:m1");
  });

  it("cliente esterno → entrambi fra i destinatari DIRETTI (to): AMMESSA — è il caso che prima falliva", async () => {
    await seedFarmakomAndTheCove();
    const account = await seedAccount({
      email: "it@farmakom.it",
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({
          id: "m1",
          from: "cliente@esterno.org",
          to: "it@farmakom.it, a.locatelli@thecove.it",
        }),
      },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(1);
    expect(gmail.calls).toContain("full:m1");
  });

  it("due indirizzi ENTRAMBI del dominio della casella ricevente (to + cc): NON ammessa (nessun secondo dominio di lavoro coinvolto)", async () => {
    await seedFarmakomAndTheCove();
    const account = await seedAccount({
      email: "it@farmakom.it",
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({
          id: "m1",
          from: "cliente@esterno.org",
          to: "it@farmakom.it",
          cc: "altro@farmakom.it",
        }),
      },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(0);
    expect(await db.select().from(emailMessages)).toEqual([]);
  });

  it("mittente di un dominio di lavoro: ammette comunque, indipendentemente dai destinatari (invariato)", async () => {
    await seedFarmakomAndTheCove();
    const account = await seedAccount({
      email: "it@farmakom.it",
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: {
        m1: message({
          id: "m1",
          from: "collega@thecove.it",
          to: "it@farmakom.it",
        }),
      },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ingested).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Errori
// ---------------------------------------------------------------------------

describe("classificazione degli errori", () => {
  it("invalid_grant disabilita la casella senza ritentativi", async () => {
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const gmail = fakeGmail({
      refreshError: new GoogleApiError({
        api: "oauth.token.refresh_token",
        status: 400,
        code: "invalid_grant",
        reason: "invalid_grant",
      }),
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.disabled).toBe(1);
    const reloaded = await reload(account.id);
    expect(reloaded.disabledAt).not.toBeNull();
    expect(reloaded.disabledReason).toBe("invalid_grant");
    // `sync_attempts` NON si tocca: misura i fallimenti ritentabili.
    expect(reloaded.syncAttempts).toBe(0);
    // E la casella non viene più reclamata.
    expect(await claimDueAccounts(db, 10, 5)).toEqual([]);
  });

  it("insufficient_scope e access_denied hanno il motivo giusto", async () => {
    for (const [code, expected] of [
      ["insufficient_scope", "insufficient_scope"],
      ["access_denied", "revoked"],
    ] as const) {
      const account = await seedAccount({
        email: `casella-${randomUUID()}@acme.com`,
        nextSyncAt: new Date(Date.now() - 60_000),
      });
      const gmail = fakeGmail({
        refreshError: new GoogleApiError({
          api: "oauth.token.refresh_token",
          status: 403,
          code,
          reason: code,
        }),
      });

      await pollGoogleOnce(deps(account, gmail));

      expect((await reload(account.id)).disabledReason).toBe(expected);
    }
  });

  it("429 con Retry-After schedula il ritentativo su quel valore", async () => {
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const gmail = fakeGmail({
      refreshError: new GoogleApiError({
        api: "gmail.messages.list",
        status: 429,
        code: "rate_limited",
        reason: "rateLimitExceeded",
        // 20 minuti: sopra sia l'intervallo (5') sia il primo backoff (1').
        retryAfterMs: 20 * 60_000,
      }),
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.disabled).toBe(0);
    const reloaded = await reload(account.id);
    expect(reloaded.disabledAt).toBeNull();
    expect(reloaded.syncAttempts).toBe(1);
    const waitMs = reloaded.nextSyncAt.getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(19 * 60_000);
    expect(waitMs).toBeLessThan(21 * 60_000);
  });

  it("all'ottavo errore transitorio la casella si spegne con sync_failed", async () => {
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      syncAttempts: GMAIL_MAX_SYNC_ATTEMPTS - 1,
    });
    const gmail = fakeGmail({ refreshError: new Error("connessione interrotta") });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.disabled).toBe(1);
    const reloaded = await reload(account.id);
    expect(reloaded.syncAttempts).toBe(GMAIL_MAX_SYNC_ATTEMPTS);
    expect(reloaded.disabledReason).toBe("sync_failed");
  });

  it("credenziali non decifrabili: si salta la casella, senza spegnerla", async () => {
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const gmail = fakeGmail({});

    const stats = await pollGoogleOnce(
      deps(account, gmail, { loadCredentials: async () => null }),
    );

    expect(stats.accounts).toBe(1);
    expect(gmail.calls).toEqual([]);
    const reloaded = await reload(account.id);
    expect(reloaded.disabledAt).toBeNull();
    expect(reloaded.syncAttempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe("retention", () => {
  const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);

  /** Un padre VECCHIO, pronto per gli scenari con figli. */
  async function seedOldMessage(
    account: typeof googleAccounts.$inferSelect,
    overrides: Partial<typeof emailMessages.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(emailMessages)
      .values({
        accountId: account.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: "t",
        fromAddress: "cliente@cliente.com",
        receivedAt: old,
        updatedAt: old,
        status: "classified",
        ...overrides,
      })
      .returning({ id: emailMessages.id });
    return row!.id;
  }

  /** Una riga FIGLIA di UN progetto, per il messaggio dato (fase 6b). */
  async function seedChild(
    messageId: string,
    projectId: string,
    overrides: Partial<typeof emailProposals.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(emailProposals)
      .values({
        emailMessageId: messageId,
        projectId,
        status: "classified",
        classification: { signal: "none", proposals: [], recommendedIndex: 0 },
        ...overrides,
      })
      .returning({ id: emailProposals.id });
    return row!.id;
  }

  /** Una notifica `google.proposal`, nello stato indicato. */
  async function seedNotification(userId: string, status: "open" | "handled"): Promise<string> {
    const [row] = await db
      .insert(notifications)
      .values({
        userId,
        kind: "google.proposal",
        status,
        ...(status === "handled" ? { handledAt: new Date() } : {}),
        event: {},
      })
      .returning({ id: notifications.id });
    return row!.id;
  }

  it("cancella i messaggi SENZA figli, già trattati e oltre la soglia", async () => {
    const account = await seedAccount();
    const base = {
      accountId: account.id,
      threadId: "t",
      fromAddress: "cliente@cliente.com",
      receivedAt: old,
    };
    await db.insert(emailMessages).values([
      { ...base, gmailMessageId: "vecchio-actioned", status: "actioned", updatedAt: old },
      { ...base, gmailMessageId: "vecchio-ignored", status: "ignored", updatedAt: old },
      { ...base, gmailMessageId: "vecchio-failed", status: "failed", updatedAt: old },
      // Mai classificato: nessun figlio da aspettare (l'insieme è vuoto), ma
      // non è mai stato nemmeno guardato — non si pota.
      { ...base, gmailMessageId: "vecchio-new", status: "new", updatedAt: old },
      // Terminale ma recente.
      { ...base, gmailMessageId: "recente-actioned", status: "actioned", updatedAt: recent },
    ]);

    expect(await pruneOldEmails(db, 90)).toBe(3);

    const left = (await db.select().from(emailMessages)).map((row) => row.gmailMessageId).sort();
    expect(left).toEqual(["recente-actioned", "vecchio-new"]);
  });

  it("un figlio ancora `classified` blocca la potatura", async () => {
    const account = await seedAccount();
    const projectId = await seedProject("acme");
    const messageId = await seedOldMessage(account);
    await seedChild(messageId, projectId, { status: "classified" });

    expect(await pruneOldEmails(db, 90)).toBe(0);
    expect(await db.select().from(emailMessages)).toHaveLength(1);
  });

  it("un figlio terminale ma con la notifica ancora aperta blocca la potatura", async () => {
    const account = await seedAccount();
    const projectId = await seedProject("acme");
    const messageId = await seedOldMessage(account);
    const notificationId = await seedNotification(account.userId, "open");
    // Stato "rotto" ad arte: un figlio TERMINALE la cui notifica è ancora
    // aperta. L'invariante garantita da `google-proposal.ts` (claim PRIMA
    // dello stato terminale) direbbe che non può succedere — ma il controllo
    // non si fida di quell'invariante, la riverifica riga per riga (difesa in
    // profondità).
    await seedChild(messageId, projectId, { status: "actioned", proposalNotificationId: notificationId });

    expect(await pruneOldEmails(db, 90)).toBe(0);
    expect(await db.select().from(emailMessages)).toHaveLength(1);
  });

  it("tutti i figli terminali e nessuna notifica aperta → potato, figli in cascata", async () => {
    const account = await seedAccount();
    const projectA = await seedProject("acme");
    const projectB = await seedProject("beta");
    const messageId = await seedOldMessage(account);
    const handledNotificationId = await seedNotification(account.userId, "handled");
    await seedChild(messageId, projectA, {
      status: "actioned",
      proposalNotificationId: handledNotificationId,
    });
    // Figlio senza notifica collegata (mai pubblicato, o pubblicazione
    // fallita dopo la classificazione): terminale comunque.
    await seedChild(messageId, projectB, { status: "ignored" });

    expect(await pruneOldEmails(db, 90)).toBe(1);
    expect(await db.select().from(emailMessages)).toHaveLength(0);
    // Cascata: i figli spariscono col padre, nessuna azione applicativa in più.
    expect(
      await db.select().from(emailProposals).where(eq(emailProposals.emailMessageId, messageId)),
    ).toEqual([]);
  });

  it("retentionDays = 0 non cancella nulla", async () => {
    const account = await seedAccount();
    await db.insert(emailMessages).values({
      accountId: account.id,
      gmailMessageId: "vecchio",
      threadId: "t",
      fromAddress: "cliente@cliente.com",
      receivedAt: new Date(0),
      status: "actioned",
      updatedAt: new Date(0),
    });

    expect(await pruneOldEmails(db, 0)).toBe(0);
    expect(await db.select().from(emailMessages)).toHaveLength(1);
  });

  it("il tick pota anche quando nessuna casella è dovuta", async () => {
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() + 3_600_000) });
    await db.insert(emailMessages).values({
      accountId: account.id,
      gmailMessageId: "vecchio",
      threadId: "t",
      fromAddress: "cliente@cliente.com",
      receivedAt: new Date(0),
      status: "ignored",
      updatedAt: new Date(0),
    });

    const stats = await pollGoogleOnce(deps(account, fakeGmail({})));

    expect(stats).toMatchObject({ accounts: 0, pruned: 1 });
  });

  // -------------------------------------------------------------------------
  // Fase 6c (Task 5): la notifica di SMISTAMENTO vive SUL PADRE — condizione
  // 4, nuova, senza figlio equivalente che la specchi.
  // -------------------------------------------------------------------------

  it("una proposta di smistamento ANCORA APERTA sul padre blocca la potatura, anche senza nessun figlio", async () => {
    const account = await seedAccount();
    const notificationId = await seedNotification(account.userId, "open");
    await seedOldMessage(account, {
      status: "proposed",
      proposalNotificationId: notificationId,
      classification: { triage: true, signal: "request", summary: "s", suggestedProjectIds: [] },
    });

    expect(await pruneOldEmails(db, 90)).toBe(0);
    expect(await db.select().from(emailMessages)).toHaveLength(1);
  });

  it("una proposta di smistamento GESTITA (notifica `handled`) non blocca più la potatura", async () => {
    const account = await seedAccount();
    const notificationId = await seedNotification(account.userId, "handled");
    await seedOldMessage(account, {
      status: "ignored", // «nessuno di questi»: chiusa come ignored, con l'esito.
      proposalNotificationId: notificationId,
      outcome: { type: "triage_dismissed" },
      classification: { triage: true, signal: "request", summary: "s", suggestedProjectIds: [] },
    });

    expect(await pruneOldEmails(db, 90)).toBe(1);
    expect(await db.select().from(emailMessages)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

describe("startGooglePoller", () => {
  it("intervalMinutes ≤ 0 non avvia nulla", async () => {
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const gmail = fakeGmail({});
    const controller = new AbortController();

    const stop = startGooglePoller({
      ...deps(account, gmail),
      intervalMinutes: 0,
      signal: controller.signal,
    });
    stop();
    controller.abort();

    expect(gmail.calls).toEqual([]);
    // Nessun claim: la casella è ancora dovuta.
    expect(await claimDueAccounts(db, 10, 5)).toHaveLength(1);
  });

  it("l'AbortSignal ferma il timer, e lo stop è idempotente", async () => {
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() + 3_600_000) });
    const controller = new AbortController();

    const stop = startGooglePoller({
      ...deps(account, fakeGmail({})),
      intervalMinutes: 5,
      signal: controller.signal,
    });
    controller.abort();
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Il tick sceglie una sola casella per volta, ma le vede tutte
// ---------------------------------------------------------------------------

describe("più caselle nello stesso tick", () => {
  it("un errore su una casella non ferma le altre", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const broken = await seedAccount({ nextSyncAt: new Date(Date.now() - 120_000) });
    const healthy = await seedAccount({
      email: `sana-${randomUUID()}@acme.com`,
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });

    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1" }) },
    });
    const stats = await pollGoogleOnce({
      ...deps(healthy, gmail),
      loadCredentials: async (_db, _key, accountId) => {
        if (accountId === broken.id) throw new Error("boom");
        return credentialsFor(healthy);
      },
    });

    expect(stats.accounts).toBe(2);
    expect(stats.ingested).toBe(1);
    expect((await reload(broken.id)).syncAttempts).toBe(1);
    const rows = await db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.accountId, healthy.id), eq(emailMessages.status, "new")));
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fase 2 del tick: la classificazione
// ---------------------------------------------------------------------------

/** Runner finto: il contenuto del run è affare di classify.test.ts, qui conta
 * solo che il tick lo chiami (e quante volte). */
function fakeRunner(reply: string | Error): AgentRunner & { calls: AgentRunOptions[] } {
  const calls: AgentRunOptions[] = [];
  return {
    calls,
    async run(opts: AgentRunOptions): Promise<AgentRunResult> {
      calls.push(opts);
      if (reply instanceof Error) throw reply;
      return { output: reply, exitCode: 0 };
    },
  };
}

const IGNORED_OUTPUT = JSON.stringify({
  signal: "none",
  summary: "Niente da fare.",
  proposals: [],
  recommendedIndex: 0,
});

describe("fase 2: classificazione dentro il tick", () => {
  it("classifica i messaggi ingeriti e li conta nelle statistiche", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1" }) },
    });
    const runner = fakeRunner(IGNORED_OUTPUT);

    const stats = await pollGoogleOnce({ ...deps(account, gmail), runner, gmailModel: "haiku" });

    expect(stats.ingested).toBe(1);
    expect(stats.ignoredMessages).toBe(1);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.model).toBe("haiku");
    const [row] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.accountId, account.id));
    expect(row!.status).toBe("ignored");
  });

  it("senza runner la fase 2 non gira: i messaggi restano `new`", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1" }) },
    });

    const stats = await pollGoogleOnce(deps(account, gmail));

    expect(stats.ignoredMessages).toBe(0);
    const [row] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.accountId, account.id));
    expect(row!.status).toBe("new");
  });

  it("rispetta GMAIL_MAX_PER_TICK e riprende dal più vecchio al giro dopo", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1", "m2"], historyId: "1010" },
      messages: { m1: message({ id: "m1" }), m2: message({ id: "m2" }) },
    });
    const runner = fakeRunner(IGNORED_OUTPUT);

    const stats = await pollGoogleOnce({
      ...deps(account, gmail),
      runner,
      classifyMaxPerTick: 1,
    });

    expect(stats.ingested).toBe(2);
    expect(stats.ignoredMessages).toBe(1);
    expect(runner.calls).toHaveLength(1);
    const remaining = await db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.accountId, account.id), eq(emailMessages.status, "new")));
    expect(remaining).toHaveLength(1);
  });

  it("un run di classificazione che esplode NON disabilita la casella", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1" }) },
    });

    const stats = await pollGoogleOnce({
      ...deps(account, gmail),
      runner: fakeRunner(new Error("CLI non disponibile")),
    });

    expect(stats.failedMessages).toBe(1);
    expect(stats.disabled).toBe(0);
    // Il giro di Gmail è comunque andato a buon fine: cursore salvato,
    // tentativi azzerati, nessun backoff.
    const reloaded = await reload(account.id);
    expect(reloaded.disabledAt).toBeNull();
    expect(reloaded.syncAttempts).toBe(0);
    expect(reloaded.gmailHistoryId).toBe("1010");
  });

  it("collega `maxProjectsPerMessage` alla classificazione: il tetto sul fan-out arriva dal poller", async () => {
    // `GMAIL_MAX_PROJECTS_PER_MESSAGE` (config) non era ancora collegato dal
    // poller alla classificazione: senza il filo, `classifyEmail` userebbe
    // sempre il default (5) di `classify.ts`, e con 3 soli progetti in
    // perimetro il tetto non taglierebbe mai niente. Qui il tetto passato è
    // 1: se il filo manca, sopravvivono i 3 progetti; se il filo c'è, ne
    // sopravvive UNO solo.
    const p1 = await seedProject("Uno");
    const p2 = await seedProject("Due");
    const p3 = await seedProject("Tre");
    for (const projectId of [p1, p2, p3]) {
      await db
        .insert(projectEmailRoutes)
        .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    }
    const account = await seedAccount({
      nextSyncAt: new Date(Date.now() - 60_000),
      gmailHistoryId: "1000",
    });
    const gmail = fakeGmail({
      history: { addedMessageIds: ["m1"], historyId: "1010" },
      messages: { m1: message({ id: "m1" }) },
    });
    const reply = JSON.stringify({
      signal: "request",
      summary: "Chiede una mano.",
      recommendedIndex: 0,
      proposals: [p1, p2, p3].map((projectId, index) => ({
        type: "create_backlog_item",
        projectId,
        title: `Voce ${index}`,
        consequence: "Entra nel backlog.",
      })),
    });
    const runner = fakeRunner(reply);

    const stats = await pollGoogleOnce({
      ...deps(account, gmail),
      runner,
      maxProjectsPerMessage: 1,
    });

    expect(stats.classified).toBe(1);
    const children = await db.select().from(emailProposals);
    expect(children).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fase 4 — proposte
// ---------------------------------------------------------------------------

/**
 * ⚠️ È LA FASE CHE RENDE VISIBILE TUTTO IL RESTO. Senza di lei l'intera fase 6
 * gira a vuoto: i messaggi si classificano, gli eventi si tracciano, e nessuno
 * vede niente. Il legame fra le righe e l'inbox non ha un altro guardiano —
 * `proposal.test.ts` copre la costruzione e la transazione, questi test coprono
 * il fatto che il tick le CHIAMI.
 *
 * Fase 6b: la selezione è sui FIGLI (`email_proposals`), non più sul padre
 * `email_messages` — `seedClassified` seed un padre PIÙ un figlio, e i test
 * leggono lo stato dal figlio (il padre non viene più toccato dalla publish).
 */
describe("fase 4 — le righe pronte diventano proposte", () => {
  /** Un messaggio già classificato dal giro precedente, con UN figlio in attesa di proposta. */
  async function seedClassified(
    accountId: string,
    projectId: string,
  ): Promise<{ messageId: string; childId: string }> {
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        receivedAt: new Date("2026-09-07T08:00:00.000Z"),
        projectId,
        status: "classified",
        signal: "request",
        classification: {
          signal: "request",
          summary: "Chiede l'export.",
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
      })
      .returning({ id: emailMessages.id });
    const [child] = await db
      .insert(emailProposals)
      .values({
        emailMessageId: message!.id,
        projectId,
        status: "classified",
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
      })
      .returning({ id: emailProposals.id });
    return { messageId: message!.id, childId: child!.id };
  }

  it("un figlio classificato diventa una notifica per il proprietario della casella", async () => {
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const { messageId, childId } = await seedClassified(account.id, projectId);

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(stats.proposed).toBe(1);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    // ⚠️ Audience `mailbox_owner`: la card è del proprietario della casella e
    // di nessun altro — l'invariante di privacy della fase.
    expect(rows[0]?.userId).toBe(account.userId);
    expect(rows[0]?.kind).toBe("google.proposal");
    const [child] = await db.select().from(emailProposals).where(eq(emailProposals.id, childId));
    expect(child?.status).toBe("proposed");
    expect(child?.proposalNotificationId).toBe(rows[0]?.id);
    // Fase 6b: il PADRE non viene mai toccato dalla publish — resta come la
    // classificazione l'ha lasciato.
    const [message] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(message?.status).toBe("classified");
    expect(message?.proposalNotificationId).toBeNull();
  });

  it("il `proposalId` dell'evento pubblicato è l'id del FIGLIO, non un randomUUID senza relazione (App M3, Fase C, Task 7, fix di correttezza)", async () => {
    // Prima di questo fix, `buildEmailProposalEvent` non riceveva
    // `proposalId` e `assembleEvent` generava un `randomUUID()` — la card
    // esisteva ma il suo `proposalId` non apriva NESSUN dettaglio vero
    // (`GET /api/me/mail/email/:id` non trova nessuna riga con quell'id in
    // `email_proposals`). `inboxGoogleSchema.proposalId` promette
    // `email_proposals.id` da `db2e5a3` ("Fase 7b, fix di review, Task 4")
    // e il link "Leggi in Stubwise" del web se ne fida da allora — questo
    // test fissa che la promessa sia VERA, non solo documentata.
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const { childId } = await seedClassified(account.id, projectId);

    await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    const [row] = await db.select().from(notifications);
    const event = row?.event as { proposalId?: string } | undefined;
    expect(event?.proposalId).toBe(childId);
  });

  it("due figli dello stesso messaggio (progetti diversi) diventano DUE notifiche", async () => {
    // Il caso che il fan-out introduce: stesso mittente/oggetto, due progetti
    // del perimetro → due card, ciascuna col proprio figlio.
    const projectA = await seedProject("negozio");
    const projectB = await seedProject("portale");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId: account.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        receivedAt: new Date("2026-09-07T08:00:00.000Z"),
        status: "classified",
      })
      .returning({ id: emailMessages.id });
    const childClassification = (projectId: string) => ({
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
    });
    const [childA] = await db
      .insert(emailProposals)
      .values({
        emailMessageId: message!.id,
        projectId: projectA,
        status: "classified",
        classification: childClassification(projectA),
      })
      .returning({ id: emailProposals.id });
    const [childB] = await db
      .insert(emailProposals)
      .values({
        emailMessageId: message!.id,
        projectId: projectB,
        status: "classified",
        classification: childClassification(projectB),
      })
      .returning({ id: emailProposals.id });

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(stats.proposed).toBe(2);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(2);
    // Domande DIVERSE: nominano progetti diversi, quindi le card si
    // distinguono anche se mittente e oggetto sono identici.
    const questions = rows.map((r) => (r.event as { question: string }).question);
    expect(new Set(questions).size).toBe(2);
    const [after1] = await db.select().from(emailProposals).where(eq(emailProposals.id, childA!.id));
    const [after2] = await db.select().from(emailProposals).where(eq(emailProposals.id, childB!.id));
    expect(after1?.status).toBe("proposed");
    expect(after2?.status).toBe("proposed");
    expect(after1?.proposalNotificationId).not.toBe(after2?.proposalNotificationId);
  });

  it("un secondo giro non ripropone lo stesso figlio", async () => {
    // Senza il claim, ogni tick pubblicherebbe una card nuova sulla stessa
    // email: una ogni cinque minuti, per sempre.
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await seedClassified(account.id, projectId);

    await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const second = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(second.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("un figlio da cui non resta niente chiude la riga invece di ripescarla", async () => {
    // `classified` senza nessuna azione eseguibile resterebbe candidato a ogni
    // tick per sempre, occupando uno slot del tetto. `ignored` lo chiude senza
    // inventare una proposta che non c'è — il PADRE non si tocca.
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId: account.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        receivedAt: new Date("2026-09-07T08:00:00.000Z"),
        projectId,
        status: "classified",
      })
      .returning({ id: emailMessages.id });
    const [child] = await db
      .insert(emailProposals)
      .values({
        emailMessageId: message!.id,
        projectId,
        status: "classified",
        classification: { signal: "none", recommendedIndex: 0, proposals: [] },
      })
      .returning({ id: emailProposals.id });

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(stats.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
    const [after] = await db.select().from(emailProposals).where(eq(emailProposals.id, child!.id));
    expect(after?.status).toBe("ignored");
    const [messageAfter] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, message!.id));
    expect(messageAfter?.status).toBe("classified");
  });

  it("`proposeMaxPerTick: 0` spegne la sola pubblicazione, le righe restano pronte", async () => {
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const { childId } = await seedClassified(account.id, projectId);

    const stats = await pollGoogleOnce(
      deps(account, fakeGmail({ listed: [] }), { proposeMaxPerTick: 0 }),
    );

    expect(stats.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
    const [child] = await db.select().from(emailProposals).where(eq(emailProposals.id, childId));
    // La riga NON viene toccata: al primo tick con la fase riaccesa riparte.
    expect(child?.status).toBe("classified");
  });

  it("il tetto per tick conta PROPOSTE, non messaggi: due figli dello stesso messaggio contano due", async () => {
    // Prima della fase 6b un messaggio produceva al più una card, quindi
    // `limit` messaggi = al più `limit` card. Col fan-out un messaggio può
    // produrre più figli: il tetto deve contarli come proposte separate,
    // altrimenti `proposeMaxPerTick: 1` lascerebbe passare comunque le due
    // card dello stesso messaggio.
    const projectA = await seedProject("negozio");
    const projectB = await seedProject("portale");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId: account.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        receivedAt: new Date("2026-09-07T08:00:00.000Z"),
        status: "classified",
      })
      .returning({ id: emailMessages.id });
    const childClassification = (projectId: string) => ({
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
    });
    await db.insert(emailProposals).values([
      {
        emailMessageId: message!.id,
        projectId: projectA,
        status: "classified",
        classification: childClassification(projectA),
      },
      {
        emailMessageId: message!.id,
        projectId: projectB,
        status: "classified",
        classification: childClassification(projectB),
      },
    ]);

    const stats = await pollGoogleOnce(
      deps(account, fakeGmail({ listed: [] }), { proposeMaxPerTick: 1 }),
    );

    // Solo UNA proposta pubblicata: il tetto ha fermato la selezione a UNA
    // riga `email_proposals`, non a un messaggio intero.
    expect(stats.proposed).toBe(1);
    expect(await db.select().from(notifications)).toHaveLength(1);
    const remaining = await db
      .select()
      .from(emailProposals)
      .where(eq(emailProposals.status, "classified"));
    expect(remaining).toHaveLength(1);
  });

  it("un guasto della fase 4 non mette la casella in backoff", async () => {
    // Il gestore d'errore del tick legge ogni eccezione come un verdetto sulla
    // CASELLA. Qui il guasto è nostro, non di Google: farlo salire spegnerebbe
    // la posta di una persona per un bug del publisher.
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await seedClassified(account.id, projectId);

    const stats = await pollGoogleOnce(
      deps(account, fakeGmail({ listed: [] }), {
        publish: () => {
          throw new Error("publish esplosa");
        },
      }),
    );

    expect(stats.proposed).toBe(0);
    expect(stats.disabled).toBe(0);
    const reloaded = await reload(account.id);
    expect(reloaded.syncAttempts).toBe(0);
    expect(reloaded.disabledAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Fase 6c (Task 5): la proposta di SMISTAMENTO, canale di selezione SEPARATO
  // -------------------------------------------------------------------------

  /** Un padre «da smistare»: segnale reale, nessun figlio, marcatore `triage`. */
  async function seedTriage(
    accountId: string,
    suggestedProjectIds: string[] = [],
  ): Promise<{ messageId: string }> {
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        subject: "Serve una mano",
        receivedAt: new Date("2026-09-07T08:00:00.000Z"),
        status: "classified",
        signal: "request",
        classification: {
          triage: true,
          signal: "request",
          summary: "Il cliente chiede qualcosa, ma non è chiaro per quale progetto.",
          suggestedProjectIds,
        },
      })
      .returning({ id: emailMessages.id });
    return { messageId: message!.id };
  }

  it("un messaggio «da smistare» diventa una proposta di smistamento per il proprietario", async () => {
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const { messageId } = await seedTriage(account.id, [projectId]);

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(stats.proposed).toBe(1);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(account.userId);
    expect(rows[0]?.kind).toBe("google.proposal");
    const event = rows[0]?.event as { actions: { type: string }[]; options: { label: string }[] };
    // Un progetto suggerito + «nessuno di questi»: due opzioni, due azioni.
    expect(event.actions.map((a) => a.type)).toEqual(["choose_project", "ignore"]);
    expect(event.options).toHaveLength(2);
    const [message] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(message?.status).toBe("proposed");
    expect(message?.proposalNotificationId).toBe(rows[0]?.id);
  });

  it("un secondo giro non ripropone lo stesso padre «da smistare»", async () => {
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await seedTriage(account.id, [projectId]);

    await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const second = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(second.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("un messaggio con FIGLI non riceve MAI una proposta di smistamento, anche se qualcosa gli scrivesse (per errore) il marcatore `triage`", async () => {
    // Difesa in profondità: il marcatore da solo basterebbe (per costruzione
    // `writeClassification` non lo scrive mai insieme a dei figli), ma il
    // `NOT EXISTS` nella selezione del poller non si fida solo di quello.
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId: account.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        receivedAt: new Date("2026-09-07T08:00:00.000Z"),
        status: "classified",
        // Marcatore incongruente col fatto che ha un figlio (non dovrebbe mai
        // accadere per costruzione — qui lo forziamo per testare la difesa).
        classification: { triage: true, signal: "request", summary: "s", suggestedProjectIds: [] },
      })
      .returning({ id: emailMessages.id });
    await db.insert(emailProposals).values({
      emailMessageId: message!.id,
      projectId,
      status: "classified",
      classification: {
        signal: "request",
        recommendedIndex: 0,
        proposals: [
          { type: "create_backlog_item", projectId, title: "Export CSV", consequence: "Entra nel backlog." },
        ],
      },
    });

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    // Una sola proposta pubblicata: quella del FIGLIO. Nessuna di smistamento.
    expect(stats.proposed).toBe(1);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    const [messageAfter] = await db.select().from(emailMessages).where(eq(emailMessages.id, message!.id));
    // Il padre non ha ricevuto una notifica propria: quella pubblicata è del figlio.
    expect(messageAfter?.proposalNotificationId).toBeNull();
  });

  it("una classificazione «da smistare» che non regge più la validazione chiude il padre come ignored, senza inventare una card", async () => {
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId: account.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        receivedAt: new Date("2026-09-07T08:00:00.000Z"),
        status: "classified",
        // `triage` come STRINGA e non booleano: `classification->>'triage'`
        // (confronto testuale, SQL) vale comunque `'true'` — la riga viene
        // SELEZIONATA — ma `storedTriageClassificationSchema` (zod, in
        // `buildTriageProposalEvent`) richiede il letterale booleano `true` e
        // scarta l'intero oggetto: è esattamente il jsonb "malformato" che il
        // gate SQL da solo non intercetta, e per cui serve la rivalidazione a
        // valle.
        classification: { triage: "true" },
      })
      .returning({ id: emailMessages.id });

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(stats.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
    const [after] = await db.select().from(emailMessages).where(eq(emailMessages.id, message!.id));
    expect(after?.status).toBe("ignored");
  });
});

// ---------------------------------------------------------------------------
// Task 6 (rifiniture): il resync del calendario dopo un 410 deve vedere anche
// le cancellazioni, non solo la finestra "com'è adesso".
// ---------------------------------------------------------------------------

/** Un evento di calendario finto, normalizzato come lo restituisce `@stubwise/google`. */
function calendarEvent(input: Partial<GoogleCalendarEvent> & { id: string }): GoogleCalendarEvent {
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

interface FakeListEventsCall {
  syncToken?: string | null;
  timeMin?: Date | null;
  timeMax?: Date | null;
  showDeleted?: boolean;
  pageToken?: string | null;
}

/**
 * Calendar finto: risponde con una CODA di pagine (evento o errore), così si
 * può simulare un 410 seguito dal resync che lo smaltisce, nella STESSA
 * chiamata a `pollGoogleOnce` — esattamente come fa `collectCalendarEvents`.
 * Registra ogni chiamata per verificare `showDeleted` e la finestra/il token.
 */
function fakeCalendarSequence(
  pages: (
    | { events: GoogleCalendarEvent[]; nextPageToken?: string | null; nextSyncToken?: string | null }
    | { error: unknown }
  )[],
): CalendarClient & { calls: FakeListEventsCall[] } {
  const calls: FakeListEventsCall[] = [];
  const queue = [...pages];
  const client = {
    calls,
    listEvents: async (input: FakeListEventsCall) => {
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
  return client as unknown as CalendarClient & { calls: FakeListEventsCall[] };
}

async function calendarRows(): Promise<(typeof calendarEvents.$inferSelect)[]> {
  return db.select().from(calendarEvents).orderBy(calendarEvents.googleEventId);
}

describe("il resync del calendario dopo un 410 vede anche le cancellazioni", () => {
  it("un evento proposto, cancellato prima del prossimo sync, poi un 410: la riga risulta cancelled", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });

    // Primo giro: nessun `calendarSyncToken` → resync per finestra (primo
    // giro), crea la riga e la fase 4 (accesa di default in questo file) la
    // propone nello stesso tick.
    await pollGoogleOnce(
      deps(account, fakeGmail({ listed: [] }), {
        calendar: fakeCalendarSequence([
          { events: [calendarEvent({ id: "e1" })], nextSyncToken: "tok-1" },
        ]),
      }),
    );

    const proposed = (await calendarRows())[0]!;
    expect(proposed.status).toBe("confirmed");
    expect(proposed.proposalNotificationId).not.toBeNull();

    // Secondo giro: il token "tok-1" è scaduto (410). Il resync che segue —
    // SUBITO, nello stesso tick — deve vedere l'evento con `showDeleted: true`
    // per poter chiudere la riga: senza il fix resterebbe aperta per sempre,
    // candidata a un appuntamento che non esiste più.
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const calendar = fakeCalendarSequence([
      {
        error: new GoogleApiError({
          api: "calendar.events.list",
          status: 410,
          code: "sync_token_expired",
          reason: "fullSyncRequired",
        }),
      },
      {
        events: [calendarEvent({ id: "e1", status: "cancelled", title: "", attendees: [] })],
        nextSyncToken: "tok-2",
      },
    ]);
    const stats = await pollGoogleOnce(
      deps(await reload(account.id), fakeGmail({ listed: [] }), { calendar }),
    );

    expect(stats.calendarCancelled).toBe(1);
    // La PRIMA chiamata (fallita col 410) usa ancora il vecchio syncToken; la
    // SECONDA — il resync per finestra — deve chiedere anche i cancellati.
    expect(calendar.calls[0]!.syncToken).toBe("tok-1");
    expect(calendar.calls[1]!.syncToken).toBeUndefined();
    expect(calendar.calls[1]!.showDeleted).toBe(true);

    const [row] = await calendarRows();
    expect(row!.status).toBe("cancelled");
    expect(row!.outcome).toEqual({ type: "cancelled" });
    // Non è più candidata a una proposta: il proprietario non la rivedrà.
    expect(row!.proposalNotificationId).not.toBeNull();
    expect((await reload(account.id)).calendarSyncToken).toBe("tok-2");
  });
});

// ---------------------------------------------------------------------------
// Fase 7b, Task 1: la serie ricorrente entra nel modello.
// ---------------------------------------------------------------------------

describe("fase 7b — la serie ricorrente entra nel modello", () => {
  it("un'occorrenza con recurringEventId scrive la colonna; un evento singolo la lascia null", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });

    await pollGoogleOnce(
      deps(account, fakeGmail({ listed: [] }), {
        now: () => new Date("2026-09-09T00:00:00.000Z"),
        calendar: fakeCalendarSequence([
          {
            events: [
              calendarEvent({
                id: "serie_20260910",
                startsAt: new Date("2026-09-10T09:00:00.000Z"),
                endsAt: new Date("2026-09-10T10:00:00.000Z"),
                recurringEventId: "serie",
              }),
              calendarEvent({ id: "singolo", startsAt: new Date("2026-09-15T09:00:00.000Z") }),
            ],
            nextSyncToken: "tok-1",
          },
        ]),
      }),
    );

    const rows = await calendarRows();
    const occorrenza = rows.find((row) => row.googleEventId === "serie_20260910")!;
    const singolo = rows.find((row) => row.googleEventId === "singolo")!;
    expect(occorrenza.recurringEventId).toBe("serie");
    expect(singolo.recurringEventId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fase 7b, Task 2: la finestra dei 60 giorni vale anche in scrittura — la rete
// di sicurezza dell'incidente del 9 settembre 2026 (design fase 7b §5a).
// ---------------------------------------------------------------------------

describe("fase 7b — la finestra dei 60 giorni vale anche in scrittura", () => {
  it("un'occorrenza fra cinque anni non scrive nessuna riga; una dentro i 60 giorni sì", async () => {
    const projectId = await seedProject("Acme");
    await db
      .insert(projectEmailRoutes)
      .values({ projectId, kind: "sender_domain", value: "cliente.com" });
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });

    // Simula esattamente l'incidente: un giro incrementale (con syncToken, la
    // finestra non è nemmeno mandabile a Google) che riceve un mix di
    // occorrenze passate, vicine e lontanissime della stessa serie espansa.
    await db
      .update(googleAccounts)
      .set({ calendarSyncToken: "tok-precedente" })
      .where(eq(googleAccounts.id, account.id));

    await pollGoogleOnce(
      deps(await reload(account.id), fakeGmail({ listed: [] }), {
        now: () => new Date("2026-09-09T00:00:00.000Z"),
        calendar: fakeCalendarSequence([
          {
            events: [
              calendarEvent({
                id: "serie_2035",
                startsAt: new Date("2035-09-10T09:00:00.000Z"),
                recurringEventId: "serie",
              }),
              calendarEvent({
                id: "serie_2026",
                startsAt: new Date("2026-09-20T09:00:00.000Z"),
                recurringEventId: "serie",
              }),
            ],
            nextSyncToken: "tok-2",
          },
        ]),
      }),
    );

    const rows = await calendarRows();
    expect(rows.map((row) => row.googleEventId)).toEqual(["serie_2026"]);
  });
});

// ---------------------------------------------------------------------------
// Fase 7b, Task 4: il poller propone SOLO se la serie è accesa, con
// l'anticipo scelto — e mai più di una proposta alla volta per serie. Le
// righe sono seminate DIRETTAMENTE (non attraverso `syncCalendar`): qui si
// testa la fase di proposta in isolamento, non la sincronizzazione.
// ---------------------------------------------------------------------------

describe("fase 7b — una serie propone solo se accesa, e con l'anticipo scelto", () => {
  const NOW = new Date("2026-09-09T00:00:00.000Z");

  async function seedOccurrence(
    accountId: string,
    projectId: string,
    overrides: Partial<typeof calendarEvents.$inferInsert> = {},
  ): Promise<void> {
    await db.insert(calendarEvents).values({
      accountId,
      googleEventId: `occ-${randomUUID()}`,
      recurringEventId: "serie-1",
      title: "Pianificazione task",
      startsAt: NOW,
      status: "confirmed",
      projectId,
      fingerprint: `f-${randomUUID()}`,
      ...overrides,
    });
  }

  it("serie MAI configurata: nessuna proposta, anche con un'occorrenza nella finestra", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await seedOccurrence(account.id, projectId, { startsAt: new Date("2026-09-10T00:00:00.000Z") });

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));

    expect(stats.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("serie SPENTA esplicitamente: nessuna proposta", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await db.insert(calendarSeries).values({
      accountId: account.id,
      recurringEventId: "serie-1",
      enabled: false,
      projectId,
      leadDays: 2,
    });
    await seedOccurrence(account.id, projectId, { startsAt: new Date("2026-09-10T00:00:00.000Z") });

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));

    expect(stats.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("serie accesa, lead_days: 2 — niente a 5 giorni, proposta a 2", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await db.insert(calendarSeries).values({
      accountId: account.id,
      recurringEventId: "serie-1",
      enabled: true,
      projectId,
      leadDays: 2,
    });
    await seedOccurrence(account.id, projectId, { startsAt: new Date("2026-09-14T00:00:00.000Z") }); // fra 5 giorni

    const early = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));
    expect(early.proposed).toBe(0);

    await db
      .update(calendarEvents)
      .set({ startsAt: new Date("2026-09-11T00:00:00.000Z") }) // fra 2 giorni
      .where(eq(calendarEvents.accountId, account.id));
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const onTime = await pollGoogleOnce(deps(await reload(account.id), fakeGmail({ listed: [] }), { now: () => NOW }));
    expect(onTime.proposed).toBe(1);
  });

  it("un'occorrenza già passata non propone, anche con la serie accesa", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await db.insert(calendarSeries).values({
      accountId: account.id,
      recurringEventId: "serie-1",
      enabled: true,
      projectId,
      leadDays: 2,
    });
    await seedOccurrence(account.id, projectId, { startsAt: new Date("2026-09-08T00:00:00.000Z") }); // ieri

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));

    expect(stats.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("una serie accesa con 100 occorrenze future produce una proposta PER VOLTA, non 100 — la rete di sicurezza dell'incidente del 9 settembre 2026", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await db.insert(calendarSeries).values({
      accountId: account.id,
      recurringEventId: "serie-1",
      enabled: true,
      projectId,
      leadDays: 30,
    });
    // 100 occorrenze, una al giorno per i prossimi 100 giorni: con
    // lead_days: 30, circa 30 di queste sono "pronte" per la timing gate da
    // sole — è ESATTAMENTE il caso che il dedup per tick e il NOT EXISTS
    // sulle proposte aperte devono impedire di esplodere in massa.
    await db.insert(calendarEvents).values(
      Array.from({ length: 100 }, (_, i) => ({
        accountId: account.id,
        googleEventId: `occ-${i}`,
        recurringEventId: "serie-1",
        title: "Pianificazione task",
        startsAt: new Date(NOW.getTime() + (i + 1) * 24 * 60 * 60 * 1000),
        status: "confirmed" as const,
        projectId,
        fingerprint: `f-${i}`,
      })),
    );

    const first = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));
    expect(first.proposed).toBe(1);
    expect(await db.select().from(notifications)).toHaveLength(1);

    // Un secondo giro, senza che nessuno abbia risposto alla proposta: resta
    // aperta, quindi il NOT EXISTS blocca ANCHE la prossima occorrenza pronta.
    await db
      .update(googleAccounts)
      .set({ nextSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(googleAccounts.id, account.id));
    const second = await pollGoogleOnce(deps(await reload(account.id), fakeGmail({ listed: [] }), { now: () => NOW }));
    expect(second.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fase 7b, Task 5: le tre azioni di una serie, e il percorso `auto`.
// ---------------------------------------------------------------------------

describe("fase 7b — voce di backlog, milestone o promemoria, proposte o automatiche", () => {
  const NOW = new Date("2026-09-09T00:00:00.000Z");

  async function seedOccurrence(
    accountId: string,
    projectId: string,
    overrides: Partial<typeof calendarEvents.$inferInsert> = {},
  ): Promise<void> {
    await db.insert(calendarEvents).values({
      accountId,
      googleEventId: `occ-${randomUUID()}`,
      recurringEventId: "serie-1",
      title: "Pianificazione task",
      startsAt: new Date("2026-09-11T00:00:00.000Z"), // fra 2 giorni
      status: "confirmed",
      projectId,
      fingerprint: `f-${randomUUID()}`,
      ...overrides,
    });
  }

  it("action: backlog_item, proposta (non auto) — la card propone, non crea nulla da sola", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await db
      .insert(calendarSeries)
      .values({ accountId: account.id, recurringEventId: "serie-1", enabled: true, projectId, action: "backlog_item", leadDays: 2, auto: false });
    await seedOccurrence(account.id, projectId);

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));

    expect(stats.proposed).toBe(1);
    expect(await db.select().from(backlogItems)).toHaveLength(0);
    const [notif] = await db.select().from(notifications);
    expect(notif!.status).toBe("open");
    expect((notif!.event as { actions: { type: string }[] }).actions[0]!.type).toBe("create_backlog_item");
  });

  it("action: reminder, proposta (non auto) — la card È il promemoria", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await db
      .insert(calendarSeries)
      .values({ accountId: account.id, recurringEventId: "serie-1", enabled: true, projectId, action: "reminder", leadDays: 2, auto: false });
    await seedOccurrence(account.id, projectId);

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));

    expect(stats.proposed).toBe(1);
    const [notif] = await db.select().from(notifications);
    expect((notif!.event as { actions: { type: string }[] }).actions[0]!.type).toBe("acknowledge_reminder");
  });

  it("auto: true, action: milestone — crea l'oggetto SENZA chiedere e lo rende visibile (notifica già 'handled')", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await db
      .insert(calendarSeries)
      .values({ accountId: account.id, recurringEventId: "serie-1", enabled: true, projectId, action: "milestone", leadDays: 2, auto: true });
    await seedOccurrence(account.id, projectId);

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));

    expect(stats.proposed).toBe(1);
    // L'oggetto esiste già, senza nessun tap.
    const createdMilestones = await db.select().from(milestones);
    expect(createdMilestones).toHaveLength(1);
    expect(createdMilestones[0]!.name).toContain("Pianificazione task");
    // La riga di calendario porta già l'esito.
    const [row] = await calendarRows();
    expect(row!.outcome).toMatchObject({ type: "milestone" });
    // La notifica è visibile ma GIÀ gestita: nessun tap può rieseguire nulla
    // (answerGoogleProposal risponde `proposal_stale` a una non `open`, vedi
    // `apps/server/src/services/google-proposal.ts`).
    const [notif] = await db.select().from(notifications);
    expect(notif!.status).toBe("handled");
    expect(notif!.handledAt).not.toBeNull();
    expect((notif!.event as { auto?: boolean }).auto).toBe(true);
  });

  it("auto: true, action: backlog_item — crea la voce di backlog senza chiedere, MAI un job AI", async () => {
    const projectId = await seedProject("Acme");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    await db
      .insert(calendarSeries)
      .values({ accountId: account.id, recurringEventId: "serie-1", enabled: true, projectId, action: "backlog_item", leadDays: 2, auto: true });
    await seedOccurrence(account.id, projectId);

    await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));

    const created = await db.select().from(backlogItems);
    expect(created).toHaveLength(1);
    expect(created[0]!.source).toBe("manual");
    const [notif] = await db.select().from(notifications);
    expect(notif!.status).toBe("handled");
  });

  it("il percorso `auto` non fa MAI partire un job AI — rete di sicurezza esplicita, per tutte e tre le azioni", async () => {
    const projectId = await seedProject("Acme");
    for (const action of ["backlog_item", "milestone", "reminder"] as const) {
      const account = await seedAccount({
        email: `mailbox-${randomUUID()}@acme.com`,
        nextSyncAt: new Date(Date.now() - 60_000),
      });
      await db
        .insert(calendarSeries)
        .values({ accountId: account.id, recurringEventId: "serie-1", enabled: true, projectId, action, leadDays: 2, auto: true });
      await seedOccurrence(account.id, projectId);

      await pollGoogleOnce(deps(account, fakeGmail({ listed: [] }), { now: () => NOW }));
    }

    expect(await db.select().from(aiJobs)).toHaveLength(0);
    expect(await db.select().from(backlogJobs)).toHaveLength(0);
  });
});
