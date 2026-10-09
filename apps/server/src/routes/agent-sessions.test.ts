import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { seedEmailMessage, startTestDb, type TestDb, seedTicket } from "@stubwise/db/testing";
import {
  agentQuestions,
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  aiJobs,
  backlogItems,
  backlogJobs,
  backlogQuestions,
  emailMessages,
  googleAccounts,
  googleWorkspaces,
  instanceSettings,
  prReviews,
  users,
} from "@stubwise/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { listAgentSessions, loadAgentSession } from "../services/agent-sessions.js";
import { seedUsers } from "../test/fixtures.js";

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let u: Awaited<ReturnType<typeof seedUsers>>;
let projectId: string;
let ticketId: string;
let jobId: string;
let otherJobId: string;
let mailSessionOfMember: string;
let jobSession: string;
let otherSession: string;
let mailSessionOfStranger: string;
let briefSession: string;
let reviewSession: string;
let orphanReviewSession: string;
let mailSessionWithMessage: string;
let mailSessionWithSubject: string;
let docUpdateSession: string;
let dailyReportSession: string;
let backlogJobSession: string;
let backlogItemSession: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(32) });
  u = await seedUsers(app);
  // seedTicket restituisce { projectId, repositoryId, ticketId } (numero 1).
  const seeded = await seedTicket(t.db);
  ({ projectId, ticketId } = seeded);
  const { ticketId: otherTicketId } = await seedTicket(t.db, {
    number: 2,
    projectId,
    repositoryId: seeded.repositoryId,
  });
  // pr_opened: finché c'è un segmento vivo lo stato è working; spento l'heartbeat
  // diventa ended con esito completed (Step 1).
  const [job] = await t.db.insert(aiJobs).values({ ticketId, status: "pr_opened" }).returning();
  jobId = job!.id;
  const [s1] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `ai_job:${jobId}`,
      kind: "ai_job",
      title: "#1 fix",
      projectId,
      ticketId,
      aiJobId: jobId,
      activeSegmentId: "seg",
      activeSegmentLabel: "execute",
      activeSegmentInteractive: true,
      liveSegmentIds: ["seg"],
      capabilities: ["interrupt_receipt_v1"],
      heartbeatAt: new Date(),
    })
    .returning();
  jobSession = s1!.id;
  const [input] = await t.db
    .insert(agentSessionInputs)
    .values({
      sessionId: jobSession,
      authorUserId: u.adminId,
      text: "non consegnato",
      status: "undelivered",
      reason: "session_not_live",
      // «Ferma e scrivi»: il dettaglio deve riportarlo anche senza evento `input`.
      interrupt: true,
    })
    .returning();
  await t.db.insert(agentSessionEvents).values([
    {
      sessionId: jobSession,
      segmentId: "seg",
      type: "input",
      data: {
        text: "fai X",
        interrupt: false,
        inputId: input!.id,
        authorUserId: u.adminId,
        authorName: "falso@scritto.dal.worker",
      },
    },
    {
      sessionId: jobSession,
      segmentId: "seg",
      type: "assistant_text",
      data: { text: "parola-unica-del-fix" },
    },
    {
      sessionId: jobSession,
      segmentId: "seg",
      type: "tool_use",
      data: { name: "Edit", input: { file_path: "a.ts" } },
    },
  ]);
  const [otherJob] = await t.db
    .insert(aiJobs)
    .values({ ticketId: otherTicketId, status: "failed" })
    .returning();
  otherJobId = otherJob!.id;
  const [s3] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `ai_job:${otherJobId}`,
      kind: "ai_job",
      title: "#2",
      projectId,
      ticketId: otherTicketId,
      aiJobId: otherJobId,
    })
    .returning();
  otherSession = s3!.id;
  const m1 = await seedEmailMessage(t.db, { userId: u.memberId });
  const [s2] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `email_message:${m1.messageId}`,
      kind: "email_message",
      title: "Oggetto privato",
      mailboxOwnerUserId: u.memberId,
      emailMessageId: m1.messageId,
    })
    .returning();
  mailSessionOfMember = s2!.id;
  await t.db.insert(agentSessionEvents).values({
    sessionId: mailSessionOfMember,
    segmentId: "s",
    type: "assistant_text",
    data: { text: "parola-solo-nella-posta" },
  });

  // Un terzo utente (member) con la SUA posta: né l'admin né l'altro member la vedono.
  const [stranger] = await t.db
    .insert(users)
    .values({ email: "terzo@example.com", passwordHash: "x", role: "member" })
    .returning();
  const m2 = await seedEmailMessage(t.db, { userId: stranger!.id });
  const [s4] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `email_message:${m2.messageId}`,
      kind: "email_message",
      title: "Posta del terzo",
      mailboxOwnerUserId: stranger!.id,
      emailMessageId: m2.messageId,
    })
    .returning();
  mailSessionOfStranger = s4!.id;

  // Un altro progetto (i filtri qui sopra contano le sessioni del primo): un
  // brief, una review con la riga proprietaria e una la cui review non c'è più.
  const second = await seedTicket(t.db);
  const [b] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: "project_brief:b1",
      kind: "project_brief",
      title: "Brief settimanale",
      projectId: second.projectId,
    })
    .returning();
  briefSession = b!.id;
  const [review] = await t.db
    .insert(prReviews)
    .values({
      repositoryId: second.repositoryId,
      prNumber: 7,
      prUrl: "https://x/pr/7",
      prTitle: "PR",
      headSha: "abc1234",
      status: "completed",
    })
    .returning();
  const [r1] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `pr_review:${review!.id}`,
      kind: "pr_review",
      title: "titolo salvato",
      projectId: second.projectId,
      prReviewId: review!.id,
    })
    .returning();
  reviewSession = r1!.id;
  const [r2] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: "pr_review:sparita",
      kind: "pr_review",
      title: "Repository di test #3",
      projectId: second.projectId,
    })
    .returning();
  orphanReviewSession = r2!.id;

  // Proprietari senza FK utile al titolo (aggiornamento Docs, report) e backlog.
  const [du] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: "doc_update:j1",
      kind: "doc_generation",
      title: "salvato",
      projectId: second.projectId,
    })
    .returning();
  docUpdateSession = du!.id;
  const [dr] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `daily_report:${second.projectId}:2026-10-08`,
      kind: "daily_report",
      title: "salvato",
      projectId: second.projectId,
    })
    .returning();
  dailyReportSession = dr!.id;
  const [bj] = await t.db
    .insert(backlogJobs)
    .values({
      projectId: second.projectId,
      kind: "intake",
      status: "done",
      payload: { mode: "manual", text: "x" } as never,
    })
    .returning();
  const [bjs] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `backlog_job:${bj!.id}`,
      kind: "backlog_job",
      title: "salvato",
      projectId: second.projectId,
      backlogJobId: bj!.id,
    })
    .returning();
  backlogJobSession = bjs!.id;
  const [item] = await t.db
    .insert(backlogItems)
    .values({ projectId: second.projectId, title: "Voce del backlog", source: "manual" })
    .returning();
  const [bis] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `backlog_item:${item!.id}`,
      kind: "backlog_item",
      title: "salvato",
      projectId: second.projectId,
      backlogItemId: item!.id,
    })
    .returning();
  backlogItemSession = bis!.id;

  // Posta con la riga del messaggio: il titolo è l'oggetto (o «senza oggetto»).
  const [workspace] = await t.db
    .insert(googleWorkspaces)
    .values({ name: "W", domains: ["example.com"], clientId: "c", clientSecretEncrypted: "x" })
    .returning();
  const [account] = await t.db
    .insert(googleAccounts)
    .values({
      userId: u.memberId,
      workspaceId: workspace!.id,
      email: "member@example.com",
      googleSub: "sub",
      refreshTokenEncrypted: "x",
    })
    .returning();
  const [message] = await t.db
    .insert(emailMessages)
    .values({
      accountId: account!.id,
      gmailMessageId: "g1",
      threadId: "t1",
      fromAddress: "a@b.c",
      subject: null,
      receivedAt: new Date(),
    })
    .returning();
  const [s5] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `email_message:${message!.id}`,
      kind: "email_message",
      title: "(senza oggetto)",
      mailboxOwnerUserId: u.memberId,
      emailMessageId: message!.id,
    })
    .returning();
  mailSessionWithMessage = s5!.id;
  // L'oggetto si legge dal messaggio collegato dalla FK, non dall'owner_key:
  // qui la chiave non nomina il messaggio, apposta.
  const withSubject = await seedEmailMessage(t.db, {
    userId: u.memberId,
    subject: "Oggetto dal messaggio",
  });
  const [s6] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: "email_message:chiave-che-non-nomina-il-messaggio",
      kind: "email_message",
      title: "titolo salvato",
      mailboxOwnerUserId: u.memberId,
      emailMessageId: withSubject.messageId,
    })
    .returning();
  mailSessionWithSubject = s6!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const idsOf = (body: { live: { id: string }[]; recent: { id: string }[] }) =>
  [...body.live, ...body.recent].map((s) => s.id);

