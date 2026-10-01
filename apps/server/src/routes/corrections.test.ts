import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiJobs, prCorrections, prReviews, ticketRepositories } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedTicket, startTestDb } from "@stubwise/db/testing";
import { seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Il bottone "Applica le correzioni" (design §3 e §6): chiunque possa lanciare
 * un run sul ticket, senza gate; un solo ciclo attivo per PR, e i 409 dicono
 * PERCHÉ — la UI li mostra.
 */

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function seedPr(
  opts: {
    branch?: string;
    prState?: "open" | "merged" | "closed_unmerged";
    prUrl?: string | null;
    prNumber?: number | null;
  } = {},
) {
  const { ticketId, repositoryId } = await seedTicket(testDb.db);
  await testDb.db.insert(ticketRepositories).values({
    ticketId,
    repositoryId,
    branch: opts.branch ?? "stubwise/ticket-1",
    prUrl: opts.prUrl === undefined ? "https://github.com/acme/repo/pull/42" : opts.prUrl,
    prState: opts.prState ?? "open",
    prNumber: opts.prNumber === undefined ? 42 : opts.prNumber,
  });
  return { ticketId, repositoryId };
}

function request(ticketId: string, repositoryId: string, cookie: string, payload?: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/tickets/${ticketId}/repositories/${repositoryId}/corrections`,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function correctionsOf(repositoryId: string) {
  return testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, repositoryId));
}

async function jobOf(correctionId: string) {
  const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.correctionId, correctionId));
  return job;
}

describe("POST /api/tickets/:id/repositories/:repositoryId/corrections", () => {
  it("un OPERATORE la chiede: 202, correzione `stubwise` in coda col suo job, senza gate del piano", async () => {
    const { ticketId, repositoryId } = await seedPr();
    const [review] = await testDb.db
      .insert(prReviews)
      .values({
        repositoryId,
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        prTitle: "Fix",
        headSha: "a".repeat(40),
        status: "completed",
        verdict: "request_changes",
      })
      .returning();

    const res = await request(ticketId, repositoryId, users.memberCookie, {
      note: "  Rinomina anche il test  ",
    });

    expect(res.statusCode).toBe(202);
    const { correctionId } = res.json() as { correctionId: string };
    const [row] = await correctionsOf(repositoryId);
    expect(row).toMatchObject({
      id: correctionId,
      ticketId,
      prNumber: 42,
      trigger: "stubwise",
      status: "queued",
      requestedByUserId: users.memberId,
      note: "Rinomina anche il test",
      reviewId: review!.id,
    });
    expect(await jobOf(correctionId)).toMatchObject({ status: "queued", planApprovalRequired: false });
  });

  // E7: `manualTrigger` scavalca budget mensile e gate di automazione — è una
  // decisione di SPESA, quindi la prende solo un maintainer. Il server non
  // guarda il budget: decide il flag, e a budget esaurito il worker ferma
  // `held` il job di un member (provato in apps/worker/src/pipeline/correction.test.ts).
  it("stessi dati, due ruoli: il job di un member ha manualTrigger false, quello di un admin true", async () => {
    const asMember = await seedPr();
    const asAdmin = await seedPr();

    const resMember = await request(asMember.ticketId, asMember.repositoryId, users.memberCookie);
    const resAdmin = await request(asAdmin.ticketId, asAdmin.repositoryId, users.adminCookie);

    expect(resMember.statusCode).toBe(202);
    expect(resAdmin.statusCode).toBe(202);
    const memberJob = await jobOf((resMember.json() as { correctionId: string }).correctionId);
    const adminJob = await jobOf((resAdmin.json() as { correctionId: string }).correctionId);
    expect(memberJob).toMatchObject({ manualTrigger: false, requestedByUserId: users.memberId });
    expect(adminJob).toMatchObject({ manualTrigger: true, requestedByUserId: users.adminId });
  });

  it("senza corpo: 202 e nota null", async () => {
    const { ticketId, repositoryId } = await seedPr();

    const res = await request(ticketId, repositoryId, users.adminCookie);

    expect(res.statusCode).toBe(202);
    expect((await correctionsOf(repositoryId))[0]!.note).toBeNull();
  });

  it("nota di soli spazi: 202 e nota null, non una stringa vuota", async () => {
    const { ticketId, repositoryId } = await seedPr();

    const res = await request(ticketId, repositoryId, users.memberCookie, { note: "   \n  " });

    expect(res.statusCode).toBe(202);
    expect((await correctionsOf(repositoryId))[0]!.note).toBeNull();
  });

  it("una richiesta dalla piattaforma in attesa: il bottone la fa partire e la risposta porta il SUO id", async () => {
    const { ticketId, repositoryId } = await seedPr();
    const [pending] = await testDb.db
      .insert(prCorrections)
      .values({
        ticketId,
        repositoryId,
        prNumber: 42,
        trigger: "provider",
        status: "pending",
        requestedByProviderLogin: "mario",
      })
      .returning();

    const res = await request(ticketId, repositoryId, users.adminCookie, { note: "anche questo" });

    expect(res.statusCode).toBe(202);
    expect((res.json() as { correctionId: string }).correctionId).toBe(pending!.id);
    const rows = await correctionsOf(repositoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pending!.id, status: "queued" });
    // Chi ha premuto è un admin: la promozione la fa partire lui.
    expect(await jobOf(pending!.id)).toMatchObject({ status: "queued", manualTrigger: true });
  });

  // Lo stesso caso col MEMBER: la promozione la fa partire chi preme, e un
  // member non scavalca il budget — il job nasce `manualTrigger: false`.
  it("una richiesta dalla piattaforma in attesa: anche un MEMBER la fa partire, senza manualTrigger", async () => {
    const { ticketId, repositoryId } = await seedPr();
    const [pending] = await testDb.db
      .insert(prCorrections)
      .values({
        ticketId,
        repositoryId,
        prNumber: 42,
        trigger: "provider",
        status: "pending",
        requestedByProviderLogin: "mario",
      })
      .returning();

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(202);
    expect((res.json() as { correctionId: string }).correctionId).toBe(pending!.id);
    const rows = await correctionsOf(repositoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pending!.id, status: "queued" });
    expect(await jobOf(pending!.id)).toMatchObject({ status: "queued", manualTrigger: false });
  });

  it("riga storica senza prNumber: il numero si ricava dall'URL", async () => {
    const { ticketId, repositoryId } = await seedPr({
      prUrl: "https://github.com/acme/repo/pull/77",
      prNumber: null,
    });

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(202);
    expect((await correctionsOf(repositoryId))[0]!.prNumber).toBe(77);
  });

  it("durante una correzione: 409 correction_in_flight, e nessuna seconda riga", async () => {
    const { ticketId, repositoryId } = await seedPr();
    await request(ticketId, repositoryId, users.memberCookie);

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("correction_in_flight");
    expect(await correctionsOf(repositoryId)).toHaveLength(1);
    const jobs = await testDb.db
      .select()
      .from(aiJobs)
      .where(and(eq(aiJobs.ticketId, ticketId), isNotNull(aiJobs.correctionId)));
    expect(jobs).toHaveLength(1);
  });

  it("durante un FIX in corso: 409 job_in_flight, nessuna riga", async () => {
    const { ticketId, repositoryId } = await seedPr();
    await testDb.db.insert(aiJobs).values({ ticketId, status: "fixing" });

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("job_in_flight");
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  // Una correzione ferma `held` (limite del provider) è ancora la correzione
  // ATTIVA della PR: un secondo click non ne apre un'altra.
  it("correzione col job `held`: 409 correction_in_flight, nessuna seconda riga", async () => {
    const { ticketId, repositoryId } = await seedPr();
    const [held] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId, repositoryId, prNumber: 42, trigger: "stubwise", status: "queued" })
      .returning();
    await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status: "held", heldReason: "limit", correctionId: held!.id });

    const res = await request(ticketId, repositoryId, users.adminCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("correction_in_flight");
    expect(await correctionsOf(repositoryId)).toHaveLength(1);
  });

  // Un fix parcheggiato per budget non è finito: il resume poller lo
  // riaccoderà, e una correzione accanto sarebbe un secondo writer sul branch.
  it("FIX `held` per budget: 409 job_in_flight, nessuna riga", async () => {
    const { ticketId, repositoryId } = await seedPr();
    await testDb.db.insert(aiJobs).values({ ticketId, status: "held", heldReason: "budget" });

    const res = await request(ticketId, repositoryId, users.adminCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("job_in_flight");
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  // La corsa col webhook di chiusura: la rotta legge la PR aperta, poi la PR si
  // chiude mentre l'accodamento aspetta il lock del ticket. `enqueueCorrection`
  // rilegge lo stato SOTTO il lock: 409 pr_not_open e niente `queued` orfana.
  it("PR chiusa fra la lettura della rotta e l'accodamento: 409 pr_not_open, nessuna riga", async () => {
    const { ticketId, repositoryId } = await seedPr();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    // Tiene il lock del ticket (lo stesso di enqueueCorrection/startRun) e, a
    // richiesta della rotta già in attesa, chiude la PR nella stessa
    // transazione: al commit il lock si libera e l'accodamento rilegge.
    const holder = testDb.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);
      locked();
      await gate;
      await tx
        .update(ticketRepositories)
        .set({ prState: "merged" })
        .where(eq(ticketRepositories.ticketId, ticketId));
    });
    await lockedP;

    const pending = request(ticketId, repositoryId, users.memberCookie);
    // La rotta ha letto la riga (aperta) ed è ferma sul lock dell'accodamento.
    for (let i = 0; i < 200; i++) {
      const rows = await testDb.db.execute(
        sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
      );
      if ((rows as unknown as Array<{ n: number }>)[0]!.n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await holder;
    const res = await pending;

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("pr_not_open");
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  it("PR non di Stubwise: 409 not_stubwise_pr", async () => {
    const { ticketId, repositoryId } = await seedPr({ branch: "feature/login" });

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("not_stubwise_pr");
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  it("branch `stubwise/*` che non è di un ticket (graphify-setup): 409 not_stubwise_pr", async () => {
    // Stessa regola di derivePrCycle (A8): lì niente ciclo, qui niente correzione.
    const { ticketId, repositoryId } = await seedPr({ branch: "stubwise/graphify-setup" });

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("not_stubwise_pr");
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  it("branch di un ALTRO ticket: 409 not_stubwise_pr", async () => {
    // seedTicket crea il ticket numero 1: `ticket-2` è un branch Stubwise, ma non suo.
    const { ticketId, repositoryId } = await seedPr({ branch: "stubwise/ticket-2" });

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("not_stubwise_pr");
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  it("PR mergiata: 409 pr_not_open", async () => {
    const { ticketId, repositoryId } = await seedPr({ prState: "merged" });

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("pr_not_open");
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  it("riga senza URL della PR (nessuna PR aperta davvero): 409 pr_not_open", async () => {
    const { ticketId, repositoryId } = await seedPr({ prUrl: null, prNumber: 42 });

    const res = await request(ticketId, repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("pr_not_open");
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  it("nessuna PR del ticket su quel repository: 404", async () => {
    const { ticketId } = await seedPr();
    const other = await seedTicket(testDb.db);

    const res = await request(ticketId, other.repositoryId, users.memberCookie);

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("not_found");
    expect(await correctionsOf(other.repositoryId)).toHaveLength(0);
  });

  it("nota oltre 4000 caratteri: 400", async () => {
    const { ticketId, repositoryId } = await seedPr();

    const res = await request(ticketId, repositoryId, users.memberCookie, { note: "x".repeat(4001) });

    expect(res.statusCode).toBe(400);
    expect(await correctionsOf(repositoryId)).toHaveLength(0);
  });

  it("senza sessione: 401", async () => {
    const { ticketId, repositoryId } = await seedPr();

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/repositories/${repositoryId}/corrections`,
    });

    expect(res.statusCode).toBe(401);
  });
});
