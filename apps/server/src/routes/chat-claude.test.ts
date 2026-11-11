import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentRuns,
  agentSessionInputs,
  agentSessions,
  chatChannels,
  chatClaudeQuestions,
  chatMessages,
  claudeConversations,
  claudeProposals,
  instanceSettings,
  issueChatToolToken,
  notifications,
} from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// @Claude nella Chat, area 4 fetta 3: la chiamata (una sessione per chiamata,
// privata di chi chiama, D5), il contesto del thread come lo legge lui, le
// proposte SEMPRE B che conferma solo lui, stop, «Try again», la domanda.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let repositoryId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let contributor: U;
let outsider: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-cc@example.com");
  dev = await createUserWithSession(app, "dev-cc@example.com");
  contributor = await createUserWithSession(app, "contributor-cc@example.com");
  outsider = await createUserWithSession(app, "outsider-cc@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, contributor.id, "contributor");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (u: U, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const post = (u: U, channelId: string, text: string, extra: Record<string, unknown> = {}) =>
  as(u, "POST", `/api/chat/channels/${channelId}/messages`, { text, ...extra });
const idOf = (res: { json: () => unknown }) => (res.json() as { id: string }).id;

type Claude = {
  state: string;
  error: string | null;
  sessionId: string | null;
  retried: boolean;
  canStop: boolean;
  canRetry: boolean;
  proposals: { id: string; status: string; cls: string; actions: { fn: string; args: Record<string, unknown> }[]; resultCodes: string[]; canConfirm: boolean }[];
  question: { id: string; text: string; canAnswer: boolean; answer: unknown } | null;
};
type Msg = { id: string; kind: string; calledById: string | null; threadRootId: string | null; claude: Claude | null; claudeReplying: boolean };

async function general(): Promise<string> {
  const [row] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  return row!.id;
}
/** La risposta di Claude nel thread di `rootId` più recente. */
async function replyIn(rootId: string): Promise<typeof chatMessages.$inferSelect> {
  const [row] = await t.db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.threadRootId, rootId), eq(chatMessages.kind, "claude")))
    .orderBy(sql`created_at desc`)
    .limit(1);
  return row!;
}
const view = async (u: U, id: string) => (await as(u, "GET", `/api/chat/messages/${id}`)).json() as Msg;
let tu = 0;
async function propose(sessionId: string, userId: string, actions: unknown[]) {
  const token = await issueChatToolToken(t.db, { sessionId, userId, ttlMs: 60_000 });
  return app.inject({
    method: "POST",
    url: `/api/claude/conversations/${sessionId}/proposals`,
    headers: { authorization: `Bearer ${token}` },
    payload: { toolUseId: `tu-cc-${++tu}`, actions, summary: "Crea la task" },
  });
}