describe("GET /api/agent-sessions", () => {
  it("la sessione di un job vivo è fra le live, con stato working, ultima azione e aiJobId", async () => {
    const res = await get("/api/agent-sessions", u.memberCookie);
    expect(res.statusCode).toBe(200);
    const row = res.json().live.find((s: { id: string }) => s.id === jobSession);
    expect(row.state).toBe("working");
    expect(row.lastActivity).toEqual({ kind: "edit", target: "a.ts" });
    expect(row.aiJobId).toBe(jobId);
    expect(row.outcome).toBeNull();
  });

  it("una sessione finita è fra le recenti, con l'esito derivato dal job", async () => {
    const row = (await get("/api/agent-sessions", u.memberCookie))
      .json()
      .recent.find((s: { id: string }) => s.id === otherSession);
    expect(row.state).toBe("ended");
    expect(row.outcome).toBe("failed");
  });

  it("la posta di un member NON compare a un admin, e compare al member", async () => {
    expect(idsOf((await get("/api/agent-sessions", u.adminCookie)).json())).not.toContain(
      mailSessionOfMember,
    );
    expect(idsOf((await get("/api/agent-sessions", u.memberCookie)).json())).toContain(
      mailSessionOfMember,
    );
  });

  it("la posta di un altro utente non compare né all'admin né a un altro member", async () => {
    const admin = idsOf((await get("/api/agent-sessions", u.adminCookie)).json());
    const member = idsOf((await get("/api/agent-sessions", u.memberCookie)).json());
    expect(admin).not.toContain(mailSessionOfStranger);
    expect(member).not.toContain(mailSessionOfStranger);
    // Il verso positivo accanto: le altre sessioni della stessa lista ci sono.
    expect(admin).toContain(jobSession);
    expect(member).toContain(jobSession);
  });

  it("filtri ticketId, aiJobId e projectId", async () => {
    const byTicket = idsOf(
      (await get(`/api/agent-sessions?ticketId=${ticketId}`, u.adminCookie)).json(),
    );
    expect(byTicket).toEqual([jobSession]);
    const byJob = idsOf(
      (await get(`/api/agent-sessions?aiJobId=${otherJobId}`, u.adminCookie)).json(),
    );
    expect(byJob).toEqual([otherSession]);
    const byProject = idsOf(
      (await get(`/api/agent-sessions?projectId=${projectId}`, u.adminCookie)).json(),
    );
    expect(byProject.sort()).toEqual([jobSession, otherSession].sort());
    const none = (await get(`/api/agent-sessions?projectId=${randomUUID()}`, u.adminCookie)).json();
    expect(idsOf(none)).toEqual([]);
    expect((await get("/api/agent-sessions?ticketId=nope", u.adminCookie)).statusCode).toBe(400);
  });

  it("una sessione con ultima attività oltre 14 giorni non compare; una vecchia ma attiva di recente sì", async () => {
    await t.db
      .update(agentSessions)
      .set({ startedAt: new Date(Date.now() - 30 * 86_400_000), lastEventAt: new Date() })
      .where(eq(agentSessions.id, otherSession));
    expect(idsOf((await get("/api/agent-sessions", u.adminCookie)).json())).toContain(otherSession);
    await t.db
      .update(agentSessions)
      .set({ lastEventAt: new Date(Date.now() - 20 * 86_400_000) })
      .where(eq(agentSessions.id, otherSession));
    expect(idsOf((await get("/api/agent-sessions", u.adminCookie)).json())).not.toContain(
      otherSession,
    );
    await t.db
      .update(agentSessions)
      .set({ startedAt: new Date(), lastEventAt: null })
      .where(eq(agentSessions.id, otherSession));
  });
});

