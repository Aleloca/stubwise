import { randomBytes, randomUUID } from "node:crypto";
import {
  aiJobs,
  emailMessages,
  emailProposals,
  encrypt,
  googleAccounts,
  googleWorkspaces,
  notifications,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { GoogleApiError } from "@stubwise/google";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillEmailCc, decodeEncryptionKey, type BackfillGoogleClient } from "./backfill-email-cc.js";

/**
 * Recupero una tantum di chi è in COPIA sui messaggi storici (16 set 2026).
 *
 * I test che contano più degli altri NON sono quelli sull'esito dello script:
 * sono i tre PALETTI. Uno script che tocca la posta di qualcuno deve poter
 * essere lanciato in produzione senza che una proposta aperta se ne accorga,
 * e questo file lo verifica sui VALORI prima/dopo, non sul fatto che lo
 * script sia andato a buon fine.
 */

let testDb: TestDb;
const ENCRYPTION_KEY = randomBytes(32);

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

const refreshAccessToken = vi.fn();
const getMessageMetadata = vi.fn();

beforeEach(() => {
  // ⚠️ Azzerate qui e non alla creazione: sono spie su un client condiviso fra
  // i test di questo file, e senza il reset i conteggi di chiamate di un test
  // finirebbero in quello dopo — il test dell'idempotenza («zero chiamate al
  // secondo giro») passerebbe o fallirebbe a seconda dell'ordine.
  refreshAccessToken.mockReset();
  getMessageMetadata.mockReset();
  refreshAccessToken.mockResolvedValue({ accessToken: "tok", expiresAt: new Date() });
  getMessageMetadata.mockResolvedValue({
    id: "g-1",
    threadId: "t-1",
    labelIds: [],
    snippet: "",
    historyId: null,
    internalDate: null,
    headers: { cc: "m.misseri@thecove.it, g.rossi@acme.test" },
  });
});

const google = { refreshAccessToken, getMessageMetadata } as unknown as BackfillGoogleClient;
const quietLogger = { info: () => {}, warn: () => {} };

function run(dryRun = false) {
  return backfillEmailCc(testDb.db, {
    dryRun,
    encryptionKey: ENCRYPTION_KEY,
    google,
    logger: quietLogger,
  });
}

async function seedMailbox(): Promise<string> {
  const [user] = await testDb.db
    .insert(await import("@stubwise/db").then((m) => m.users))
    .values({ email: `u-${randomUUID()}@acme.test`, passwordHash: "x", role: "member" })
    .returning({ id: (await import("@stubwise/db")).users.id });
  const [workspace] = await testDb.db
    .insert(googleWorkspaces)
    .values({
      name: "Acme",
      domains: ["acme.test"],
      clientId: "client-id",
      clientSecretEncrypted: encrypt("client-secret", ENCRYPTION_KEY),
    })
    .returning({ id: googleWorkspaces.id });
  const [account] = await testDb.db
    .insert(googleAccounts)
    .values({
      userId: user!.id,
      workspaceId: workspace!.id,
      email: `mailbox-${randomUUID()}@acme.test`,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: encrypt("refresh-token", ENCRYPTION_KEY),
    })
    .returning({ id: googleAccounts.id });
  return account!.id;
}

async function seedMessage(
  accountId: string,
  overrides: Partial<typeof emailMessages.$inferInsert> = {},
): Promise<string> {
  const [row] = await testDb.db
    .insert(emailMessages)
    .values({
      accountId,
      gmailMessageId: `g-${randomUUID()}`,
      threadId: `t-${randomUUID()}`,
      fromAddress: "cliente@acme.test",
      subject: "Un oggetto",
      textExcerpt: "il testo che la classificazione ha letto",
      receivedAt: new Date("2026-08-04T09:00:00.000Z"),
      ...overrides,
    })
    .returning({ id: emailMessages.id });
  return row!.id;
}

async function reload(id: string) {
  const [row] = await testDb.db.select().from(emailMessages).where(eq(emailMessages.id, id));
  return row!;
}

