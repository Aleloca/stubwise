import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentQuestions,
  aiJobs,
  comments,
  notificationDeliveries,
  notifications,
  projectDecisions,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import type { NotificationEvent } from "@stubwise/notifications";
import { createTicket } from "../db/tickets.js";
import type { Actor } from "./jobs.js";
import { answerQuestion } from "./questions.js";

/**
 * Test di `answerQuestion` su un Postgres reale (testcontainers): tutto ciò che
 * conta qui — UPDATE guardati, corse fra due risposte, propagazione su più
 * righe — è comportamento del DB, non della funzione.
 */

let testDb: TestDb;
let db: Db;
let projectId: string;
let maintainer: Actor & { email: string };
let operator: Actor & { email: string };

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
  maintainer = await seedUser("admin");
  operator = await seedUser("member");
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Inserisce un utente col ruolo dato (id reale: serve alle FK). */
async function seedUser(role: "admin" | "member"): Promise<Actor & { email: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role })
    .returning({ id: users.id, role: users.role, email: users.email });
  return { id: row!.id, role: row!.role, email: row!.email };
}

/** Crea un ticket nel progetto di test. */
async function seedTicket(): Promise<string> {
  const ticket = await createTicket(db, {
    projectId,
    title: "Ticket con domanda",
    type: "bug",
    priority: "medium",
    source: "manual",
  });
  return ticket.id;
}

/** Opzioni di default della domanda: due alternative, la prima consigliata. */
const OPTIONS = [
  { label: "Colonne vecchie", consequence: "Nessuna migrazione" },
  { label: "Colonne nuove" },
];

/**
 * Un job parcheggiato su una domanda aperta: la situazione da cui `answerQuestion`
 * parte sempre. Restituisce ticket, job e domanda.
 */
async function seedParkedJob(
  options: {
    requestedByUserId?: string | null;
    jobStatus?: "awaiting_input" | "fixing" | "queued";
    allowFreeText?: boolean;
    round?: number;
    withQuestion?: boolean;
  } = {},
): Promise<{ ticketId: string; jobId: string; questionId: string | null }> {
  const ticketId = await seedTicket();
  const [job] = await db
    .insert(aiJobs)
    .values({
      ticketId,
      status: options.jobStatus ?? "awaiting_input",
      requestedByUserId: options.requestedByUserId === undefined ? null : options.requestedByUserId,
      cliSessionId: "sess-1",
    })
    .returning({ id: aiJobs.id });
  if (options.withQuestion === false) {
    return { ticketId, jobId: job!.id, questionId: null };
  }
  const [question] = await db
    .insert(agentQuestions)
    .values({
      jobId: job!.id,
      ticketId,
      round: options.round ?? 1,
      question: "Quali colonne deve avere il CSV?",
      options: OPTIONS,
      recommendedIndex: 0,
      allowFreeText: options.allowFreeText ?? true,
    })
    .returning({ id: agentQuestions.id });
  return { ticketId, jobId: job!.id, questionId: question!.id };
}

/** Evento `job.awaiting_input` realistico. */
function awaitingInputEvent(questionId: string): NotificationEvent {
  return {
    kind: "job.awaiting_input",
    ticketNumber: 7,
    ticketTitle: "Export CSV dello storico",
    projectName: "negozio-web",
    ticketUrl: "https://stubwise.test/tickets/7",
    questionId,
    round: 1,
    question: "Quali colonne deve avere il CSV?",
    options: OPTIONS,
    recommendedIndex: 0,
    allowFreeText: true,
  };
}

/** Inserisce una copia della notifica della domanda per l'utente dato. */
async function seedNotification(input: {
  userId: string;
  ticketId: string;
  jobId: string;
  questionId: string;
  kind?: NotificationEvent["kind"];
}): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      kind: input.kind ?? "job.awaiting_input",
      event: awaitingInputEvent(input.questionId) as unknown as Record<string, unknown>,
      ticketId: input.ticketId,
      jobId: input.jobId,
      projectId,
      status: "open",
    })
    .returning({ id: notifications.id });
  return row!.id;
}

