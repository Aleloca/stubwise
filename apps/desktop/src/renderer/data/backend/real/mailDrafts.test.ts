import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { createAppClient } from "./transport";
import { installFakeServer, ME_ID } from "./fakeServer";
import { mail } from "./mail";

// Le bozze della Posta nella build app (area 6, fetta 3): bozze di GMAIL
// (D7 = b), una per persona, conversazione e modalità. L'indirizzamento di
// Rispondi, Rispondi a tutti e Inoltra lo calcola il server; una bozza nuova
// non salvata ha `id: null` sul server.

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const ACC2 = "aaaaaaaa-2222-4222-8222-222222222222";
const D1 = "dfdfdfdf-1111-4111-8111-111111111111";
const M1 = "dddddddd-1111-4111-8111-111111111111";

const draft = (over: Record<string, unknown> = {}) => ({
  id: D1,
  accountId: ACC,
  threadId: "t-1",
  mode: "reply",
  replyToMessageId: M1,
  to: [{ email: "bob@client.test", name: "Bob Rossi" }],
  cc: [{ email: "ada@acme.test", name: null }],
  subject: "Re: Preventivo",
  body: "Grazie, ci sentiamo.",
  attachments: [],
  quote: true,
  updatedAt: "2026-11-12T10:00:00.000Z",
  ...over,
});

const account = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

const accounts = { "GET /api/me/google/accounts": { body: [account(), account({ id: ACC2, email: "ada@beta.test" })] } };
const query = (path: string) => new URLSearchParams(path.split("?")[1] ?? "");

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  session.personId = ME_ID;
});
afterEach(() => {
  session.personId = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le bozze: leggere", () => {
  it("le mie bozze, dalla più recente, della loro conversazione; io sono io fra i destinatari", async () => {
    installFakeServer({
      ...accounts,
      "GET /api/me/mail/drafts": {
        body: { items: [draft({ updatedAt: "2026-11-12T08:00:00.000Z", threadId: "t-0", id: "dfdfdfdf-0000-4000-8000-000000000000" }), draft()] },
      },
    });
    const list = await mail.listDrafts();
    expect(list.map((d) => d.threadId)).toEqual([`${ACC}_t-1`, `${ACC}_t-0`]);
    expect(list[0]).toMatchObject({
      id: D1,
      personId: ME_ID,
      mode: "reply",
      replyToMessageId: M1,
      to: [{ name: "Bob Rossi", email: "bob@client.test", personId: null }],
      cc: [{ name: "ada@acme.test", email: "ada@acme.test", personId: ME_ID }],
      subject: "Re: Preventivo",
      body: "Grazie, ci sentiamo.",
      attachments: [],
      updatedAt: "2026-11-12T10:00:00.000Z",
    });
  });

  it("la bozza di una conversazione: il server la indirizza, con la casella della conversazione", async () => {
    const { seen } = installFakeServer({ ...accounts, "GET /api/me/mail/drafts/compose": { body: draft({ id: null }) } });
    const d = await mail.getDraft(`${ACC2}_t-1`, "replyAll");
    const q = query(seen.find((r) => r.path.startsWith("/api/me/mail/drafts/compose"))!.path);
    expect([q.get("account"), q.get("thread"), q.get("mode")]).toEqual([ACC2, "t-1", "replyAll"]);
    expect(d.to).toEqual([{ name: "Bob Rossi", email: "bob@client.test", personId: null }]);
  });

  it("la firma di Gmail della casella e il suo stato (la aggiunge il server all'invio, mai nel corpo)", async () => {
    installFakeServer({ ...accounts, "GET /api/me/mail/drafts/compose": { body: draft({ id: null, signature: "Ada Lovelace\nAcme", signatureStatus: "present" }) } });
    expect(await mail.getDraft(`${ACC}_t-1`, "reply")).toMatchObject({ signature: "Ada Lovelace\nAcme", signatureStatus: "present", body: "Grazie, ci sentiamo." });
    installFakeServer({ ...accounts, "GET /api/me/mail/drafts/compose": { body: draft({ id: null }) } });
    expect(await mail.getDraft(`${ACC}_t-1`, "reply")).toMatchObject({ signature: null, signatureStatus: "none" });
  });

  it("una bozza non ancora salvata ha un id suo (la conversazione e la modalità), non null", async () => {
    installFakeServer({ ...accounts, "GET /api/me/mail/drafts/compose": { body: draft({ id: null }) } });
    const d = await mail.getDraft(`${ACC}_t-1`, "reply");
    expect(d.id).toMatch(/^unsaved_/);
  });

  it("l'email nuova: dalla prima casella collegata, senza conversazione", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/google/accounts": { body: [account({ disabledAt: "2026-11-01T00:00:00.000Z" }), account({ id: ACC2, email: "ada@beta.test" })] },
      "GET /api/me/mail/drafts/compose": { body: draft({ id: null, accountId: ACC2, threadId: null, mode: "new", to: [], cc: [], subject: "", body: "" }) },
    });
    const d = await mail.getDraft(null, "new");
    const q = query(seen.find((r) => r.path.startsWith("/api/me/mail/drafts/compose"))!.path);
    expect(q.get("account")).toBe(ACC2);
    expect(q.get("thread")).toBeNull();
    expect(d).toMatchObject({ threadId: null, mode: "new" });
  });

  it("lo slot di Support (area 8) non c'è: `invalid: slot`", async () => {
    installFakeServer({ ...accounts });
    await expect(mail.getDraft(null, "new", "support-AUD-S1")).rejects.toThrow("invalid: slot");
  });
});

