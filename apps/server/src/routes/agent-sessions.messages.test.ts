import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  seedBacklogItem,
  seedEmailMessage,
  startTestDb,
  type TestDb,
  seedTicket,
} from "@stubwise/db/testing";
import {
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  aiJobs,
  backlogRefineSessions,
} from "@stubwise/db";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  AGENT_SESSION_INPUT_CHANNEL,
  AGENT_SESSION_PARTIAL_CHANNEL,
} from "@stubwise/shared";
import { buildApp } from "../app.js";
import { createAgentSessionBus, type AgentSessionBus } from "../agent-session-bus.js";
import { sendAgentMessage } from "../services/agent-sessions.js";
import { actorAs, addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let u: Awaited<ReturnType<typeof seedUsers>>;
let jobSession: string; // viva e interattiva (execute), con interruzione
let otherLiveSession: string; // viva e interattiva, SENZA capability di interruzione
let triageSession: string; // viva ma NON interattiva (triage)
let docsSession: string; // viva, Docs: in sola lettura (design §6.4)
let endedSession: string; // nessun segmento aperto
let staleSession: string; // segmento aperto ma heartbeat vecchio
let mailSessionOfMember: string;
let liveSessions: string[];

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(32) });
  u = await seedUsers(app);
  const { projectId, ticketId } = await seedTicket(t.db);
  // Il member VEDE le sessioni del progetto ma non ci interviene (Viewer: niente
  // `agent_sessions.intervene`). Sui progetti delle sessioni di refinement è
  // invece Legacy Member, che il permesso ce l'ha (`refineSession` qui sotto).
  await addMember(app, projectId, u.memberId, "viewer");
  const [job] = await t.db.insert(aiJobs).values({ ticketId, status: "fixing" }).returning();
  const live = {
    liveSegmentIds: ["seg"],
    activeSegmentId: "seg",
    heartbeatAt: new Date(),
    projectId,
    ticketId,
  };
  const insertSession = async (values: typeof agentSessions.$inferInsert) =>
    (await t.db.insert(agentSessions).values(values).returning({ id: agentSessions.id }))[0]!.id;
  jobSession = await insertSession({
    ownerKey: `ai_job:${job!.id}`,
    kind: "ai_job",
    title: "#1",
    aiJobId: job!.id,
    ...live,
    activeSegmentLabel: "execute",
    activeSegmentInteractive: true,
    capabilities: ["interrupt_receipt_v1"],
  });
  otherLiveSession = await insertSession({
    ownerKey: "ai_job:other-live",
    kind: "ai_job",
    title: "#1",
    ...live,
    activeSegmentLabel: "execute",
    activeSegmentInteractive: true,
  });
  triageSession = await insertSession({
    ownerKey: "ai_job:triage",
    kind: "ai_job",
    title: "#1",
    ...live,
    activeSegmentLabel: "triage",
    activeSegmentInteractive: false,
  });
  docsSession = await insertSession({
    ownerKey: "doc_generation:docs",
    kind: "doc_generation",
    title: "Docs",
    ...live,
    activeSegmentLabel: "docs",
    activeSegmentInteractive: false,
  });
  endedSession = await insertSession({
    ownerKey: "ai_job:ended",
    kind: "ai_job",
    title: "#1",
    projectId,
    ticketId,
  });
  staleSession = await insertSession({
    ownerKey: "ai_job:stale",
    kind: "ai_job",
    title: "#1",
    ...live,
    heartbeatAt: new Date(Date.now() - 10 * 60_000),
    activeSegmentLabel: "execute",
    activeSegmentInteractive: true,
    capabilities: ["interrupt_receipt_v1"],
  });
  const { messageId } = await seedEmailMessage(t.db, { userId: u.memberId });
  mailSessionOfMember = await insertSession({
    ownerKey: `email_message:${messageId}`,
    kind: "email_message",
    title: "Oggetto",
    mailboxOwnerUserId: u.memberId,
    emailMessageId: messageId,
  });
  liveSessions = [jobSession, otherLiveSession, triageSession, docsSession];
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});
// Le sessioni «vive» lo restano per tutto il file: heartbeat fresco a ogni test.
beforeEach(async () => {
  await t.db
    .update(agentSessions)
    .set({ heartbeatAt: new Date() })
    .where(inArray(agentSessions.id, liveSessions));
});

const post = (id: string, cookie: string, body: object) =>
  app.inject({
    method: "POST",
    url: `/api/agent-sessions/${id}/messages`,
    headers: { cookie },
    payload: body,
  });
const inputsOf = async (id: string) =>
  t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, id));