describe("la chiamata", () => {
  it("«@Claude» fa nascere subito la risposta nel thread, «chiamato da» chi scrive, con la SUA sessione (D5)", async () => {
    const g = await general();
    const root = idOf(await post(lead, g, "Il rilascio di venerdì è confermato"));
    await post(contributor, g, "Io non ci sono venerdì", { threadRootId: root });
    const deleted = idOf(await post(contributor, g, "da togliere", { threadRootId: root }));
    await as(contributor, "DELETE", `/api/chat/messages/${deleted}`);
    const call = await post(dev, g, "@Claude riassumi il thread", { threadRootId: root });
    expect(call.statusCode, call.body).toBe(201);
    const reply = await replyIn(root);
    expect(reply).toMatchObject({ kind: "claude", calledById: dev.id, callMessageId: idOf(call), claudeState: "working", body: "" });
    // La sessione è di chi chiama: lui ne legge gli eventi, un altro membro no.
    const sid = reply.agentSessionId!;
    expect((await view(dev, reply.id)).claude).toMatchObject({ state: "working", sessionId: sid, canStop: true });
    expect((await view(lead, reply.id)).claude).toMatchObject({ state: "working", sessionId: null, canStop: false });
    expect((await as(dev, "GET", `/api/agent-sessions/${sid}`)).statusCode).toBe(200);
    expect((await as(lead, "GET", `/api/agent-sessions/${sid}`)).statusCode).toBe(404);
    expect((await as(lead, "GET", `/api/agent-sessions/${sid}/events`)).statusCode).toBe(404);
    // Il contesto è il thread prima della chiamata, senza eliminati, come testo da leggere.
    const [input] = await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, sid));
    expect(input!.text).toContain("riassumi il thread");
    expect(input!.text).toContain("lead-cc: Il rilascio di venerdì è confermato");
    expect(input!.text).toContain("contributor-cc: Io non ci sono venerdì");
    expect(input!.text).not.toContain("da togliere");
    expect(input!.text).not.toContain("@Claude");
    // Non è una conversazione della destinazione «Claude».
    const mine = (await as(dev, "GET", "/api/claude/conversations")).json() as { items: { id: string }[] };
    expect(mine.items.map((c) => c.id)).not.toContain(sid);
    expect((await as(dev, "GET", `/api/claude/conversations/${sid}`)).statusCode).toBe(404);
    // La radice dice che Claude sta rispondendo; «@Claude» non è una menzione da avvisare.
    expect((await view(lead, root)).claudeReplying).toBe(true);
    expect(await t.db.select().from(notifications).where(eq(notifications.kind, "chat.mention"))).toEqual([]);
  });

  it("da una radice risponde nel suo thread; una modifica che aggiunge «@Claude» non chiama", async () => {
    const g = await general();
    const root = idOf(await post(dev, g, "@Claude cosa manca?"));
    expect((await replyIn(root)).threadRootId).toBe(root);
    const plain = idOf(await post(dev, g, "senza chiamata"));
    await as(dev, "PATCH", `/api/chat/messages/${plain}`, { text: "ora @Claude" });
    expect(await t.db.select().from(chatMessages).where(and(eq(chatMessages.threadRootId, plain), eq(chatMessages.kind, "claude")))).toEqual([]);
  });

  it("a budget finito la risposta nasce «failed» col motivo `budget`, senza sessione", async () => {
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    const [run] = await t.db
      .insert(agentRuns)
      .values({ phase: "triage", operation: "triage", model: "claude-sonnet-5-5", costUsd: "2" } as typeof agentRuns.$inferInsert)
      .returning({ id: agentRuns.id });
    try {
      const g = await general();
      const root = idOf(await post(dev, g, "@Claude aiutami"));
      const reply = await replyIn(root);
      expect(reply).toMatchObject({ claudeState: "failed", claudeError: "budget", agentSessionId: null });
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null });
      await t.db.execute(sql`delete from agent_runs where id = ${run!.id}`);
    }
  });
});