describe("le bozze: salvare ed eliminare", () => {
  it("salvare: la casella e il thread Gmail della conversazione, i destinatari come indirizzi", async () => {
    const { seen } = installFakeServer({ ...accounts, "PUT /api/me/mail/drafts": { body: draft() } });
    const saved = await mail.saveDraft({
      threadId: `${ACC}_t-1`,
      mode: "reply",
      replyToMessageId: M1,
      to: [{ name: "Bob Rossi", email: "bob@client.test", personId: null }],
      // Un indirizzo senza nome ha per nome l'indirizzo stesso: al server va senza nome.
      cc: [{ name: "carla@client.test", email: "carla@client.test", personId: null }],
      subject: "Re: Preventivo",
      body: "Grazie, ci sentiamo.",
      attachments: [],
      quote: false,
    });
    expect(seen.find((r) => r.method === "PUT")!.body).toEqual({
      accountId: ACC,
      threadId: "t-1",
      mode: "reply",
      replyToMessageId: M1,
      to: [{ email: "bob@client.test", name: "Bob Rossi" }],
      cc: [{ email: "carla@client.test", name: null }],
      subject: "Re: Preventivo",
      body: "Grazie, ci sentiamo.",
      quote: false,
    });
    expect(saved.id).toBe(D1);
  });

  it("«Tieni la mia»: il salvataggio scrive sopra la versione di Gmail (`overwrite`)", async () => {
    const { seen } = installFakeServer({ ...accounts, "PUT /api/me/mail/drafts": { body: draft() } });
    await mail.saveDraft({ threadId: `${ACC}_t-1`, mode: "reply", replyToMessageId: null, to: [], cc: [], subject: "", body: "x", attachments: [], overwrite: true });
    expect(seen.find((r) => r.method === "PUT")!.body).toMatchObject({ overwrite: true });
    await mail.saveDraft({ threadId: `${ACC}_t-1`, mode: "reply", replyToMessageId: null, to: [], cc: [], subject: "", body: "x", attachments: [] });
    expect((seen.filter((r) => r.method === "PUT")[1]!.body as Record<string, unknown>).overwrite).toBeUndefined();
  });

  it("modificata da Gmail nel frattempo: `draft_changed` (non vince l'ultimo)", async () => {
    installFakeServer({ ...accounts, "PUT /api/me/mail/drafts": { status: 409, body: { code: "draft_changed", message: "x" } } });
    await expect(
      mail.saveDraft({ threadId: `${ACC}_t-1`, mode: "reply", replyToMessageId: null, to: [], cc: [], subject: "", body: "x", attachments: [] }),
    ).rejects.toThrow("draft_changed");
  });

  it("gli errori della casella: permesso nuovo, scaduta, Google non raggiungibile", async () => {
    const cases: [number, string, string][] = [
      [409, "google_scope_missing", "google_scope_missing"],
      [409, "account_disabled", "google_not_connected"],
      [409, "token_expired", "google_not_connected"],
      [502, "google_unavailable", "google_unavailable"],
    ];
    for (const [status, code, error] of cases) {
      installFakeServer({ ...accounts, "PUT /api/me/mail/drafts": { status, body: { code, message: "x" } } });
      await expect(
        mail.saveDraft({ threadId: null, mode: "new", replyToMessageId: null, to: [], cc: [], subject: "", body: "x", attachments: [] }),
      ).rejects.toThrow(error);
    }
  });

  it("eliminare: su Gmail e in Stubwise; una mai salvata non chiama niente", async () => {
    const { seen } = installFakeServer({ ...accounts, [`DELETE /api/me/mail/drafts/${D1}`]: { status: 204 } });
    await mail.discardDraft(D1);
    await mail.discardDraft("unsaved_x");
    expect(seen.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/api/me/mail/drafts/${D1}`]);
  });

  it("«Annulla» di Elimina: la bozza si salva di nuovo, uguale", async () => {
    const { seen } = installFakeServer({ ...accounts, "PUT /api/me/mail/drafts": { body: draft() } });
    const r = await mail.restoreDiscardedDraft({
      threadId: `${ACC}_t-1`,
      mode: "reply",
      replyToMessageId: M1,
      to: [{ name: "Bob Rossi", email: "bob@client.test", personId: null }],
      cc: [],
      subject: "Re: Preventivo",
      body: "Grazie, ci sentiamo.",
      attachments: [],
    });
    expect(seen.filter((x) => x.method === "PUT")).toHaveLength(1);
    expect(r).toMatchObject({ draft: { id: D1 }, droppedAttachments: [] });
  });
});


describe("gli allegati di una bozza (salvati con lei)", () => {
  const ATT = "a7a7a7a7-1111-4111-8111-111111111111";
  const DRV = "d1d1d1d1-1111-4111-8111-111111111111";
  const input = (attachments: unknown[]) => ({
    threadId: `${ACC}_t-1`,
    mode: "reply" as const,
    replyToMessageId: null,
    to: [],
    cc: [],
    subject: "",
    body: "x",
    attachments: attachments as never[],
  });
  /**
   * Il ponte del desktop: il main carica il file (token, streaming). Il client
   * nasce prima, così le altre richieste vanno al server finto.
   */
  function bridge() {
    setAppClientForTests(createAppClient());
    const upload = vi.fn(async ({ path }: { path: string }) => ({ ok: true, body: draft({ attachments: [{ id: ATT, name: "listino.pdf", sizeBytes: 3, driveFileId: null, as: "copy" }] }), path }));
    vi.stubGlobal("stubwise", {
      files: { register: vi.fn(async () => ({ ok: true, grant: "g" })), onProgress: () => () => undefined, cancel: vi.fn() },
      api: { upload },
    });
    return upload;
  }

  it("un file dal disco si carica sulla bozza salvata, una volta sola anche salvando di nuovo", async () => {
    const upload = bridge();
    installFakeServer({ ...accounts, "PUT /api/me/mail/drafts": { body: draft() } });
    const file = new File(["abc"], "listino.pdf");
    const local = { id: "up-1", name: "listino.pdf", sizeBytes: 3, driveFileId: null, as: "copy", file };
    const saved = await mail.saveDraft(input([local]));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toMatchObject({ path: `/api/me/mail/drafts/${D1}/attachments` });
    expect(saved.attachments.map((a) => a.name)).toEqual(["listino.pdf"]);
    await mail.saveDraft(input([local]));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("un file del Drive si allega dal Drive; già sulla bozza non si riallega", async () => {
    const { seen } = installFakeServer({
      ...accounts,
      "PUT /api/me/mail/drafts": () => ({ body: draft({ attachments: attached ? [{ id: ATT, name: "brief.pdf", sizeBytes: 9, driveFileId: DRV, as: "copy" }] : [] }) }),
      [`POST /api/me/mail/drafts/${D1}/attachments/drive`]: () => {
        attached = true;
        return { body: draft({ attachments: [{ id: ATT, name: "brief.pdf", sizeBytes: 9, driveFileId: DRV, as: "copy" }] }) };
      },
    });
    let attached = false;
    const drive = { id: `att-${DRV}`, name: "brief.pdf", sizeBytes: 9, driveFileId: DRV, as: "copy" };
    await mail.saveDraft(input([drive]));
    await mail.saveDraft(input([drive]));
    expect(seen.filter((r) => r.path.endsWith("/attachments/drive")).map((r) => r.body)).toEqual([{ driveFileId: DRV }]);
  });

  it("un allegato tolto dalla bozza si toglie sul server", async () => {
    const { seen } = installFakeServer({
      ...accounts,
      "PUT /api/me/mail/drafts": { body: draft({ attachments: [{ id: ATT, name: "vecchio.pdf", sizeBytes: 1, driveFileId: null, as: "copy" }] }) },
      [`DELETE /api/me/mail/drafts/${D1}/attachments/${ATT}`]: { body: draft({ attachments: [] }) },
    });
    const saved = await mail.saveDraft(input([]));
    expect(seen.some((r) => r.method === "DELETE" && r.path.endsWith(`/attachments/${ATT}`))).toBe(true);
    expect(saved.attachments).toEqual([]);
  });

  it("gli errori degli allegati nelle parole del prototipo", async () => {
    const cases: [number, string, string][] = [
      [400, "too_large", "invalid: too_large"],
      [400, "too_many_attachments", "invalid: attachments"],
      [400, "storage_not_configured", "invalid: storage_off"],
      [409, "attachment_unavailable", "attachment_unavailable"],
    ];
    for (const [status, code, error] of cases) {
      installFakeServer({
        ...accounts,
        "PUT /api/me/mail/drafts": { body: draft() },
        [`POST /api/me/mail/drafts/${D1}/attachments/drive`]: { status, body: { code, message: "x" } },
      });
      await expect(mail.saveDraft(input([{ id: "att-x", name: "x.pdf", sizeBytes: 1, driveFileId: DRV, as: "copy" }]))).rejects.toThrow(error);
    }
  });
});

describe("allegare un file del Drive a una bozza salvata", () => {
  it("dal Drive, la bozza riscritta; un file che non vedo: `attachment_unavailable`", async () => {
    const DRV = "d1d1d1d1-1111-4111-8111-111111111111";
    installFakeServer({
      ...accounts,
      [`POST /api/me/mail/drafts/${D1}/attachments/drive`]: { body: draft({ attachments: [{ id: "a7a7a7a7-1111-4111-8111-111111111111", name: "brief.pdf", sizeBytes: 9, driveFileId: DRV, as: "copy" }] }) },
    });
    expect((await mail.attachDriveFile(D1, DRV)).attachments.map((a) => a.driveFileId)).toEqual([DRV]);
    installFakeServer({
      ...accounts,
      [`POST /api/me/mail/drafts/${D1}/attachments/drive`]: { status: 409, body: { code: "attachment_unavailable", message: "x" } },
    });
    await expect(mail.attachDriveFile(D1, DRV)).rejects.toThrow("attachment_unavailable");
  });
});

describe("i destinatari suggeriti", () => {
  it("prima il team, poi gli indirizzi della mia posta; da 2 caratteri", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/mail/recipients": {
        body: {
          items: [
            { name: "Carla Bianchi", email: "carla@acme.test", personId: "88888888-2222-4222-8222-222222222222", group: "team" },
            { name: "Bob Rossi", email: "bob@client.test", personId: null, group: "mail" },
            { name: null, email: "dan@client.test", personId: null, group: "mail" },
          ],
        },
      },
    });
    expect(await mail.suggestRecipients("b")).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(await mail.suggestRecipients("bo")).toEqual([
      { name: "Carla Bianchi", email: "carla@acme.test", personId: "88888888-2222-4222-8222-222222222222", group: "team" },
      { name: "Bob Rossi", email: "bob@client.test", personId: null, group: "mail" },
      // Senza nome, il nome è l'indirizzo (come nel prototipo).
      { name: "dan@client.test", email: "dan@client.test", personId: null, group: "mail" },
    ]);
    expect(query(seen[0]!.path).get("q")).toBe("bo");
  });
});
