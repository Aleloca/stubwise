import { randomBytes, randomUUID } from "node:crypto";
import {
  calendarEvents,
  calendarProposalRecipients,
  calendarProposals,
  calendarSeries,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projectEmailRoutes,
  projectMembers,
  projects,
  roles,
  users,
  type Db,
} from "@stubwise/db";
import { deleteAllProjects, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { GoogleCalendarEvent } from "@stubwise/google";
import type { GoogleAccountCredentials } from "@stubwise/google/credentials";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeSelect } from "../providers/select-fake.js";
import { closeCancelledSharedCalendarProposals, closeDeclinedCalendarRecipients, eventInviteeIds, publishSharedCalendarProposals } from "./calendar-shared.js";
import { pollGoogleOnce, type CalendarClient, type GmailClient, type GooglePollerDeps } from "./poller.js";

/**
 * LE PROPOSTE DEL CALENDARIO CONDIVISE FRA GLI INVITATI (lotto 9, voce 2 (d)).
 * I test che contano sono NEGATIVI: un admin non invitato, un invitato non
 * membro e chi ha rifiutato NON ricevono la card; due caselle con lo stesso
 * appuntamento NON fanno due proposte né due card per la stessa persona.
 */

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let db: Db;
let roleId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  roleId = (await db.select({ id: roles.id }).from(roles).where(eq(roles.scope, "project")).limit(1))[0]!.id;
}, 120_000);

afterEach(async () => {
  await db.delete(notifications);
  await db.delete(calendarProposals);
  await db.delete(calendarSeries);
  await db.delete(calendarEvents);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
  await db.delete(projectEmailRoutes);
  await db.delete(projectMembers);
  await deleteAllProjects(db);
});

afterAll(async () => {
  await testDb.stop();
});

const START = new Date(Date.now() + 7 * 24 * 3600_000);

async function user(email: string, role: "member" | "admin" = "member"): Promise<string> {
  return (await db.insert(users).values({ email, passwordHash: "x", role } as typeof users.$inferInsert).returning())[0]!.id;
}

async function mailbox(userId: string, email: string) {
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  return (
    await db
      .insert(googleAccounts)
      .values({ userId, workspaceId: ws!.id, email, googleSub: randomUUID(), refreshTokenEncrypted: "r", nextSyncAt: new Date(Date.now() - 60_000) })
      .returning()
  )[0]!;
}

type Attendee = { email: string; responseStatus: "declined" | "tentative" | "needsAction" | "accepted" | null };

async function copyOf(accountId: string, input: { uid: string; projectId: string; attendees: Attendee[]; googleEventId?: string; recurringEventId?: string }) {
  return (
    await db
      .insert(calendarEvents)
      .values({
        accountId,
        googleEventId: input.googleEventId ?? `ev-${randomUUID().slice(0, 8)}`,
        icalUid: input.uid,
        title: "Consegna grafiche",
        startsAt: START,
        endsAt: new Date(START.getTime() + 3600_000),
        organizer: input.attendees[0]?.email ?? null,
        attendees: input.attendees as never,
        status: "confirmed",
        projectId: input.projectId,
        fingerprint: `fp-${randomUUID()}`,
        recurringEventId: input.recurringEventId ?? null,
      })
      .returning()
  )[0]!;
}

/**
 * Matteo e Giulia, invitati e membri; Eva, admin NON invitata; Fabio, admin
 * invitato ma NON membro esplicito; Dario, invitato NON membro; Carla, membro
 * NON invitata. Matteo e Giulia hanno ognuno la sua copia dell'evento.
 */