describe("le proposte in Chat", () => {
  it("sempre B, anche quando il calcolo dice A; conferma solo chi ha chiamato", async () => {
    const g = await general();
    const root = idOf(await post(dev, g, "@Claude crea una task per il rilascio"));
    const reply = await replyIn(root);
    const res = await propose(reply.agentSessionId!, dev.id, [{ fn: "createTask", args: { projectId, title: "Preparare il rilascio", type: "bug" } }]);
    expect(res.json(), res.body).toMatchObject({ status: "awaiting_confirmation" });
    const proposalId = (res.json() as { proposalId: string }).proposalId;
    const [row] = await t.db.select().from(claudeProposals).where(eq(claudeProposals.id, proposalId));
    expect(row!.declaredCls).toBe("B");
    const forDev = (await view(dev, reply.id)).claude!.proposals[0]!;
    expect(forDev).toMatchObject({ status: "open", cls: "B", canConfirm: true });
    expect(forDev.actions[0]!.args).toMatchObject({ title: "Preparare il rilascio" });
    const forLead = (await view(lead, reply.id)).claude!.proposals[0]!;
    expect(forLead).toMatchObject({ status: "open", canConfirm: false });
    expect((await as(lead, "POST", `/api/claude/proposals/${proposalId}/confirm`, {})).statusCode).toBe(404);
    const ok = await as(dev, "POST", `/api/claude/proposals/${proposalId}/confirm`, {});
    expect(ok.statusCode, ok.body).toBe(200);
    const confirmed = (await view(dev, reply.id)).claude!.proposals[0]!;
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.resultCodes).toHaveLength(1);
    // Il Contributor non vede la task (niente tickets.view_all): il codice non esce.
    expect((await view(contributor, reply.id)).claude!.proposals[0]!.resultCodes).toEqual([]);
    // Niente «Annulla» nella Chat.
    const groupId = (ok.json() as { groupId: string }).groupId;
    expect((await as(dev, "POST", `/api/claude/groups/${groupId}/undo`)).json()).toMatchObject({ code: "not_undoable" });
  });

  it("gli altri lettori vedono gli argomenti degli oggetti che vedono, e solo quelli (due lettori)", async () => {
    const g = await general();
    const { ticketId } = await seedTicket(t.db, { projectId, repositoryId, number: 900 });
    const root = idOf(await post(dev, g, "@Claude crea l'export e riassegna la vecchia"));
    const reply = await replyIn(root);
    const res = await propose(reply.agentSessionId!, dev.id, [
      { fn: "createTask", args: { projectId, title: "Export PDF", type: "feature" } },
      { fn: "updateTask", args: { id: ticketId, patch: { title: "Vecchio export, da togliere" } } },
    ]);
    expect(res.json(), res.body).toMatchObject({ status: "awaiting_confirmation" });
    // Il Lead vede il progetto e la task: gli argomenti come li vede chi ha chiamato.
    const forLead = (await view(lead, reply.id)).claude!.proposals[0]!;
    expect(forLead.actions[0]!.args).toMatchObject({ projectId, title: "Export PDF" });
    expect(forLead.actions[1]!.args).toMatchObject({ id: ticketId, patch: { title: "Vecchio export, da togliere" } });
    // Il Contributor vede il progetto ma non le task: la task da creare sì, la
    // modifica di una che non vede esce senza argomenti (né id né titolo).
    const forContributor = (await view(contributor, reply.id)).claude!.proposals[0]!;
    expect(forContributor.actions.map((a) => a.fn)).toEqual(["createTask", "updateTask"]);
    expect(forContributor.actions[0]!.args).toMatchObject({ projectId, title: "Export PDF" });
    expect(forContributor.actions[1]!.args).toEqual({});
    expect(JSON.stringify(forContributor)).not.toContain("Vecchio export");
    expect(JSON.stringify(forContributor)).not.toContain(ticketId);
  });

  it("scadono dopo 20 messaggi del thread; in un canale archiviato non si decidono; le azioni della pagina non esistono", async () => {
    const id = idOf(await as(dev, "POST", "/api/chat/channels", { projectId, name: "proposte-cc" }));
    const root = idOf(await post(dev, id, "@Claude crea due task"));
    const reply = await replyIn(root);
    const sid = reply.agentSessionId!;
    const a = (await propose(sid, dev.id, [{ fn: "createTask", args: { projectId, title: "Una", type: "bug" } }])).json() as { proposalId: string };
    const b = (await propose(sid, dev.id, [{ fn: "createTask", args: { projectId, title: "Due", type: "bug" } }])).json() as { proposalId: string };
    const page = await propose(sid, dev.id, [{ fn: "pageAction", args: { action: "openFilters" } }]);
    expect(page.json()).toMatchObject({ status: "refused" });
    for (let i = 0; i < 20; i++) await post(dev, id, `risposta ${i}`, { threadRootId: root });
    expect((await view(dev, reply.id)).claude!.proposals.map((p) => p.status)).toEqual(["expired", "expired", "failed"]);
    expect((await as(dev, "POST", `/api/claude/proposals/${a.proposalId}/confirm`, {})).json()).toMatchObject({ code: "expired" });
    // Un canale archiviato: la scheda non si decide più.
    await t.db.update(claudeProposals).set({ createdAt: new Date() }).where(eq(claudeProposals.id, b.proposalId));
    await t.db.execute(sql`delete from chat_messages where thread_root_id = ${root} and kind = 'person'`);
    await as(dev, "PATCH", `/api/chat/channels/${id}`, { archived: true });
    expect((await as(dev, "POST", `/api/claude/proposals/${b.proposalId}/confirm`, {})).statusCode).toBe(404);
  });
});

