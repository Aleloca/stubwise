import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientReturning(status: number, body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(status, body));
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

describe("endpoints mail", () => {
  it("list: costruisce la querystring dai filtri e omette i campi assenti", async () => {
    const { c, fetchImpl } = clientReturning(200, { items: [], nextCursor: null });
    await c.mail.list({ status: "failed", project: ID }, "cur", 10);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail?status=failed&project=${ID}&cursor=cur&limit=10`);

    await c.mail.list();
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/mail");
  });

  it("summary: GET /api/me/mail/summary", async () => {
    const { c, fetchImpl } = clientReturning(200, { openProposals: 2, failed: 1, ignored: 0 });
    const summary = await c.mail.summary();
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/mail/summary");
    expect(summary).toEqual({ openProposals: 2, failed: 1, ignored: 0 });
  });

  it("get: GET /api/me/mail/:source/:id — l'estratto, textExcerpt può essere null", async () => {
    const detail = {
      id: ID,
      source: "email",
      accountId: ID,
      accountEmail: "ops@example.com",
      from: "Cliente <cliente@example.com>",
      to: ["ops@example.com"],
      subject: "Reso ordine #123",
      receivedAt: "2026-09-11T09:00:00.000Z",
      labels: [],
      textExcerpt: null,
      url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
    };
    const { c, fetchImpl } = clientReturning(200, detail);
    const result = await c.mail.get("email", ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/email/${ID}`);
    expect(result.textExcerpt).toBeNull();
    expect(result.from).toBe("Cliente <cliente@example.com>");
  });

  it("get: source 'email_triage' — il PADRE di uno smistamento, stesso path", async () => {
    const { c, fetchImpl } = clientReturning(200, {
      id: ID,
      source: "email",
      accountId: ID,
      accountEmail: "ops@example.com",
      from: "a@example.com",
      to: [],
      subject: null,
      receivedAt: "2026-09-11T09:00:00.000Z",
      labels: [],
      textExcerpt: null,
      url: "https://mail.google.com/x",
    });
    await c.mail.get("email_triage", ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/email_triage/${ID}`);
  });

  it("original: GET /api/me/mail/:source/:id/original — successo", async () => {
    const original = {
      subject: "Reso ordine #123",
      from: "cliente@example.com",
      to: ["ops@example.com"],
      cc: [],
      bodyText: "Vorrei restituire l'articolo.",
      bodyHtml: null,
      attachments: [],
    };
    const { c, fetchImpl } = clientReturning(200, original);
    const result = await c.mail.original("email", ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/email/${ID}/original`);
    expect(result.bodyText).toBe("Vorrei restituire l'articolo.");
  });

  it("original: 409 message_gone — il messaggio non esiste più su Gmail", async () => {
    const { c } = clientReturning(409, { code: "message_gone", message: "…" });
    const error = await c.mail.original("email", ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("message_gone");
  });

  it("original: 409 token_expired — la casella va ricollegata", async () => {
    const { c } = clientReturning(409, { code: "token_expired", message: "…" });
    const error = await c.mail.original("email", ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("token_expired");
  });

  it("original: 502 google_unavailable — Google irraggiungibile", async () => {
    const { c } = clientReturning(502, { code: "google_unavailable", message: "…" });
    const error = await c.mail.original("email", ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBe("google_unavailable");
  });

  it("repropose: POST sulla rotta con il source giusto nel path (email/calendar/email_triage)", async () => {
    const { c, fetchImpl } = clientReturning(200, { ok: true });
    await c.mail.repropose("email", ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/email/${ID}/repropose`);
    expect(fetchImpl.mock.calls.at(-1)![1]!.method).toBe("POST");

    await c.mail.repropose("calendar", ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/calendar/${ID}/repropose`);

    await c.mail.repropose("email_triage", ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/email_triage/${ID}/repropose`);
  });

  it("repropose: 409 not_reproposable — lo stato non lo permette", async () => {
    const { c } = clientReturning(409, { code: "not_reproposable", message: "…" });
    const error = await c.mail.repropose("email", ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("not_reproposable");
  });
});