describe("GET /api/agent-sessions/:id e /events", () => {
  it("admin: 404 sul dettaglio e sugli eventi della posta altrui; il proprietario legge il testo", async () => {
    expect(
      (await get(`/api/agent-sessions/${mailSessionOfMember}`, u.adminCookie)).statusCode,
    ).toBe(404);
    const evAdmin = await get(`/api/agent-sessions/${mailSessionOfMember}/events`, u.adminCookie);
    expect(evAdmin.statusCode).toBe(404);
    expect(evAdmin.body).not.toContain("parola-solo-nella-posta");
    const evOwner = await get(`/api/agent-sessions/${mailSessionOfMember}/events`, u.memberCookie);
    expect(evOwner.body).toContain("parola-solo-nella-posta");
  });

  it("member: 404 sul dettaglio e sugli eventi della posta di un altro utente", async () => {
    expect(
      (await get(`/api/agent-sessions/${mailSessionOfStranger}`, u.memberCookie)).statusCode,
    ).toBe(404);
    expect(
      (await get(`/api/agent-sessions/${mailSessionOfStranger}/events`, u.memberCookie)).statusCode,
    ).toBe(404);
    expect(
      (await get(`/api/agent-sessions/${mailSessionOfMember}`, u.memberCookie)).statusCode,
    ).toBe(200);
  });

  it("stessi dati, due ruoli: canWrite vero per l'admin e falso per il member", async () => {
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    const member = (await get(`/api/agent-sessions/${jobSession}`, u.memberCookie)).json();
    expect(admin.canWrite).toBe(true);
    expect(member.canWrite).toBe(false);
    expect(admin.canInterrupt).toBe(true);
    expect(member.canInterrupt).toBe(false);
  });

  it("stessi dati, due ruoli: canIntervene vero per l'admin e falso per il member", async () => {
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    const member = (await get(`/api/agent-sessions/${jobSession}`, u.memberCookie)).json();
    expect(admin.canIntervene).toBe(true);
    expect(member.canIntervene).toBe(false);
  });

  it("fra un segmento e l'altro: canWrite cade, canIntervene resta (solo per l'admin)", async () => {
    // Fine della ripresa del piano, prima dell'esecuzione: nessun segmento aperto.
    await t.db
      .update(agentSessions)
      .set({ liveSegmentIds: [] })
      .where(eq(agentSessions.id, jobSession));
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    const member = (await get(`/api/agent-sessions/${jobSession}`, u.memberCookie)).json();
    expect(admin.canWrite).toBe(false);
    expect(admin.canIntervene).toBe(true);
    expect(member.canWrite).toBe(false);
    expect(member.canIntervene).toBe(false);
    await t.db
      .update(agentSessions)
      .set({ liveSegmentIds: ["seg"] })
      .where(eq(agentSessions.id, jobSession));
  });

  it("review, Docs, brief, posta: nessuno interviene, nemmeno l'admin", async () => {
    for (const id of [reviewSession, docUpdateSession, briefSession, backlogJobSession]) {
      const admin = (await get(`/api/agent-sessions/${id}`, u.adminCookie)).json();
      expect(admin.canIntervene).toBe(false);
    }
    const owner = (await get(`/api/agent-sessions/${mailSessionOfMember}`, u.memberCookie)).json();
    expect(owner.canIntervene).toBe(false);
    // La voce di backlog (deep dive, chat) invece sì, per l'admin.
    const item = (await get(`/api/agent-sessions/${backlogItemSession}`, u.adminCookie)).json();
    expect(item.canIntervene).toBe(true);
  });

  it("senza la capability di interruzione: si scrive ma non si interrompe", async () => {
    await t.db
      .update(agentSessions)
      .set({ capabilities: [] })
      .where(eq(agentSessions.id, jobSession));
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    expect(admin.canWrite).toBe(true);
    expect(admin.canInterrupt).toBe(false);
    await t.db
      .update(agentSessions)
      .set({ capabilities: ["interrupt_receipt_v1"] })
      .where(eq(agentSessions.id, jobSession));
  });

  it("il dettaglio elenca gli interventi, anche quelli NON consegnati, col nome dell'autore", async () => {
    const detail = (await get(`/api/agent-sessions/${jobSession}`, u.memberCookie)).json();
    expect(detail.inputs).toEqual([
      expect.objectContaining({
        text: "non consegnato",
        status: "undelivered",
        reason: "session_not_live",
        authorUserId: u.adminId,
        authorName: "admin@example.com",
        interrupt: true,
      }),
    ]);
  });

  it("heartbeat vecchio: la sessione è ended, con esito, e nessuno può scrivere", async () => {
    await t.db
      .update(agentSessions)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(agentSessions.id, jobSession));
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    expect(admin.state).toBe("ended");
    expect(admin.outcome).toBe("completed");
    expect(admin.canWrite).toBe(false);
    await t.db
      .update(agentSessions)
      .set({ heartbeatAt: new Date() })
      .where(eq(agentSessions.id, jobSession));
  });

  it("segmenti chiusi (elenco vuoto) con heartbeat fresco: non è viva", async () => {
    await t.db
      .update(agentSessions)
      .set({ liveSegmentIds: [] })
      .where(eq(agentSessions.id, jobSession));
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    expect(admin.canWrite).toBe(false);
    await t.db
      .update(agentSessions)
      .set({ liveSegmentIds: ["seg"] })
      .where(eq(agentSessions.id, jobSession));
  });

  it("il segmento attivo è già chiuso mentre un altro gira: nessuno scrive", async () => {
    // active_segment_* punta ancora a "seg", ma l'unico aperto è un altro.
    await t.db
      .update(agentSessions)
      .set({ liveSegmentIds: ["altro"] })
      .where(eq(agentSessions.id, jobSession));
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    expect(admin.state).toBe("working");
    expect(admin.canWrite).toBe(false);
    expect(admin.canInterrupt).toBe(false);
    await t.db
      .update(agentSessions)
      .set({ liveSegmentIds: ["seg"] })
      .where(eq(agentSessions.id, jobSession));
  });

  it("eventi paginati in ordine, con cursore; l'autore di un input lo deriva il server", async () => {
    const page = (
      await get(`/api/agent-sessions/${jobSession}/events?limit=1`, u.memberCookie)
    ).json();
    expect(page.events).toHaveLength(1);
    expect(page.events[0].type).toBe("tool_use");
    expect(page.before).not.toBeNull();
    const older = (
      await get(
        `/api/agent-sessions/${jobSession}/events?limit=1&before=${page.before}`,
        u.memberCookie,
      )
    ).json();
    expect(older.events[0].type).toBe("assistant_text");
    const all = (await get(`/api/agent-sessions/${jobSession}/events`, u.memberCookie)).json();
    const input = all.events.find((e: { type: string }) => e.type === "input");
    // Il valore scritto nel jsonb è IGNORATO: conta quello derivato dagli utenti.
    expect(input.data.authorName).toBe("admin@example.com");
  });

  it("id non uuid → 400, senza login → 401", async () => {
    expect((await get("/api/agent-sessions/nope", u.adminCookie)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/agent-sessions" })).statusCode).toBe(401);
  });
});

describe("titolo mostrato: derivato dal proprietario, nella lingua dell'istanza", () => {
  const setLanguage = (lang: "it" | "en") =>
    t.db
      .insert(instanceSettings)
      .values({ id: 1, contentLanguage: lang })
      .onConflictDoUpdate({ target: instanceSettings.id, set: { contentLanguage: lang } });
  const titleOf = async (id: string, cookie = u.memberCookie) =>
    (await get(`/api/agent-sessions/${id}`, cookie)).json().title as string;

  it("in italiano", async () => {
    await setLanguage("it");
    expect(await titleOf(jobSession)).toBe("#1 Ticket di test");
    expect(await titleOf(briefSession)).toBe("Brief settimanale · Progetto di test");
    expect(await titleOf(reviewSession)).toBe("Review di Repository di test #7");
    expect(await titleOf(mailSessionWithMessage)).toBe("(senza oggetto)");
    expect(await titleOf(mailSessionWithSubject)).toBe("Oggetto dal messaggio");
  });

  it("in inglese", async () => {
    await setLanguage("en");
    expect(await titleOf(jobSession)).toBe("#1 Ticket di test");
    expect(await titleOf(briefSession)).toBe("Weekly brief · Progetto di test");
    expect(await titleOf(reviewSession)).toBe("Review of Repository di test #7");
    expect(await titleOf(mailSessionWithMessage)).toBe("(no subject)");
    expect(await titleOf(docUpdateSession)).toBe("Docs update · Progetto di test");
    expect(await titleOf(dailyReportSession)).toBe("Daily report 2026-10-08 · Progetto di test");
    expect(await titleOf(backlogJobSession)).toBe("Backlog intake");
    expect(await titleOf(backlogItemSession)).toBe("Voce del backlog");
    // Anche nell'elenco, non solo nel dettaglio.
    const row = (await get("/api/agent-sessions", u.memberCookie))
      .json()
      .recent.find((s: { id: string }) => s.id === briefSession);
    expect(row.title).toBe("Weekly brief · Progetto di test");
  });

  it("riga proprietaria sparita: il titolo salvato", async () => {
    expect(await titleOf(orphanReviewSession)).toBe("Repository di test #3");
  });
});

describe("elenco: le sessioni non finite ci sono tutte, il tetto vale solo per le recenti", () => {
  it("oltre 250 sessioni finite più nuove: held e awaiting_approval restano fra le live", async () => {
    const { ticketId: heldTicket } = await seedTicket(t.db, {
      number: 20,
      projectId,
    });
    const { ticketId: approvalTicket } = await seedTicket(t.db, { number: 22, projectId });
    const [heldJob] = await t.db
      .insert(aiJobs)
      .values({ ticketId: heldTicket, status: "held" })
      .returning();
    const [approvalJob] = await t.db
      .insert(aiJobs)
      .values({ ticketId: approvalTicket, status: "awaiting_plan_approval" })
      .returning();
    const old = new Date(Date.now() - 3 * 86_400_000);
    const [held] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: `ai_job:${heldJob!.id}`,
        kind: "ai_job",
        title: "held",
        projectId,
        ticketId: heldTicket,
        aiJobId: heldJob!.id,
        startedAt: old,
        lastEventAt: old,
      })
      .returning();
    const [approval] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: `ai_job:${approvalJob!.id}`,
        kind: "ai_job",
        title: "approval",
        projectId,
        ticketId: approvalTicket,
        aiJobId: approvalJob!.id,
        startedAt: old,
        lastEventAt: old,
      })
      .returning();
    // 260 sessioni finite, tutte più recenti, visibili a chiunque.
    await t.db.insert(agentSessions).values(
      Array.from({ length: 260 }, (_, i) => ({
        ownerKey: `project_brief:bulk-${i}`,
        kind: "project_brief" as const,
        title: `bulk ${i}`,
        lastEventAt: new Date(Date.now() - i * 1000),
      })),
    );
    const body = (await get("/api/agent-sessions", u.adminCookie)).json();
    const live = body.live.map((s: { id: string; state: string }) => [s.id, s.state]);
    expect(live).toContainEqual([held!.id, "held"]);
    expect(live).toContainEqual([approval!.id, "awaiting_approval"]);
    expect(body.recent).toHaveLength(50);
    // Le recenti sono le più nuove, in ordine.
    expect(body.recent[0].title).toBe("bulk 0");
    // I filtri valgono anche per le non finite.
    const filtered = idsOf(
      (await get(`/api/agent-sessions?ticketId=${heldTicket}`, u.adminCookie)).json(),
    );
    expect(filtered).toEqual([held!.id]);
  });
});

