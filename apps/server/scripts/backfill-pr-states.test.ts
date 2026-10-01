import { randomBytes } from "node:crypto";
import {
  aiJobs,
  encrypt,
  gitAccounts,
  notifications,
  prCorrections,
  repositories,
  ticketRepositories,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedTicket, seedTicketRepository, startTestDb } from "@stubwise/db/testing";
import { GitProviderError, type FetchLike, type PullRequestFinalState } from "@stubwise/git";
import { promoteStalePendings } from "@stubwise/notifications";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillPrStates, unverifiedTotal, type ProviderFor } from "./backfill-pr-states.js";

/**
 * G7: le righe `ticket_repositories` rimaste `open` su PR già chiuse prima
 * che il webhook (G3) scrivesse lo stato. Il provider è un doppio: i test non
 * parlano con la rete, e il `fetch` di base lancia se qualcuno lo chiama
 * senza che il test lo voglia.
 */

let testDb: TestDb;
const KEY = randomBytes(32);
const quietLogger = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Stato che il doppio risponde per numero di PR; una funzione per gli errori. */
let answers: Map<number, PullRequestFinalState | (() => Promise<PullRequestFinalState>)>;
const getPullRequestFinalState = vi.fn(
  async (_p: unknown, prNumber: number): Promise<PullRequestFinalState> => {
    const answer = answers.get(prNumber);
    if (answer === undefined) throw new Error(`nessuna risposta preparata per la PR ${prNumber}`);
    return typeof answer === "function" ? answer() : answer;
  },
);
const providerFor: ProviderFor = () => ({ getPullRequestFinalState });

const noNetwork = vi.fn(async (): Promise<Response> => {
  throw new Error("rete non consentita nei test");
});

beforeEach(async () => {
  answers = new Map();
  getPullRequestFinalState.mockClear();
  noNetwork.mockClear();
  await testDb.db.delete(ticketRepositories);
  await testDb.db.delete(prCorrections);
  await testDb.db.delete(aiJobs);
});

function run(dryRun = false, extra: { fetchImpl?: FetchLike; requestTimeoutMs?: number } = {}) {
  return backfillPrStates(testDb.db, {
    dryRun,
    encryptionKey: KEY,
    providerFor,
    logger: quietLogger,
    fetchImpl: extra.fetchImpl ?? noNetwork,
    requestTimeoutMs: extra.requestTimeoutMs,
  });
}

let ticketSeq = 100;

/** Un repository col suo account principale (credenziali cifrate con KEY) e un ticket con la riga PR `open`. */
async function seedPrRow(
  prNumber: number,
  opts: { credentials?: string; withNumber?: boolean; repositoryId?: string; projectId?: string } = {},
) {
  let repositoryId = opts.repositoryId;
  let projectId = opts.projectId;
  if (!repositoryId || !projectId) {
    const seeded = await seedRepository(testDb.db);
    repositoryId = seeded.repositoryId;
    projectId = seeded.projectId;
    const [account] = await testDb.db
      .insert(gitAccounts)
      .values({
        name: `Account ${randomBytes(3).toString("hex")}`,
        provider: "github",
        encryptedCredentials:
          opts.credentials ?? encrypt(JSON.stringify({ username: "bot", token: "tok" }), KEY),
      })
      .returning();
    await testDb.db
      .update(repositories)
      .set({ gitAccountId: account!.id })
      .where(eq(repositories.id, repositoryId));
  }
  const { ticketId } = await seedTicket(testDb.db, { number: ++ticketSeq, projectId, repositoryId });
  await testDb.db.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticketId));
  const rowId = await seedTicketRepository(testDb.db, {
    ticketId,
    repositoryId,
    prUrl: `https://github.com/octo/repo/pull/${prNumber}`,
    prNumber: opts.withNumber === false ? null : prNumber,
  });
  return { repositoryId, projectId, ticketId, rowId };
}

async function prStateOf(rowId: string) {
  const [row] = await testDb.db
    .select({ prState: ticketRepositories.prState })
    .from(ticketRepositories)
    .where(eq(ticketRepositories.id, rowId));
  return row!.prState;
}

/** Una correzione `queued` sulla PR, col suo job `queued`. */
async function seedQueuedCorrection(ticketId: string, repositoryId: string, prNumber: number) {
  const [correction] = await testDb.db
    .insert(prCorrections)
    .values({ ticketId, repositoryId, prNumber, trigger: "review", status: "queued" })
    .returning();
  const [job] = await testDb.db
    .insert(aiJobs)
    .values({ ticketId, status: "queued", correctionId: correction!.id })
    .returning();
  return { correctionId: correction!.id, jobId: job!.id };
}

async function correctionStatus(id: string) {
  const [row] = await testDb.db.select({ status: prCorrections.status }).from(prCorrections).where(eq(prCorrections.id, id));
  return row!.status;
}

