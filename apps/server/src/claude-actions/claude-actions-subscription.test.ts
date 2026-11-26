import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { alertSubscriptions, issueChatToolToken, projects } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 8, F2, S7: `setSubscription`, l'iscrizione di CHI CHIEDE a un tipo
// d'avviso. A (nessun altro è avvisato), parte subito con «Annulla», che
// riscrive i valori di prima; le stesse regole della rotta delle Preferenze
// (obbligatori e sospesi non si toccano, un progetto che non si vede non c'è).

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let hiddenProjectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let author: U;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ({ projectId: hiddenProjectId } = await seedRepository(t.db));
  author = await createUserWithSession(app, "author-sub@example.com");
  // Un Contributor: membro, ma senza repos.view (le righe delle PR con permesso sono sospese).
  await addMember(app, projectId, author.id, "contributor");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversation(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: author.headers.cookie }, payload: {} });
  return (res.json() as { id: string }).id;
}
const propose = async (actions: unknown[]) => {
  const sid = await conversation();
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: author.id, ttlMs: 60_000 });
  const res = await app.inject({
    method: "POST",
    url: `/api/claude/conversations/${sid}/proposals`,
    headers: { authorization: `Bearer ${tok}` },
    payload: { toolUseId: `tu-sub-${++n}`, actions },
  });
  return { sid, res };
};
const asAuthor = (method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { cookie: author.headers.cookie }, ...(payload ? { payload } : {}) });

async function savedOf(type: string): Promise<boolean> {
  const { items } = (await asAuthor("GET", "/api/me/alert-subscriptions")).json() as {
    items: { projectId: string; rows: { type: string; saved: boolean }[] }[];
  };
  return items.find((p) => p.projectId === projectId)!.rows.find((r) => r.type === type)!.saved;
}
async function rowOf(type: string): Promise<{ app: boolean; phone: boolean; state: string }> {
  const { items: list } = (await asAuthor("GET", "/api/me/alert-subscriptions")).json() as {
    items: { projectId: string; rows: { type: string; app: boolean; phone: boolean; state: string }[] }[];
  };
  const row = list.find((p) => p.projectId === projectId)!.rows.find((r) => r.type === type)!;
  return { app: row.app, phone: row.phone, state: row.state };
}
async function groupOf(sid: string) {
  const [group] = (await asAuthor("GET", `/api/claude/conversations/${sid}/groups`)).json() as {
    id: string;
    undo: string;
    changedBy: string | null;
    actions: { fn: string; args: Record<string, unknown> }[];
  }[];
  return group!;
}