/** Attesa breve, per i test che devono far interleavare due transazioni. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Legge la domanda per id. */
async function readQuestion(id: string) {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id));
  return row;
}

/** Legge il job per id. */
async function readJob(id: string) {
  const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
  return row;
}

/** Commenti del ticket, dal più vecchio. */
async function readComments(ticketId: string) {
  return db.select().from(comments).where(eq(comments.ticketId, ticketId));
}

/** Consegne `slack_update` accodate per la notifica data. */
async function readSlackUpdates(notificationId: string) {
  return db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.notificationId, notificationId),
        eq(notificationDeliveries.channel, "slack_update"),
      ),
    );
}

describe("answerQuestion — risoluzione dell'ancora", () => {
  it("job inesistente → not_found", async () => {
    const result = await answerQuestion(db, {
      jobId: randomUUID(),
      actor: maintainer,
      answer: { optionIndex: 0 },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("notifica inesistente → not_found", async () => {
    const result = await answerQuestion(db, {
      notificationId: randomUUID(),
      actor: maintainer,
      answer: { optionIndex: 0 },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("notifica senza job dietro → not_found", async () => {
    const [row] = await db
      .insert(notifications)
      .values({
        userId: maintainer.id,
        kind: "docs.limit_paused",
        event: {},
        projectId,
        status: "open",
      })
      .returning({ id: notifications.id });
    const result = await answerQuestion(db, {
      notificationId: row!.id,
      actor: maintainer,
      answer: { optionIndex: 0 },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("dalla notifica risolve il job e risponde", async () => {
    const parked = await seedParkedJob();
    const notificationId = await seedNotification({
      userId: maintainer.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    const result = await answerQuestion(db, {
      notificationId,
      actor: maintainer,
      answer: { optionIndex: 1 },
    });
    expect(result.ok).toBe(true);
    expect(await readQuestion(parked.questionId!)).toMatchObject({ answer: { optionIndex: 1 } });
  });
});

describe("answerQuestion — permessi", () => {
  it("il richiedente (member) può rispondere", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const result = await answerQuestion(db, {
      jobId: parked.jobId,
      actor: operator,
      answer: { optionIndex: 0 },
    });
    expect(result.ok).toBe(true);
  });

  it("un ALTRO member → forbidden (è identità, non ruolo)", async () => {
    const other = await seedUser("member");
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const result = await answerQuestion(db, {
      jobId: parked.jobId,
      actor: other,
      answer: { optionIndex: 0 },
    });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    // Niente si è mosso: la domanda resta aperta e il job parcheggiato.
    expect(await readQuestion(parked.questionId!)).toMatchObject({ answeredAt: null });
    expect((await readJob(parked.jobId))?.status).toBe("awaiting_input");
  });

  it("un maintainer può rispondere alla domanda di un collega", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const result = await answerQuestion(db, {
      jobId: parked.jobId,
      actor: maintainer,
      answer: { optionIndex: 0 },
    });
    expect(result.ok).toBe(true);
  });

  it("run dell'automazione (nessun richiedente): solo il maintainer", async () => {
    const auto = await seedParkedJob({ requestedByUserId: null });
    expect(
      await answerQuestion(db, { jobId: auto.jobId, actor: operator, answer: { optionIndex: 0 } }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      (
        await answerQuestion(db, {
          jobId: auto.jobId,
          actor: maintainer,
          answer: { optionIndex: 0 },
        })
      ).ok,
    ).toBe(true);
  });
});

describe("answerQuestion — stato della domanda", () => {
  it("job senza nessuna domanda → question_not_pending", async () => {
    const parked = await seedParkedJob({ withQuestion: false });
    expect(
      await answerQuestion(db, {
        jobId: parked.jobId,
        actor: maintainer,
        answer: { optionIndex: 0 },
      }),
    ).toEqual({ ok: false, error: "question_not_pending" });
  });

  it("job ripartito (non più awaiting_input) → question_not_pending", async () => {
    const parked = await seedParkedJob({ jobStatus: "fixing" });
    expect(
      await answerQuestion(db, {
        jobId: parked.jobId,
        actor: maintainer,
        answer: { optionIndex: 0 },
      }),
    ).toEqual({ ok: false, error: "question_not_pending" });
  });

  it("domanda GIÀ risposta → already_handled con chi ha risposto", async () => {
    const parked = await seedParkedJob();
    const first = await answerQuestion(db, {
      jobId: parked.jobId,
      actor: maintainer,
      answer: { optionIndex: 0 },
    });
    expect(first.ok).toBe(true);
    const second = await answerQuestion(db, {
      jobId: parked.jobId,
      actor: maintainer,
      answer: { optionIndex: 1 },
    });
    expect(second).toEqual({
      ok: false,
      error: "already_handled",
      answeredBy: { id: maintainer.id, email: maintainer.email },
    });
  });

  it("risposta arrivata DOPO la lettura e PRIMA della scrittura → already_handled", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });

    // Scrittore concorrente: risponde alla domanda e riprende il job, ma tiene
    // la transazione APERTA. `answerQuestion` legge quindi una domanda ancora
    // aperta (l'UPDATE non è committato) e arriva alla sua scrittura convinta di
    // poter rispondere: è l'unico modo per mettere alla prova l'UPDATE guardato
    // su `answered_at IS NULL`, che il test con Promise.all non raggiunge (là la
    // seconda chiamata trova la domanda già chiusa in LETTURA).
    let release!: () => void;
    const holdOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx
        .update(agentQuestions)
        .set({
          answer: { optionIndex: 0 },
          answeredAt: new Date(),
          answeredByUserId: maintainer.id,
        })
        .where(eq(agentQuestions.id, parked.questionId!));
      await tx
        .update(aiJobs)
        .set({ status: "queued", resumeMode: "plan_continue" })
        .where(eq(aiJobs.id, parked.jobId));
      await holdOpen;
    });

    try {
      await delay(150);
      const running = answerQuestion(db, {
        jobId: parked.jobId,
        actor: operator,
        answer: { optionIndex: 1 },
      });
      // Finché il writer non committa, la scrittura resta bloccata sul lock di riga.
      const pending = Symbol("pending");
      expect(await Promise.race([running, delay(250).then(() => pending)])).toBe(pending);

      release();
      await writer;

      await expect(running).resolves.toEqual({
        ok: false,
        error: "already_handled",
        answeredBy: { id: maintainer.id, email: maintainer.email },
      });
    } finally {
      release();
      await writer.catch(() => undefined);
    }

    // La risposta del writer è intatta e il perdente non ha lasciato traccia.
    expect(await readQuestion(parked.questionId!)).toMatchObject({
      answer: { optionIndex: 0 },
      answeredByUserId: maintainer.id,
    });
    expect(await readComments(parked.ticketId)).toHaveLength(0);
  });

  it("due risposte in parallelo: una vince, l'altra already_handled", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const [a, b] = await Promise.all([
      answerQuestion(db, { jobId: parked.jobId, actor: maintainer, answer: { optionIndex: 0 } }),
      answerQuestion(db, { jobId: parked.jobId, actor: operator, answer: { optionIndex: 1 } }),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0]!;
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("impossibile");
    expect(loser.error).toBe("already_handled");
    // Il perdente sa CHI ha risposto: è ciò che le superfici mostrano.
    expect(loser.answeredBy?.email).toBeTruthy();
    // Una sola risposta persistita, e un solo commento di sistema sul ticket.
    const question = await readQuestion(parked.questionId!);
    expect(question?.answeredAt).not.toBeNull();
    expect(question?.answeredByUserId).toBe(loser.answeredBy!.id);
    const systemComments = (await readComments(parked.ticketId)).filter(
      (c) => c.authorType === "system",
    );
    expect(systemComments).toHaveLength(1);
  });
});

describe("answerQuestion — validazione della risposta", () => {
  it("indice fuori dalle opzioni persistite → invalid_answer", async () => {
    const parked = await seedParkedJob();
    expect(
      await answerQuestion(db, {
        jobId: parked.jobId,
        actor: maintainer,
        answer: { optionIndex: 2 },
      }),
    ).toEqual({ ok: false, error: "invalid_answer" });
    expect(await readQuestion(parked.questionId!)).toMatchObject({ answeredAt: null });
  });

  it("indice negativo o non intero → invalid_answer", async () => {
    const parked = await seedParkedJob();
    for (const optionIndex of [-1, 1.5, Number.NaN]) {
      expect(
        await answerQuestion(db, {
          jobId: parked.jobId,
          actor: maintainer,
          answer: { optionIndex },
        }),
      ).toEqual({ ok: false, error: "invalid_answer" });
    }
  });

  it("né opzione né testo, o entrambi → invalid_answer", async () => {
    const parked = await seedParkedJob();
    expect(
      await answerQuestion(db, { jobId: parked.jobId, actor: maintainer, answer: {} }),
    ).toEqual({ ok: false, error: "invalid_answer" });
    expect(
      await answerQuestion(db, {
        jobId: parked.jobId,
        actor: maintainer,
        answer: { optionIndex: 0, text: "anche" },
      }),
    ).toEqual({ ok: false, error: "invalid_answer" });
  });

  it("testo libero su una domanda che non lo ammette → invalid_answer", async () => {
    const parked = await seedParkedJob({ allowFreeText: false });
    expect(
      await answerQuestion(db, {
        jobId: parked.jobId,
        actor: maintainer,
        answer: { text: "Nessuna delle due" },
      }),
    ).toEqual({ ok: false, error: "invalid_answer" });
  });

  it("testo vuoto o di soli spazi → invalid_answer", async () => {
    const parked = await seedParkedJob();
    for (const text of ["", "   \n\t "]) {
      expect(
        await answerQuestion(db, { jobId: parked.jobId, actor: maintainer, answer: { text } }),
      ).toEqual({ ok: false, error: "invalid_answer" });
    }
  });

  it("testo oltre i 4000 caratteri → invalid_answer", async () => {
    const parked = await seedParkedJob();
    expect(
      await answerQuestion(db, {
        jobId: parked.jobId,
        actor: maintainer,
        answer: { text: "x".repeat(4001) },
      }),
    ).toEqual({ ok: false, error: "invalid_answer" });
  });

  it("il testo viene trimmato prima di essere persistito", async () => {
    const parked = await seedParkedJob();
    const result = await answerQuestion(db, {
      jobId: parked.jobId,
      actor: maintainer,
      answer: { text: "  TTL di un'ora  " },
    });
    expect(result.ok).toBe(true);
    expect(await readQuestion(parked.questionId!)).toMatchObject({
      answer: { text: "TTL di un'ora" },
    });
  });
});

describe("answerQuestion — effetti", () => {
  it("scrive la risposta, rimette il job in coda e commenta il ticket", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const result = await answerQuestion(db, {
      jobId: parked.jobId,
      actor: operator,
      answer: { optionIndex: 0 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("impossibile");
    expect(result.jobId).toBe(parked.jobId);
    expect(result.questionId).toBe(parked.questionId);

    const question = await readQuestion(parked.questionId!);
    expect(question?.answer).toEqual({ optionIndex: 0 });
    expect(question?.answeredAt).not.toBeNull();
    expect(question?.answeredByUserId).toBe(operator.id);

    // Il contratto atteso dal worker: queued + plan_continue (la sessione CLI
    // resta, è quella da riprendere).
    const job = await readJob(parked.jobId);
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("plan_continue");
    expect(job?.cliSessionId).toBe("sess-1");

    // Il commento è di SISTEMA, non del team: la risposta raggiunge il modello
    // per il solo canale fidato (vedi il docblock del servizio).
    const ticketComments = await readComments(parked.ticketId);
    expect(ticketComments).toHaveLength(1);
    expect(ticketComments[0]!.authorType).toBe("system");
    expect(ticketComments[0]!.authorId).toBeNull();
    expect(ticketComments[0]!.body).toContain(operator.email);
    expect(ticketComments[0]!.body).toContain("Colonne vecchie");
    expect(
      ticketComments.filter((c) => c.authorType === "user"),
      "nessun commento 'user': la stessa risposta arriverebbe al modello due volte con etichette di fiducia opposte",
    ).toHaveLength(0);
  });

  it("il testo libero finisce nel commento", async () => {
    const parked = await seedParkedJob();
    await answerQuestion(db, {
      jobId: parked.jobId,
      actor: maintainer,
      answer: { text: "Colonne nuove, ma senza header" },
    });
    const ticketComments = await readComments(parked.ticketId);
    expect(ticketComments[0]!.body).toContain("Colonne nuove, ma senza header");
  });

  it("chiude TUTTE le copie della notifica e ne accoda il rispecchiamento Slack", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const mine = await seedNotification({
      userId: operator.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    const theirs = await seedNotification({
      userId: maintainer.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    // Una notifica di ALTRO kind sullo stesso job non va toccata.
    const other = await seedNotification({
      userId: maintainer.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
      kind: "job.failed",
    });

    const result = await answerQuestion(db, {
      jobId: parked.jobId,
      actor: operator,
      answer: { optionIndex: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("impossibile");
    expect(new Set(result.changedNotificationIds)).toEqual(new Set([mine, theirs]));

    const rows = await db.select().from(notifications).where(eq(notifications.jobId, parked.jobId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(mine)?.status).toBe("handled");
    expect(byId.get(theirs)?.status).toBe("handled");
    expect(byId.get(other)?.status).toBe("open");

    // La nota del DM porta la risposta, non solo il nome di chi ha risposto.
    const updates = await readSlackUpdates(theirs);
    expect(updates).toHaveLength(1);
    const note = (updates[0]!.event as { note?: string }).note ?? "";
    expect(note).toContain("💬");
    expect(note).toContain(operator.email);
    expect(note).toContain("Colonne nuove");
    expect(await readSlackUpdates(other)).toHaveLength(0);
  });
});

describe("answerQuestion — residuo e round", () => {
  /**
   * Riproduce lo STATO che resta se il processo muore (o `propagateHandled`
   * fallisce) fra il commit della transazione e la propagazione: risposta
   * registrata, job ripartito, copie della notifica ancora `open`. È l'unico
   * modo di scriverlo — la finestra è fra due statement, non fra due chiamate —
   * e su questo kind quel residuo non avrebbe via d'uscita: `handled` lo nega il
   * catalogo, `answer` lo nega lo stato del job.
   */
  async function seedOrphanState() {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const mine = await seedNotification({
      userId: operator.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    const theirs = await seedNotification({
      userId: maintainer.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    await db
      .update(agentQuestions)
      .set({
        answer: { optionIndex: 0 },
        answeredAt: new Date(),
        answeredByUserId: maintainer.id,
      })
      .where(eq(agentQuestions.id, parked.questionId!));
    await db
      .update(aiJobs)
      .set({ status: "queued", resumeMode: "plan_continue" })
      .where(eq(aiJobs.id, parked.jobId));
    return { ...parked, mine, theirs };
  }

  it("chiude le copie orfane al primo tentativo che le incontra", async () => {
    const { mine, theirs, jobId } = await seedOrphanState();

    const result = await answerQuestion(db, {
      notificationId: mine,
      actor: operator,
      answer: { optionIndex: 1 },
    });
    expect(result).toEqual({
      ok: false,
      error: "already_handled",
      answeredBy: { id: maintainer.id, email: maintainer.email },
    });

    // Tutte le copie chiuse, attribuite a CHI HA RISPOSTO (non a chi è passato
    // di qui): la riga significa "questa domanda l'ha decisa il maintainer".
    const rows = await db.select().from(notifications).where(eq(notifications.jobId, jobId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("handled");
      expect(row.handledByUserId).toBe(maintainer.id);
    }
    // E il DM porta la risposta vera, come se la propagazione fosse riuscita
    // al primo colpo.
    const note = ((await readSlackUpdates(theirs))[0]!.event as { note?: string }).note ?? "";
    expect(note).toContain(maintainer.email);
    expect(note).toContain("Colonne vecchie");
  });

  it("non riscrive nulla quando le copie sono già chiuse (percorso normale)", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const theirs = await seedNotification({
      userId: maintainer.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    expect(
      (await answerQuestion(db, { notificationId: theirs, actor: operator, answer: { text: "A" } }))
        .ok,
    ).toBe(true);
    // Secondo tentativo sulla stessa card: 409 e basta. La riparazione è
    // guardata sullo stato della riga, quindi non accoda un secondo DM.
    expect(
      (
        await answerQuestion(db, {
          notificationId: theirs,
          actor: operator,
          answer: { optionIndex: 0 },
        })
      ).ok,
    ).toBe(false);
    expect(await readSlackUpdates(theirs)).toHaveLength(1);
  });

  it("una card di un round precedente NON risponde alla domanda nuova", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const cardRound1 = await seedNotification({
      userId: operator.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    expect(
      (
        await answerQuestion(db, {
          jobId: parked.jobId,
          actor: operator,
          answer: { optionIndex: 0 },
        })
      ).ok,
    ).toBe(true);

    // Il run riprende e fa una SECONDA domanda, con opzioni diverse.
    await db.update(aiJobs).set({ status: "awaiting_input" }).where(eq(aiJobs.id, parked.jobId));
    const [round2] = await db
      .insert(agentQuestions)
      .values({
        jobId: parked.jobId,
        ticketId: parked.ticketId,
        round: 2,
        question: "E il TTL della cache?",
        options: [{ label: "Un'ora" }, { label: "Un giorno" }],
        allowFreeText: true,
      })
      .returning({ id: agentQuestions.id });

    // Click su "opzione 2" della card VECCHIA: senza la guardia sarebbe stato
    // validato contro le opzioni del round 2 — una risposta valida a un'altra
    // domanda.
    const result = await answerQuestion(db, {
      notificationId: cardRound1,
      actor: operator,
      answer: { optionIndex: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("impossibile");
    expect(result.error).toBe("already_handled");

    // La domanda nuova è rimasta APERTA e il job in attesa: nessuno ha risposto
    // per sbaglio al suo posto.
    const [q2] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, round2!.id));
    expect(q2?.answeredAt).toBeNull();
    expect((await readJob(parked.jobId))?.status).toBe("awaiting_input");
  });

  it("la card del round 1 non viene chiusa mentre il round 2 aspetta", async () => {
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const cardRound1 = await seedNotification({
      userId: operator.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    await db
      .update(agentQuestions)
      .set({
        answer: { optionIndex: 0 },
        answeredAt: new Date(),
        answeredByUserId: maintainer.id,
      })
      .where(eq(agentQuestions.id, parked.questionId!));
    const [round2] = await db
      .insert(agentQuestions)
      .values({
        jobId: parked.jobId,
        ticketId: parked.ticketId,
        round: 2,
        question: "E il TTL della cache?",
        options: [{ label: "Un'ora" }, { label: "Un giorno" }],
        allowFreeText: true,
      })
      .returning({ id: agentQuestions.id });
    const cardRound2 = await seedNotification({
      userId: operator.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: round2!.id,
    });

    // Premere la card vecchia non deve sanare nulla: la riparazione chiude
    // TUTTE le copie del job, e fra queste c'è la card del round 2, che sta
    // aspettando una risposta.
    await answerQuestion(db, {
      notificationId: cardRound1,
      actor: operator,
      answer: { optionIndex: 1 },
    });
    const rows = await db.select().from(notifications).where(eq(notifications.jobId, parked.jobId));
    expect(rows.map((r) => r.status)).toEqual(["open", "open"]);
    expect(cardRound1).not.toBe(cardRound2);

    // Rispondendo al round 2 se ne vanno entrambe: il residuo del round 1 si
    // sana da solo, senza bisogno della riparazione.
    expect(
      (
        await answerQuestion(db, {
          jobId: parked.jobId,
          actor: operator,
          answer: { optionIndex: 0 },
        })
      ).ok,
    ).toBe(true);
    const after = await db
      .select()
      .from(notifications)
      .where(eq(notifications.jobId, parked.jobId));
    expect(after.every((r) => r.status === "handled")).toBe(true);
  });
});

describe("answerQuestion — nota del DM", () => {
  it("il taglio della risposta lunga non spezza un'emoji a metà", async () => {
    const parked = await seedParkedJob();
    const notificationId = await seedNotification({
      userId: maintainer.id,
      ticketId: parked.ticketId,
      jobId: parked.jobId,
      questionId: parked.questionId!,
    });
    // 198 caratteri, poi l'emoji: in UTF-16 la sua coppia di surrogati sta a
    // cavallo del taglio a 199 *code unit*, quindi uno `slice` ingenuo
    // lascerebbe nella nota un surrogato spaiato.
    const text = `${"x".repeat(198)}😀${"y".repeat(50)}`;
    expect(
      (await answerQuestion(db, { notificationId, actor: maintainer, answer: { text } })).ok,
    ).toBe(true);

    const note =
      ((await readSlackUpdates(notificationId))[0]!.event as { note?: string }).note ?? "";
    expect(note).toContain("😀");
    // Nessun surrogato alto senza il suo basso (né viceversa).
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(note),
    ).toBe(false);
    // Troncata: la coda non c'è, e la nota finisce col carattere di ellissi.
    expect(note).not.toContain("yyyyy");
    expect(note).toContain("…");
  });
});

describe("answerQuestion — registro decisioni", () => {
  /** Decisioni del progetto di test, dalla più recente. */
  async function readDecisions() {
    return db
      .select()
      .from(projectDecisions)
      .where(eq(projectDecisions.projectId, projectId))
      .orderBy(desc(projectDecisions.createdAt));
  }

  it("una risposta a scelta multipla lascia una decisione con attore e conseguenze", async () => {
    // Risponde l'OPERATORE che ha chiesto il run: l'attore della decisione è
    // chi ha deciso, non chi ha i permessi più larghi.
    const parked = await seedParkedJob({ requestedByUserId: operator.id });
    const before = (await readDecisions()).length;

    const result = await answerQuestion(db, {
      jobId: parked.jobId,
      questionId: parked.questionId!,
      actor: operator,
      answer: { optionIndex: 0 },
    });
    expect(result.ok).toBe(true);

    const rows = await readDecisions();
    expect(rows).toHaveLength(before + 1);
    const decision = rows[0]!;
    expect(decision.source).toBe("ask_user");
    expect(decision.sourceKey).toBe(`question:${parked.questionId}`);
    expect(decision.sourceRef).toMatchObject({
      questionId: parked.questionId,
      jobId: parked.jobId,
    });
    expect(decision.ticketId).toBe(parked.ticketId);
    // Titolo = la domanda dell'agente, dentro il template i18n.
    expect(decision.title).toContain("Quali colonne deve avere il CSV?");
    // Decisione = l'ETICHETTA scelta, non la riga "etichetta — conseguenza".
    expect(decision.decision).toBe("Colonne vecchie");
    expect(decision.consequences).toBe("Nessuna migrazione");
    expect(decision.decidedByUserId).toBe(operator.id);
  });

  it("una risposta in testo libero è la decisione, e non ha conseguenze dichiarate", async () => {
    const parked = await seedParkedJob();

    expect(
      (
        await answerQuestion(db, {
          jobId: parked.jobId,
          questionId: parked.questionId!,
          actor: maintainer,
          answer: { text: "Le colonne del vecchio export, più `stato`." },
        })
      ).ok,
    ).toBe(true);

    const decision = (await readDecisions())[0]!;
    expect(decision.decision).toBe("Le colonne del vecchio export, più `stato`.");
    expect(decision.consequences).toBeNull();
  });

  it("una risposta annullata (job uscito da awaiting_input) non lascia decisioni", async () => {
    const parked = await seedParkedJob();
    const before = (await readDecisions()).length;
    // Il job cambia stato dopo la lettura: l'UPDATE guardato dentro la
    // transazione trova 0 righe e fa rollback di tutto, decisione compresa.
    await db.update(aiJobs).set({ status: "fixing" }).where(eq(aiJobs.id, parked.jobId));

    const result = await answerQuestion(db, {
      jobId: parked.jobId,
      questionId: parked.questionId!,
      actor: maintainer,
      answer: { optionIndex: 0 },
    });
    expect(result.ok).toBe(false);
    expect(await readDecisions()).toHaveLength(before);
  });
});