describe("fermare, rifare, eliminare, rispondere", () => {
  it("«Stop» solo chi ha chiamato; ferma il turno (la conversazione si archivia)", async () => {
    const g = await general();
    const root = idOf(await post(dev, g, "@Claude lavora"));
    const reply = await replyIn(root);
    expect((await as(lead, "POST", `/api/chat/messages/${reply.id}/claude/stop`)).json()).toMatchObject({ code: "not_yours" });
    const stopped = await as(dev, "POST", `/api/chat/messages/${reply.id}/claude/stop`);
    expect((stopped.json() as Msg).claude).toMatchObject({ state: "stopped", canStop: false });
    const [conv] = await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, reply.agentSessionId!));
    expect(conv!.archivedAt).not.toBeNull();
    expect((await as(dev, "POST", `/api/chat/messages/${reply.id}/claude/stop`)).json()).toMatchObject({ code: "invalid_status" });
  });

  it("«Try again» solo su una fallita, una volta, come risposta nuova", async () => {
    const g = await general();
    const root = idOf(await post(dev, g, "@Claude riprova"));
    const reply = await replyIn(root);
    expect((await as(dev, "POST", `/api/chat/messages/${reply.id}/claude/retry`)).json()).toMatchObject({ code: "invalid_status" });
    await t.db.update(chatMessages).set({ claudeState: "failed", claudeError: "other" }).where(eq(chatMessages.id, reply.id));
    expect((await view(dev, reply.id)).claude).toMatchObject({ canRetry: true });
    expect((await as(lead, "POST", `/api/chat/messages/${reply.id}/claude/retry`)).statusCode).toBe(403);
    const again = await as(dev, "POST", `/api/chat/messages/${reply.id}/claude/retry`);
    expect(again.statusCode, again.body).toBe(201);
    expect(idOf(again)).not.toBe(reply.id);
    expect((await view(dev, idOf(again))).claude).toMatchObject({ state: "working" });
    expect((await view(dev, reply.id)).claude).toMatchObject({ retried: true, canRetry: false });
    expect((await as(dev, "POST", `/api/chat/messages/${reply.id}/claude/retry`)).json()).toMatchObject({ code: "invalid_status" });
  });

  it("la domanda di Claude: in «Da decidere» di chi ha chiamato; risponde solo lui, una volta; la risposta riparte", async () => {
    const g = await general();
    const root = idOf(await post(dev, g, "@Claude assegna la task"));
    const reply = await replyIn(root);
    // Il worker (`ask_question`) scrive la domanda e mette la risposta in attesa.
    const [q] = await t.db
      .insert(chatClaudeQuestions)
      .values({ replyMessageId: reply.id, text: "A chi la assegno?", options: [{ label: "Lead" }, { label: "Dev" }] })
      .returning({ id: chatClaudeQuestions.id });
    await t.db.update(chatMessages).set({ claudeState: "waiting" }).where(eq(chatMessages.id, reply.id));
    expect(((await as(dev, "GET", "/api/chat/claude-questions")).json() as { items: { questionId: string }[] }).items.map((i) => i.questionId)).toEqual([q!.id]);
    expect((await as(lead, "GET", "/api/chat/claude-questions")).json()).toMatchObject({ items: [] });
    // Tutti la leggono nel thread, solo lui può rispondere.
    expect((await view(lead, reply.id)).claude!.question).toMatchObject({ text: "A chi la assegno?", canAnswer: false });
    expect((await view(dev, reply.id)).claude!.question).toMatchObject({ canAnswer: true });
    expect((await as(lead, "POST", `/api/chat/messages/${reply.id}/claude/answer`, { questionId: q!.id, optionIndex: 0 })).statusCode).toBe(403);
    const answered = await as(dev, "POST", `/api/chat/messages/${reply.id}/claude/answer`, { questionId: q!.id, optionIndex: 1 });
    expect(answered.statusCode, answered.body).toBe(200);
    expect((answered.json() as Msg).claude).toMatchObject({ state: "working" });
    const inputs = await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, reply.agentSessionId!));
    expect(inputs.map((i) => i.text)).toContain("Dev");
    expect((await as(dev, "POST", `/api/chat/messages/${reply.id}/claude/answer`, { questionId: q!.id, optionIndex: 0 })).json()).toMatchObject({
      code: "already_answered",
    });
    expect((await as(dev, "GET", "/api/chat/claude-questions")).json()).toMatchObject({ items: [] });
  });

  it("la risposta di Claude la elimina chi l'ha chiamata: si ferma e le sue proposte aperte decadono", async () => {
    const g = await general();
    const root = idOf(await post(dev, g, "@Claude crea una task"));
    const reply = await replyIn(root);
    const p = (await propose(reply.agentSessionId!, dev.id, [{ fn: "createTask", args: { projectId, title: "Tre", type: "bug" } }])).json() as {
      proposalId: string;
    };
    expect((await view(dev, reply.id))).toMatchObject({ claude: { state: "working" } });
    expect((await as(lead, "DELETE", `/api/chat/messages/${reply.id}`)).statusCode).toBe(403);
    expect((await as(dev, "PATCH", `/api/chat/messages/${reply.id}`, { text: "modificata" })).statusCode).toBe(403);
    expect((await as(dev, "DELETE", `/api/chat/messages/${reply.id}`)).statusCode).toBe(204);
    const [row] = await t.db.select().from(chatMessages).where(eq(chatMessages.id, reply.id));
    expect(row).toMatchObject({ claudeState: "stopped", body: "" });
    const [proposal] = await t.db.select().from(claudeProposals).where(eq(claudeProposals.id, p.proposalId));
    expect(proposal!.status).toBe("cancelled");
  });

  it("chi non scrive nel canale non chiama: nessuna risposta, nessuna sessione", async () => {
    const id = idOf(await as(dev, "POST", "/api/chat/channels", { projectId, name: "chiamate-cc" }));
    const before = (await t.db.select().from(agentSessions).where(eq(agentSessions.kind, "chat_mention"))).length;
    expect((await post(lead, id, "@Claude ci sei?")).statusCode).toBe(403);
    expect((await post(outsider, id, "@Claude ci sei?")).statusCode).toBe(404);
    expect((await t.db.select().from(agentSessions).where(eq(agentSessions.kind, "chat_mention"))).length).toBe(before);
  });
});
