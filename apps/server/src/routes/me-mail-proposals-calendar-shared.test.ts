import { randomUUID } from "node:crypto";
import {
  calendarEvents,
  calendarProposalRecipients,
  calendarProposals,
  googleAccounts,
  googleWorkspaces,
  milestones,
  notifications,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * LE PROPOSTE DEL CALENDARIO CONDIVISE FRA GLI INVITATI, IN LETTURA E IN
 * DECISIONE (lotto 9, voce 2 (d)). Il cuore sono i test NEGATIVI: un membro
 * non destinatario, un admin non destinatario e chi ha rifiutato non la
 * vedono (404); il primo che decide la chiude per tutti, chi arriva dopo ha
 * `already_handled` con chi l'ha decisa, mascherato se non è fra gli invitati.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  // Le proposte del calendario stanno in `/proposals` col flag della dottrina nuova.
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

async function person(presetKey: string | null, name: string) {
  const user = await createUserWithSession(app, `${name.toLowerCase()}-${randomUUID()}@acme.com`);
  await db.update(users).set({ displayName: name }).where(eq(users.id, user.id));
  if (presetKey) await addMember(app, projectId, user.id, presetKey);
  return user;
}

const startsAt = new Date(Date.now() + 5 * 86_400_000);
const day = startsAt.toISOString().slice(0, 10);

/**
 * La riunione «Consegna grafiche» di MKX: Matteo (col calendario collegato) e
 * Giulia (senza) sono i destinatari; Bruno è destinatario ma solo in lettura
 * nel progetto; Carla è membro ma NON destinataria; l'admin non è invitato.
 */
async function seed() {
  const [project] = await db.insert(projects).values({ name: "MKX", slug: `mkx-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
  projectId = project!.id;
  const matteo = await person("developer", "Matteo");
  const giulia = await person("developer", "Giulia");
  const bruno = await person("viewer", "Bruno");
  const carla = await person("developer", "Carla");
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [box] = await db
    .insert(googleAccounts)
    .values({ userId: matteo.id, workspaceId: ws!.id, email: `matteo-box-${randomUUID()}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r" })
    .returning();
  const uid = `uid-${randomUUID()}@google.com`;
  const [ev] = await db
    .insert(calendarEvents)
    .values({ accountId: box!.id, googleEventId: `g-${randomUUID()}`, icalUid: uid, title: "Consegna grafiche", startsAt, allDay: false, fingerprint: "f", projectId })
    .returning();
  const [proposal] = await db
    .insert(calendarProposals)
    .values({ icalUid: uid, projectId, calendarEventId: ev!.id, googleEventId: ev!.googleEventId, title: "Consegna grafiche", startsAt, allDay: false })
    .returning();
  await db.update(calendarEvents).set({ calendarProposalId: proposal!.id }).where(eq(calendarEvents.id, ev!.id));
  const card = async (userId: string) =>
    (
      await db
        .insert(notifications)
        .values({
          userId,
          kind: "google.proposal",
          projectId,
          status: "open",
          event: {
            kind: "google.proposal",
            proposalId: proposal!.id,
            source: "calendar",
            from: "matteo@acme.com",
            subject: "Consegna grafiche",
            question: "?",
            options: [{ label: "Crea il traguardo" }, { label: "Non fare nulla" }],
            actions: [{ type: "create_milestone", projectId, name: "Consegna grafiche", dueDate: day }, { type: "ignore" }],
            recommendedIndex: 0,
            allowFreeText: false,
            messageUrl: "https://calendar.google.com/x",
            signal: "deadline",
          },
        })
        .returning()
    )[0]!.id;
  const cards = { matteo: await card(matteo.id), giulia: await card(giulia.id), bruno: await card(bruno.id) };
  await db.insert(calendarProposalRecipients).values([
    { proposalId: proposal!.id, userId: matteo.id, notificationId: cards.matteo },
    { proposalId: proposal!.id, userId: giulia.id, notificationId: cards.giulia },
    { proposalId: proposal!.id, userId: bruno.id, notificationId: cards.bruno },
  ]);
  return { matteo, giulia, bruno, carla, ev: ev!, proposal: proposal!, cards };
}

type Item = Record<string, unknown> & { id: string; kind: string; sharedWith: { userId: string; name: string }[] };
const calendarItems = async (headers: { cookie: string }) =>
  ((await app.inject({ method: "GET", url: "/api/me/mail/proposals", headers })).json() as { items: Item[] }).items.filter((i) => i.kind === "calendar");
const post = (headers: { cookie: string }, id: string, what: "confirm" | "ignore") =>
  app.inject({ method: "POST", url: `/api/me/mail/proposals/${id}/${what}`, headers, payload: {} });

describe("GET /api/me/mail/proposals — le condivise del calendario", () => {
  it("ogni destinatario la vede: l'estratto «titolo · data» a tutti, l'origine solo a chi ha l'evento, gli altri in sharedWith", async () => {
    const { matteo, giulia, bruno, ev, proposal } = await seed();
    const [forMatteo] = await calendarItems(matteo.headers);
    expect(forMatteo).toMatchObject({
      id: proposal.id,
      kind: "calendar",
      messageId: null,
      projectId,
      status: "open",
      excerpt: `Consegna grafiche · ${day}`,
      canConfirm: true,
      canHand: false,
      canReassign: false,
      calendarOrigin: { eventId: ev.id, title: "Consegna grafiche", allDay: false },
    });
    expect(forMatteo!.sharedWith.map((p) => p.name)).toEqual(["Bruno", "Giulia"]);
    const [forGiulia] = await calendarItems(giulia.headers);
    expect(forGiulia).toMatchObject({ id: proposal.id, excerpt: `Consegna grafiche · ${day}`, calendarOrigin: null, canConfirm: true });
    expect(forGiulia!.sharedWith.map((p) => p.userId).sort()).toEqual([matteo.id, bruno.id].sort());
    // Bruno è solo in lettura: la vede, ma la milestone non la può confermare.
    const [forBruno] = await calendarItems(bruno.headers);
    expect(forBruno).toMatchObject({ canConfirm: false, blockedIndices: [0] });
  });

  it("NEGATIVO: un membro non destinatario e un admin non invitato non la vedono; il dettaglio e le decisioni sono 404", async () => {
    const { carla, proposal, cards } = await seed();
    const admin = { cookie: adminCookie };
    for (const headers of [carla.headers, admin]) {
      expect(await calendarItems(headers)).toEqual([]);
      expect((await app.inject({ method: "GET", url: `/api/me/mail/proposals/${proposal.id}`, headers })).statusCode).toBe(404);
      expect((await post(headers, proposal.id, "confirm")).statusCode).toBe(404);
      expect((await post(headers, proposal.id, "ignore")).statusCode).toBe(404);
    }
    // Niente si è chiuso.
    const [row] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposal.id));
    expect(row!.status).toBe("proposed");
    const [card] = await db.select().from(notifications).where(eq(notifications.id, cards.matteo));
    expect(card!.status).toBe("open");
  });

  it("chi ha rifiutato l'invito non la vede più, e non è più fra gli «anche per»", async () => {
    const { matteo, giulia, proposal } = await seed();
    await db
      .update(calendarProposalRecipients)
      .set({ declinedAt: new Date() })
      .where(and(eq(calendarProposalRecipients.proposalId, proposal.id), eq(calendarProposalRecipients.userId, giulia.id)));
    expect(await calendarItems(giulia.headers)).toEqual([]);
    expect((await post(giulia.headers, proposal.id, "confirm")).statusCode).toBe(404);
    const [forMatteo] = await calendarItems(matteo.headers);
    expect(forMatteo!.sharedWith.map((p) => p.name)).toEqual(["Bruno"]);
  });
});

describe("decidere una condivisa del calendario", () => {
  it("la decide il primo: le card di TUTTI si chiudono, chi arriva dopo ha already_handled con chi l'ha decisa, e la milestone nasce una volta", async () => {
    const { matteo, giulia, proposal, cards } = await seed();
    const first = await post(giulia.headers, proposal.id, "confirm");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: "confirmed" });

    const [row] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposal.id));
    expect(row).toMatchObject({ status: "actioned", decidedByUserId: giulia.id });
    expect(row!.decidedAt).not.toBeNull();
    for (const id of Object.values(cards)) {
      const [card] = await db.select().from(notifications).where(eq(notifications.id, id));
      expect(card!.status).toBe("handled");
    }
    // La riga dell'evento non porta l'esito: è della proposta.
    const [ev] = await db.select().from(calendarEvents).where(eq(calendarEvents.calendarProposalId, proposal.id));
    expect(ev!.outcome).toBeNull();

    // Matteo arriva secondo: Giulia è fra gli invitati, quindi resta vera.
    const second = await post(matteo.headers, proposal.id, "confirm");
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "already_handled", decidedBy: { userId: giulia.id, name: "Giulia" } });
    expect(await db.select().from(milestones).where(eq(milestones.projectId, projectId))).toHaveLength(1);
    // Nella vista di Matteo: decisa, da Giulia.
    const [view] = await calendarItems(matteo.headers);
    expect(view).toMatchObject({ status: "confirmed", decidedBy: { userId: giulia.id, name: "Giulia" }, canConfirm: false });
  });

  it("«Ignora» del primo la chiude per tutti", async () => {
    const { matteo, giulia, proposal, cards } = await seed();
    expect((await post(matteo.headers, proposal.id, "ignore")).statusCode).toBe(200);
    const [row] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposal.id));
    expect(row).toMatchObject({ status: "ignored", decidedByUserId: matteo.id });
    const [card] = await db.select().from(notifications).where(eq(notifications.id, cards.giulia));
    expect(card!.status).toBe("handled");
    expect((await post(giulia.headers, proposal.id, "ignore")).statusCode).toBe(409);
  });

  it("chi ha deciso e NON è fra gli invitati è un segnaposto, nella vista e nel 409", async () => {
    const { matteo, proposal } = await seed();
    const [stranger] = await db.insert(users).values({ email: `stranger-cal-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member", displayName: "Zeta" }).returning({ id: users.id });
    await db.update(calendarProposals).set({ status: "actioned", decidedByUserId: stranger!.id, decidedAt: new Date() }).where(eq(calendarProposals.id, proposal.id));
    const [view] = await calendarItems(matteo.headers);
    expect(view!.decidedBy).toEqual({ userId: "hidden-1", name: "" });
    const res = await post(matteo.headers, proposal.id, "confirm");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "already_handled", decidedBy: { userId: "hidden-1", name: "" } });
    expect(res.body).not.toContain(stranger!.id);
  });

  it("i permessi di oggi: chi è solo in lettura non conferma la milestone (403) e nulla si chiude", async () => {
    const { bruno, proposal, cards } = await seed();
    expect((await post(bruno.headers, proposal.id, "confirm")).statusCode).toBe(403);
    const [row] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, proposal.id));
    expect(row!.status).toBe("proposed");
    const [card] = await db.select().from(notifications).where(eq(notifications.id, cards.matteo));
    expect(card!.status).toBe("open");
  });
});