async function jobStatus(id: string) {
  const [row] = await testDb.db.select({ status: aiJobs.status }).from(aiJobs).where(eq(aiJobs.id, id));
  return row!.status;
}

/** Fotografia di ciò che lo script NON deve toccare. */
async function untouchables() {
  return {
    tickets: await testDb.db.select({ id: tickets.id, status: tickets.status }).from(tickets).orderBy(asc(tickets.id)),
    notifications: await testDb.db.select({ id: notifications.id }).from(notifications).orderBy(asc(notifications.id)),
    jobs: await testDb.db.select({ id: aiJobs.id }).from(aiJobs).orderBy(asc(aiJobs.id)),
  };
}

const NONE = { error: 0, timeout: 0, not_found: 0, credentials: 0, no_pr_number: 0 };

describe("backfillPrStates", () => {
  it("merged: la riga diventa merged e la correzione queued è annullata, col suo job skipped", async () => {
    const fx = await seedPrRow(42);
    const c = await seedQueuedCorrection(fx.ticketId, fx.repositoryId, 42);
    answers.set(42, "merged");

    const result = await run();

    expect(result).toEqual({
      candidates: 1,
      merged: 1,
      closedUnmerged: 0,
      stillOpen: 0,
      unverified: NONE,
      correctionsCancelled: 1,
    });
    expect(await prStateOf(fx.rowId)).toBe("merged");
    expect(await correctionStatus(c.correctionId)).toBe("cancelled");
    expect(await jobStatus(c.jobId)).toBe("skipped");
    expect(getPullRequestFinalState).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { username: "bot", token: "tok" } }),
      42,
      expect.objectContaining({ fetchImpl: expect.any(Function) }),
    );
  });

  it("closed: la riga diventa closed_unmerged", async () => {
    const fx = await seedPrRow(43);
    answers.set(43, "closed_unmerged");

    const result = await run();

    expect(result).toMatchObject({ candidates: 1, merged: 0, closedUnmerged: 1, unverified: NONE });
    expect(await prStateOf(fx.rowId)).toBe("closed_unmerged");
  });

  it("ancora aperta: la riga resta intatta e conta come «ancora aperta»", async () => {
    const fx = await seedPrRow(44);
    const c = await seedQueuedCorrection(fx.ticketId, fx.repositoryId, 44);
    answers.set(44, "open");

    const result = await run();

    expect(result).toMatchObject({ candidates: 1, stillOpen: 1, merged: 0, closedUnmerged: 0, correctionsCancelled: 0 });
    expect(unverifiedTotal(result)).toBe(0);
    expect(await prStateOf(fx.rowId)).toBe("open");
    expect(await correctionStatus(c.correctionId)).toBe("queued");
  });

  it("errore del provider: riga intatta, «non verificata: errore», correzione intatta", async () => {
    const fx = await seedPrRow(45);
    const c = await seedQueuedCorrection(fx.ticketId, fx.repositoryId, 45);
    answers.set(45, async () => {
      throw new GitProviderError("GitHub API request failed with status 500: token=segreto", 500, "token=segreto");
    });
    const warn = vi.fn();

    const result = await backfillPrStates(testDb.db, {
      dryRun: false,
      encryptionKey: KEY,
      providerFor,
      logger: { info: () => {}, warn },
      fetchImpl: noNetwork,
    });

    expect(result).toMatchObject({ candidates: 1, merged: 0, closedUnmerged: 0, stillOpen: 0, correctionsCancelled: 0 });
    expect(result.unverified).toEqual({ ...NONE, error: 1 });
    expect(await prStateOf(fx.rowId)).toBe("open");
    expect(await correctionStatus(c.correctionId)).toBe("queued");
    // La categoria sì, il messaggio grezzo (e quello che contiene) mai.
    expect(warn.mock.calls.flat().join("\n")).toContain("(error)");
    expect(warn.mock.calls.flat().join("\n")).not.toContain("segreto");
  });

  it("404: riga intatta, «non trovata»", async () => {
    const fx = await seedPrRow(46);
    answers.set(46, async () => {
      throw new GitProviderError("not found", 404, "");
    });

    const result = await run();

    expect(result.unverified).toEqual({ ...NONE, not_found: 1 });
    expect(await prStateOf(fx.rowId)).toBe("open");
  });

  it("timeout: riga intatta, «non verificata: timeout», e lo script passa alla PR successiva", async () => {
    const appesa = await seedPrRow(47);
    const altra = await seedPrRow(48);
    const hanging = vi.fn(
      (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    answers.set(48, "merged");
    // La PR 47 passa davvero dal fetch dato (che resta appeso); l'ordine di
    // visita dipende dagli slug, quindi lo stesso doppio serve entrambe.
    const viaFetch = async (_p: unknown, prNumber: number, opts?: unknown): Promise<PullRequestFinalState> => {
      if (prNumber !== 47) return answers.get(prNumber) as PullRequestFinalState;
      await (opts as { fetchImpl: FetchLike }).fetchImpl("https://api.example.test/pulls/47");
      return "merged";
    };
    getPullRequestFinalState.mockImplementationOnce(viaFetch).mockImplementationOnce(viaFetch);

    const result = await run(false, { fetchImpl: hanging, requestTimeoutMs: 30 });

    expect(hanging).toHaveBeenCalledTimes(1);
    expect(result.unverified).toEqual({ ...NONE, timeout: 1 });
    expect(result.merged).toBe(1);
    expect(await prStateOf(appesa.rowId)).toBe("open");
    expect(await prStateOf(altra.rowId)).toBe("merged");
  });

  it("credenziali non decifrabili: riga intatta, «non verificata: credentials», nessuna chiamata", async () => {
    const fx = await seedPrRow(49, { credentials: encrypt(JSON.stringify({ token: "tok" }), randomBytes(32)) });
    answers.set(49, "merged");

    const result = await run();

    expect(result.unverified).toEqual({ ...NONE, credentials: 1 });
    expect(getPullRequestFinalState).not.toHaveBeenCalled();
    expect(await prStateOf(fx.rowId)).toBe("open");
  });

  it("--dry-run: nessuna scrittura, ma il provider è chiamato e i conteggi sono quelli veri", async () => {
    const a = await seedPrRow(50);
    const ca = await seedQueuedCorrection(a.ticketId, a.repositoryId, 50);
    const b = await seedPrRow(51);
    const c = await seedPrRow(52);
    const d = await seedPrRow(53, { credentials: "blob-rotto" });
    answers.set(50, "merged").set(51, "closed_unmerged").set(52, "open").set(53, "merged");

    const result = await run(true);

    expect(result).toEqual({
      candidates: 4,
      merged: 1,
      closedUnmerged: 1,
      stillOpen: 1,
      unverified: { ...NONE, credentials: 1 },
      correctionsCancelled: 1,
    });
    expect(getPullRequestFinalState).toHaveBeenCalledTimes(3);
    for (const fx of [a, b, c, d]) expect(await prStateOf(fx.rowId)).toBe("open");
    expect(await correctionStatus(ca.correctionId)).toBe("queued");
    expect(await jobStatus(ca.jobId)).toBe("queued");
  });

  it("secondo lancio: le righe allineate non sono più candidate", async () => {
    await seedPrRow(54);
    await seedPrRow(55);
    answers.set(54, "merged").set(55, "closed_unmerged");

    const first = await run();
    expect(first.candidates).toBe(2);
    getPullRequestFinalState.mockClear();

    const second = await run();

    expect(second).toEqual({
      candidates: 0,
      merged: 0,
      closedUnmerged: 0,
      stillOpen: 0,
      unverified: NONE,
      correctionsCancelled: 0,
    });
    expect(getPullRequestFinalState).not.toHaveBeenCalled();
  });

  it("non cambia lo stato dei ticket, non pubblica notifiche, non inserisce job", async () => {
    const a = await seedPrRow(56);
    await seedQueuedCorrection(a.ticketId, a.repositoryId, 56);
    await seedPrRow(57);
    answers.set(56, "merged").set(57, "closed_unmerged");
    const before = await untouchables();

    await run();

    const after = await untouchables();
    expect(after.tickets).toEqual(before.tickets);
    expect(after.tickets.find((t) => t.id === a.ticketId)?.status).toBe("in_review");
    expect(after.notifications).toEqual(before.notifications);
    expect(after.jobs).toEqual(before.jobs);
  });

  it("riga storica senza prNumber: il numero viene dall'URL", async () => {
    const fx = await seedPrRow(58, { withNumber: false });
    answers.set(58, "merged");

    const result = await run();

    expect(getPullRequestFinalState).toHaveBeenCalledWith(expect.anything(), 58, expect.anything());
    expect(result.merged).toBe(1);
    expect(await prStateOf(fx.rowId)).toBe("merged");
  });

  it("non promuove le pending di un'altra PR: lo fa il tick (promoteStalePendings)", async () => {
    const fx = await seedPrRow(60);
    // Stesso ticket, un'altra PR (61) con una pending: la correzione in coda
    // sulla 60 la blocca finché il suo job è vivo.
    await seedQueuedCorrection(fx.ticketId, fx.repositoryId, 60);
    const [pending] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: fx.ticketId, repositoryId: fx.repositoryId, prNumber: 61, trigger: "stubwise", status: "pending" })
      .returning();
    answers.set(60, "merged");

    await run();

    expect(await correctionStatus(pending!.id)).toBe("pending");
    const promoted = await promoteStalePendings(testDb.db);
    expect(promoted).toContain(pending!.id);
    expect(await correctionStatus(pending!.id)).toBe("queued");
  });
});