describe("elenco senza tetto: la posta altrui non entra fra le sessioni attive", () => {
  it("una sessione di posta di un terzo, attiva e più vecchia del tetto, non compare all'admin ma al proprietario sì", async () => {
    const [owner] = await t.db
      .insert(users)
      .values({ email: "proprietario-attiva@example.com", passwordHash: "x", role: "member" })
      .returning();
    const old = new Date(Date.now() - 4 * 86_400_000);
    // Ferma (held): il kind email_message non ha un job proprio, quindi lo
    // stato si prende da un job held collegato; la query delle possibilmente
    // attive guarda lo stato, non il kind.
    const { ticketId: heldTicket } = await seedTicket(t.db, { number: 40, projectId });
    const [heldJob] = await t.db
      .insert(aiJobs)
      .values({ ticketId: heldTicket, status: "held" })
      .returning();
    const heldMessage = await seedEmailMessage(t.db, { userId: owner!.id });
    const liveMessage = await seedEmailMessage(t.db, { userId: owner!.id });
    const [heldMail] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: "email_message:held-third",
        kind: "email_message",
        title: "Posta ferma del terzo",
        mailboxOwnerUserId: owner!.id,
        emailMessageId: heldMessage.messageId,
        aiJobId: heldJob!.id,
        startedAt: old,
        lastEventAt: old,
      })
      .returning();
    // Viva (segmento aperto, heartbeat fresco): la stessa query senza tetto.
    const [liveMail] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: "email_message:live-third",
        kind: "email_message",
        title: "Posta viva del terzo",
        mailboxOwnerUserId: owner!.id,
        emailMessageId: liveMessage.messageId,
        liveSegmentIds: ["seg"],
        activeSegmentId: "seg",
        heartbeatAt: new Date(),
        startedAt: old,
        lastEventAt: old,
      })
      .returning();
    // Più di 50 sessioni finite, più nuove e visibili a tutti: fuori dal tetto
    // delle recenti le due sessioni arrivano SOLO dalla query senza limite.
    await t.db.insert(agentSessions).values(
      Array.from({ length: 60 }, (_, i) => ({
        ownerKey: `project_brief:cap-third-${i}`,
        kind: "project_brief" as const,
        title: `cap ${i}`,
        lastEventAt: new Date(Date.now() - i * 1000),
      })),
    );
    const mine = [heldMail!.id, liveMail!.id];

    const asAdmin = (await get("/api/agent-sessions", u.adminCookie)).json();
    const adminIds = idsOf(asAdmin);
    for (const id of mine) expect(adminIds).not.toContain(id);
    const asMember = (await get("/api/agent-sessions", u.memberCookie)).json();
    for (const id of mine) expect(idsOf(asMember)).not.toContain(id);

    // Verso positivo: il proprietario le vede, fra le live, con lo stato giusto.
    const asOwner = await listAgentSessions(t.db, { id: owner!.id, role: "member" });
    const ownerLive = asOwner.live.map((s) => [s.id, s.state]);
    expect(ownerLive).toContainEqual([heldMail!.id, "held"]);
    expect(ownerLive).toContainEqual([liveMail!.id, "working"]);
  });
});

