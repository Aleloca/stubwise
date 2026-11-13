import { randomUUID } from "node:crypto";
import { calendarEvents, emailMessages, emailProposalRecipients, emailProposals, googleAccounts, googleWorkspaces, meetingNotes, projects, tickets, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * LE RIUNIONI REGISTRATE IN LETTURA (area 6, F5a, task 4): l'eccezione
 * dichiarata a «Posta e Calendario personali». La vedono TUTTI gli invitati
 * di Stubwise (anche senza l'evento nel loro calendario, anche senza aver
 * ricevuto l'email); MAI un membro che non c'era, MAI un admin non invitato,
 * MAI un invitato tolto da Google. I NEGATIVI sono il punto: 404 sulle
 * rotte, `visible: false` sul messaggio inoltrato, nessuna proposta.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 6).toString("base64"), mailClassifyV2: true });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

let ws: string | null = null;
async function person() {
  const email = `p-${randomUUID().slice(0, 8)}@acme.com`;
  const user = await createUserWithSession(app, email);
  if (!ws) ws = (await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "x" }).returning())[0]!.id;
  const [box] = await db.insert(googleAccounts).values({ userId: user.id, workspaceId: ws, email, googleSub: randomUUID(), refreshTokenEncrypted: "x" }).returning();
  return { ...user, email, accountId: box!.id };
}

