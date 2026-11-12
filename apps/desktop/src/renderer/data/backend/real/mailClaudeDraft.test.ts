import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { mail } from "./mail";
import { createAppClient } from "./transport";

// La bozza di Claude nella Posta della build app (area 6, fetta 3): arriva a
// pezzi (SSE) e resta una PROPOSTA — non salva e non spedisce, il testo lo
// mette nel campo chi scrive. Sul desktop passa dal main (il token non lascia
// mai il main), sul web col fetch e il cookie, dietro lo stesso adattatore.

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const PRJ = "22222222-2222-4222-8222-222222222222";
const T1 = "77777777-1111-4111-8111-111111111111";

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
const accounts = { "GET /api/me/google/accounts": { body: [account] } };

type Msg = { type: string; [k: string]: unknown };

/** Il ponte del desktop: registra l'apertura e lascia al test di mandare i messaggi del main. */
function bridge() {
  const opened: { path: string; body: unknown; send: (m: Msg) => void; closed: boolean }[] = [];
  vi.stubGlobal("stubwise", {
    openStream: (path: string, onMessage: (m: Msg) => void, options: { body?: unknown } = {}) => {
      const entry = { path, body: options.body, send: onMessage, closed: false };
      opened.push(entry);
      return () => {
        entry.closed = true;
      };
    },
  });
  return opened;
}

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

describe("la bozza di Claude, sul desktop (dal main)", () => {
  it("chiede la bozza della conversazione col corpo previsto; il testo arriva a pezzi; alla fine le task usate", async () => {
    installFakeServer(accounts);
    setAppClientForTests(createAppClient());
    const opened = bridge();
    const texts: string[] = [];
    const s = mail.streamClaudeDraft({ threadId: `${ACC}_t-1`, hint: "digli che slitta" }, (t) => texts.push(t));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatchObject({
      path: "/api/me/mail/drafts/claude",
      body: { accountId: ACC, threadId: "t-1", mode: "reply", hint: "digli che slitta", projectId: null },
    });
    opened[0]!.send({ type: "open" });
    opened[0]!.send({ type: "mailDraft", event: { type: "delta", text: "Ciao " } });
    opened[0]!.send({ type: "mailDraft", event: { type: "delta", text: "Bob" } });
    opened[0]!.send({
      type: "mailDraft",
      event: { type: "done", text: "Ciao Bob", projectId: PRJ, used: [{ taskId: T1, code: "AUD-12", title: "Export", late: true }] },
    });
    await expect(s.result).resolves.toEqual({
      text: "Ciao Bob",
      projectId: PRJ,
      used: [{ taskId: T1, code: "AUD-12", title: "Export", late: true }],
      complete: true,
    });
    expect(texts).toEqual(["Ciao ", "Ciao Bob"]);
  });

  it("l'email nuova: senza conversazione, dalla prima casella, col progetto scelto", async () => {
    installFakeServer(accounts);
    setAppClientForTests(createAppClient());
    const opened = bridge();
    void mail.streamClaudeDraft({ threadId: null, hint: "presentati", projectId: PRJ }, () => undefined).result.catch(() => undefined);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]!.body).toEqual({ accountId: ACC, threadId: null, mode: "new", hint: "presentati", projectId: PRJ });
  });

  it("«Ferma»: chiude lo stream e tiene il testo fin lì", async () => {
    installFakeServer(accounts);
    setAppClientForTests(createAppClient());
    const opened = bridge();
    const s = mail.streamClaudeDraft({ threadId: `${ACC}_t-1`, hint: "" }, () => undefined);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0]!.send({ type: "mailDraft", event: { type: "delta", text: "Ciao" } });
    s.stop();
    await expect(s.result).resolves.toMatchObject({ text: "Ciao", complete: false, used: [] });
    expect(opened[0]!.closed).toBe(true);
  });

  it("i rifiuti prima dello stream e l'errore a metà: il codice del server", async () => {
    installFakeServer(accounts);
    setAppClientForTests(createAppClient());
    const opened = bridge();
    const a = mail.streamClaudeDraft({ threadId: `${ACC}_t-1`, hint: "" }, () => undefined);
    const b = mail.streamClaudeDraft({ threadId: `${ACC}_t-1`, hint: "" }, () => undefined);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    opened[0]!.send({ type: "end", reason: "http", fatal: false, status: 409, code: "budget_exhausted" });
    opened[1]!.send({ type: "mailDraft", event: { type: "error", code: "claude_unavailable" } });
    await expect(a.result).rejects.toThrow("budget_exhausted");
    await expect(b.result).rejects.toThrow("claude_unavailable");
  });

  it("finito senza la fine (connessione caduta): non riuscita", async () => {
    installFakeServer(accounts);
    setAppClientForTests(createAppClient());
    const opened = bridge();
    const s = mail.streamClaudeDraft({ threadId: `${ACC}_t-1`, hint: "" }, () => undefined);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0]!.send({ type: "mailDraft", event: { type: "delta", text: "Ci" } });
    opened[0]!.send({ type: "end", reason: "network", fatal: false });
    await expect(s.result).rejects.toThrow("claude_unavailable");
  });
});

describe("la bozza di Claude, sul web (fetch col cookie)", () => {
  it("POST con il cookie; i pezzi dallo stream SSE", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "delta", text: "Ciao" })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "done", text: "Ciao Bob", projectId: null, used: [] })}\n\n`));
        c.close();
      },
    });
    const { seen } = installFakeServer({
      ...accounts,
      "POST /api/me/mail/drafts/claude": () => undefined as never,
    });
    const realFetch = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/me/mail/drafts/claude")) {
        seen.push({ method: init.method ?? "GET", path: "/api/me/mail/drafts/claude", body: JSON.parse(String(init.body)), credentials: init.credentials, authorization: null });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return realFetch(input, init);
    });
    const s = mail.streamClaudeDraft({ threadId: `${ACC}_t-1`, hint: "" }, () => undefined);
    await expect(s.result).resolves.toMatchObject({ text: "Ciao Bob", complete: true });
    const post = seen.find((r) => r.path === "/api/me/mail/drafts/claude")!;
    expect(post.method).toBe("POST");
    expect(post.credentials).toBe("include");
  });

  it("un rifiuto JSON prima dello stream (400 invalid_hint): il codice", async () => {
    installFakeServer({ ...accounts, "POST /api/me/mail/drafts/claude": { status: 400, body: { code: "invalid_hint", message: "x" } } });
    await expect(mail.streamClaudeDraft({ threadId: null, hint: "" }, () => undefined).result).rejects.toThrow("invalid: hint");
  });
});