/**
 * La decodifica del segreto, che il 16 set 2026 ha fatto fallire il recupero
 * in PRODUZIONE senza che nulla sembrasse rotto.
 *
 * Lo script leggeva `ENCRYPTION_KEY` come **hex** mentre il server la valida
 * come **base64**: `Buffer.from(<base64>, "hex")` non lancia, restituisce
 * ZERO byte. Ogni decifratura falliva, tutte e tre le caselle finivano nel
 * ramo «non usabile» e il log diceva «163 righe saltate» — che si legge come
 * «le caselle sono scollegate», non come «il segreto è illeggibile».
 *
 * Il difetto stava nel punto di ingresso, l'unico pezzo che i test non
 * toccavano di proposito. Ora la conversione è una funzione a sé, e questi
 * test la coprono da entrambi i lati: la codifica giusta, e il fallimento
 * RUMOROSO di quella sbagliata.
 */
describe("decodeEncryptionKey", () => {
  it("legge base64, la stessa codifica del server", () => {
    const key = randomBytes(32);
    expect(decodeEncryptionKey(key.toString("base64"))).toEqual(key);
  });

  it("⚠️ una chiave in HEX lancia, invece di dare zero byte in silenzio", () => {
    // Il caso esatto della produzione: 44 caratteri base64 che, letti come
    // hex, davano un buffer vuoto senza che nessuno se ne accorgesse.
    expect(() => decodeEncryptionKey(randomBytes(32).toString("hex"))).toThrow(/32 byte in base64/);
  });

  it("una chiave della lunghezza sbagliata lancia dicendo quanti byte ha", () => {
    expect(() => decodeEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/ne ha 16/);
  });
});

