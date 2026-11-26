import { randomUUID } from "node:crypto";
import {
  calendarEvents,
  calendarProposalRecipients,
  calendarProposals,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { answerGoogleProposal } from "../services/google-proposal.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * LA «QUALE PROGETTO?» CONDIVISA DEL CALENDARIO (lotto 9, voce 2 (a)), in
 * lettura e in decisione. Il cuore sono i test NEGATIVI: chi non è
 * destinatario ha il 404; un destinatario non sceglie un progetto fuori dai
 * candidati, uno che non vede, né uno in cui non può confermare — e niente
 * cambia nel DB.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: Buffer.alloc(32, 7).toString("base64"), mailClassifyV2: true });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
afterEach(async () => {
  await db.delete(notifications);
  await db.delete(calendarProposals);
  await db.delete(calendarEvents);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const startsAt = new Date(Date.now() + 5 * 86_400_000);

async function project(name: string) {
  return (await db.insert(projects).values({ name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning())[0]!;
}

async function person(name: string, memberships: [string, string][]) {
  const user = await createUserWithSession(app, `${name.toLowerCase()}-${randomUUID()}@acme.com`);
  await db.update(users).set({ displayName: name }).where(eq(users.id, user.id));
  for (const [projectId, preset] of memberships) await addMember(app, projectId, user.id, preset);
  return user;
}

/**
 * La riunione «Revisione grafiche», candidata ad Alfa e Beta. Matteo (la
 * casella) è developer in Alfa e Beta; Giulia developer SOLO in Alfa; Bruno
 * viewer in Alfa e developer in Beta; Carla developer in Alfa ma NON
 * destinataria; Matteo è anche developer di Gamma, che NON è candidata.
 */
async function seed() {
  const alfa = await project("Alfa");
  const beta = await project("Beta");
  const gamma = await project("Gamma");
  const matteo = await person("Matteo", [
    [alfa.id, "developer"],
    [beta.id, "developer"],
    [gamma.id, "developer"],
  ]);
  const giulia = await person("Giulia", [[alfa.id, "developer"]]);
  const bruno = await person("Bruno", [
    [alfa.id, "viewer"],
    [beta.id, "developer"],
  ]);
  const carla = await person("Carla", [[alfa.id, "developer"]]);
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [box] = await db
    .insert(googleAccounts)
    .values({ userId: matteo.id, workspaceId: ws!.id, email: `matteo-box-${randomUUID()}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r" })
    .returning();
  const uid = `uid-${randomUUID()}@google.com`;
  const guess = { projectId: null, reason: "non so", at: new Date().toISOString(), by: "model" as const, candidates: [alfa.id, beta.id].sort() };
  const [ev] = await db
    .insert(calendarEvents)
    .values({ accountId: box!.id, googleEventId: `g-${randomUUID()}`, icalUid: uid, title: "Revisione grafiche", startsAt, allDay: false, fingerprint: "f", proposalCandidate: true, projectGuess: guess })
    .returning();
  const [proposal] = await db
    .insert(calendarProposals)
    .values({ icalUid: uid, projectId: null, candidateProjectIds: [alfa.id, beta.id], calendarEventId: ev!.id, googleEventId: ev!.googleEventId, title: "Revisione grafiche", startsAt, allDay: false })
    .returning();
  await db.update(calendarEvents).set({ calendarProposalId: proposal!.id }).where(eq(calendarEvents.id, ev!.id));
  const card = async (userId: string, choose: string[]) =>
    (
      await db
        .insert(notifications)
        .values({
          userId,
          kind: "google.proposal",
          projectId: choose[0]!,
          status: "open",
          event: {
            kind: "google.proposal",
            proposalId: proposal!.id,
            source: "calendar",
            from: "matteo@acme.com",
            subject: "Revisione grafiche",
            question: "?",
            options: [...choose.map((id) => ({ label: id === alfa.id ? "Alfa" : "Beta" })), { label: "Non fare nulla" }],
            actions: [...choose.map((projectId) => ({ type: "choose_project", projectId })), { type: "ignore" }],
            recommendedIndex: 0,
            allowFreeText: false,
            messageUrl: "https://calendar.google.com/x",
            signal: "deadline",
          },
        })
        .returning()
    )[0]!.id;
  const cards = { matteo: await card(matteo.id, [alfa.id, beta.id]), giulia: await card(giulia.id, [alfa.id]), bruno: await card(bruno.id, [beta.id]) };
  await db.insert(calendarProposalRecipients).values([
    { proposalId: proposal!.id, userId: matteo.id, notificationId: cards.matteo },
    { proposalId: proposal!.id, userId: giulia.id, notificationId: cards.giulia },
    { proposalId: proposal!.id, userId: bruno.id, notificationId: cards.bruno },
  ]);
  return { alfa, beta, gamma, matteo, giulia, bruno, carla, ev: ev!, proposal: proposal!, cards };
}

type Item = { id: string; kind: string; projectId: string; status: string; actions: { type: string; args: { projectIds?: string[] } }[]; canConfirm: boolean };
const calendarItems = async (headers: { cookie: string }) =>
  ((await app.inject({ method: "GET", url: "/api/me/mail/proposals", headers })).json() as { items: Item[] }).items.filter((i) => i.kind === "calendar");
const choose = (headers: { cookie: string }, id: string, projectId: string) =>
  app.inject({ method: "POST", url: `/api/me/mail/proposals/${id}/choose-project`, headers, payload: { projectId } });

/** Lo stato del DB che una decisione toccherebbe: proposta, card, copie. */
async function snapshot(proposalId: string) {
  const [proposal] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposalId));
  const cards = (await db.select({ id: notifications.id, status: notifications.status }).from(notifications)).sort((a, b) => a.id.localeCompare(b.id));
  const copies = (await db.select({ id: calendarEvents.id, projectId: calendarEvents.projectId, link: calendarEvents.calendarProposalId, guess: calendarEvents.projectGuess }).from(calendarEvents)).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  return { proposal: { status: proposal!.status, projectId: proposal!.projectId, decidedBy: proposal!.decidedByUserId, outcome: proposal!.outcome }, cards, copies };
}

describe("GET /api/me/mail/proposals — la «Quale progetto?» del calendario", () => {
  it("ogni destinatario vede SOLO i candidati in cui può confermare, e projectId è uno che vede", async () => {
    const { alfa, beta, matteo, giulia, bruno, proposal } = await seed();
    const [forMatteo] = await calendarItems(matteo.headers);
    expect(forMatteo).toMatchObject({ id: proposal.id, status: "open", canConfirm: false });
    expect(forMatteo!.actions).toHaveLength(1);
    expect(forMatteo!.actions[0]!.type).toBe("choose_project");
    expect([...forMatteo!.actions[0]!.args.projectIds!].sort()).toEqual([alfa.id, beta.id].sort());
    const [forGiulia] = await calendarItems(giulia.headers);
    expect(forGiulia!.actions[0]!.args.projectIds).toEqual([alfa.id]);
    expect(forGiulia!.projectId).toBe(alfa.id);
    // La vista di Giulia non porta l'id di Beta, che lei non vede.
    expect(JSON.stringify(forGiulia)).not.toContain(beta.id);
    // Bruno vede Alfa (in lettura) ma può confermare solo in Beta.
    const [forBruno] = await calendarItems(bruno.headers);
    expect(forBruno!.actions[0]!.args.projectIds).toEqual([beta.id]);
    expect(forBruno!.projectId).toBe(beta.id);
  });

  it("NEGATIVO: un membro non destinatario e un admin non invitato non la vedono, e non la scelgono (404, nulla cambia)", async () => {
    const { alfa, carla, proposal } = await seed();
    const before = await snapshot(proposal.id);
    for (const headers of [carla.headers, { cookie: adminCookie }]) {
      expect(await calendarItems(headers)).toEqual([]);
      expect((await app.inject({ method: "GET", url: `/api/me/mail/proposals/${proposal.id}`, headers })).statusCode).toBe(404);
      expect((await choose(headers, proposal.id, alfa.id)).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `/api/me/mail/proposals/${proposal.id}/ignore`, headers, payload: {} })).statusCode).toBe(404);
    }
    expect(await snapshot(proposal.id)).toEqual(before);
  });
});

describe("scegliere il progetto", () => {
  it("la scelta chiude la domanda per tutti e rimanda l'evento al percorso di progetto", async () => {
    const { beta, matteo, ev, proposal, cards } = await seed();
    const res = await choose(matteo.headers, proposal.id, beta.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "moved", projectId: beta.id });
    const [row] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposal.id));
    expect(row).toMatchObject({ status: "actioned", decidedByUserId: matteo.id, outcome: { type: "project_chosen", projectId: beta.id } });
    for (const id of Object.values(cards)) {
      const [card] = await db.select().from(notifications).where(eq(notifications.id, id));
      expect(card!.status).toBe("handled");
    }
    // La copia prende il progetto e si slega: il giro dopo del worker fa nascere la proposta di Beta.
    const [copy] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, ev.id));
    expect(copy).toMatchObject({ projectId: beta.id, projectBy: "manual", calendarProposalId: null, outcome: null });
    expect(copy!.projectGuess).toMatchObject({ projectId: beta.id, by: "person" });
  });

  it("NEGATIVO: Giulia, membro della sola Alfa, non mette la proposta in Beta (rotta chiamata direttamente) e nulla cambia", async () => {
    const { beta, giulia, proposal } = await seed();
    const before = await snapshot(proposal.id);
    const res = await choose(giulia.headers, proposal.id, beta.id);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_target" });
    expect(await snapshot(proposal.id)).toEqual(before);
  });

  it("NEGATIVO: Bruno vede Alfa solo in lettura: non la sceglie (403) e nulla cambia", async () => {
    const { alfa, bruno, proposal } = await seed();
    const before = await snapshot(proposal.id);
    const res = await choose(bruno.headers, proposal.id, alfa.id);
    expect(res.statusCode).toBe(403);
    expect(await snapshot(proposal.id)).toEqual(before);
  });

  it("NEGATIVO: un progetto fuori dai candidati non si sceglie, nemmeno se chi sceglie ne è membro (Gamma)", async () => {
    const { gamma, matteo, proposal } = await seed();
    const before = await snapshot(proposal.id);
    const res = await choose(matteo.headers, proposal.id, gamma.id);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_target" });
    expect(await snapshot(proposal.id)).toEqual(before);
  });

  it("chi arriva secondo ha already_handled con chi l'ha decisa", async () => {
    const { alfa, matteo, giulia, proposal } = await seed();
    expect((await choose(matteo.headers, proposal.id, alfa.id)).statusCode).toBe(200);
    const second = await choose(giulia.headers, proposal.id, alfa.id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "already_handled", decidedBy: { userId: matteo.id, name: "Matteo" } });
    const [row] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposal.id));
    expect(row!.decidedByUserId).toBe(matteo.id);
  });

  it("«Non fare nulla» la chiude per tutti, e la conferma non c'è", async () => {
    const { matteo, giulia, proposal, cards } = await seed();
    expect((await app.inject({ method: "POST", url: `/api/me/mail/proposals/${proposal.id}/confirm`, headers: giulia.headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/me/mail/proposals/${proposal.id}/ignore`, headers: giulia.headers, payload: {} })).statusCode).toBe(200);
    const [row] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposal.id));
    expect(row).toMatchObject({ status: "ignored", decidedByUserId: giulia.id });
    const [card] = await db.select().from(notifications).where(eq(notifications.id, cards.matteo));
    expect(card!.status).toBe("handled");
    expect((await choose(matteo.headers, proposal.id, giulia.id)).statusCode).toBe(409);
  });

  it("una copia in una casella il cui titolare NON vede il progetto scelto resta senza progetto", async () => {
    const { beta, matteo, giulia, proposal } = await seed();
    // Giulia (solo Alfa) ha la sua copia dello stesso appuntamento, legata alla domanda.
    const [ws] = await db.insert(googleWorkspaces).values({ name: "G", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
    const [box] = await db
      .insert(googleAccounts)
      .values({ userId: giulia.id, workspaceId: ws!.id, email: `giulia-box-${randomUUID()}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r" })
      .returning();
    const [theirs] = await db
      .insert(calendarEvents)
      .values({ accountId: box!.id, googleEventId: `g-${randomUUID()}`, icalUid: proposal.icalUid, title: "Revisione grafiche", startsAt, fingerprint: "f", proposalCandidate: true, calendarProposalId: proposal.id })
      .returning();
    expect((await choose(matteo.headers, proposal.id, beta.id)).statusCode).toBe(200);
    const [copy] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, theirs!.id));
    expect(copy).toMatchObject({ projectId: null, calendarProposalId: null });
    expect(copy!.projectGuess).toMatchObject({ projectId: beta.id, by: "person" });
  });

  it("l'esecutore delle card (`answerGoogleProposal`) non la esegue: proposal_stale, e nulla si chiude", async () => {
    const { matteo, proposal, cards } = await seed();
    const before = await snapshot(proposal.id);
    const answered = await answerGoogleProposal(db, { notificationId: cards.matteo, actor: { id: matteo.id, role: "member" }, optionIndex: 0 });
    expect(answered).toMatchObject({ ok: false, error: "proposal_stale" });
    expect(await snapshot(proposal.id)).toEqual(before);
  });

  it("dall'inbox: l'opzione della card sceglie il progetto che MOSTRA", async () => {
    const { alfa, giulia, proposal, cards } = await seed();
    const res = await app.inject({ method: "POST", url: `/api/inbox/${cards.giulia}/actions/answer`, headers: giulia.headers, payload: { optionIndex: 0 } });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposal.id));
    expect(row).toMatchObject({ status: "actioned", decidedByUserId: giulia.id, outcome: { type: "project_chosen", projectId: alfa.id } });
  });
});
