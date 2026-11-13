import { randomUUID } from "node:crypto";
import { automationRuns, automations, googleAccounts, googleWorkspaces, mailDrafts, mailOutgoing, projects, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { GoogleApiError } from "@stubwise/google";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { recoverInterruptedSends, sendDueMail, startMailSender, type MailSenderClient } from "./mail-sender.js";

/**
 * L'INVIO ALLO SCADERE DEI 10 SECONDI (area 6, F3, task 4, D6): manda solo
 * le righe dovute, una volta sola, e non ritenta mai da solo.
 */

let testDb: TestDb;
let db: Db;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);
afterEach(async () => {
  await db.delete(mailOutgoing);
  await db.delete(mailDrafts);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});
afterAll(async () => {
  await testDb.stop();
});

function client(sendImpl?: () => Promise<{ messageId: string; threadId: string }>) {
  const sent: string[] = [];
  const raws: { raw: string; threadId: string | null }[] = [];
  const c: MailSenderClient = {
    refreshAccessToken: async () => ({ accessToken: "at", expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null }),
    sendDraft: async (input) => {
      sent.push(input.id);
      return sendImpl ? sendImpl() : { messageId: `m-${input.id}`, threadId: "t1" };
    },
    sendMessage: async (input) => {
      raws.push({ raw: input.raw, threadId: input.threadId ?? null });
      return sendImpl ? sendImpl() : { messageId: `m-auto-${raws.length}`, threadId: input.threadId ?? `t-auto-${raws.length}` };
    },
  };
  return { c, sent, raws };
}

async function queued(sendAtOffsetMs: number) {
  const [user] = await db.insert(users).values({ email: `u-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" } as typeof users.$inferInsert).returning();
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [account] = await db.insert(googleAccounts).values({ userId: user!.id, workspaceId: ws!.id, email: `b-${randomUUID()}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  const [draft] = await db.insert(mailDrafts).values({ userId: user!.id, accountId: account!.id, gmailDraftId: `gd-${randomUUID()}`, threadId: "t1", mode: "reply", state: "sending" }).returning();
  const [row] = await db
    .insert(mailOutgoing)
    .values({ userId: user!.id, accountId: account!.id, draftId: draft!.id, gmailDraftId: draft!.gmailDraftId, threadId: "t1", sendAt: sql`now() + make_interval(secs => ${sendAtOffsetMs / 1000})` })
    .returning();
  return { row: row!, draft: draft!, account: account! };
}
const deps = (c: MailSenderClient) => ({
  db,
  encryptionKey: Buffer.alloc(32),
  client: c,
  loadCredentials: async () => ({ clientId: "c", clientSecret: "s", refreshToken: "r", email: "x", accountId: "a" }) as never,
});
const reload = async (id: string) => (await db.select().from(mailOutgoing).where(eq(mailOutgoing.id, id)))[0]!;

/** Un'email di un'automazione (area 7, F2, C-F2-1): nessuna bozza, l'esecuzione che l'ha chiesta. */
async function automationRow() {
  const { account, row: human } = await queued(60_000);
  await db.delete(mailOutgoing).where(eq(mailOutgoing.id, human.id));
  const [project] = await db.insert(projects).values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  const [a] = await db.insert(automations).values({ code: `M${randomUUID().slice(0, 5)}-A1`, seq: 1, name: "A", projectId: project!.id }).returning();
  const [run] = await db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "R", origin: "manual" }).returning();
  const insert = (rfc: string, threadId: string | null, state: "queued" | "sent", offsetMs = -1000) =>
    db
      .insert(mailOutgoing)
      .values({ userId: account.userId, accountId: account.id, automationRunId: run!.id, gmailThreadId: threadId, rfcMessageId: rfc, toAddresses: [{ email: "cliente@b.it", name: null }], subject: "Benvenuto", body: "Ciao Rossi", state, sendAt: sql`now() + make_interval(secs => ${offsetMs / 1000})` })
      .returning();
  return { account, run: run!, insert };
}

