import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issueChatToolToken, notifications, projectStatuses, roles, tickets, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { inboxItemSchema, readerSchema, taskActivityEntryViewSchema, ticketCommentSchema } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// «via Claude» DERIVATO A LETTURA (chat, fetta 3): le scritture portano la
// colonna `via_claude_action_id`; le letture ne derivano `viaClaude`, l'id
// dell'azione e chi l'ha chiesta (dal gruppo), senza toccare il jsonb delle
// notifiche — vale anche per le righe scritte prima.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let author: U;
let other: U;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  author = await createUserWithSession(app, "author-via@example.com");
  other = await createUserWithSession(app, "other-via@example.com");
  await addMember(app, projectId, author.id, "legacy_member");
  await addMember(app, projectId, other.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversation(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: author.headers.cookie }, payload: {} });
  return (res.json() as { id: string }).id;
}
async function task() {
  n += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { cookie: author.headers.cookie },
    payload: { projectId, title: `Via ${n}`, type: "bug" },
  });
  return res.json() as { id: string; code: string };
}
/** Una B proposta e confermata dall'autore. */
async function viaClaude(actions: unknown[]) {
  const sid = await conversation();
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: author.id, ttlMs: 60_000 });
  const res = await app.inject({
    method: "POST",
    url: `/api/claude/conversations/${sid}/proposals`,
    headers: { authorization: `Bearer ${tok}` },
    payload: { toolUseId: `tu-${++n}`, actions },
  });
  expect(res.json(), res.body).toMatchObject({ status: "awaiting_confirmation" });
  const proposalId = (res.json() as { proposalId: string }).proposalId;
  const ok = await app.inject({ method: "POST", url: `/api/claude/proposals/${proposalId}/confirm`, headers: { cookie: author.headers.cookie }, payload: {} });
  expect(ok.statusCode, ok.body).toBe(200);
}

type Comment = { body: string; viaClaude: boolean; viaClaudeActionId: string | null; viaClaudeRequesterId: string | null };

describe("commenti", () => {
  it("un commento scritto da Claude porta viaClaude, l'azione e chi l'ha chiesto; uno a mano no", async () => {
    const tk = await task();
    await viaClaude([{ fn: "addComment", args: { taskId: tk.id, body: "Scritto da Claude" } }]);
    await app.inject({ method: "POST", url: `/api/tickets/${tk.id}/comments`, headers: { cookie: author.headers.cookie }, payload: { body: "Scritto a mano" } });
    const list = (await app.inject({ method: "GET", url: `/api/tickets/${tk.id}/comments`, headers: { cookie: author.headers.cookie } })).json() as Comment[];
    const byClaude = list.find((c) => c.body === "Scritto da Claude")!;
    const byHand = list.find((c) => c.body === "Scritto a mano")!;
    expect(byClaude).toMatchObject({ viaClaude: true, viaClaudeRequesterId: author.id });
    expect(byClaude.viaClaudeActionId).toEqual(expect.any(String));
    expect(byHand).toMatchObject({ viaClaude: false, viaClaudeActionId: null, viaClaudeRequesterId: null });
  });
});

describe("registro della task", () => {
  it("cambio di campo e commento via Claude portano il segno e il richiedente; quelli a mano no", async () => {
    const tk = await task();
    await viaClaude([
      { fn: "addComment", args: { taskId: tk.id, body: "Nota di Claude" } },
      { fn: "updateTask", args: { id: tk.id, patch: { assigneeId: other.id } } },
    ]);
    await app.inject({ method: "PATCH", url: `/api/tasks/${tk.id}`, headers: { cookie: author.headers.cookie }, payload: { title: "A mano" } });
    const entries = (await app.inject({ method: "GET", url: `/api/tasks/${tk.id}/activity`, headers: { cookie: author.headers.cookie } })).json() as {
      kind: string;
      field?: string;
      body?: string;
      viaClaude: boolean;
      viaClaudeActionId: string | null;
      viaClaudeRequesterId: string | null;
    }[];
    const comment = entries.find((e) => e.kind === "comment" && e.body === "Nota di Claude")!;
    const assignee = entries.find((e) => e.field === "assignee")!;
    const title = entries.find((e) => e.field === "title")!;
    expect(comment).toMatchObject({ viaClaude: true, viaClaudeRequesterId: author.id });
    expect(assignee).toMatchObject({ viaClaude: true, viaClaudeRequesterId: author.id });
    expect(assignee.viaClaudeActionId).not.toBe(comment.viaClaudeActionId);
    expect(title).toMatchObject({ viaClaude: false, viaClaudeActionId: null, viaClaudeRequesterId: null });
  });
});

