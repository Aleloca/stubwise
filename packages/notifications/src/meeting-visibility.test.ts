import { randomUUID } from "node:crypto";
import { calendarEvents, emailMessages, googleAccounts, googleWorkspaces, meetingNotes, users } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canSeeMeeting, meetingViewerIds } from "./meeting-visibility.js";

/**
 * CHI VEDE UNA RIUNIONE REGISTRATA (area 6, F5a): l'eccezione dichiarata a
 * «Posta e Calendario personali». I NEGATIVI sono il punto: un membro che non
 * c'era, un full admin non invitato, un invitato tolto da Google.
 */

let t: TestDb;
let wsId: string;
beforeAll(async () => {
  t = await startTestDb();
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  wsId = ws!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function person(opts: { admin?: boolean; mailbox?: boolean } = {}) {
  const email = `p-${randomUUID().slice(0, 8)}@acme.com`;
  const [u] = await t.db.insert(users).values({ email, passwordHash: "x", role: opts.admin ? "admin" : "member" } as typeof users.$inferInsert).returning();
  let accountId: string | null = null;
  let mailbox: string | null = null;
  if (opts.mailbox !== false) {
    mailbox = `box-${randomUUID().slice(0, 8)}@acme.com`;
    const [box] = await t.db.insert(googleAccounts).values({ userId: u!.id, workspaceId: wsId, email: mailbox, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
    accountId = box!.id;
  }
  return { id: u!.id, email, mailbox, accountId };
}

async function geminiEmail(accountId: string, to: string[]) {
  const [m] = await t.db.insert(emailMessages).values({ accountId, gmailMessageId: randomUUID(), threadId: randomUUID(), fromAddress: "gemini-notes@google.com", toAddresses: to, receivedAt: new Date(), kind: "transcript", rfcMessageId: `<${randomUUID()}@google.com>` }).returning();
  return m!;
}

describe("meetingViewerIds", () => {
  it("con l'evento: gli invitati attuali (anche declined, anche SENZA casella collegata) e l'organizzatore; mai un membro che non c'era né un admin non invitato", async () => {
    const ada = await person();
    const noBox = await person({ mailbox: false });
    const declined = await person();
    const outsider = await person();
    const admin = await person({ admin: true });
    const uid = `ev-${randomUUID()}@google.com`;
    const at = new Date();
    await t.db.insert(calendarEvents).values({
      accountId: ada.accountId!,
      googleEventId: randomUUID(),
      startsAt: at,
      fingerprint: "f",
      icalUid: uid,
      organizer: ada.mailbox,
      attendees: [{ email: noBox.email, responseStatus: "accepted" }, { email: declined.mailbox!, responseStatus: "declined" }],
    });
    const message = await geminiEmail(ada.accountId!, [ada.mailbox!, outsider.email]);
    const [note] = await t.db.insert(meetingNotes).values({ docFileId: randomUUID(), sourceMessageId: message.id, rfcMessageId: message.rfcMessageId, icalUid: uid, eventStartsAt: at }).returning();
    expect([...(await meetingViewerIds(t.db, note!.id))].sort()).toEqual([ada.id, noBox.id, declined.id].sort());
    // Ha ricevuto l'email ma NON è fra gli invitati: con l'evento collegato non conta.
    expect(await canSeeMeeting(t.db, note!.id, outsider.id)).toBe(false);
    expect(await canSeeMeeting(t.db, note!.id, admin.id)).toBe(false);
  });

  it("un invitato TOLTO da Google non vede più: conta la riga più recente non cancellata, non una vecchia", async () => {
    const ada = await person();
    const bob = await person();
    const uid = `ev-${randomUUID()}@google.com`;
    const old = new Date(Date.now() - 3600_000);
    const at = new Date();
    // La riga di Bob, cancellata quando l'hanno tolto: ha ancora gli invitati di prima.
    await t.db.insert(calendarEvents).values({ accountId: bob.accountId!, googleEventId: randomUUID(), startsAt: at, fingerprint: "f", icalUid: uid, status: "cancelled", attendees: [{ email: bob.mailbox!, responseStatus: "accepted" }, { email: ada.mailbox!, responseStatus: "accepted" }], updatedAt: new Date() });
    const [adaRow] = await t.db.insert(calendarEvents).values({ accountId: ada.accountId!, googleEventId: randomUUID(), startsAt: at, fingerprint: "f", icalUid: uid, attendees: [{ email: bob.mailbox!, responseStatus: "accepted" }, { email: ada.mailbox!, responseStatus: "accepted" }] }).returning();
    await t.db.update(calendarEvents).set({ updatedAt: old }).where(eq(calendarEvents.id, adaRow!.id));
    const message = await geminiEmail(ada.accountId!, [ada.mailbox!]);
    const [note] = await t.db.insert(meetingNotes).values({ docFileId: randomUUID(), sourceMessageId: message.id, icalUid: uid, eventStartsAt: at }).returning();
    expect(await canSeeMeeting(t.db, note!.id, bob.id)).toBe(true);
    // La riga di un'altra casella non ancora risincronizzata: più VECCHIA, ha ancora Bob.
    const carla = await person();
    const [carlaRow] = await t.db.insert(calendarEvents).values({ accountId: carla.accountId!, googleEventId: randomUUID(), startsAt: at, fingerprint: "f", icalUid: uid, attendees: [{ email: bob.mailbox!, responseStatus: "accepted" }, { email: ada.mailbox!, responseStatus: "accepted" }] }).returning();
    await t.db.update(calendarEvents).set({ updatedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(calendarEvents.id, carlaRow!.id));
    // Il giro dopo: la riga di Ada senza Bob; la cancellata di Bob resta la più recente di tutte.
    await t.db.update(calendarEvents).set({ attendees: [{ email: ada.mailbox!, responseStatus: "accepted" }], updatedAt: new Date() }).where(eq(calendarEvents.id, adaRow!.id));
    await t.db.execute(sql`update calendar_events set updated_at = now() + interval '1 hour' where ical_uid = ${uid} and status = 'cancelled'`);
    expect(await canSeeMeeting(t.db, note!.id, bob.id)).toBe(false);
    expect(await canSeeMeeting(t.db, note!.id, ada.id)).toBe(true);
  });

  it("senza righe dell'evento resta lo snapshot; senza evento, chi ha ricevuto l'email (non il mittente, non un admin)", async () => {
    const ada = await person();
    const bob = await person();
    const admin = await person({ admin: true });
    const message = await geminiEmail(ada.accountId!, [ada.mailbox!, bob.email]);
    const [snap] = await t.db.insert(meetingNotes).values({ docFileId: randomUUID(), sourceMessageId: message.id, icalUid: `gone-${randomUUID()}`, attendeeEmails: [bob.email] }).returning();
    expect(await meetingViewerIds(t.db, snap!.id)).toEqual([bob.id]);
    const [none] = await t.db.insert(meetingNotes).values({ docFileId: randomUUID(), sourceMessageId: message.id, rfcMessageId: message.rfcMessageId }).returning();
    expect([...(await meetingViewerIds(t.db, none!.id))].sort()).toEqual([ada.id, bob.id].sort());
    expect(await canSeeMeeting(t.db, none!.id, admin.id)).toBe(false);
  });
});

describe("review F5a, punto 1 (CRITICO): le occorrenze di una serie hanno lo STESSO iCalUID", () => {
  it("chi è invitato a un'ALTRA occorrenza non vede la riunione di questa; uno tolto da questa non la vede anche se è nelle altre", async () => {
    const ada = await person();
    const bob = await person();
    const carla = await person();
    const uid = `serie-${randomUUID()}@google.com`;
    const lastWeek = new Date(Date.now() - 7 * 86_400_000);
    const nextWeek = new Date(Date.now() + 7 * 86_400_000);
    // La settimana scorsa: Ada e Bob (registrata). La prossima: Ada, Bob e Carla (riga più recente).
    await t.db.insert(calendarEvents).values({ accountId: ada.accountId!, googleEventId: `x_${randomUUID()}`, startsAt: lastWeek, fingerprint: "f", icalUid: uid, organizer: ada.mailbox, organizerSelf: true, attendees: [{ email: bob.mailbox!, responseStatus: "accepted" }], updatedAt: new Date(Date.now() - 3600_000) });
    await t.db.insert(calendarEvents).values({ accountId: ada.accountId!, googleEventId: `x_${randomUUID()}`, startsAt: nextWeek, fingerprint: "f", icalUid: uid, organizer: ada.mailbox, organizerSelf: true, attendees: [{ email: bob.mailbox!, responseStatus: "accepted" }, { email: carla.mailbox!, responseStatus: "accepted" }], updatedAt: new Date() });
    const message = await geminiEmail(ada.accountId!, [ada.mailbox!]);
    const [note] = await t.db.insert(meetingNotes).values({ docFileId: randomUUID(), sourceMessageId: message.id, icalUid: uid, eventStartsAt: lastWeek }).returning();
    expect(await canSeeMeeting(t.db, note!.id, carla.id)).toBe(false);
    expect(await canSeeMeeting(t.db, note!.id, bob.id)).toBe(true);
  });

  it("punto 8: vince la riga dell'ORGANIZZATORE, non quella toccata per ultima in locale", async () => {
    const ada = await person();
    const bob = await person();
    const uid = `ev-${randomUUID()}@google.com`;
    const at = new Date();
    // La riga di Bob, toccata per ultima in locale ma vecchia: Bob c'era; quella di Ada (organizzatrice) non più.
    await t.db.insert(calendarEvents).values({ accountId: ada.accountId!, googleEventId: randomUUID(), startsAt: at, fingerprint: "f", icalUid: uid, organizer: ada.mailbox, organizerSelf: true, attendees: [], updatedAt: new Date(Date.now() - 3600_000) });
    await t.db.insert(calendarEvents).values({ accountId: bob.accountId!, googleEventId: randomUUID(), startsAt: at, fingerprint: "f", icalUid: uid, organizer: ada.mailbox, attendees: [{ email: bob.mailbox!, responseStatus: "accepted" }], updatedAt: new Date() });
    const message = await geminiEmail(ada.accountId!, [ada.mailbox!]);
    const [note] = await t.db.insert(meetingNotes).values({ docFileId: randomUUID(), sourceMessageId: message.id, icalUid: uid, eventStartsAt: at }).returning();
    expect(await canSeeMeeting(t.db, note!.id, bob.id)).toBe(false);
    expect(await canSeeMeeting(t.db, note!.id, ada.id)).toBe(true);
  });
});
