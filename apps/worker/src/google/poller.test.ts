import { randomBytes, randomUUID } from "node:crypto";
import {
  calendarEvents,
  emailMessages,
  googleAccounts,
  googleWorkspaces,
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

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(emailMessages);
  await db.delete(calendarEvents);
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
  it("cancella solo gli stati terminali oltre la soglia", async () => {
    const account = await seedAccount();
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
      // Vecchio ma NON terminale: è una card ancora aperta in una inbox.
      { ...base, gmailMessageId: "vecchio-proposed", status: "proposed", updatedAt: old },
      { ...base, gmailMessageId: "vecchio-new", status: "new", updatedAt: old },
      // Terminale ma recente.
      { ...base, gmailMessageId: "recente-actioned", status: "actioned", updatedAt: recent },
    ]);

    expect(await pruneOldEmails(db, 90)).toBe(3);

    const left = (await db.select().from(emailMessages)).map((row) => row.gmailMessageId).sort();
    expect(left).toEqual(["recente-actioned", "vecchio-new", "vecchio-proposed"]);
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
 */
describe("fase 4 — le righe pronte diventano proposte", () => {
  /** Un messaggio già classificato dal giro precedente, in attesa di proposta. */
  async function seedClassified(accountId: string, projectId: string): Promise<string> {
    const [row] = await db
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
    return row!.id;
  }

  it("un messaggio classificato diventa una notifica per il proprietario della casella", async () => {
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const messageId = await seedClassified(account.id, projectId);

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(stats.proposed).toBe(1);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    // ⚠️ Audience `mailbox_owner`: la card è del proprietario della casella e
    // di nessun altro — l'invariante di privacy della fase.
    expect(rows[0]?.userId).toBe(account.userId);
    expect(rows[0]?.kind).toBe("google.proposal");
    const [message] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    expect(message?.status).toBe("proposed");
    expect(message?.proposalNotificationId).toBe(rows[0]?.id);
  });

  it("un secondo giro non ripropone lo stesso messaggio", async () => {
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

  it("una classificazione da cui non resta niente chiude la riga invece di ripescarla", async () => {
    // `classified` senza nessuna azione eseguibile resterebbe candidata a ogni
    // tick per sempre, occupando uno slot del tetto. `ignored` la chiude senza
    // inventare una proposta che non c'è.
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const [row] = await db
      .insert(emailMessages)
      .values({
        accountId: account.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        receivedAt: new Date("2026-09-07T08:00:00.000Z"),
        projectId,
        status: "classified",
        classification: { signal: "none", recommendedIndex: 0, proposals: [] },
      })
      .returning({ id: emailMessages.id });

    const stats = await pollGoogleOnce(deps(account, fakeGmail({ listed: [] })));

    expect(stats.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
    const [after] = await db.select().from(emailMessages).where(eq(emailMessages.id, row!.id));
    expect(after?.status).toBe("ignored");
  });

  it("`proposeMaxPerTick: 0` spegne la sola pubblicazione, le righe restano pronte", async () => {
    const projectId = await seedProject("negozio");
    const account = await seedAccount({ nextSyncAt: new Date(Date.now() - 60_000) });
    const messageId = await seedClassified(account.id, projectId);

    const stats = await pollGoogleOnce(
      deps(account, fakeGmail({ listed: [] }), { proposeMaxPerTick: 0 }),
    );

    expect(stats.proposed).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
    const [message] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    // La riga NON viene toccata: al primo tick con la fase riaccesa riparte.
    expect(message?.status).toBe("classified");
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
    attendees: ["cliente@cliente.com", MAILBOX],
    organizer: MAILBOX,
    htmlLink: null,
    updatedAt: null,
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