async function scenario() {
  const tag = randomUUID().slice(0, 8);
  const addr = (n: string) => `${n}-${tag}@acme.com`;
  const matteo = await user(addr("matteo"));
  const giulia = await user(addr("giulia"));
  const carla = await user(addr("carla"));
  const dario = await user(addr("dario"));
  const eva = await user(addr("eva"), "admin");
  const fabio = await user(addr("fabio"), "admin");
  const [project] = await db.insert(projects).values({ name: "MKX", slug: `mkx-${tag}`, ingestionKey: randomUUID() }).returning();
  for (const id of [matteo, giulia, carla]) await db.insert(projectMembers).values({ projectId: project!.id, userId: id, roleId });
  const matteoBox = await mailbox(matteo, addr("matteo-box"));
  const giuliaBox = await mailbox(giulia, addr("giulia"));
  const attendees: Attendee[] = [
    { email: addr("matteo-box"), responseStatus: "accepted" },
    { email: addr("giulia"), responseStatus: "needsAction" },
    { email: addr("dario"), responseStatus: "accepted" },
    { email: addr("fabio"), responseStatus: "accepted" },
    { email: "cliente@esterno.it", responseStatus: null },
  ];
  const uid = `uid-${tag}@google.com`;
  return { tag, addr, matteo, giulia, carla, dario, eva, fabio, project: project!, matteoBox, giuliaBox, attendees, uid };
}

const notified = async () => (await db.select({ userId: notifications.userId }).from(notifications)).map((r) => r.userId).sort();

describe("eventInviteeIds (audience `event_invitees`)", () => {
  it("invitati non rifiutati E membri ESPLICITI: mai un admin in quanto tale, mai un non membro", async () => {
    const s = await scenario();
    const ids = await eventInviteeIds(db, { attendees: s.attendees, mailboxOwnerUserId: s.matteo, projectId: s.project.id });
    expect(ids).toEqual([s.matteo, s.giulia].sort());
    expect(ids).not.toContain(s.eva);
    expect(ids).not.toContain(s.fabio);
    expect(ids).not.toContain(s.dario);
    expect(ids).not.toContain(s.carla);
  });

  it("chi ha rifiutato è fuori", async () => {
    const s = await scenario();
    const attendees = s.attendees.map((a) => (a.email === s.addr("giulia") ? { ...a, responseStatus: "declined" as const } : a));
    expect(await eventInviteeIds(db, { attendees, mailboxOwnerUserId: s.matteo, projectId: s.project.id })).toEqual([s.matteo]);
  });

  it("correzione di 46: il titolare entra anche NON membro; se ha rifiutato no (direttamente sulla regola)", async () => {
    const s = await scenario();
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, s.project.id), eq(projectMembers.userId, s.matteo)));
    expect(await eventInviteeIds(db, { attendees: s.attendees, mailboxOwnerUserId: s.matteo, projectId: s.project.id })).toEqual([s.matteo, s.giulia].sort());
    const declined = s.attendees.map((a) => (a.email === s.addr("matteo-box") ? { ...a, responseStatus: "declined" as const } : a));
    expect(await eventInviteeIds(db, { attendees: declined, mailboxOwnerUserId: s.matteo, projectId: s.project.id })).toEqual([s.giulia]);
  });

  it("il proprietario della casella conta come un invitato che ha accettato, anche se non è fra gli invitati", async () => {
    const s = await scenario();
    const attendees = s.attendees.filter((a) => a.email !== s.addr("matteo-box"));
    expect(await eventInviteeIds(db, { attendees, mailboxOwnerUserId: s.matteo, projectId: s.project.id })).toEqual([s.matteo, s.giulia].sort());
  });
});