const notifyEvents = (sessionId: string) =>
  t.db.execute(
    sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`,
  );
/**
 * Una sessione `plan` viva e interattiva, col suo segmento: quella su cui il
 * worker abbassa il flag al primo result del piano.
 */
const insertLivePlanSession = async (ownerKey: string) =>
  (
    await t.db
      .insert(agentSessions)
      .values({
        ownerKey,
        kind: "ai_job",
        title: "#1",
        liveSegmentIds: ["seg-plan"],
        activeSegmentId: "seg-plan",
        activeSegmentLabel: "plan",
        activeSegmentInteractive: true,
        heartbeatAt: new Date(),
        capabilities: ["interrupt_receipt_v1"],
      })
      .returning({ id: agentSessions.id })
  )[0]!.id;
/**
 * Ciò che il worker scrive quando l'handle smette di accettare interventi
 * (`createSegmentSink` → `onInputsClosed`, apps/worker/src/sessions/store.ts):
 * il flag del SOLO segmento attivo, più la notifica degli eventi.
 */
const closeInputsLikeTheWorker = async (sessionId: string, segmentId: string) => {
  await t.db
    .update(agentSessions)
    .set({ activeSegmentInteractive: false })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.activeSegmentId, segmentId)));
  await notifyEvents(sessionId);
};

describe("POST /api/agent-sessions/:id/messages", () => {
  it("scrivere chiede agent_sessions.intervene nel progetto: il Legacy Member sì (202, una riga sua), il non membro 404 e nessuna riga", async () => {
    const legacy = await createUserWithPat(app, "legacy-intervene@example.com");
    const outsider = await createUserWithPat(app, "fuori-sessioni@example.com");
    // Una sessione sua, viva e interattiva, nello STESSO progetto delle altre.
    const [source] = await t.db
      .select({ projectId: agentSessions.projectId, ticketId: agentSessions.ticketId })
      .from(agentSessions)
      .where(eq(agentSessions.id, otherLiveSession));
    const [own] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: "ai_job:legacy-intervene",
        kind: "ai_job",
        title: "#1",
        projectId: source!.projectId,
        ticketId: source!.ticketId,
        liveSegmentIds: ["seg"],
        activeSegmentId: "seg",
        heartbeatAt: new Date(),
        activeSegmentLabel: "execute",
        activeSegmentInteractive: true,
      })
      .returning({ id: agentSessions.id });
    await addMember(app, source!.projectId!, legacy.id, "legacy_member");
    const send = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: `/api/agent-sessions/${own!.id}/messages`,
        headers,
        payload: { text: "da chi ha il permesso" },
      });

    const no = await send(outsider.headers);
    expect(no.statusCode).toBe(404);
    expect(await inputsOf(own!.id)).toHaveLength(0);

    const ok = await send(legacy.headers);
    expect(ok.statusCode).toBe(202);
    expect((await inputsOf(own!.id)).map((r) => [r.authorUserId, r.text])).toEqual([
      [legacy.id, "da chi ha il permesso"],
    ]);
  });

  it("member: 403 E nessuna riga scritta", async () => {
    const res = await post(jobSession, u.memberCookie, { text: "salta il piano" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    expect(await inputsOf(jobSession)).toHaveLength(0);
  });

  it("servizio, sotto la rotta: un member riceve forbidden e nessuna riga (difesa in profondità)", async () => {
    const result = await sendAgentMessage(t.db, {
      sessionId: jobSession,
      actor: actorAs(u.memberId, "member"),
      text: "x",
      interrupt: false,
    });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(await inputsOf(jobSession)).toHaveLength(0);
  });

  it("stessi dati, due ruoli: il member no (nessuna riga), l'admin sì (una riga sua)", async () => {
    const asMember = await post(otherLiveSession, u.memberCookie, { text: "due-ruoli" });
    expect(asMember.statusCode).toBe(403);
    expect(await inputsOf(otherLiveSession)).toHaveLength(0);
    const asAdmin = await post(otherLiveSession, u.adminCookie, { text: "due-ruoli" });
    expect(asAdmin.statusCode).toBe(202);
    const rows = await inputsOf(otherLiveSession);
    expect(rows.map((r) => [r.text, r.authorUserId])).toEqual([["due-ruoli", u.adminId]]);
  });

  it("admin su sessione viva e interattiva: 202, riga pending e pg_notify sul canale degli input", async () => {
    const notified: string[] = [];
    await t.client.listen(AGENT_SESSION_INPUT_CHANNEL, (p) => notified.push(p));
    const res = await post(jobSession, u.adminCookie, { text: "guarda anche X", interrupt: true });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
    const [row] = await inputsOf(jobSession);
    expect(res.json().inputId).toBe(row!.id);
    expect(row!.status).toBe("pending");
    expect(row!.interrupt).toBe(true);
    expect(row!.text).toBe("guarda anche X");
    expect(row!.authorUserId).toBe(u.adminId);
    await new Promise((r) => setTimeout(r, 100));
    expect(notified.map((p) => JSON.parse(p).sessionId)).toContain(jobSession);
  });

  it("sessione senza segmenti aperti: 409 session_ended e nessuna riga", async () => {
    const res = await post(endedSession, u.adminCookie, { text: "ciao" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("session_ended");
    expect(await inputsOf(endedSession)).toHaveLength(0);
  });

  it("segmento aperto ma heartbeat vecchio: 409 session_ended e nessuna riga", async () => {
    const res = await post(staleSession, u.adminCookie, { text: "ciao" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("session_ended");
    expect(await inputsOf(staleSession)).toHaveLength(0);
  });

  it("segmento non interattivo (triage): 409 not_interactive e nessuna riga", async () => {
    const res = await post(triageSession, u.adminCookie, { text: "ciao" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("not_interactive");
    expect(await inputsOf(triageSession)).toHaveLength(0);
  });

  it("piano con gli interventi chiusi dal worker (segmento ancora vivo): canWrite false, 409 not_interactive e nessuna riga", async () => {
    const id = await insertLivePlanSession("ai_job:plan-inputs-closed");
    const before = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${id}`,
      headers: { cookie: u.adminCookie },
    });
    expect(before.json().canWrite).toBe(true);
    await closeInputsLikeTheWorker(id, "seg-plan");
    const after = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${id}`,
      headers: { cookie: u.adminCookie },
    });
    // Viva (il processo è nella grazia) ma non più scrivibile.
    expect(after.json().state).not.toBe("ended");
    expect(after.json().canWrite).toBe(false);
    expect(after.json().canInterrupt).toBe(false);
    expect(after.json().canIntervene).toBe(true);
    const res = await post(id, u.adminCookie, { text: "arrivo tardi" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("not_interactive");
    expect(await inputsOf(id)).toHaveLength(0);
  });

  it("generazione Docs viva: in sola lettura, 409 not_interactive e nessuna riga", async () => {
    const res = await post(docsSession, u.adminCookie, { text: "ciao" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("not_interactive");
    expect(await inputsOf(docsSession)).toHaveLength(0);
  });

  it("interruzione senza la capability: 409 interrupt_unsupported e nessuna riga nuova", async () => {
    const before = (await inputsOf(otherLiveSession)).length;
    const res = await post(otherLiveSession, u.adminCookie, { text: "fermati", interrupt: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("interrupt_unsupported");
    expect(await inputsOf(otherLiveSession)).toHaveLength(before);
  });

  it("posta altrui: 404 anche per un admin, nessuna riga", async () => {
    const res = await post(mailSessionOfMember, u.adminCookie, { text: "x" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
    expect(await inputsOf(mailSessionOfMember)).toHaveLength(0);
  });

  it("servizio: la posta altrui è not_found per un admin, nessuna riga", async () => {
    const result = await sendAgentMessage(t.db, {
      sessionId: mailSessionOfMember,
      actor: actorAs(u.adminId, "admin"),
      text: "x",
      interrupt: false,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await inputsOf(mailSessionOfMember)).toHaveLength(0);
  });

  it("testo vuoto SENZA interruzione: 400 e nessuna riga", async () => {
    const before = (await inputsOf(jobSession)).length;
    expect((await post(jobSession, u.adminCookie, { text: "   " })).statusCode).toBe(400);
    expect((await post(jobSession, u.adminCookie, { interrupt: false })).statusCode).toBe(400);
    expect((await post(jobSession, u.adminCookie, {})).statusCode).toBe(400);
    expect(await inputsOf(jobSession)).toHaveLength(before);
  });
});

describe("POST /api/agent-sessions/:id/messages — «Ferma» senza testo", () => {
  const stopSession = (ownerKey: string, capabilities = ["interrupt_receipt_v1"]) =>
    t.db
      .insert(agentSessions)
      .values({
        ownerKey,
        kind: "ai_job",
        title: "#1",
        liveSegmentIds: ["seg-x"],
        activeSegmentId: "seg-x",
        activeSegmentLabel: "execute",
        activeSegmentInteractive: true,
        heartbeatAt: new Date(),
        capabilities,
      })
      .returning({ id: agentSessions.id })
      .then((r) => r[0]!.id);

  it("stessi dati, due ruoli: il member 403 e nessuna riga, l'admin 202 e una riga interrupt col testo vuoto", async () => {
    const id = await stopSession("ai_job:stop-two-roles");
    const asMember = await post(id, u.memberCookie, { interrupt: true });
    expect(asMember.statusCode).toBe(403);
    expect(await inputsOf(id)).toHaveLength(0);
    const asAdmin = await post(id, u.adminCookie, { interrupt: true });
    expect(asAdmin.statusCode).toBe(202);
    const rows = await inputsOf(id);
    expect(rows.map((r) => [r.text, r.interrupt, r.status, r.authorUserId])).toEqual([
      ["", true, "pending", u.adminId],
    ]);
    expect(asAdmin.json().inputId).toBe(rows[0]!.id);
  });

  it("testo di soli spazi con interrupt: salvato vuoto", async () => {
    const id = await stopSession("ai_job:stop-blank");
    expect((await post(id, u.adminCookie, { text: "   ", interrupt: true })).statusCode).toBe(202);
    expect((await inputsOf(id)).map((r) => r.text)).toEqual([""]);
  });

  it("servizio: un member riceve forbidden anche per «Ferma» senza testo, e nessuna riga", async () => {
    const id = await stopSession("ai_job:stop-service-member");
    const result = await sendAgentMessage(t.db, {
      sessionId: id,
      actor: actorAs(u.memberId, "member"),
      text: "",
      interrupt: true,
    });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(await inputsOf(id)).toHaveLength(0);
  });

  it("senza la capability: 409 interrupt_unsupported e nessuna riga", async () => {
    const id = await stopSession("ai_job:stop-no-cap", []);
    const res = await post(id, u.adminCookie, { interrupt: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("interrupt_unsupported");
    expect(await inputsOf(id)).toHaveLength(0);
  });

  it("sessione finita: 409 session_ended; passo non interattivo: 409 not_interactive; nessuna riga", async () => {
    const ended = await post(endedSession, u.adminCookie, { interrupt: true });
    expect(ended.statusCode).toBe(409);
    expect(ended.json().code).toBe("session_ended");
    expect(await inputsOf(endedSession)).toHaveLength(0);
    const triage = await post(triageSession, u.adminCookie, { interrupt: true });
    expect(triage.statusCode).toBe(409);
    expect(triage.json().code).toBe("not_interactive");
    expect(await inputsOf(triageSession)).toHaveLength(0);
  });
});

describe("GET /api/agent-sessions/:id — paused derivato a lettura", () => {
  const minus = (s: number) => new Date(Date.now() - s * 1000);
  const liveSession = async (ownerKey: string) =>
    (
      await t.db
        .insert(agentSessions)
        .values({
          ownerKey,
          kind: "ai_job",
          title: "#1",
          liveSegmentIds: ["seg-p"],
          activeSegmentId: "seg-p",
          activeSegmentLabel: "execute",
          activeSegmentInteractive: true,
          heartbeatAt: new Date(),
          capabilities: ["interrupt_receipt_v1"],
        })
        .returning({ id: agentSessions.id })
    )[0]!.id;
  const event = (
    sessionId: string,
    type: "assistant_text" | "tool_use" | "turn_end" | "segment_end",
    at: Date,
  ) =>
    t.db.insert(agentSessionEvents).values({
      sessionId,
      segmentId: "seg-p",
      type,
      data: {},
      createdAt: at,
    });
  const input = (
    sessionId: string,
    v: { text: string; interrupt: boolean; status: "pending" | "delivered" | "undelivered"; at: Date },
  ) =>
    t.db.insert(agentSessionInputs).values({
      sessionId,
      authorUserId: u.adminId,
      text: v.text,
      interrupt: v.interrupt,
      status: v.status,
      createdAt: v.at,
      deliveredAt: v.status === "delivered" ? v.at : null,
    });
  const detail = async (id: string, cookie = u.adminCookie) =>
    (
      await app.inject({
        method: "GET",
        url: `/api/agent-sessions/${id}`,
        headers: { cookie },
      })
    ).json();

  it("«Ferma» senza testo consegnato, poi il turn_end dell'interruzione: in pausa (per chiunque guardi)", async () => {
    const id = await liveSession("ai_job:paused-yes");
    await event(id, "assistant_text", minus(30));
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    // La coda del turno interrotto arriva DOPO la consegna, prima del suo turn_end.
    await event(id, "assistant_text", minus(19));
    await event(id, "turn_end", minus(18));
    expect((await detail(id)).paused).toBe(true);
    expect((await detail(id, u.memberCookie)).paused).toBe(true);
  });

  it("monotona dalla consegna al turn_end: la coda del turno interrotto non fa lampeggiare la pausa", async () => {
    const id = await liveSession("ai_job:paused-monotonic");
    await event(id, "assistant_text", minus(30));
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    expect((await detail(id)).paused).toBe(true);
    // Coda del turno interrotto, registrata DOPO la consegna e prima del suo turn_end.
    await event(id, "assistant_text", minus(19));
    expect((await detail(id)).paused).toBe(true);
    await event(id, "tool_use", minus(18));
    expect((await detail(id)).paused).toBe(true);
    await event(id, "turn_end", minus(17));
    expect((await detail(id)).paused).toBe(true);
    // Un turno NUOVO dopo quel turn_end: la pausa finisce.
    await event(id, "assistant_text", minus(5));
    expect((await detail(id)).paused).toBe(false);
  });

  it("deliverable nell'output: il result RIUSCITO arrivato prima dell'interrupt chiude gli interventi e la pausa (Q2 I1)", async () => {
    const id = await liveSession("ai_job:paused-success-output");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    expect((await detail(id)).paused).toBe(true);
    // Ciò che il worker scrive in quel percorso: il turn_end `success`, poi
    // `onInputsClosed` abbassa il flag del segmento attivo (la pausa finisce
    // senza annullare, e parte la grazia).
    await t.db.insert(agentSessionEvents).values({
      sessionId: id,
      segmentId: "seg-p",
      type: "turn_end",
      data: { subtype: "success", isError: false },
      createdAt: minus(18),
    });
    await closeInputsLikeTheWorker(id, "seg-p");
    const d = await detail(id);
    expect(d.state).not.toBe("ended");
    expect(d.paused).toBe(false);
  });

  it("segmento coi file: un result riuscito dopo lo «Ferma» non chiude gli interventi, e la pausa resta", async () => {
    const id = await liveSession("ai_job:paused-success-files");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    await t.db.insert(agentSessionEvents).values({
      sessionId: id,
      segmentId: "seg-p",
      type: "turn_end",
      data: { subtype: "success", isError: false },
      createdAt: minus(18),
    });
    expect((await detail(id)).paused).toBe(true);
  });

  it("un intervento successivo (con testo): non più in pausa", async () => {
    const id = await liveSession("ai_job:paused-later-input");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    await event(id, "turn_end", minus(18));
    await input(id, { text: "riprendi da Y", interrupt: false, status: "pending", at: minus(5) });
    expect((await detail(id)).paused).toBe(false);
  });

  it("attività dell'agente dopo il turn_end: non in pausa", async () => {
    const id = await liveSession("ai_job:paused-later-activity");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    await event(id, "turn_end", minus(18));
    await event(id, "tool_use", minus(10));
    expect((await detail(id)).paused).toBe(false);
  });

  it("segmento finito dopo la consegna: non in pausa", async () => {
    const id = await liveSession("ai_job:paused-segment-end");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    await event(id, "turn_end", minus(18));
    await event(id, "segment_end", minus(10));
    expect((await detail(id)).paused).toBe(false);
  });

  it("sessione non viva (heartbeat vecchio): non in pausa", async () => {
    const id = await liveSession("ai_job:paused-not-live");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    await event(id, "turn_end", minus(18));
    await t.db
      .update(agentSessions)
      .set({ heartbeatAt: minus(600) })
      .where(eq(agentSessions.id, id));
    expect((await detail(id)).paused).toBe(false);
  });

  it("«Ferma e scrivi» (interruzione CON testo): non è una pausa", async () => {
    const id = await liveSession("ai_job:paused-with-text");
    await input(id, { text: "fai X", interrupt: true, status: "delivered", at: minus(20) });
    await event(id, "turn_end", minus(18));
    expect((await detail(id)).paused).toBe(false);
  });

  it("sessione viva e interattiva senza stop: canInterrupt vero (il controllo dei casi qui sotto)", async () => {
    const id = await liveSession("ai_job:can-interrupt-base");
    const d = await detail(id);
    expect(d.canWrite).toBe(true);
    expect(d.canInterrupt).toBe(true);
  });

  it("in pausa: canInterrupt FALSO, canWrite resta vero (l'agente è già fermo)", async () => {
    const id = await liveSession("ai_job:can-interrupt-paused");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    await event(id, "turn_end", minus(18));
    const d = await detail(id);
    expect(d.paused).toBe(true);
    expect(d.canWrite).toBe(true);
    expect(d.canInterrupt).toBe(false);
  });

  it("«Ferma» senza testo ancora in attesa di consegna: canInterrupt FALSO già prima della pausa", async () => {
    const id = await liveSession("ai_job:can-interrupt-stop-pending");
    await input(id, { text: "", interrupt: true, status: "pending", at: minus(1) });
    const d = await detail(id);
    expect(d.paused).toBe(false);
    expect(d.canWrite).toBe(true);
    expect(d.canInterrupt).toBe(false);
  });

  it("«Ferma e scrivi» in attesa (CON testo) non spegne canInterrupt", async () => {
    const id = await liveSession("ai_job:can-interrupt-pending-with-text");
    await input(id, { text: "fai X", interrupt: true, status: "pending", at: minus(1) });
    expect((await detail(id)).canInterrupt).toBe(true);
  });

  it("finita la pausa (turno nuovo), canInterrupt torna vero", async () => {
    const id = await liveSession("ai_job:can-interrupt-after-pause");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    await event(id, "turn_end", minus(18));
    await input(id, { text: "riprendi", interrupt: false, status: "delivered", at: minus(10) });
    await event(id, "assistant_text", minus(5));
    const d = await detail(id);
    expect(d.paused).toBe(false);
    expect(d.canInterrupt).toBe(true);
  });

  it("in pausa un secondo «Ferma» (o «Ferma e scrivi») è 409 interrupt_unsupported, e nessuna riga nasce", async () => {
    const id = await liveSession("ai_job:can-interrupt-paused-post");
    await input(id, { text: "", interrupt: true, status: "delivered", at: minus(20) });
    await event(id, "turn_end", minus(18));
    for (const payload of [{ interrupt: true }, { text: "fai Y", interrupt: true }]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/agent-sessions/${id}/messages`,
        headers: { cookie: u.adminCookie },
        payload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("interrupt_unsupported");
    }
    const rows = await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, id));
    expect(rows).toHaveLength(1);
    // Un messaggio normale invece passa: in pausa si scrive.
    const ok = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${id}/messages`,
      headers: { cookie: u.adminCookie },
      payload: { text: "riprendi da Y" },
    });
    expect(ok.statusCode).toBe(202);
  });

  it("gli interventi del dettaglio portano id e stato (la bolla «In coda» li abbina all'evento input per inputId)", async () => {
    const id = await liveSession("ai_job:queued-bubble");
    await input(id, { text: "in coda", interrupt: false, status: "delivered", at: minus(5) });
    const d = await detail(id);
    expect(d.inputs).toHaveLength(1);
    expect(d.inputs[0]).toMatchObject({ text: "in coda", status: "delivered" });
    expect(typeof d.inputs[0].id).toBe("string");
  });
});

describe("GET /api/agent-sessions/:id/stream", () => {
  let base: string;
  let sseApp: ReturnType<typeof buildApp>;
  let realBus: AgentSessionBus;
  /** Sottoscrizioni aperte, per sessione: serve a provare che la chiusura non ne lascia. */
  const open = new Map<string, number>();
  const openTotal = () => [...open.values()].reduce((a, b) => a + b, 0);

  beforeAll(async () => {
    realBus = await createAgentSessionBus((c, cb) => t.client.listen(c, cb));
    const countingBus: AgentSessionBus = {
      subscribe(sessionId, cb) {
        open.set(sessionId, (open.get(sessionId) ?? 0) + 1);
        const off = realBus.subscribe(sessionId, cb);
        return () => {
          open.set(sessionId, (open.get(sessionId) ?? 0) - 1);
          off();
        };
      },
    };
    sseApp = buildApp({
      db: t.db,
      sessionSecret: "x".repeat(32),
      sessionBus: countingBus,
    });
    base = await sseApp.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => sseApp.close());

  /** Legge lo stream finché compare `needle` (o scade): restituisce TUTTO il letto. */
  function reader(res: Response) {
    const r = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    return async (needle: string, ms = 3000): Promise<string> => {
      const deadline = Date.now() + ms;
      while (!acc.includes(needle)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        pending ??= r.read();
        const result = await Promise.race([
          pending,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
        ]);
        if (result === null) break;
        pending = null;
        if (result.done) break;
        acc += decoder.decode(result.value);
      }
      return acc;
    };
  }

  const openStream = (id: string, cookie: string, signal: AbortSignal, after?: string) =>
    fetch(`${base}/api/agent-sessions/${id}/stream${after ? `?after=${after}` : ""}`, {
      headers: { cookie },
      signal,
    });

  async function waitFor(cond: () => boolean, ms = 2000) {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return cond();
  }

  it("un member riceve il dettaglio (con inputs) e poi gli eventi nuovi notificati dal worker", async () => {
    const ctrl = new AbortController();
    const res = await openStream(jobSession, u.memberCookie, ctrl.signal);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const read = reader(res);
    const first = await read('"type":"session"');
    expect(first).toContain('"type":"session"');
    expect(first).toContain('"inputs":');
    await t.db.insert(agentSessionEvents).values({
      sessionId: jobSession,
      segmentId: "seg",
      type: "assistant_text",
      data: { text: "evento-nuovo-dal-vivo" },
    });
    await notifyEvents(jobSession);
    const all = await read("evento-nuovo-dal-vivo");
    expect(all).toContain("evento-nuovo-dal-vivo");
    // L'id (bigint in tabella) viaggia come stringa.
    expect(all).toMatch(/"id":"\d+","type":"assistant_text"/);
    ctrl.abort();
  });

  it("un intervento che diventa undelivered arriva nel messaggio session successivo", async () => {
    const ctrl = new AbortController();
    const res = await openStream(jobSession, u.adminCookie, ctrl.signal);
    const read = reader(res);
    await read('"type":"session"');
    // Quello che farebbe il relay del worker (Task 7): cambio di stato + notifica eventi.
    await t.db
      .update(agentSessionInputs)
      .set({ status: "undelivered", reason: "stdin_closed" })
      .where(eq(agentSessionInputs.sessionId, jobSession));
    await notifyEvents(jobSession);
    expect(await read('"reason":"stdin_closed"')).toContain('"reason":"stdin_closed"');
    ctrl.abort();
  });

  it("due notifiche ravvicinate: nessun evento perso (flag sporco, niente attesa del poll)", async () => {
    const ctrl = new AbortController();
    const res = await openStream(jobSession, u.memberCookie, ctrl.signal);
    const read = reader(res);
    await read('"type":"session"');
    for (const text of ["raffica-uno", "raffica-due"]) {
      await t.db
        .insert(agentSessionEvents)
        .values({
          sessionId: jobSession,
          segmentId: "seg",
          type: "assistant_text",
          data: { text },
        });
      await notifyEvents(jobSession);
    }
    // Entro 2 s, ben sotto il poll di rete di 5 s.
    expect(await read("raffica-due", 2000)).toContain("raffica-due");
    ctrl.abort();
  });

  it("riconnessione con after: solo gli eventi successivi al cursore", async () => {
    const [older] = await t.db
      .insert(agentSessionEvents)
      .values({
        sessionId: jobSession,
        segmentId: "seg",
        type: "assistant_text",
        data: { text: "gia-visto-prima" },
      })
      .returning({ id: agentSessionEvents.id });
    await t.db.insert(agentSessionEvents).values({
      sessionId: jobSession,
      segmentId: "seg",
      type: "assistant_text",
      data: { text: "dopo-il-cursore" },
    });
    const ctrl = new AbortController();
    const res = await openStream(jobSession, u.memberCookie, ctrl.signal, older!.id.toString());
    const all = await reader(res)("dopo-il-cursore");
    expect(all).toContain("dopo-il-cursore");
    expect(all).not.toContain("gia-visto-prima");
    expect(all).not.toContain("evento-nuovo-dal-vivo");
    ctrl.abort();
  });

  it("il contenuto degli eventi si rilegge dal DB: quello scritto nella NOTIFY non passa", async () => {
    const ctrl = new AbortController();
    const res = await openStream(jobSession, u.memberCookie, ctrl.signal);
    const read = reader(res);
    await read('"type":"session"');
    const payload = JSON.stringify({
      sessionId: jobSession,
      events: [{ type: "assistant_text", data: { text: "contenuto-solo-nella-notify" } }],
    });
    await t.db.execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${payload})`);
    await t.db.insert(agentSessionEvents).values({
      sessionId: jobSession,
      segmentId: "seg",
      type: "assistant_text",
      data: { text: "contenuto-dal-db" },
    });
    await notifyEvents(jobSession);
    const all = await read("contenuto-dal-db");
    expect(all).toContain("contenuto-dal-db");
    expect(all).not.toContain("contenuto-solo-nella-notify");
    ctrl.abort();
  });

  it("due stream su sessioni diverse: ciascuno riceve solo i parziali e gli eventi suoi", async () => {
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const readA = reader(await openStream(jobSession, u.memberCookie, ctrlA.signal));
    const readB = reader(await openStream(otherLiveSession, u.memberCookie, ctrlB.signal));
    await readA('"type":"session"');
    await readB('"type":"session"');
    const partial = (sessionId: string, text: string) =>
      t.db.execute(
        sql`select pg_notify(${AGENT_SESSION_PARTIAL_CHANNEL}, ${JSON.stringify({ sessionId, segmentId: "seg", text })})`,
      );
    await partial(jobSession, "parziale-di-A");
    await partial(otherLiveSession, "parziale-di-B");
    await t.db.insert(agentSessionEvents).values({
      sessionId: jobSession,
      segmentId: "seg",
      type: "assistant_text",
      data: { text: "evento-di-A" },
    });
    await notifyEvents(jobSession);
    const a = await readA("evento-di-A");
    const b = await readB("parziale-di-B");
    expect(a).toContain('"type":"partial","segmentId":"seg","text":"parziale-di-A"');
    expect(a).toContain("evento-di-A");
    expect(a).not.toContain("parziale-di-B");
    expect(b).toContain("parziale-di-B");
    // Lascia il tempo all'evento di A di arrivare, se mai arrivasse a B.
    const bAfter = await readB("evento-di-A", 500);
    expect(bAfter).not.toContain("parziale-di-A");
    expect(bAfter).not.toContain("evento-di-A");
    ctrlA.abort();
    ctrlB.abort();
  });

  it("chiusura del client: la sottoscrizione al bus si toglie (nessuna perdita)", async () => {
    expect(await waitFor(() => openTotal() === 0)).toBe(true);
    const ctrl = new AbortController();
    const read = reader(await openStream(jobSession, u.memberCookie, ctrl.signal));
    await read('"type":"session"');
    expect(open.get(jobSession)).toBe(1);
    ctrl.abort();
    expect(await waitFor(() => openTotal() === 0)).toBe(true);
  });

  it("il worker chiude gli interventi del piano: lo stream manda SUBITO un dettaglio con canWrite false", async () => {
    const id = await insertLivePlanSession("ai_job:plan-inputs-closed-stream");
    const ctrl = new AbortController();
    const res = await openStream(id, u.adminCookie, ctrl.signal);
    const read = reader(res);
    expect(await read('"canWrite":true')).toContain('"canWrite":true');
    await closeInputsLikeTheWorker(id, "seg-plan");
    // Ben prima del poll di sicurezza: è la notifica a far partire la rilettura.
    expect(await read('"canWrite":false', 1500)).toContain('"canWrite":false');
    ctrl.abort();
  });

  it("posta altrui: 404 in JSON anche per un admin, senza aprire lo stream né sottoscrivere", async () => {
    const res = await fetch(`${base}/api/agent-sessions/${mailSessionOfMember}/stream`, {
      headers: { cookie: u.adminCookie },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).code).toBe("not_found");
    expect(open.get(mailSessionOfMember) ?? 0).toBe(0);
  });

  it("il proprietario della casella apre lo stream della SUA posta", async () => {
    const ctrl = new AbortController();
    const res = await openStream(mailSessionOfMember, u.memberCookie, ctrl.signal);
    expect(res.status).toBe(200);
    expect(await reader(res)('"type":"session"')).toContain(mailSessionOfMember);
    ctrl.abort();
  });
});