describe("backfillEmailCc", () => {
  it("una riga senza copia nota viene riempita da Gmail", async () => {
    const accountId = await seedMailbox();
    const id = await seedMessage(accountId);

    const result = await run();

    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect((await reload(id)).ccAddresses).toEqual(["m.misseri@thecove.it", "g.rossi@acme.test"]);
  });

  it("`--dry-run` non scrive e non chiama Google nemmeno una volta", async () => {
    const accountId = await seedMailbox();
    const id = await seedMessage(accountId);

    const result = await run(true);

    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.updated).toBe(0);
    expect(getMessageMetadata).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect((await reload(id)).ccAddresses).toBeNull();
  });

  it("⚠️ IDEMPOTENTE: la seconda esecuzione non chiama Google nemmeno una volta", async () => {
    // È la proprietà per cui la colonna è NULLABLE e non `default '{}'`: la
    // condizione di ripresa è `is null`, quindi una riga già vista — anche se
    // il suo `cc` è vuoto — non viene mai ri-scaricata.
    const accountId = await seedMailbox();
    await seedMessage(accountId);
    // Un messaggio che legittimamente NON ha nessuno in copia: con un default
    // `'{}'` sarebbe indistinguibile da uno mai guardato, e tornerebbe a
    // Google a ogni lancio, per sempre.
    getMessageMetadata.mockResolvedValue({
      id: "g-2",
      threadId: "t-2",
      labelIds: [],
      snippet: "",
      historyId: null,
      internalDate: null,
      headers: {},
    });

    await run();
    const callsAfterFirst = getMessageMetadata.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    getMessageMetadata.mockClear();
    refreshAccessToken.mockClear();
    const second = await run();

    expect(second.candidates).toBe(0);
    expect(getMessageMetadata).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("un messaggio senza copia resta `[]`, non `null`: è «guardato, nessuno»", async () => {
    const accountId = await seedMailbox();
    const id = await seedMessage(accountId);
    getMessageMetadata.mockResolvedValue({
      id: "g-3",
      threadId: "t-3",
      labelIds: [],
      snippet: "",
      historyId: null,
      internalDate: null,
      headers: {},
    });

    await run();
    expect((await reload(id)).ccAddresses).toEqual([]);
  });

  it("⚠️ PALETTO 2 — un 404 non ferma il resto: quella riga resta `null`, le altre si riempiono", async () => {
    const accountId = await seedMailbox();
    const gone = await seedMessage(accountId, { gmailMessageId: "g-gone" });
    const ok = await seedMessage(accountId, { gmailMessageId: "g-ok" });

    getMessageMetadata.mockImplementation(async (input: { id: string }) => {
      if (input.id === "g-gone") {
        throw new GoogleApiError({
          api: "gmail.messages.get.metadata",
          status: 404,
          code: "message_gone",
          reason: "notFound",
        });
      }
      return {
        id: input.id,
        threadId: "t",
        labelIds: [],
        snippet: "",
        historyId: null,
        internalDate: null,
        headers: { cc: "m.misseri@thecove.it" },
      };
    });

    const result = await run();

    expect(result.skipped).toBe(1);
    expect((await reload(gone)).ccAddresses).toBeNull();
    expect((await reload(ok)).ccAddresses).toEqual(["m.misseri@thecove.it"]);
  });

  it("⚠️ PALETTO 1 — tocca SOLO `cc_addresses`: una proposta aperta non se ne accorge", async () => {
    const accountId = await seedMailbox();
    // `seedRepository` e non un insert a mano: `projects.ingestion_key` è NOT
    // NULL senza default, e il seed lo sa.
    const { projectId } = await seedRepository(testDb.db);
    const messageId = await seedMessage(accountId, {
      status: "proposed",
      outcome: { type: "qualcosa" },
    });
    const [proposal] = await testDb.db
      .insert(emailProposals)
      .values({
        emailMessageId: messageId,
        projectId,
        status: "proposed",
        classification: { signal: "request" },
      })
      .returning();

    const before = await reload(messageId);
    await run();
    const after = await reload(messageId);

    // L'unico campo che cambia.
    expect(before.ccAddresses).toBeNull();
    expect(after.ccAddresses).not.toBeNull();
    // Tutto il resto identico, VALORE per VALORE — non solo «lo script è
    // andato a buon fine».
    expect(after.textExcerpt).toBe(before.textExcerpt);
    expect(after.status).toBe(before.status);
    expect(after.outcome).toEqual(before.outcome);
    expect(after.proposalNotificationId).toBe(before.proposalNotificationId);
    expect(after.error).toBe(before.error);
    expect(after.projectId).toBe(before.projectId);
    expect(after.admitted).toBe(before.admitted);

    // E la proposta figlia è intatta: è LEI la cosa che un utente sta
    // guardando in inbox mentre lo script gira.
    const [proposalAfter] = await testDb.db
      .select()
      .from(emailProposals)
      .where(eq(emailProposals.id, proposal!.id));
    expect(proposalAfter!.status).toBe(proposal!.status);
    expect(proposalAfter!.classification).toEqual(proposal!.classification);
    expect(proposalAfter!.outcome).toEqual(proposal!.outcome);
    expect(proposalAfter!.proposalNotificationId).toBe(proposal!.proposalNotificationId);
  });

  it("⚠️ PALETTO 3 — non fa partire NIENTE: zero job, zero notifiche", async () => {
    const accountId = await seedMailbox();
    await seedMessage(accountId);

    await run();

    expect(await testDb.db.select().from(aiJobs)).toHaveLength(0);
    expect(await testDb.db.select().from(notifications)).toHaveLength(0);
  });

  it("una casella con credenziali non usabili salta le sue righe senza fermare lo script", async () => {
    const accountId = await seedMailbox();
    const id = await seedMessage(accountId);
    // Refresh token non decifrabile con questa chiave: la casella è inservibile.
    await testDb.db
      .update(googleAccounts)
      .set({ refreshTokenEncrypted: "non-decifrabile" })
      .where(eq(googleAccounts.id, accountId));

    const result = await run();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect((await reload(id)).ccAddresses).toBeNull();
  });
});
