import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const SERIES = "abc123_20260911T090000Z";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientReturning(status: number, body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(status, body));
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

const EVENT = {
  id: ID,
  accountId: ID,
  accountEmail: "ops@example.com",
  recurringEventId: null,
  projectId: null,
  projectName: null,
  title: "Riunione settimanale",
  organizer: "capo@example.com",
  attendees: [{ email: "ops@example.com", responseStatus: "accepted" }],
  startsAt: "2026-09-14T09:00:00.000Z",
  endsAt: "2026-09-14T10:00:00.000Z",
  allDay: false,
  status: "new",
  outcome: null,
  error: null,
  url: "https://calendar.google.com/x",
  eventUrl: "https://calendar.google.com/event?eid=x",
  reproposable: false,
};

const SERIES_ITEM = {
  accountId: ID,
  accountEmail: "ops@example.com",
  recurringEventId: SERIES,
  title: "Riunione settimanale",
  occurrenceCount: 12,
  nextOccurrenceAt: "2026-09-14T09:00:00.000Z",
  enabled: false,
  projectId: null,
  projectName: null,
  action: "milestone",
  leadDays: 2,
  auto: false,
};

describe("endpoints calendar — la lista keyset", () => {
  it("list: costruisce la querystring dai filtri e omette i campi assenti", async () => {
    const { c, fetchImpl } = clientReturning(200, { items: [], nextCursor: null });
    await c.calendar.list({ status: "proposed", project: ID }, "cur", 10);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/calendar?status=proposed&project=${ID}&cursor=cur&limit=10`);

    await c.calendar.list();
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/calendar");
  });
});

describe("endpoints calendar — l'intervallo della griglia", () => {
  it("range: GET /range con from/to (e account solo se c'è)", async () => {
    const { c, fetchImpl } = clientReturning(200, { items: [EVENT], nextCursor: null });
    const page = await c.calendar.range({ from: "2026-08-31T00:00:00.000Z", to: "2026-10-05T00:00:00.000Z" });

    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(
      "/api/me/calendar/range?from=2026-08-31T00%3A00%3A00.000Z&to=2026-10-05T00%3A00%3A00.000Z",
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.title).toBe("Riunione settimanale");
    // Nessuna paginazione su questa rotta: il tetto sull'ampiezza fa da limite.
    expect(page.nextCursor).toBeNull();

    await c.calendar.range({ from: "2026-08-31T00:00:00.000Z", to: "2026-10-05T00:00:00.000Z", account: ID });
    expect(fetchImpl.mock.calls.at(-1)![0]).toContain(`account=${ID}`);
  });

  it("range: 400 invalid_range — 'to' non è dopo 'from'", async () => {
    const { c } = clientReturning(400, { code: "invalid_range", message: "…" });
    const error = await c.calendar
      .range({ from: "2026-09-14T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe("invalid_range");
  });

  it("range: 400 range_too_wide — oltre i 100 giorni (MAX_RANGE_DAYS)", async () => {
    const { c } = clientReturning(400, { code: "range_too_wide", message: "…" });
    const error = await c.calendar
      .range({ from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe("range_too_wide");
  });

  it("un evento con i soli campi obbligatori si parsa lo stesso: i campi della fase 9 hanno un default", async () => {
    // L'app si aggiorna dagli store, il server no: un'istanza self-hosted più
    // vecchia (o un rollback) manda una riga SENZA i campi aggiunti dalla fase
    // 9 — `attendees`, `endsAt`, `allDay`, `eventUrl`, `recurringEventId`. Il
    // parse deve reggere, non fallire l'intera pagina.
    const { c } = clientReturning(200, {
      items: [
        {
          id: ID,
          accountId: ID,
          accountEmail: "ops@example.com",
          projectId: null,
          startsAt: "2026-09-14T09:00:00.000Z",
          status: "new",
        },
      ],
      nextCursor: null,
    });
    const page = await c.calendar.range({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" });
    expect(page.items[0]!.attendees).toEqual([]);
    expect(page.items[0]!.endsAt).toBeNull();
    expect(page.items[0]!.allDay).toBe(false);
    expect(page.items[0]!.eventUrl).toBeNull();
    expect(page.items[0]!.recurringEventId).toBeNull();
  });
});

describe("endpoints calendar — le serie", () => {
  it("series: GET /series, con `account` solo se passato", async () => {
    const { c, fetchImpl } = clientReturning(200, { items: [SERIES_ITEM] });
    const list = await c.calendar.series();
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/calendar/series");
    // Una serie non configurata è SPENTA, non un errore.
    expect(list.items[0]!.enabled).toBe(false);
    expect(list.items[0]!.action).toBe("milestone");

    await c.calendar.series(ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/calendar/series?account=${ID}`);
  });

  it("series: una riga con i soli campi obbligatori si parsa (tutto il resto ha un default)", async () => {
    const { c } = clientReturning(200, {
      items: [{ accountId: ID, accountEmail: "ops@example.com", recurringEventId: SERIES }],
    });
    const list = await c.calendar.series();
    expect(list.items[0]!.enabled).toBe(false);
    expect(list.items[0]!.auto).toBe(false);
    expect(list.items[0]!.leadDays).toBe(2);
    expect(list.items[0]!.occurrenceCount).toBe(0);
    expect(list.items[0]!.nextOccurrenceAt).toBeNull();
  });

  it("putSeries: PUT con il corpo INTEGRALE, id nel path percent-encoded", async () => {
    const { c, fetchImpl } = clientReturning(200, { ok: true });
    const result = await c.calendar.putSeries("serie con spazi/e slash", {
      accountId: ID,
      enabled: true,
      projectId: ID,
      action: "backlog_item",
      leadDays: 3,
      auto: false,
    });

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe("/api/me/calendar/series/serie%20con%20spazi%2Fe%20slash");
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(String(init!.body))).toEqual({
      accountId: ID,
      enabled: true,
      projectId: ID,
      action: "backlog_item",
      leadDays: 3,
      auto: false,
    });
    expect(result.ok).toBe(true);
  });

  it("putSeries: 400 project_required — accendere una serie senza progetto", async () => {
    // Il server è la rete, non il controllo: la UI non deve poter comporre
    // questo corpo (design fase 7b §4, "il progetto si fissa, non si
    // ri-deduce"). Il client però deve riportare il codice vero, non uno
    // generico, o chi lo usa non sa cosa dire a chi guarda.
    const { c } = clientReturning(400, { code: "project_required", message: "…" });
    const error = await c.calendar
      .putSeries(SERIES, { accountId: ID, enabled: true, projectId: null })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe("project_required");
  });

  it("putSeries: 404 not_found — la casella o la serie non sono di questo utente", async () => {
    // Mai 403: non si conferma che l'id esiste (ACL di `me-calendar.ts`).
    const { c } = clientReturning(404, { code: "not_found", message: "…" });
    const error = await c.calendar
      .putSeries(SERIES, { accountId: ID, enabled: false, projectId: null })
      .catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
  });

  it("deleteSeries: DELETE con `account` in querystring", async () => {
    const { c, fetchImpl } = clientReturning(200, { ok: true });
    await c.calendar.deleteSeries(SERIES, ID);
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/me/calendar/series/${SERIES}?account=${ID}`);
    expect(init!.method).toBe("DELETE");
  });
});