describe("domande nel dettaglio: opzioni complete e canAnswer calcolato dal server", () => {
  const OPTIONS = [
    { label: "Postgres", consequence: "Serve un volume" },
    { label: "SQLite" },
  ];
  let ownerId: string;
  let otherMemberId: string;
  let askedSession: string;
  let askedJobId: string;
  let askedTicketId: string;
  let askedQuestionId: string;
  let backlogSession: string;
  let backlogItemId: string;
  let backlogQuestionId: string;

  beforeAll(async () => {
    ownerId = u.memberId;
    const [other] = await t.db
      .insert(users)
      .values({ email: "altro-member@example.com", passwordHash: "x", role: "member" })
      .returning();
    otherMemberId = other!.id;
    const seeded = await seedTicket(t.db);
    askedTicketId = seeded.ticketId;
    const [job] = await t.db
      .insert(aiJobs)
      .values({ ticketId: askedTicketId, status: "awaiting_input", requestedByUserId: ownerId })
      .returning();
    askedJobId = job!.id;
    const [q] = await t.db
      .insert(agentQuestions)
      .values({
        jobId: askedJobId,
        ticketId: askedTicketId,
        round: 2,
        question: "Quale DB?",
        options: OPTIONS,
        recommendedIndex: 1,
        allowFreeText: true,
      })
      .returning();
    askedQuestionId = q!.id;
    const [s] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: `ai_job:${askedJobId}`,
        kind: "ai_job",
        title: "#9",
        projectId: seeded.projectId,
        ticketId: askedTicketId,
        aiJobId: askedJobId,
      })
      .returning();
    askedSession = s!.id;

    const [item] = await t.db
      .insert(backlogItems)
      .values({ projectId: seeded.projectId, title: "Voce con domanda", source: "manual" })
      .returning();
    backlogItemId = item!.id;
    const [bq] = await t.db
      .insert(backlogQuestions)
      .values({
        backlogItemId,
        question: "Quale ambito?",
        options: OPTIONS,
        allowFreeText: false,
      })
      .returning();
    backlogQuestionId = bq!.id;
    const [bs] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: `backlog_item:${backlogItemId}`,
        kind: "backlog_item",
        title: "salvato",
        projectId: seeded.projectId,
        backlogItemId,
      })
      .returning();
    backlogSession = bs!.id;
  });

  const as = (id: string, role: "admin" | "member") => ({ id, role });
  const questionOf = async (sessionId: string, viewer: { id: string; role: "admin" | "member" }) =>
    (await loadAgentSession(t.db, viewer, sessionId))!.detail.questions[0]!;

  it("domanda dell'agente: opzioni, round, consigliata, testo libero e ticket; canAnswer richiedente/maintainer sì, altro member no", async () => {
    const forOwner = await questionOf(askedSession, as(ownerId, "member"));
    expect(forOwner).toMatchObject({
      id: askedQuestionId,
      source: "agent",
      round: 2,
      options: OPTIONS,
      recommendedIndex: 1,
      allowFreeText: true,
      ticketId: askedTicketId,
      backlogItemId: null,
      answered: false,
      canAnswer: true,
    });
    expect((await questionOf(askedSession, as(u.adminId, "admin"))).canAnswer).toBe(true);
    expect((await questionOf(askedSession, as(otherMemberId, "member"))).canAnswer).toBe(false);
  });

  it("lo stesso vale sulla rotta HTTP", async () => {
    const admin = (await get(`/api/agent-sessions/${askedSession}`, u.adminCookie)).json();
    const member = (await get(`/api/agent-sessions/${askedSession}`, u.memberCookie)).json();
    expect(admin.questions[0].canAnswer).toBe(true);
    expect(member.questions[0].canAnswer).toBe(true);
    expect(member.questions[0].options).toEqual(OPTIONS);
  });

  it("job non più in awaiting_input: la domanda aperta non è rispondibile da nessuno", async () => {
    await t.db.update(aiJobs).set({ status: "fixing" }).where(eq(aiJobs.id, askedJobId));
    expect((await questionOf(askedSession, as(u.adminId, "admin"))).canAnswer).toBe(false);
    expect((await questionOf(askedSession, as(ownerId, "member"))).canAnswer).toBe(false);
    await t.db.update(aiJobs).set({ status: "awaiting_input" }).where(eq(aiJobs.id, askedJobId));
  });

  it("domanda già risposta: nessuno può rispondere", async () => {
    await t.db
      .update(agentQuestions)
      .set({ answer: { optionIndex: 0 }, answeredAt: new Date(), answeredByUserId: u.adminId })
      .where(eq(agentQuestions.id, askedQuestionId));
    const forAdmin = await questionOf(askedSession, as(u.adminId, "admin"));
    expect(forAdmin).toMatchObject({ answered: true, canAnswer: false });
    expect((await questionOf(askedSession, as(ownerId, "member"))).canAnswer).toBe(false);
  });

  it("domanda del backlog: opzioni e backlogItemId; rispondibile da ogni utente finché aperta", async () => {
    for (const viewer of [as(u.adminId, "admin"), as(ownerId, "member"), as(otherMemberId, "member")]) {
      expect(await questionOf(backlogSession, viewer)).toMatchObject({
        id: backlogQuestionId,
        source: "backlog",
        options: OPTIONS,
        allowFreeText: false,
        backlogItemId,
        ticketId: null,
        canAnswer: true,
      });
    }
  });

  it("domanda del backlog chiusa con «non ora»: non rispondibile", async () => {
    await t.db
      .update(backlogQuestions)
      .set({ dismissedAt: new Date() })
      .where(eq(backlogQuestions.id, backlogQuestionId));
    expect(await questionOf(backlogSession, as(u.adminId, "admin"))).toMatchObject({
      answered: true,
      canAnswer: false,
    });
  });
});
