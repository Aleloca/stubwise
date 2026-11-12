import { describe, expect, it, vi } from "vitest";
import { UNKNOWN } from "@stubwise/shared";
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

  it("rejections: GET /api/me/mail/rejections, days solo se passato", async () => {
    const body = {
      days: 7,
      total: 3,
      accounts: [
        {
          accountId: ID,
          email: "ops@example.com",
          total: 3,
          reasons: [
            { reason: "automated", count: 3, domains: [{ domain: "github.com", count: 2 }, { domain: null, count: 1 }], otherDomains: 0 },
          ],
        },
      ],
    };
    const { c, fetchImpl } = clientReturning(200, body);
    expect(await c.mail.rejections()).toEqual(body);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/mail/rejections");

    await c.mail.rejections(30);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/mail/rejections?days=30");
  });

  it("rejections: un motivo che l'app non conosce arriva come UNKNOWN, non rompe la risposta", async () => {
    const { c } = clientReturning(200, {
      days: 7,
      total: 1,
      accounts: [
        {
          accountId: ID,
          email: "ops@example.com",
          total: 1,
          reasons: [{ reason: "quarantined", count: 1, domains: [], otherDomains: 0 }],
        },
      ],
    });
    const result = await c.mail.rejections();
    expect(result.accounts[0]?.reasons[0]?.reason).toBe(UNKNOWN);
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

  it("threads: la lista per conversazione, con i filtri opzionali", async () => {
    const { c, fetchImpl } = clientReturning(200, { items: [], nextCursor: null });
    await c.mail.threads();
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/mail/threads");

    await c.mail.threads(ID, "cur", 10);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/threads?account=${ID}&cursor=cur&limit=10`);
  });

  it("threads con un oggetto (area 6, F1.4): anche `q`, nella stessa querystring", async () => {
    const { c, fetchImpl } = clientReturning(200, { items: [], nextCursor: null });
    await c.mail.threads({ account: ID, q: "preventivo luglio", limit: 5 });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/threads?account=${ID}&limit=5&q=preventivo+luglio`);
    await c.mail.threads({});
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/mail/threads");
  });

  it("threads: una riga coi soli campi obbligatori si parsa (tutto il resto ha un default)", async () => {
    const { c } = clientReturning(200, {
      items: [
        {
          threadId: "t1",
          accountId: ID,
          accountEmail: "ops@example.com",
          lastFrom: "cliente@example.com",
          lastReceivedAt: "2026-09-11T09:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    const page = await c.mail.threads();
    expect(page.items[0]!.subject).toBeNull();
    expect(page.items[0]!.messageCount).toBe(1);
    expect(page.items[0]!.openProposals).toBe(0);
    expect(page.items[0]!.projectNames).toEqual([]);
  });

  it("thread: il dettaglio, con il threadId percent-encoded", async () => {
    const { c, fetchImpl } = clientReturning(200, {
      threadId: "t1",
      accountId: ID,
      accountEmail: "ops@example.com",
      url: "https://mail.google.com/x",
      messages: [
        {
          id: ID,
          from: "cliente@example.com",
          receivedAt: "2026-09-11T09:00:00.000Z",
          textExcerpt: "Ciao",
          admitted: false,
        },
      ],
    });
    const detail = await c.mail.thread("thread/con slash");
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/mail/threads/thread%2Fcon%20slash");
    // `admitted: false` = messaggio di contesto: si legge, non propone.
    expect(detail.messages[0]!.admitted).toBe(false);
    expect(detail.messages[0]!.proposalIds).toEqual([]);
    expect(detail.subject).toBeNull();
  });

  it("F2: i filtri nuovi di threads (importanza, progetto, senza progetto, importanti)", async () => {
    const { c, fetchImpl } = clientReturning(200, { items: [], nextCursor: null });
    await c.mail.threads({ importance: "high", project: ID, noProject: true, important: true, limit: 5 });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/threads?limit=5&importance=high&project=${ID}&noProject=true&important=true`);
  });

  it("F2: le proposte condivise, per messaggio e per id", async () => {
    const proposal = {
      id: ID,
      messageId: ID,
      projectId: ID,
      status: "open",
      createdAt: "2026-11-12T10:00:00.000Z",
      actions: [{ type: "create_task", args: { title: "X" }, label: "Crea la task «X»" }],
    };
    const list = clientReturning(200, { items: [proposal] });
    const items = await list.c.mail.proposals({ message: ID, status: "open" });
    expect(list.fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/proposals?message=${ID}&status=open`);
    expect(items.items[0]!.canConfirm).toBe(false);
    await list.c.mail.proposals({ thread: "t/1", account: ID });
    expect(list.fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/proposals?thread=t%2F1&account=${ID}`);
    const one = clientReturning(200, proposal);
    await one.c.mail.proposal(ID);
    expect(one.fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/proposals/${ID}`);
  });

  it("F2: decidere una proposta condivisa — ogni gesto è un POST col suo corpo, e l'esito si legge con lo schema condiviso", async () => {
    const calls: [string, unknown][] = [];
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      calls.push([String(url), init?.body ? JSON.parse(String(init.body)) : undefined]);
      return jsonResponse(200, { status: "confirmed", results: [{ kind: "task", id: "t1", code: "AUD-12" }] });
    });
    const c = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    const out = await c.mail.confirmProposal(ID, { indices: [0], edits: { "0": { title: "X" } } });
    expect(out).toEqual({ status: "confirmed", results: [{ kind: "task", id: "t1", code: "AUD-12" }], error: null, projectId: null });
    await c.mail.confirmProposalWithMembers(ID, { addOutsiders: [ID] });
    await c.mail.ignoreProposal(ID);
    await c.mail.handProposal(ID);
    await c.mail.reassignProposal(ID, ID);
    await c.mail.chooseProposalProject(ID, ID);
    expect(calls.map(([url]) => url.replace(`/api/me/mail/proposals/${ID}`, ""))).toEqual([
      "/confirm",
      "/confirm-with-members",
      "/ignore",
      "/hand",
      "/reassign",
      "/choose-project",
    ]);
    expect(calls[0]![1]).toEqual({ indices: [0], edits: { "0": { title: "X" } } });
    expect(calls[4]![1]).toEqual({ projectId: ID });
  });

  it("F3: le bozze — elenco, la bozza di, salva, elimina", async () => {
    const draft = { id: null, accountId: ID, mode: "reply" };
    const { c, fetchImpl } = clientReturning(200, draft);
    const out = await c.mail.draft({ account: ID, thread: "t/1", mode: "reply" });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/drafts/compose?account=${ID}&thread=t%2F1&mode=reply`);
    expect(out).toMatchObject({ id: null, to: [], subject: "", quote: true });
    await c.mail.saveDraft({ accountId: ID, mode: "new", subject: "x" });
    const [, init] = fetchImpl.mock.calls.at(-1)!;
    expect(init!.method).toBe("PUT");
  });

  it("setRead (area 6, F1.3): POST col body { account, read }; `unread` assente (server di prima) si legge false", async () => {
    const { c, fetchImpl } = clientReturning(200, {
      threadId: "t1",
      accountId: ID,
      accountEmail: "ops@example.com",
      url: "https://mail.google.com/x",
      messages: [{ id: ID, from: "cliente@example.com", receivedAt: "2026-09-11T09:00:00.000Z" }],
    });
    const detail = await c.mail.setRead("thread/1", ID, true);
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe("/api/me/mail/threads/thread%2F1/read");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ account: ID, read: true });
    expect(detail.messages[0]!.unread).toBe(false);
  });

  it("thread: 404 su un thread che non è dell'utente (mai 403)", async () => {
    const { c } = clientReturning(404, { code: "not_found", message: "…" });
    const error = await c.mail.thread("t1").catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
  });

  it("repropose: 409 not_reproposable — lo stato non lo permette", async () => {
    const { c } = clientReturning(409, { code: "not_reproposable", message: "…" });
    const error = await c.mail.repropose("email", ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("not_reproposable");
  });

  it("gli allegati di una bozza: multipart col campo `file`, dal Drive con l'id, e la rimozione; rispondono con la bozza", async () => {
    const draft = { id: ID, accountId: ID, mode: "new", attachments: [] };
    const { c, fetchImpl } = clientReturning(200, draft);
    expect(await c.mail.uploadAttachment(ID, new Blob(["x"]), "nota.txt")).toMatchObject({ id: ID });
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/me/mail/drafts/${ID}/attachments`);
    expect(init!.method).toBe("POST");
    expect((init!.body as FormData).get("file")).toBeInstanceOf(Blob);
    await c.mail.attachDriveFile(ID, "22222222-2222-4222-8222-222222222222");
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/drafts/${ID}/attachments/drive`);
    expect(fetchImpl.mock.calls.at(-1)![1]!.body).toBe(JSON.stringify({ driveFileId: "22222222-2222-4222-8222-222222222222" }));
    await c.mail.removeAttachment(ID, "33333333-3333-4333-8333-333333333333");
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/me/mail/drafts/${ID}/attachments/33333333-3333-4333-8333-333333333333`);
    expect(fetchImpl.mock.calls.at(-1)![1]!.method).toBe("DELETE");
  });

  it("recipients(q): la q nella querystring, e un group sconosciuto non rompe la lista", async () => {
    const { c, fetchImpl } = clientReturning(200, { items: [{ name: "Marta", email: "m@acme.com", personId: ID, group: "team" }, { email: "x@y.it", group: "rubrica" }] });
    const out = await c.mail.recipients("mar ta&");
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/me/mail/recipients?q=mar+ta%26");
    expect(out.items[0]).toMatchObject({ email: "m@acme.com", group: "team", personId: ID });
    expect(out.items[1]).toMatchObject({ email: "x@y.it", group: UNKNOWN, name: null, personId: null });
  });

  it("la bozza di Claude: il path dello stream (POST, SSE) in un posto solo", () => {
    const { c } = clientReturning(200, {});
    expect(c.mail.claudeDraftPath()).toBe("/api/me/mail/drafts/claude");
  });
});