describe("sessioni di refinement: scrive chi ha agent_sessions.intervene (il Legacy Member sì, il Viewer no)", () => {
  async function refineSession(
    opts: { status?: "active" | "closed"; itemStatus?: "new" | "converted" } = {},
  ) {
    const { itemId, projectId } = await seedBacklogItem(t.db, { status: opts.itemStatus ?? "new" });
    await addMember(app, projectId, u.memberId, "legacy_member");
    const [s] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: `backlog_refine:${itemId}`,
        kind: "backlog_refine",
        title: "t",
        backlogItemId: itemId,
        projectId,
      })
      .returning();
    await t.db.insert(backlogRefineSessions).values({
      itemId,
      agentSessionId: s!.id,
      status: opts.status ?? "active",
      ...(opts.status === "closed"
        ? {
            closedAt: new Date(),
            closedReason: "idle" as const,
            lastActivityAt: new Date(Date.now() - 3_600_000),
          }
        : {}),
    });
    return { id: s!.id, itemId };
  }
  const refineOf = async (itemId: string) =>
    (
      await t.db
        .select()
        .from(backlogRefineSessions)
        .where(eq(backlogRefineSessions.itemId, itemId))
    )[0]!;

  it("stesso member, due progetti (Review Focus #4): col permesso (refinement) 202 con la sua riga; senza (ai_job, Viewer) 403 e NESSUNA riga", async () => {
    const r = await refineSession();
    const ok = await post(r.id, u.memberCookie, { text: "proposta" });
    expect(ok.statusCode).toBe(202);
    expect((await inputsOf(r.id)).map((i) => [i.text, i.authorUserId, i.status])).toEqual([
      ["proposta", u.memberId, "pending"],
    ]);
    const before = (await inputsOf(jobSession)).length;
    const no = await post(jobSession, u.memberCookie, { text: "proposta" });
    expect(no.statusCode).toBe(403);
    expect(await inputsOf(jobSession)).toHaveLength(before);
  });

  it("senza processo vivo NON è session_ended: il messaggio diventa un turno (riga pending)", async () => {
    const r = await refineSession();
    expect((await post(r.id, u.adminCookie, { text: "via" })).statusCode).toBe(202);
    expect((await inputsOf(r.id)).map((i) => [i.text, i.authorUserId, i.status])).toEqual([
      ["via", u.adminId, "pending"],
    ]);
  });

  it("su una sessione chiusa (voce aperta) la riapre e tocca l'attività", async () => {
    const r = await refineSession({ status: "closed" });
    const before = (await refineOf(r.itemId)).lastActivityAt;
    expect((await post(r.id, u.memberCookie, { text: "riprendiamo" })).statusCode).toBe(202);
    const after = await refineOf(r.itemId);
    expect(after).toMatchObject({ status: "active", closedAt: null, closedReason: null });
    expect(after.lastActivityAt.getTime()).toBeGreaterThan(before.getTime());
    expect(await inputsOf(r.id)).toHaveLength(1);
  });

  it("voce convertita (Review Focus #6): 409 item_closed e nessuna riga", async () => {
    const r = await refineSession({ status: "closed", itemStatus: "converted" });
    const res = await post(r.id, u.memberCookie, { text: "x" });
    expect([res.statusCode, res.json().code]).toEqual([409, "item_closed"]);
    expect(await inputsOf(r.id)).toHaveLength(0);
    expect(await refineOf(r.itemId)).toMatchObject({ status: "closed" });
  });

  it("«Ferma» senza un turno vivo: 409 interrupt_unsupported, nessuna riga", async () => {
    const r = await refineSession();
    const res = await post(r.id, u.memberCookie, { text: "", interrupt: true });
    expect([res.statusCode, res.json().code]).toEqual([409, "interrupt_unsupported"]);
    expect(await inputsOf(r.id)).toHaveLength(0);
  });

  it("dettaglio per un member: canWrite e canIntervene anche fermi, canClose solo attiva, canInterrupt mai senza turno", async () => {
    const active = await refineSession();
    const closed = await refineSession({ status: "closed" });
    const converted = await refineSession({ itemStatus: "converted" });
    const get = async (id: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/agent-sessions/${id}`,
          headers: { cookie: u.memberCookie },
        })
      ).json();
    expect(await get(active.id)).toMatchObject({
      canWrite: true,
      canIntervene: true,
      canClose: true,
      canInterrupt: false,
      state: "idle",
    });
    expect(await get(closed.id)).toMatchObject({ canWrite: true, canClose: false, state: "ended" });
    expect(await get(converted.id)).toMatchObject({ canWrite: false });
  });

  it("stesso member, due kind, turno VIVO: «Ferma» sul refinement canInterrupt e 202 con la riga; sull'ai_job canInterrupt falso, 403 e nessuna riga", async () => {
    const r = await refineSession();
    await t.db
      .update(agentSessions)
      .set({
        liveSegmentIds: ["seg"],
        activeSegmentId: "seg",
        heartbeatAt: new Date(),
        activeSegmentLabel: "refine",
        activeSegmentInteractive: true,
        capabilities: ["interrupt_receipt_v1"],
      })
      .where(eq(agentSessions.id, r.id));
    const get = async (id: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/agent-sessions/${id}`,
          headers: { cookie: u.memberCookie },
        })
      ).json();
    expect(await get(r.id)).toMatchObject({ canInterrupt: true });
    const ok = await post(r.id, u.memberCookie, { text: "", interrupt: true });
    expect(ok.statusCode).toBe(202);
    expect((await inputsOf(r.id)).map((i) => [i.text, i.interrupt, i.authorUserId])).toEqual([
      ["", true, u.memberId],
    ]);
    expect(await get(jobSession)).toMatchObject({ canInterrupt: false });
    const before = (await inputsOf(jobSession)).length;
    const no = await post(jobSession, u.memberCookie, { text: "", interrupt: true });
    expect(no.statusCode).toBe(403);
    expect(await inputsOf(jobSession)).toHaveLength(before);
  });

  it("sessione backlog_refine SENZA riga di refinement: 404 not_found (non item_closed) e nessuna riga", async () => {
    const { itemId, projectId } = await seedBacklogItem(t.db);
    const [s] = await t.db
      .insert(agentSessions)
      .values({
        ownerKey: `backlog_refine:${itemId}`,
        kind: "backlog_refine",
        title: "t",
        backlogItemId: itemId,
        projectId,
      })
      .returning();
    const res = await post(s!.id, u.memberCookie, { text: "x" });
    expect([res.statusCode, res.json().code]).toEqual([404, "not_found"]);
    expect(await inputsOf(s!.id)).toHaveLength(0);
  });

  it("servizio: la riga di refinement sparisce fra la lettura e la transazione → not_found, nessuna riga", async () => {
    const r = await refineSession({ status: "closed" });
    const racing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: Parameters<typeof t.db.transaction>[0]) => {
            await t.db.delete(backlogRefineSessions).where(eq(backlogRefineSessions.agentSessionId, r.id));
            return t.db.transaction(fn);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof t.db;
    const result = await sendAgentMessage(racing, {
      sessionId: r.id,
      actor: actorAs(u.memberId, "member"),
      text: "x",
      interrupt: false,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await inputsOf(r.id)).toHaveLength(0);
  });

  it("un messaggio in attesa di un turno: la sessione è queued", async () => {
    const r = await refineSession();
    await post(r.id, u.memberCookie, { text: "in coda" });
    const res = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${r.id}`,
      headers: { cookie: u.memberCookie },
    });
    expect(res.json()).toMatchObject({ state: "queued", canWrite: true });
  });
});