describe("sendDueMail", () => {
  it("area 7, F2: un'email d'automazione parte SENZA bozza, dalla casella, col suo Message-ID; nella stessa conversazione risponde alla precedente", async () => {
    const { account, insert } = await automationRow();
    const [first] = await insert("<a1@stubwise>", null, "queued");
    const { c, sent, raws } = client();
    expect(await sendDueMail(deps(c))).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual([]);
    const mime = Buffer.from(raws[0]!.raw, "base64url").toString("utf8");
    expect(mime).toContain(`From: ${account.email}`);
    expect(mime).toContain("To: cliente@b.it");
    expect(mime).toContain("Message-ID: <a1@stubwise>");
    expect(mime).not.toContain("In-Reply-To");
    expect(raws[0]!.threadId).toBeNull();
    const firstSent = await reload(first!.id);
    expect(firstSent).toMatchObject({ state: "sent", gmailMessageId: "m-auto-1", gmailThreadId: "t-auto-1" });
    // La seconda allo stesso indirizzo: nel thread della prima, in risposta alla prima.
    const [second] = await insert("<a2@stubwise>", firstSent.gmailThreadId, "queued");
    await sendDueMail(deps(c));
    const reply = Buffer.from(raws[1]!.raw, "base64url").toString("utf8");
    expect(raws[1]!.threadId).toBe("t-auto-1");
    expect(reply).toContain("In-Reply-To: <a1@stubwise>");
    expect(reply).toContain("References: <a1@stubwise>");
    expect(await reload(second!.id)).toMatchObject({ state: "sent", gmailThreadId: "t-auto-1" });
  });


  it("manda le righe DOVUTE: la bozza di Gmail parte, la riga è sent, la bozza se ne va", async () => {
    const { row, draft } = await queued(-1000);
    const { c, sent } = client();
    expect(await sendDueMail(deps(c))).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual([draft.gmailDraftId]);
    expect(await reload(row.id)).toMatchObject({ state: "sent", gmailMessageId: `m-${draft.gmailDraftId}`, gmailThreadId: "t1" });
    expect(await db.select().from(mailDrafts).where(eq(mailDrafts.id, draft.id))).toEqual([]);
  });

  it("NIENTE prima dei 10 secondi, e niente di annullato", async () => {
    const early = await queued(60_000);
    const gone = await queued(-1000);
    await db.update(mailOutgoing).set({ state: "cancelled" }).where(eq(mailOutgoing.id, gone.row.id));
    const { c, sent } = client();
    await sendDueMail(deps(c));
    expect(sent).toEqual([]);
    expect((await reload(early.row.id)).state).toBe("queued");
  });

  it("un fallimento resta failed col suo codice, e il giro dopo NON ritenta", async () => {
    const { row } = await queued(-1000);
    const { c, sent } = client(async () => {
      throw new GoogleApiError({ api: "gmail.drafts.send", status: 429, code: "rate_limited", reason: "rateLimitExceeded" });
    });
    await sendDueMail(deps(c));
    expect(await reload(row.id)).toMatchObject({ state: "failed", error: "quota" });
    await sendDueMail(deps(c));
    expect(sent).toHaveLength(1);
  });

  it("due giri insieme: UNA email sola", async () => {
    const { row } = await queued(-1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { c, sent } = client(async () => {
      await gate;
      return { messageId: "m", threadId: "t1" };
    });
    const a = sendDueMail(deps(c));
    const b = sendDueMail(deps(c));
    await new Promise((r) => setTimeout(r, 200));
    release();
    await Promise.all([a, b]);
    expect(sent).toHaveLength(1);
    expect((await reload(row.id)).state).toBe("sent");
  });

  it("una casella disabilitata: failed account_disabled, nessuna chiamata", async () => {
    const { row, account } = await queued(-1000);
    await db.update(googleAccounts).set({ disabledAt: new Date(), disabledReason: "revoked" }).where(eq(googleAccounts.id, account.id));
    const { c, sent } = client();
    await sendDueMail(deps(c));
    expect(sent).toEqual([]);
    expect(await reload(row.id)).toMatchObject({ state: "failed", error: "account_disabled" });
  });
});

describe("recoverInterruptedSends", () => {
  it("un invio rimasto `sending` (worker morto a metà) diventa failed interrupted, e NON si rimanda", async () => {
    const { row } = await queued(-1000);
    await db.update(mailOutgoing).set({ state: "sending" }).where(eq(mailOutgoing.id, row.id));
    expect(await recoverInterruptedSends(db)).toBe(1);
    expect(await reload(row.id)).toMatchObject({ state: "failed", error: "interrupted" });
    const { c, sent } = client();
    await sendDueMail(deps(c));
    expect(sent).toEqual([]);
  });
});

describe("review F3, punto 2: un intoppo del DB non fa uscire il worker, e un invio riuscito non diventa un doppione", () => {
  /** Il db, con le prime `n` transazioni che falliscono (dopo che Gmail ha mandato). */
  function flakyTransactions(n: number): Db {
    let left = n;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return async (fn: Parameters<Db["transaction"]>[0]) => {
          if (left > 0) {
            left -= 1;
            throw new Error("connessione persa");
          }
          return target.transaction(fn);
        };
      },
    }) as Db;
  }

  it("Gmail ha mandato, la scrittura di `sent` fallisce una volta: si ritenta, ed è sent (una sola email)", async () => {
    const { row } = await queued(-1000);
    const { c, sent } = client();
    await sendDueMail({ ...deps(c), db: flakyTransactions(1) });
    expect(sent).toHaveLength(1);
    expect((await reload(row.id)).state).toBe("sent");
  });

  it("…e se fallisce sempre: failed con `sent_unrecorded` (MAI other: Elimina e Riprova manderebbero un doppione)", async () => {
    const { row } = await queued(-1000);
    const { c, sent } = client();
    await sendDueMail({ ...deps(c), db: flakyTransactions(99) });
    expect(sent).toHaveLength(1);
    expect(await reload(row.id)).toMatchObject({ state: "failed", error: "sent_unrecorded" });
  });

  it("un errore del DB scrivendo il fallimento non fa RIFIUTARE il giro (il worker non esce)", async () => {
    await queued(-1000);
    const { c } = client(async () => {
      throw new GoogleApiError({ api: "gmail.drafts.send", status: 400, code: "bad_request", reason: "invalid" });
    });
    let updates = 0;
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "update") {
          updates += 1;
          // La prima è il claim; la seconda (il fallimento) si rompe.
          if (updates >= 2) throw new Error("db giù");
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    await expect(sendDueMail({ ...deps(c), db: broken })).resolves.toBeDefined();
  });
});

describe("review F3, punto 2: il catch del giro", () => {
  it("un errore che SFUGGE da dentro il giro non diventa un rifiuto non gestito (il worker non esce): si logga", async () => {
    await queued(-1000);
    const { c } = client(async () => {
      throw new GoogleApiError({ api: "gmail.drafts.send", status: 400, code: "bad_request", reason: "invalid" });
    });
    const errors: string[] = [];
    // Il log del fallimento lancia: è l'errore che esce da `sendDueMail`.
    const logger = { info: () => {}, warn: () => { throw new Error("log rotto"); }, error: (m: string) => void errors.push(m) };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const controller = new AbortController();
    try {
      startMailSender({ ...deps(c), logger, signal: controller.signal, pollMs: 50 });
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      controller.abort();
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(errors.some((m) => m.includes("giro degli invii fallito") && m.includes("log rotto"))).toBe(true);
  });
});

