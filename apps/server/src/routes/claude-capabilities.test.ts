import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleAccounts, googleWorkspaces, issueChatToolToken, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { GMAIL_MODIFY_SCOPE } from "@stubwise/google";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

// Area 10, F7 (S0, F7-1 = a): ciò che Claude sa fare per chi chiede, dalle
// firme vere (mai il ruolo). Una capacità c'è solo se la sua azione passerebbe
// in almeno un posto; solo id, nessun dato di un progetto.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let seeded: SeededUsers;
let projectId: string;
let workspaceId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  seeded = await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "Acme", domains: ["acme.test"], clientId: "c", clientSecretEncrypted: "x" }).returning();
  workspaceId = ws!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

let n = 0;
async function person(preset?: string): Promise<U> {
  const u = await createUserWithSession(app, `cap-${++n}@example.com`);
  if (preset) await addMember(app, projectId, u.id, preset);
  return u;
}
async function mailbox(userId: string, opts: { scopes?: string[]; disabled?: boolean } = {}) {
  await t.db.insert(googleAccounts).values({
    userId,
    workspaceId,
    email: `box-${++n}@acme.test`,
    googleSub: `sub-${n}`,
    refreshTokenEncrypted: "x",
    scopes: opts.scopes ?? [GMAIL_MODIFY_SCOPE],
    ...(opts.disabled ? { disabledAt: new Date() } : {}),
  });
}
const capabilities = async (cookie: string) => {
  const res = await app.inject({ method: "GET", url: "/api/claude/capabilities", headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: string[] };
};

describe("GET /api/claude/capabilities", () => {
  it("permessi diversi, elenchi diversi; ogni capacità ha il caso in cui manca", async () => {
    // Nessun progetto: resta il lavoro fermo (Claude legge ciò che la persona vede).
    expect((await capabilities((await person()).headers.cookie)).items).toEqual(["stalled"]);
    // Contributor: niente spesa, niente scritture del catalogo.
    expect((await capabilities((await person("contributor")).headers.cookie)).items).toEqual(["stalled"]);
    // Viewer: la spesa del progetto (`project.usage.view`), nient'altro.
    expect((await capabilities((await person("viewer")).headers.cookie)).items).toEqual(["stalled", "spend"]);
    // Developer: `tickets.edit` (descrizione e note), senza automazioni, archivio e membri.
    expect((await capabilities((await person("developer")).headers.cookie)).items).toEqual(["stalled", "spend", "releaseNotes", "taskDescription"]);
    // Project Lead: tutto ciò che è del progetto; la posta no (non ha una casella).
    expect((await capabilities((await person("project_lead")).headers.cookie)).items).toEqual(["automation", "stalled", "spend", "archive", "addMember", "releaseNotes", "taskDescription"]);
  });

  it("la posta: solo con una casella di chi chiede, viva e con gmail.modify", async () => {
    const live = await person();
    await mailbox(live.id);
    expect((await capabilities(live.headers.cookie)).items).toEqual(["stalled", "mailBody"]);
    const off = await person();
    await mailbox(off.id, { disabled: true });
    expect((await capabilities(off.headers.cookie)).items).toEqual(["stalled"]);
    const readOnly = await person();
    await mailbox(readOnly.id, { scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
    expect((await capabilities(readOnly.headers.cookie)).items).toEqual(["stalled"]);
  });

  it("un full admin le riceve tutte (la posta con la sua casella); solo id, nessun dato di un progetto", async () => {
    const before = await capabilities(seeded.adminCookie);
    expect(before.items).toEqual(["automation", "stalled", "spend", "archive", "addMember", "releaseNotes", "taskDescription"]);
    await mailbox(seeded.adminId);
    const after = await capabilities(seeded.adminCookie);
    expect(after).toEqual({ items: ["automation", "stalled", "spend", "archive", "addMember", "releaseNotes", "mailBody", "taskDescription"] });
    expect(JSON.stringify(after)).not.toContain(projectId);
  });

  it("col token del turno risponde per l'autore della conversazione", async () => {
    const lead = await person("project_lead");
    const conv = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: lead.headers.cookie }, payload: {} });
    const token = await issueChatToolToken(t.db, { sessionId: (conv.json() as { id: string }).id, userId: lead.id, ttlMs: 60_000 });
    const res = await app.inject({ method: "GET", url: "/api/claude/capabilities", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: string[] }).items).toContain("addMember");
    expect((await t.db.select().from(users).where(eq(users.id, lead.id))).length).toBe(1);
  });
});
