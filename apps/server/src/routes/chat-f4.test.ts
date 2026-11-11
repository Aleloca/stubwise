import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { chatChannels, milestones, projectStatuses, ticketRepositories, tickets } from "@stubwise/db";
import { seedBacklogItem, seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Chat, area 4 fetta 4: gli eventi dei progetti nei canali (la scheda derivata
// a lettura, con le regole di chi vede) e `setPublishedEvents`.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let repositoryId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let contributor: U;
let closedStatus: string;
let ticketNumber = 500;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-f4@example.com");
  dev = await createUserWithSession(app, "dev-f4@example.com");
  contributor = await createUserWithSession(app, "contributor-f4@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, contributor.id, "contributor");
  const statuses = await t.db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId)).orderBy(asc(projectStatuses.position));
  closedStatus = statuses.find((s) => s.family === "closed")!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (u: U, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

type Ev = {
  kind: string;
  ref: { kind: string; id: string };
  object: { label: string; title: string | null; visible: boolean; projectId: string | null } | null;
  pr: { number: number | null; url: string | null; repository: string } | null;
};
type Msg = { id: string; kind: string; text: string; event: Ev | null };

async function general(): Promise<string> {
  const [row] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  return row!.id;
}
async function events(u: U, channelId: string): Promise<Msg[]> {
  const res = await as(u, "GET", `/api/chat/channels/${channelId}/messages?limit=200`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: Msg[] }).items.filter((m) => m.kind === "system");
}
async function channelWithAll(name: string): Promise<string> {
  const res = await as(dev, "POST", "/api/chat/channels", { projectId, name });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  const put = await as(dev, "PUT", `/api/chat/channels/${id}/events`, {
    events: ["task_closed", "request_new", "pr_opened", "pr_merged", "milestone_reached", "brief_ready", "release_page"],
  });
  expect(put.statusCode, put.body).toBe(200);
  for (const u of [lead, contributor]) await as(u, "POST", `/api/chat/channels/${id}/join`);
  return id;
}
async function newTicket(title: string): Promise<string> {
  const { ticketId } = await seedTicket(t.db, { projectId, repositoryId, number: ++ticketNumber });
  await t.db.update(tickets).set({ title }).where(eq(tickets.id, ticketId));
  return ticketId;
}

describe("gli eventi dei progetti nei canali", () => {
  it("una task chiusa: chi vede la task legge codice e titolo, chi non la vede il solo codice", async () => {
    const ch = await channelWithAll("eventi-task");
    const id = await newTicket("Export PDF");
    await t.db.update(tickets).set({ statusId: closedStatus }).where(eq(tickets.id, id));
    const [forLead] = (await events(lead, ch)).filter((m) => m.event?.ref.id === id);
    expect(forLead).toMatchObject({ text: "", event: { kind: "task_closed", ref: { kind: "task", id }, object: { title: "Export PDF", visible: true, projectId } } });
    expect(forLead!.event!.object!.label).toMatch(/-\d+$/);
    const [forContributor] = (await events(contributor, ch)).filter((m) => m.event?.ref.id === id);
    expect(forContributor!.event!.object).toEqual({ label: forLead!.event!.object!.label, title: null, visible: false, projectId });
    expect(JSON.stringify(forContributor)).not.toContain("Export PDF");
    // Il «general» non pubblica task_closed.
    expect((await events(lead, await general())).some((m) => m.event?.ref.id === id)).toBe(false);
  });

  it("una task che non c'è più: la scheda mostra solo il tipo dell'evento", async () => {
    const ch = await channelWithAll("eventi-gone");
    const id = await newTicket("Da togliere");
    await t.db.update(tickets).set({ statusId: closedStatus }).where(eq(tickets.id, id));
    await t.db.delete(tickets).where(eq(tickets.id, id));
    const [m] = (await events(lead, ch)).filter((e) => e.event?.ref.id === id);
    expect(m!.event).toMatchObject({ kind: "task_closed", object: null, pr: null });
  });

  it("una richiesta nuova, un traguardo e la PR: le schede con l'oggetto, la PR solo a chi vede la task", async () => {
    const ch = await channelWithAll("eventi-vari");
    const { itemId } = await seedBacklogItem(t.db, { projectId, title: "Esportare i report" });
    const [ms] = await t.db.insert(milestones).values({ projectId, name: "Beta pubblica" }).returning({ id: milestones.id });
    await t.db.update(milestones).set({ status: "closed", closedAt: new Date() }).where(eq(milestones.id, ms!.id));
    const id = await newTicket("Con la PR");
    const [tr] = await t.db.insert(ticketRepositories).values({ ticketId: id, repositoryId, branch: "stubwise/x" }).returning({ id: ticketRepositories.id });
    await t.db.update(ticketRepositories).set({ prUrl: "https://github.com/o/r/pull/12", prNumber: 12 }).where(eq(ticketRepositories.id, tr!.id));

    const forLead = await events(lead, ch);
    const request = forLead.find((m) => m.event?.ref.id === itemId)!;
    expect(request.event).toMatchObject({ kind: "request_new", object: { title: "Esportare i report", visible: true } });
    expect(request.event!.object!.label).toMatch(/-R\d+$/);
    expect(forLead.find((m) => m.event?.ref.id === ms!.id)!.event).toMatchObject({
      kind: "milestone_reached",
      object: { label: "Beta pubblica", visible: true, projectId },
    });
    const pr = forLead.find((m) => m.event?.kind === "pr_opened" && m.event.ref.id === id)!;
    expect(pr.event).toMatchObject({ object: { title: "Con la PR", visible: true }, pr: { number: 12, url: "https://github.com/o/r/pull/12" } });
    expect(pr.event!.pr!.repository.length).toBeGreaterThan(0);

    const forContributor = await events(contributor, ch);
    const prHidden = forContributor.find((m) => m.event?.kind === "pr_opened" && m.event.ref.id === id)!;
    expect(prHidden.event).toMatchObject({ object: { title: null, visible: false }, pr: null });
    expect(JSON.stringify(prHidden)).not.toContain("pull/12");
  });

  it("un brief pronto nel «general», di default", async () => {
    const { projectBriefs } = await import("@stubwise/db");
    const [b] = await t.db.insert(projectBriefs).values({ projectId, periodStart: "2026-11-02", periodEnd: "2026-11-08" }).returning({ id: projectBriefs.id });
    await t.db.update(projectBriefs).set({ status: "done", summary: "# Brief" }).where(eq(projectBriefs.id, b!.id));
    const m = (await events(contributor, await general())).find((e) => e.event?.ref.id === b!.id)!;
    expect(m.event).toMatchObject({ kind: "brief_ready", object: { label: "2026-11-02/2026-11-08", visible: true } });
  });
});

describe("setPublishedEvents", () => {
  it("il creatore o chi gestisce, su un canale di progetto vivo; l'elenco si scrive in ordine canonico", async () => {
    const res = await as(dev, "POST", "/api/chat/channels", { projectId, name: "eventi-scelti" });
    const id = (res.json() as { id: string }).id;
    const put = await as(dev, "PUT", `/api/chat/channels/${id}/events`, { events: ["task_closed", "pr_opened", "task_closed"] });
    expect(put.statusCode, put.body).toBe(200);
    expect((put.json() as { publishedEvents: string[] }).publishedEvents).toEqual(["pr_opened", "task_closed"]);
    // Chi gestisce i canali del progetto (il Lead) anche se non l'ha creato.
    const byLead = await as(lead, "PUT", `/api/chat/channels/${id}/events`, { events: [] });
    expect(byLead.statusCode, byLead.body).toBe(200);
    expect((byLead.json() as { publishedEvents: string[] }).publishedEvents).toEqual([]);
    // Un membro qualunque no.
    await as(contributor, "POST", `/api/chat/channels/${id}/join`);
    const byContributor = await as(contributor, "PUT", `/api/chat/channels/${id}/events`, { events: ["task_closed"] });
    expect(byContributor.statusCode).toBe(403);
    // Un evento fuori elenco: 400.
    expect((await as(dev, "PUT", `/api/chat/channels/${id}/events`, { events: ["deploy"] })).statusCode).toBe(400);
    // Archiviato: nessuno.
    await as(dev, "PATCH", `/api/chat/channels/${id}`, { archived: true });
    expect((await as(dev, "PUT", `/api/chat/channels/${id}/events`, { events: ["task_closed"] })).statusCode).toBe(403);
    const [row] = await t.db.select({ e: chatChannels.publishedEvents }).from(chatChannels).where(eq(chatChannels.id, id));
    expect(row!.e).toEqual([]);
  });

  it("non su un canale generale né su un DM; un canale che non vede: 404", async () => {
    const g = await as(lead, "POST", "/api/chat/channels", { projectId: null, name: "annunci-f4" });
    expect(g.statusCode, g.body).toBe(201);
    expect((await as(lead, "PUT", `/api/chat/channels/${(g.json() as { id: string }).id}/events`, { events: ["task_closed"] })).statusCode).toBe(403);
    const dm = await as(lead, "POST", "/api/chat/dm", { personIds: [dev.id] });
    expect((await as(lead, "PUT", `/api/chat/channels/${(dm.json() as { id: string }).id}/events`, { events: [] })).statusCode).toBe(403);
    const priv = await as(dev, "POST", "/api/chat/channels", { projectId, name: "segreto-f4", visibility: "private" });
    const pid = (priv.json() as { id: string }).id;
    expect((await as(contributor, "PUT", `/api/chat/channels/${pid}/events`, { events: [] })).statusCode).toBe(404);
  });
});
