import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { mail } from "./mail";

// L'invio della Posta nella build app (area 6, fetta 3): il server trattiene
// l'invio per 10 secondi (D6), «Annulla» rimette la bozza, un invio fallito
// non si ritenta da solo («Riprova», «Elimina»).

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const D1 = "dfdfdfdf-1111-4111-8111-111111111111";
const O1 = "0f0f0f0f-1111-4111-8111-111111111111";

const draft = (over: Record<string, unknown> = {}) => ({
  id: D1,
  accountId: ACC,
  threadId: "t-1",
  mode: "reply",
  replyToMessageId: null,
  to: [{ email: "bob@client.test", name: "Bob" }],
  cc: [],
  subject: "Re: Preventivo",
  body: "Grazie.",
  attachments: [],
  quote: true,
  updatedAt: "2026-11-12T10:00:00.000Z",
  ...over,
});

const outgoing = (over: Record<string, unknown> = {}) => ({
  messageId: O1,
  threadId: "t-1",
  state: "queued",
  undoUntil: "2026-11-12T10:00:10.000Z",
  error: null,
  sentAt: null,
  ...over,
});

const account = {
  id: ACC,
  email: "ada@acme.test",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Acme",
  scopes: [],
  proposalsEnabled: true,
  connectedAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: "2026-11-12T09:58:00.000Z",
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
  syncRequestedAt: null,
};
const base = {
  "GET /api/me/google/accounts": { body: [account] },
  "GET /api/me/mail/drafts": { body: { items: [draft()] } },
};

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  session.personId = ME_ID;
});
afterEach(() => {
  session.personId = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le costanti della scrittura", () => {
  it("«Annulla» per 10 secondi (D6), al più 10 allegati e 25 MB", () => {
    expect(mail.MAIL_UNDO_MS).toBe(10_000);
    expect(mail.MAIL_MAX_ATTACHMENTS).toBe(10);
    expect(mail.MAIL_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("Invia", () => {
  it("l'invio della bozza: l'id dell'invio, la sua conversazione, fin quando si annulla", async () => {
    const { seen } = installFakeServer({ ...base, [`POST /api/me/mail/drafts/${D1}/send`]: { body: outgoing() } });
    expect(await mail.sendDraft(D1)).toEqual({ messageId: O1, threadId: `${ACC}_t-1`, undoUntil: "2026-11-12T10:00:10.000Z" });
    expect(seen.some((r) => r.method === "POST" && r.path === `/api/me/mail/drafts/${D1}/send`)).toBe(true);
  });

  it("un'email nuova: la conversazione la sa il server solo dopo la partenza", async () => {
    installFakeServer({
      ...base,
      "GET /api/me/mail/drafts": { body: { items: [draft({ threadId: null, mode: "new" })] } },
      [`POST /api/me/mail/drafts/${D1}/send`]: { body: outgoing({ threadId: null }) },
    });
    expect((await mail.sendDraft(D1)).threadId).toBe("");
  });

  it("una bozza che non c'è (o non è mia): `not_found`; il resto lo dice l'invio, dopo", async () => {
    installFakeServer({ ...base, [`POST /api/me/mail/drafts/${D1}/send`]: { status: 404, body: { code: "not_found", message: "x" } } });
    await expect(mail.sendDraft(D1)).rejects.toThrow("not_found");
  });

  it("«è partito?»: si rilegge l'invio finché non esce dai suoi 10 s (partito, fallito o annullato)", async () => {
    vi.useFakeTimers();
    let state = "queued";
    installFakeServer({ [`GET /api/me/mail/outgoing/${O1}`]: () => ({ body: outgoing({ state }) }) });
    let settled = false;
    void mail.whenSendSettled(O1).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(settled).toBe(false);
    state = "sent";
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toBe(true);
  });
});

describe("Annulla, Riprova, Elimina", () => {
  it("«Annulla» entro i 10 s: la bozza torna", async () => {
    installFakeServer({ ...base, [`POST /api/me/mail/outgoing/${O1}/undo`]: { body: { draft: draft(), droppedAttachments: [] } } });
    const r = await mail.undoSend(O1);
    expect(r.draft).toMatchObject({ id: D1, threadId: `${ACC}_t-1`, body: "Grazie." });
    expect(r.droppedAttachments).toEqual([]);
  });

  it("«Annulla» troppo tardi: `too_late`; con un'altra bozza nella conversazione: `draft_slot_taken`", async () => {
    installFakeServer({ ...base, [`POST /api/me/mail/outgoing/${O1}/undo`]: { status: 409, body: { code: "too_late", message: "x" } } });
    await expect(mail.undoSend(O1)).rejects.toThrow("too_late");
    installFakeServer({ ...base, [`POST /api/me/mail/outgoing/${O1}/undo`]: { status: 409, body: { code: "draft_slot_taken", message: "x" } } });
    await expect(mail.undoSend(O1)).rejects.toThrow("draft_slot_taken");
  });

  it("gli allegati che non stanno più nei limiti sono detti per nome", async () => {
    installFakeServer({ ...base, [`POST /api/me/mail/outgoing/${O1}/undo`]: { body: { draft: draft(), droppedAttachments: ["listino.pdf"] } } });
    expect((await mail.undoSend(O1)).droppedAttachments.map((a) => a.name)).toEqual(["listino.pdf"]);
  });

  it("«Riprova» un invio fallito: un invio nuovo dai suoi 10 s", async () => {
    installFakeServer({ ...base, [`POST /api/me/mail/outgoing/${O1}/retry`]: { body: outgoing() } });
    expect(await mail.retrySend(O1)).toMatchObject({ messageId: O1, undoUntil: "2026-11-12T10:00:10.000Z" });
  });

  it("«Riprova» dopo un Invia da qui: la conversazione nella casella della bozza", async () => {
    installFakeServer({
      ...base,
      [`POST /api/me/mail/drafts/${D1}/send`]: { body: outgoing() },
      [`POST /api/me/mail/outgoing/${O1}/retry`]: { body: outgoing() },
    });
    await mail.sendDraft(D1);
    expect((await mail.retrySend(O1)).threadId).toBe(`${ACC}_t-1`);
  });

  it("«Elimina» un invio fallito: la bozza torna; uno che non è fallito: `not_failed`", async () => {
    installFakeServer({ ...base, [`POST /api/me/mail/outgoing/${O1}/discard`]: { body: { draft: draft(), droppedAttachments: [] } } });
    expect((await mail.deleteFailedSend(O1)).draft.id).toBe(D1);
    installFakeServer({ ...base, [`POST /api/me/mail/outgoing/${O1}/discard`]: { status: 409, body: { code: "not_failed", message: "x" } } });
    await expect(mail.deleteFailedSend(O1)).rejects.toThrow("not_failed");
  });
});