async function scenario() {
  // Ada organizza e ha ricevuto l'email; Bruno è invitato ma NON ha ricevuto l'email né ha l'evento nel suo calendario;
  // Carla ha ricevuto l'email INOLTRATA ma non era invitata; Dario è membro del progetto e non c'era.
  const ada = await person();
  const bruno = await person();
  const carla = await person();
  const dario = await person();
  const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  const [p] = await db.insert(projects).values({ name: "Audin", code, slug: `aud-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  for (const u of [ada, bruno, carla, dario]) await addMember(app, p!.id, u.id);
  const uid = `uid-${randomUUID()}@google.com`;
  const startsAt = new Date(Date.now() - 3 * 3600_000);
  const [adaRow] = await db
    .insert(calendarEvents)
    .values({ accountId: ada.accountId, googleEventId: randomUUID(), title: "Revisione", startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), fingerprint: "f", icalUid: uid, organizer: ada.email, organizerSelf: true, projectId: p!.id, projectBy: "manual", attendees: [{ email: bruno.email, responseStatus: "declined" }] })
    .returning();
  const rfc = `<${randomUUID()}@google.com>`;
  const message = async (accountId: string) =>
    (await db.insert(emailMessages).values({ accountId, gmailMessageId: randomUUID(), threadId: `t-${randomUUID()}`, fromAddress: "gemini-notes@google.com", toAddresses: [ada.email], subject: "Notes: “Revisione”", receivedAt: new Date(), kind: "transcript", rfcMessageId: rfc, admitted: true, textExcerpt: "Le note sono pronte" }).returning())[0]!;
  const adaCopy = await message(ada.accountId);
  const carlaCopy = await message(carla.accountId);
  const [note] = await db.insert(meetingNotes).values({ docFileId: `doc${randomUUID().replace(/-/g, "")}`, sourceMessageId: adaCopy.id, rfcMessageId: rfc, icalUid: uid, eventStartsAt: startsAt, eventTitle: "Revisione", docTitle: "Notes – Revisione", docStatus: "ready", summary: "Si rilascia venerdì.", projectId: p!.id }).returning();
  const [proposal] = await db
    .insert(emailProposals)
    .values({ emailMessageId: adaCopy.id, projectId: p!.id, rfcMessageId: `meeting:${note!.docFileId}`, audience: "meeting_invitees", meetingNoteId: note!.id, status: "proposed", classification: { version: 2, summary: "Si rilascia venerdì.", actions: [{ type: "create_task", args: { title: "Export", description: "", assigneeId: null, dueDate: null } }] } })
    .returning();
  for (const u of [ada, bruno]) await db.insert(emailProposalRecipients).values({ proposalId: proposal!.id, userId: u.id });
  return { code, ada, bruno, carla, dario, projectId: p!.id, note: note!, proposal: proposal!, adaRow: adaRow!, adaCopy, carlaCopy, uid };
}

const get = (headers: { cookie: string }, url: string) => app.inject({ method: "GET", url, headers });

describe("il riassunto di una riunione", () => {
  it("un invitato SENZA l'evento nel suo calendario (e senza l'email) lo legge da /api/me/meetings; un membro che non c'era, un admin non invitato, chi ha solo l'email inoltrata: 404", async () => {
    const s = await scenario();
    const bruno = await get(s.bruno.headers, `/api/me/meetings/${s.note.id}`);
    expect(bruno.statusCode).toBe(200);
    expect(bruno.json()).toMatchObject({ noteId: s.note.id, eventId: null, summary: "Si rilascia venerdì.", docUrl: `https://docs.google.com/document/d/${s.note.docFileId}`, email: null });
    for (const outsider of [s.dario.headers, s.carla.headers, { cookie: adminCookie }]) {
      const res = await get(outsider, `/api/me/meetings/${s.note.id}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("rilascia");
    }
  });

  it("dall'evento del proprio calendario: /calendar/events/:id/summary con l'evento e la propria copia dell'email", async () => {
    const s = await scenario();
    const res = await get(s.ada.headers, `/api/me/calendar/events/${s.adaRow.id}/summary`);
    expect(res.json()).toMatchObject({ eventId: s.adaRow.id, email: { threadId: s.adaCopy.threadId, accountId: s.ada.accountId, messageId: s.adaCopy.id } });
  });

  it("un invitato TOLTO da Google non legge più (il giro dopo del poller)", async () => {
    const s = await scenario();
    await db.update(calendarEvents).set({ attendees: [], updatedAt: new Date() }).where(eq(calendarEvents.id, s.adaRow.id));
    expect((await get(s.bruno.headers, `/api/me/meetings/${s.note.id}`)).statusCode).toBe(404);
  });
});

describe("il messaggio di Gemini nella conversazione", () => {
  it("a chi c'era la riunione intera; sull'email INOLTRATA a chi non c'era `visible: false` e nient'altro", async () => {
    const s = await scenario();
    const thread = async (who: typeof s.ada, copy: typeof s.adaCopy) =>
      (await get(who.headers, `/api/me/mail/threads/${encodeURIComponent(copy.threadId)}?account=${who.accountId}`)).json() as { messages: { kind: string; meeting: Record<string, unknown> | null }[] };
    const mine = await thread(s.ada, s.adaCopy);
    expect(mine.messages[0]).toMatchObject({ kind: "transcript", meeting: { noteId: s.note.id, visible: true, summary: "Si rilascia venerdì.", docTitle: "Notes – Revisione", doc: "ready", event: { id: s.adaRow.id } } });
    const forwarded = await thread(s.carla, s.carlaCopy);
    expect(forwarded.messages[0]!.meeting).toEqual({ noteId: s.note.id, docTitle: null, doc: null, docReason: null, visible: false, summary: null, docUrl: null, event: null });
  });
});

describe("le proposte di una riunione", () => {
  it("un invitato che NON ha ricevuto l'email la vede (kind meeting, l'origine) e la decide; la prima decisione chiude per tutti (Q1)", async () => {
    const s = await scenario();
    const list = (await get(s.bruno.headers, "/api/me/mail/proposals")).json().items as Record<string, unknown>[];
    const mine = list.find((p) => p.id === s.proposal.id);
    expect(mine).toMatchObject({ kind: "meeting", messageId: null, meetingOrigin: { noteId: s.note.id, eventId: null, threadId: null, accountId: null, title: "Revisione" } });
    // Chi ha la sua copia e l'evento: il SUO thread, la SUA casella, la SUA riga.
    const adaView = ((await get(s.ada.headers, "/api/me/mail/proposals")).json().items as Record<string, unknown>[]).find((p) => p.id === s.proposal.id);
    expect(adaView).toMatchObject({ messageId: s.adaCopy.id, meetingOrigin: { eventId: s.adaRow.id, threadId: s.adaCopy.threadId, accountId: s.ada.accountId } });
    expect((await app.inject({ method: "POST", url: `/api/me/mail/proposals/${s.proposal.id}/ignore`, headers: s.bruno.headers })).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `/api/me/mail/proposals/${s.proposal.id}/ignore`, headers: s.ada.headers });
    expect([again.statusCode, again.json().code]).toEqual([409, "already_handled"]);
  });

  it("un membro che non c'era, un admin, chi ha l'email inoltrata: nessuna proposta, e non la decidono; un invitato tolto nemmeno", async () => {
    const s = await scenario();
    for (const outsider of [s.dario.headers, s.carla.headers, { cookie: adminCookie }]) {
      const items = (await get(outsider, "/api/me/mail/proposals")).json().items as { id: string }[];
      expect(items.map((p) => p.id)).not.toContain(s.proposal.id);
      expect((await app.inject({ method: "POST", url: `/api/me/mail/proposals/${s.proposal.id}/ignore`, headers: outsider })).statusCode).toBe(404);
    }
    await db.update(calendarEvents).set({ attendees: [], updatedAt: new Date() }).where(eq(calendarEvents.id, s.adaRow.id));
    expect(((await get(s.bruno.headers, "/api/me/mail/proposals")).json().items as { id: string }[]).map((p) => p.id)).not.toContain(s.proposal.id);
    expect((await app.inject({ method: "POST", url: `/api/me/mail/proposals/${s.proposal.id}/ignore`, headers: s.bruno.headers })).statusCode).toBe(404);
  });
});

describe("«Task da questa riunione» e la scheda di preparazione", () => {
  it("ai membri del progetto le task nate dalle proposte confermate; a chi non è membro null", async () => {
    const s = await scenario();
    const [ticket] = await db.insert(tickets).values({ projectId: s.projectId, number: 7, title: "Export", type: "feature", priority: "medium", source: "manual", dueDate: "2020-01-01" } as typeof tickets.$inferInsert).returning();
    await db.update(emailProposals).set({ status: "actioned", decidedAt: new Date(), results: [{ kind: "task", id: ticket!.id, code: `${s.code}-7` }] }).where(eq(emailProposals.id, s.proposal.id));
    const res = await get(s.ada.headers, `/api/me/calendar/events/${s.adaRow.id}/tasks`);
    expect(res.json()).toEqual({ tasks: [{ kind: "task", id: ticket!.id, code: `${s.code}-7`, title: "Export", status: "late", inProgress: false, dueDate: "2020-01-01", departmentId: ticket!.departmentId }], proposedTasks: 0 });
    // L'invitato SENZA l'evento: le stesse task per id della riunione; chi non c'era 404.
    expect((await get(s.bruno.headers, `/api/me/meetings/${s.note.id}/tasks`)).json()).toEqual(res.json());
    for (const outsider of [s.dario.headers, { cookie: adminCookie }]) expect((await get(outsider, `/api/me/meetings/${s.note.id}/tasks`)).statusCode).toBe(404);
    // Fuori dal progetto: null, anche se l'evento è suo.
    const [other] = await db.insert(projects).values({ name: "Altro", slug: `alt-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
    await db.update(calendarEvents).set({ projectId: other!.id }).where(eq(calendarEvents.id, s.adaRow.id));
    expect((await get(s.ada.headers, `/api/me/calendar/events/${s.adaRow.id}/tasks`)).json()).toBeNull();
  });

  it("hasPrep: un evento FUTURO con un progetto che chi guarda vede; uno passato no", async () => {
    const s = await scenario();
    const future = new Date(Date.now() + 2 * 86_400_000);
    await db.insert(calendarEvents).values({ accountId: s.ada.accountId, googleEventId: randomUUID(), title: "Prossima", startsAt: future, fingerprint: "f", projectId: s.projectId });
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const items = (await get(s.ada.headers, `/api/me/calendar/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json().items as { title: string; hasPrep: boolean }[];
    expect(items.find((i) => i.title === "Prossima")!.hasPrep).toBe(true);
    expect(items.find((i) => i.title === "Revisione")!.hasPrep).toBe(false);
  });
});