describe("setSubscription (A)", () => {
  it("review F2 (46), 5: «Annulla» su una riga senza scelta salvata la riporta al DEFAULT (nessuna riga), non a un valore fissato", async () => {
    expect(await savedOf("docs.release_note")).toBe(false);
    const { sid, res } = await propose([{ fn: "setSubscription", args: { projectId, type: "docs.release_note", app: true } }]);
    expect(res.json()).toMatchObject({ status: "executed" });
    expect(await savedOf("docs.release_note")).toBe(true);
    const group = await groupOf(sid);
    expect((await asAuthor("POST", `/api/claude/groups/${group.id}/undo`)).json()).toEqual({ kind: "undone" });
    expect(await savedOf("docs.release_note")).toBe(false);
    const rows = await t.db
      .select()
      .from(alertSubscriptions)
      .where(and(eq(alertSubscriptions.userId, author.id), eq(alertSubscriptions.projectId, projectId), eq(alertSubscriptions.alertType, "docs.release_note")));
    expect(rows).toEqual([]);
  });

  it("review F2 (46), A: {phone:true} su una riga spenta accende anche l'App", async () => {
    const { res } = await propose([{ fn: "setSubscription", args: { projectId, type: "release.succeeded", phone: true } }]);
    expect(res.json()).toMatchObject({ status: "executed" });
    expect(await rowOf("release.succeeded")).toEqual({ app: true, phone: true, state: "on" });
  });

  it("review F2 (46), 5: riportata al default dalle Preferenze DOPO l'azione, «Annulla» è changed_after", async () => {
    const { sid } = await propose([{ fn: "setSubscription", args: { projectId, type: "pr.opened", app: true } }]);
    const del = await app.inject({ method: "DELETE", url: `/api/me/alert-subscriptions/${projectId}/pr.opened`, headers: { cookie: author.headers.cookie } });
    expect(del.statusCode, del.body).toBe(200);
    expect(await groupOf(sid)).toMatchObject({ undo: "changed_after" });
  });

  it("parte subito, scrive SOLO l'iscrizione di chi chiede; «Annulla» riscrive i valori di prima", async () => {
    expect(await rowOf("pr.opened")).toEqual({ app: false, phone: false, state: "off" });
    const { sid, res } = await propose([{ fn: "setSubscription", args: { projectId, type: "pr.opened", app: true } }]);
    expect(res.json()).toMatchObject({ status: "executed" });
    expect(await rowOf("pr.opened")).toEqual({ app: true, phone: false, state: "on" });
    const rows = await t.db.select().from(alertSubscriptions).where(eq(alertSubscriptions.projectId, projectId));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([author.id]));

    const group = await groupOf(sid);
    expect(group.undo).toBe("available");
    expect(group.actions[0]).toMatchObject({ fn: "setSubscription", args: { projectId, type: "pr.opened", app: true } });
    expect((await asAuthor("POST", `/api/claude/groups/${group.id}/undo`)).json()).toEqual({ kind: "undone" });
    expect(await rowOf("pr.opened")).toEqual({ app: false, phone: false, state: "off" });
  });

  it("la riga dei server scrive anche i kind di prima che vi confluiscono (come le Preferenze)", async () => {
    const { res } = await propose([{ fn: "setSubscription", args: { projectId, type: "server.trouble", app: false } }]);
    expect(res.json()).toMatchObject({ status: "executed" });
    const rows = await t.db
      .select({ type: alertSubscriptions.alertType, app: alertSubscriptions.app })
      .from(alertSubscriptions)
      .where(and(eq(alertSubscriptions.userId, author.id), eq(alertSubscriptions.projectId, projectId)));
    const off = rows.filter((r) => !r.app).map((r) => r.type);
    expect(off).toEqual(expect.arrayContaining(["server.trouble", "monitor.alert", "monitor.recovered"]));
  });

  it("cambiata dopo dalle Preferenze: «Annulla» è changed_after, da chi chiede", async () => {
    const { sid } = await propose([{ fn: "setSubscription", args: { projectId, type: "release.merged", app: true } }]);
    await new Promise((r) => setTimeout(r, 20));
    const put = await asAuthor("PUT", `/api/me/alert-subscriptions/${projectId}/release.merged`, { phone: true });
    expect(put.statusCode, put.body).toBe(200);
    const group = await groupOf(sid);
    expect(group).toMatchObject({ undo: "changed_after", changedBy: author.id });
    expect((await asAuthor("POST", `/api/claude/groups/${group.id}/undo`)).json()).toMatchObject({ code: "changed_after" });
    expect(await rowOf("release.merged")).toEqual({ app: true, phone: true, state: "on" });
  });

  it("un tipo solo obbligatorio o sospeso, o un progetto che non si vede: rifiutata, niente scritto", async () => {
    const before = await t.db.select().from(alertSubscriptions).where(eq(alertSubscriptions.userId, author.id));
    // pr.corrected è solo obbligatorio; pr.analysis_issues vuole repos.view (sospesa per un Contributor).
    for (const args of [
      { projectId, type: "pr.corrected", app: true },
      { projectId, type: "pr.analysis_issues", app: true },
      { projectId: hiddenProjectId, type: "pr.opened", app: true },
    ]) {
      const { res } = await propose([{ fn: "setSubscription", args }]);
      expect(res.json(), JSON.stringify(args)).toMatchObject({ status: "refused" });
    }
    expect(await t.db.select().from(alertSubscriptions).where(eq(alertSubscriptions.userId, author.id))).toEqual(before);
    // Il progetto nascosto esiste davvero (il rifiuto non è per un id a caso).
    expect(await t.db.select({ id: projects.id }).from(projects).where(eq(projects.id, hiddenProjectId))).toHaveLength(1);
  });
});