describe("publishSharedCalendarProposals", () => {
  it("due caselle con lo stesso ical_uid: UNA proposta, UNA card per destinatario, nessuna agli altri", async () => {
    const s = await scenario();
    const a = await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });
    const b = await copyOf(s.giuliaBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });

    expect(await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email })).toBe(1);
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.giuliaBox.id, userId: s.giulia, email: s.giuliaBox.email });
    // Un secondo giro non cambia niente.
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email });

    const proposals = await db.select().from(calendarProposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ icalUid: s.uid, projectId: s.project.id, status: "proposed", audience: "event_invitees" });
    expect(await notified()).toEqual([s.matteo, s.giulia].sort());
    const recipients = await db.select().from(calendarProposalRecipients);
    expect(recipients.map((r) => r.userId).sort()).toEqual([s.matteo, s.giulia].sort());
    expect(recipients.every((r) => r.notificationId !== null)).toBe(true);

    // Le due copie sono legate alla proposta; nessuna ha una card per casella.
    for (const id of [a.id, b.id]) {
      const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));
      expect(row!.calendarProposalId).toBe(proposals[0]!.id);
      expect(row!.proposalNotificationId).toBeNull();
    }
    // Ogni card porta lo stesso proposalId (la chiave del claim) e l'ancora della SUA copia.
    const cards = await db.select().from(notifications);
    const ev = (userId: string) => cards.find((c) => c.userId === userId)!.event as { proposalId: string; calendarEventId?: string; messageUrl: string };
    expect(ev(s.matteo).proposalId).toBe(proposals[0]!.id);
    expect(ev(s.giulia).proposalId).toBe(proposals[0]!.id);
    expect(ev(s.matteo).calendarEventId).toBe(a.id);
    expect(ev(s.giulia).calendarEventId).toBe(b.id);
    expect(ev(s.giulia).messageUrl).toContain(encodeURIComponent(s.giuliaBox.email));
  });

  it("un invitato membro senza calendario collegato la riceve, senza l'id della riga di un altro", async () => {
    const s = await scenario();
    await db.delete(googleAccounts).where(eq(googleAccounts.id, s.giuliaBox.id));
    await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email });
    expect(await notified()).toEqual([s.matteo, s.giulia].sort());
    const [card] = await db.select().from(notifications).where(eq(notifications.userId, s.giulia));
    expect((card!.event as { calendarEventId?: string }).calendarEventId).toBeUndefined();
  });

  it("un admin NON invitato non riceve niente; un admin invitato ma non membro esplicito nemmeno", async () => {
    const s = await scenario();
    await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email });
    const users = await notified();
    expect(users).not.toContain(s.eva);
    expect(users).not.toContain(s.fabio);
  });

  it("un invitato NON membro non riceve niente", async () => {
    const s = await scenario();
    await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email });
    expect(await notified()).not.toContain(s.dario);
    expect((await db.select().from(calendarProposalRecipients)).map((r) => r.userId)).not.toContain(s.dario);
  });

  it("correzione di 46: il TITOLARE della casella NON membro riceve SEMPRE la sua card (mailbox_owner, com'era); gli altri invitati non membri no", async () => {
    const s = await scenario();
    await db.delete(projectMembers).where(eq(projectMembers.projectId, s.project.id));
    await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email });
    expect(await notified()).toEqual([s.matteo]);
    const [row] = await db.select().from(calendarProposals);
    expect(row!.status).not.toBe("ignored");
  });

  it("il titolare che ha RIFIUTATO non la riceve, nemmeno come titolare", async () => {
    const s = await scenario();
    await db.delete(projectMembers).where(eq(projectMembers.projectId, s.project.id));
    const attendees = s.attendees.map((a) => (a.email === s.matteoBox.email ? { ...a, responseStatus: "declined" as const } : a));
    await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees });
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email });
    expect(await notified()).toEqual([]);
  });
});

describe("le serie restano fuori", () => {
  it("un'occorrenza di SERIE non diventa mai una proposta condivisa (nemmeno di una serie spenta)", async () => {
    const s = await scenario();
    await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees, recurringEventId: "weekly" });
    expect(await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email })).toBe(0);
    expect(await db.select().from(calendarProposals)).toEqual([]);
    expect(await notified()).toEqual([]);
  });
});

describe("una copia cancellata", () => {
  it("se resta una copia viva, si chiude solo la card di chi l'ha persa; senza copie vive, la proposta per tutti", async () => {
    const s = await scenario();
    const a = await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });
    const b = await copyOf(s.giuliaBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email });
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.giuliaBox.id, userId: s.giulia, email: s.giuliaBox.email });
    const [proposal] = await db.select().from(calendarProposals);
    const status = async (userId: string) => (await db.select().from(notifications).where(eq(notifications.userId, userId)))[0]!.status;

    await db.update(calendarEvents).set({ status: "cancelled" }).where(eq(calendarEvents.id, b.id));
    await db.transaction((tx) => closeCancelledSharedCalendarProposals(tx, s.giuliaBox.id, [proposal!.id]));
    expect(await status(s.giulia)).toBe("handled");
    expect(await status(s.matteo)).toBe("open");
    expect((await db.select().from(calendarProposals))[0]!.status).toBe("proposed");

    await db.update(calendarEvents).set({ status: "cancelled" }).where(eq(calendarEvents.id, a.id));
    await db.transaction((tx) => closeCancelledSharedCalendarProposals(tx, s.matteoBox.id, [proposal!.id]));
    expect(await status(s.matteo)).toBe("handled");
    expect((await db.select().from(calendarProposals))[0]).toMatchObject({ status: "ignored", outcome: { type: "cancelled" } });
  });
});