describe("attività per persona (By person)", () => {
  it("uno spostamento e un commento via Claude portano viaClaude nella riga di chi l'ha chiesto", async () => {
    const [role] = await t.db
      .insert(roles)
      .values({ name: "Standup via", scope: "instance", permissions: ["users.view_all", "people.activity.view"] })
      .returning({ id: roles.id });
    await t.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, other.id));
    const tk = await task();
    const [current] = await t.db.select({ statusId: tickets.statusId }).from(tickets).where(eq(tickets.id, tk.id));
    const status = (await t.db.select({ id: projectStatuses.id }).from(projectStatuses).where(eq(projectStatuses.projectId, projectId))).find(
      (s) => s.id !== current!.statusId,
    );
    await viaClaude([
      { fn: "addComment", args: { taskId: tk.id, body: "Commento per persona" } },
      { fn: "updateTask", args: { id: tk.id, patch: { statusId: status!.id } } },
    ]);
    await app.inject({ method: "POST", url: `/api/tickets/${tk.id}/comments`, headers: { cookie: author.headers.cookie }, payload: { body: "Commento a mano" } });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date());
    const res = await app.inject({ method: "GET", url: `/api/people/activity?date=${day}`, headers: { cookie: other.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const mine = (res.json() as { personId: string | null; comments: { body: string; viaClaude: boolean }[]; tasksMoved: { taskId: string; viaClaude: boolean }[] }[]).find(
      (r) => r.personId === author.id,
    )!;
    expect(mine.comments.find((c) => c.body === "Commento per persona")).toMatchObject({ viaClaude: true });
    expect(mine.comments.find((c) => c.body === "Commento a mano")).toMatchObject({ viaClaude: false });
    expect(mine.tasksMoved.find((m) => m.taskId === tk.id)).toMatchObject({ viaClaude: true });
  });
});

describe("inbox", () => {
  it("la card di chi riceve un'assegnazione via Claude porta il segno e il richiedente; il jsonb resta com'era", async () => {
    const tk = await task();
    await viaClaude([{ fn: "updateTask", args: { id: tk.id, patch: { assigneeId: other.id } } }]);
    const page = (await app.inject({ method: "GET", url: "/api/inbox", headers: { cookie: other.headers.cookie } })).json() as {
      items: { id: string; ticketId: string | null; viaClaude: boolean; viaClaudeActionId: string | null; viaClaudeRequesterId: string | null }[];
    };
    const card = page.items.find((i) => i.ticketId === tk.id)!;
    expect(card).toMatchObject({ viaClaude: true, viaClaudeRequesterId: author.id });
    expect(card.viaClaudeActionId).toEqual(expect.any(String));
    const [row] = await t.db.select().from(notifications).where(eq(notifications.id, card.id));
    expect(row!.event).not.toHaveProperty("viaClaude");
  });

  it("una card senza azione di Claude: viaClaude false e i due id nulli", async () => {
    const tk = await task();
    await app.inject({ method: "PATCH", url: `/api/tasks/${tk.id}`, headers: { cookie: author.headers.cookie }, payload: { assigneeId: other.id } });
    const page = (await app.inject({ method: "GET", url: "/api/inbox", headers: { cookie: other.headers.cookie } })).json() as {
      items: { ticketId: string | null; viaClaude: boolean; viaClaudeActionId: string | null; viaClaudeRequesterId: string | null }[];
    };
    const card = page.items.find((i) => i.ticketId === tk.id);
    expect(card, "la PATCH a mano deve avvisare l'assegnatario").toBeDefined();
    expect(card).toMatchObject({ viaClaude: false, viaClaudeActionId: null, viaClaudeRequesterId: null });
  });
});

describe("schemi: una risposta SENZA i campi nuovi si legge (server vecchio)", () => {
  it("commento", () => {
    const c = readerSchema(ticketCommentSchema).parse({
      id: "11111111-1111-4111-8111-111111111111",
      ticketId: "22222222-2222-4222-8222-222222222222",
      authorType: "user",
      authorId: null,
      body: "x",
      createdAt: "2026-11-10T10:00:00.000Z",
    });
    expect(c).toMatchObject({ viaClaude: false, viaClaudeActionId: null, viaClaudeRequesterId: null });
  });

  it("voce del registro", () => {
    const e = readerSchema(taskActivityEntryViewSchema).parse({
      id: "x",
      taskId: "22222222-2222-4222-8222-222222222222",
      kind: "comment",
      authorId: null,
      at: "2026-11-10T10:00:00.000Z",
    });
    expect(e).toMatchObject({ viaClaude: false, viaClaudeActionId: null, viaClaudeRequesterId: null });
  });

  it("card di inbox", async () => {
    const page = (await app.inject({ method: "GET", url: "/api/inbox", headers: { cookie: other.headers.cookie } })).json() as {
      items: Record<string, unknown>[];
    };
    const old = { ...page.items[0]! };
    delete old.viaClaude;
    delete old.viaClaudeActionId;
    delete old.viaClaudeRequesterId;
    const parsed = readerSchema(inboxItemSchema).parse(old);
    expect(parsed).toMatchObject({ viaClaude: false, viaClaudeActionId: null, viaClaudeRequesterId: null });
  });
});
