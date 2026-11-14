import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// Support (area 8, F3): percorsi, metodi, corpi, e una risposta di un server
// che manda solo i campi obbligatori.

const P = "11111111-1111-4111-8111-111111111111";
const view = {
  id: "22222222-2222-4222-8222-222222222222",
  code: "ACQ-S2",
  projectId: P,
  projectCode: "ACQ",
  channel: "widget",
  state: "waiting_us",
  createdAt: "2026-11-14T10:00:00.000Z",
  lastMessageAt: "2026-11-14T10:05:00.000Z",
};
function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "https://x.test", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const call = (f: ReturnType<typeof client>["fetchImpl"], i = 0) => {
  const [url, init] = f.mock.calls[i]!;
  return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

describe("client.support", () => {
  it("elenco (col filtro di stato) e «Clienti in attesa»: le viste coi default", async () => {
    const { c, fetchImpl } = client({ items: [view] });
    const out = await c.support.list(P, { state: "waiting_us" });
    await c.support.waitingCustomers();
    expect(call(fetchImpl)).toMatchObject({ url: `https://x.test/api/projects/${P}/support/conversations?state=waiting_us`, method: "GET" });
    expect(call(fetchImpl, 1)).toMatchObject({ url: "https://x.test/api/me/waiting-customers", method: "GET" });
    expect(out.items[0]).toMatchObject({ messages: [], canReply: false, canMarkNotConcluded: false, claudeDraftPending: false, triage: null, task: null });
  });

  it("dettaglio, anteprima, bozza email per codice", async () => {
    const { c, fetchImpl } = client({ ...view, status: "received", messages: [], slot: "support-ACQ-S2", to: { email: "m@x.it" }, subject: "s", body: "b" });
    await c.support.get("ACQ-S2");
    await c.support.preview("ACQ-S2");
    await c.support.emailDraft("ACQ-S2");
    expect(call(fetchImpl).url).toBe("https://x.test/api/support/conversations/by-code/ACQ-S2");
    expect(call(fetchImpl, 1).url).toBe("https://x.test/api/support/conversations/by-code/ACQ-S2/preview");
    expect(call(fetchImpl, 2).url).toBe("https://x.test/api/support/conversations/by-code/ACQ-S2/email-draft");
  });

  it("le scritture: risposta, segui, richiesta, «Non conclusa», «Ask Claude»", async () => {
    const { c, fetchImpl } = client(view);
    await c.support.reply("ACQ-S2", { body: "Ciao", clientId: P });
    await c.support.follow("ACQ-S2", true);
    await c.support.markNotConcluded("ACQ-S2");
    await c.support.requestDraft("ACQ-S2");
    const base = "https://x.test/api/support/conversations/by-code/ACQ-S2";
    expect(call(fetchImpl)).toMatchObject({ url: `${base}/replies`, method: "POST", body: { body: "Ciao", clientId: P } });
    expect(call(fetchImpl, 1)).toMatchObject({ url: `${base}/follow`, method: "PUT", body: { on: true } });
    expect(call(fetchImpl, 2)).toMatchObject({ url: `${base}/not-concluded`, method: "POST" });
    expect(call(fetchImpl, 3)).toMatchObject({ url: `${base}/draft`, method: "POST" });
    const opened = client({ conversation: view, request: { id: P, code: "ACQ-R14" } });
    const r = await opened.c.support.openRequest("ACQ-S2", { title: "Export PDF", description: "d" });
    expect(call(opened.fetchImpl)).toMatchObject({ url: `${base}/request`, method: "POST", body: { title: "Export PDF", description: "d" } });
    expect(r.request.code).toBe("ACQ-R14");
  });
});