describe("il rifiuto SOPRAVVENUTO", () => {
  it("un invitato che rifiuta dopo la pubblicazione si vede chiudere la SUA card; le altre restano aperte", async () => {
    const s = await scenario();
    const a = await copyOf(s.matteoBox.id, { uid: s.uid, projectId: s.project.id, attendees: s.attendees });
    await publishSharedCalendarProposals({ db, lang: "it" }, { id: s.matteoBox.id, userId: s.matteo, email: s.matteoBox.email });
    // Giulia rifiuta: il giro dopo rilegge gli invitati dalla copia di Matteo.
    const declined = s.attendees.map((x) => (x.email === s.addr("giulia") ? { ...x, responseStatus: "declined" as const } : x));
    await db.update(calendarEvents).set({ attendees: declined as never }).where(eq(calendarEvents.id, a.id));

    expect(await closeDeclinedCalendarRecipients({ db }, s.matteoBox.id)).toBe(1);

    const cards = await db.select().from(notifications);
    expect(cards.find((c) => c.userId === s.giulia)!.status).toBe("handled");
    expect(cards.find((c) => c.userId === s.matteo)!.status).toBe("open");
    const [giulia] = await db.select().from(calendarProposalRecipients).where(eq(calendarProposalRecipients.userId, s.giulia));
    expect(giulia!.declinedAt).not.toBeNull();
    // La proposta resta aperta per gli altri.
    expect((await db.select().from(calendarProposals))[0]!.status).toBe("proposed");
    // Un secondo giro non rifà niente.
    expect(await closeDeclinedCalendarRecipients({ db }, s.matteoBox.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Il giro vero (`pollGoogleOnce`): eventi singoli condivisi, serie per casella.
// ---------------------------------------------------------------------------

function credentialsFor(account: typeof googleAccounts.$inferSelect): GoogleAccountCredentials {
  return {
    accountId: account.id,
    userId: account.userId,
    workspaceId: account.workspaceId,
    email: account.email,
    googleSub: account.googleSub,
    refreshToken: "refresh",
    clientId: "client-id",
    clientSecret: "client-secret",
    domains: ["acme.com"],
    scopes: [],
    proposalsEnabled: account.proposalsEnabled,
    gmailHistoryId: account.gmailHistoryId,
    calendarSyncToken: account.calendarSyncToken,
    disabledAt: account.disabledAt,
  };
}

const quietGmail = {
  refreshAccessToken: async () => ({ accessToken: "at", expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null }),
  listHistory: async () => ({ addedMessageIds: [], historyId: null, unreadChanges: [], nextPageToken: null }),
  listMessages: async () => ({ messageIds: [], nextPageToken: null }),
  getMessageMetadata: async () => {
    throw new Error("non previsto");
  },
  getMessageFull: async () => {
    throw new Error("non previsto");
  },
  getThreadFull: async (input: { id: string }) => ({ id: input.id, messages: [] }),
} as unknown as GmailClient;

function googleEvent(input: Partial<GoogleCalendarEvent> & { id: string }): GoogleCalendarEvent {
  return {
    status: "confirmed",
    title: "Consegna grafiche",
    description: null,
    allDay: false,
    startsAt: START,
    endsAt: new Date(START.getTime() + 3600_000),
    attendees: [],
    organizer: null,
    htmlLink: null,
    eventType: "default",
    transparency: "opaque",
    etag: null,
    iCalUID: null,
    visibility: "default",
    organizerSelf: false,
    updatedAt: null,
    recurringEventId: null,
    originalStartTime: null,
    timeZone: null,
    attachments: [],
    location: null,
    hangoutLink: null,
    conferenceEntryPoints: [],
    reminders: [],
    remindersUseDefault: false,
    ...input,
  };
}

function calendarWith(events: GoogleCalendarEvent[]): CalendarClient {
  return {
    listEvents: async () => ({ events, nextPageToken: null, nextSyncToken: "tok" }),
    getEvent: async (input: { eventId: string }) => ({ id: input.eventId, recurrence: [] }),
  } as unknown as CalendarClient;
}

function tickDeps(account: typeof googleAccounts.$inferSelect, calendar: CalendarClient): GooglePollerDeps {
  return {
    db,
    encryptionKey: randomBytes(32),
    select: fakeSelect(db, "legacy"),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    gmail: quietGmail,
    calendar,
    loadCredentials: async () => credentialsFor(account),
    intervalMinutes: 5,
    retentionDays: 90,
  };
}

describe("il giro del poller", () => {
  it("due caselle invitate allo stesso appuntamento: una proposta, una card a testa; un'occorrenza di SERIE resta per casella", async () => {
    const s = await scenario();
    // Il routing di oggi (flag spento): il dominio del cliente fra gli invitati porta il progetto.
    await db.insert(projectEmailRoutes).values({ projectId: s.project.id, kind: "sender_domain", value: "esterno.it" });
    // La serie di Matteo, accesa e col progetto scelto.
    await db.insert(calendarSeries).values({ accountId: s.matteoBox.id, recurringEventId: "weekly", enabled: true, leadDays: 30, action: "milestone", auto: false, projectId: s.project.id });
    const single = (id: string) => googleEvent({ id, iCalUID: s.uid, attendees: s.attendees, organizer: s.addr("matteo-box") });
    const occurrence = googleEvent({
      id: "weekly_1",
      title: "Riunione settimanale",
      iCalUID: `weekly-${s.tag}`,
      recurringEventId: "weekly",
      attendees: s.attendees,
      organizer: s.addr("matteo-box"),
      startsAt: new Date(START.getTime() + 3600_000 * 30),
      endsAt: new Date(START.getTime() + 3600_000 * 31),
    });

    // Una casella alla volta: la prima trova l'evento e crea la proposta, l'altra ci si lega.
    await db.update(googleAccounts).set({ nextSyncAt: new Date(Date.now() + 3600_000) }).where(eq(googleAccounts.id, s.giuliaBox.id));
    await pollGoogleOnce(tickDeps(s.matteoBox, calendarWith([single("g-matteo"), occurrence])));
    await db.update(googleAccounts).set({ nextSyncAt: new Date(Date.now() - 60_000) }).where(eq(googleAccounts.id, s.giuliaBox.id));
    await pollGoogleOnce(tickDeps(s.giuliaBox, calendarWith([single("g-giulia")])));

    const proposals = await db.select().from(calendarProposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.icalUid).toBe(s.uid);
    // Le card del singolo: una a Matteo, una a Giulia, nessuna agli altri.
    const recipients = await db.select().from(calendarProposalRecipients);
    expect(recipients.map((r) => r.userId).sort()).toEqual([s.matteo, s.giulia].sort());
    // L'occorrenza di serie: la card per casella di prima, a Matteo, sulla sua riga.
    const [weekly] = await db.select().from(calendarEvents).where(eq(calendarEvents.googleEventId, "weekly_1"));
    expect(weekly!.proposalNotificationId).not.toBeNull();
    expect(weekly!.calendarProposalId).toBeNull();
    const cards = await db.select().from(notifications);
    expect(cards).toHaveLength(3);
    expect(cards.find((c) => c.id === weekly!.proposalNotificationId)!.userId).toBe(s.matteo);
    // Nessuna copia del singolo ha una card per casella.
    for (const id of ["g-matteo", "g-giulia"]) {
      const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.googleEventId, id));
      expect(row!.proposalNotificationId).toBeNull();
      expect(row!.calendarProposalId).toBe(proposals[0]!.id);
    }
  });
});
