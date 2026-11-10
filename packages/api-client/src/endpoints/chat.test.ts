import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// La Chat fra persone (area 4, fetta 1): i percorsi e i corpi delle rotte
// `/api/chat`, e le forme delle risposte (con i default per un server vecchio).

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const MSG = "7f1c2a1e-0000-4000-8000-0000000000d1";
const PROJECT = "7f1c2a1e-0000-4000-8000-0000000000a1";
const channel = { id: CH, kind: "project", projectId: PROJECT, name: "general", createdAt: "2026-11-10T10:00:00.000Z" };
const message = { id: MSG, channelId: CH, authorId: null, text: "Ciao", createdAt: "2026-11-10T10:00:00.000Z" };

function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const last = (f: ReturnType<typeof client>["fetchImpl"]) => {
  const [url, init] = f.mock.calls.at(-1)!;
  return { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

describe("endpoints chat", () => {
  it("canali: lista per progetto, uno, crea, patch, elimina, entra ed esci", async () => {
    const list = client({ items: [channel] });
    const page = await list.c.chat.channels.list({ projectId: PROJECT });
    expect(last(list.fetchImpl)).toMatchObject({ url: `/api/chat/channels?projectId=${PROJECT}`, method: "GET" });
    // Un server vecchio che non manda i permessi: tutto spento.
    expect(page.items[0]).toMatchObject({ canWrite: false, canManage: false, isMember: false, unread: 0, level: "all" });
    const one = client(channel);
    await one.c.chat.channels.get(CH);
    expect(last(one.fetchImpl).url).toBe(`/api/chat/channels/${CH}`);
    await one.c.chat.channels.create({ projectId: PROJECT, name: "design" });
    expect(last(one.fetchImpl)).toEqual({ url: "/api/chat/channels", method: "POST", body: { projectId: PROJECT, name: "design" } });
    await one.c.chat.channels.update(CH, { archived: true });
    expect(last(one.fetchImpl)).toEqual({ url: `/api/chat/channels/${CH}`, method: "PATCH", body: { archived: true } });
    await one.c.chat.channels.join(CH);
    expect(last(one.fetchImpl)).toMatchObject({ url: `/api/chat/channels/${CH}/join`, method: "POST" });
    await one.c.chat.channels.leave(CH);
    expect(last(one.fetchImpl)).toMatchObject({ url: `/api/chat/channels/${CH}/join`, method: "DELETE" });
    await one.c.chat.channels.setPref(CH, "mentions");
    expect(last(one.fetchImpl)).toEqual({ url: `/api/chat/channels/${CH}/pref`, method: "PUT", body: { level: "mentions" } });
    const gone = client(null, 204);
    await gone.c.chat.channels.remove(CH);
    expect(last(gone.fetchImpl)).toMatchObject({ url: `/api/chat/channels/${CH}`, method: "DELETE" });
    await gone.c.chat.channels.markRead(CH, { threadRootId: MSG });
    expect(last(gone.fetchImpl)).toEqual({ url: `/api/chat/channels/${CH}/read`, method: "POST", body: { threadRootId: MSG } });
  });

  it("messaggi: pagina, uno, thread, invio, modifica, elimina, reazione, follow", async () => {
    const page = client({ items: [message] });
    const p = await page.c.chat.messages.page(CH, { before: "c1", limit: 50 });
    expect(last(page.fetchImpl).url).toBe(`/api/chat/channels/${CH}/messages?before=c1&limit=50`);
    expect(p).toMatchObject({ before: null, items: [{ deleted: false, reactions: [], canEdit: false }] });
    const one = client(message);
    await one.c.chat.messages.get(MSG);
    expect(last(one.fetchImpl).url).toBe(`/api/chat/messages/${MSG}`);
    await one.c.chat.messages.send(CH, { text: "Ciao", threadRootId: MSG });
    expect(last(one.fetchImpl)).toEqual({ url: `/api/chat/channels/${CH}/messages`, method: "POST", body: { text: "Ciao", threadRootId: MSG } });
    await one.c.chat.messages.edit(MSG, "Ciao!");
    expect(last(one.fetchImpl)).toEqual({ url: `/api/chat/messages/${MSG}`, method: "PATCH", body: { text: "Ciao!" } });
    await one.c.chat.messages.toggleReaction(MSG, "👍");
    expect(last(one.fetchImpl)).toEqual({ url: `/api/chat/messages/${MSG}/reactions/toggle`, method: "POST", body: { emoji: "👍" } });
    await one.c.chat.messages.setFollow(MSG, true);
    expect(last(one.fetchImpl)).toEqual({ url: `/api/chat/messages/${MSG}/follow`, method: "PUT", body: { following: true } });
    const thread = client({ root: message, replies: [] });
    await thread.c.chat.messages.thread(MSG);
    expect(last(thread.fetchImpl).url).toBe(`/api/chat/messages/${MSG}/thread`);
    const gone = client(null, 204);
    await gone.c.chat.messages.remove(MSG);
    expect(last(gone.fetchImpl)).toMatchObject({ url: `/api/chat/messages/${MSG}`, method: "DELETE" });
  });

  it("viste e stream: thread con novità, menzioni, segnale; il percorso dello stream col cursore", async () => {
    const t = client({ items: [] });
    await t.c.chat.threads();
    expect(last(t.fetchImpl).url).toBe("/api/chat/threads");
    await t.c.chat.mentions();
    expect(last(t.fetchImpl).url).toBe("/api/chat/mentions");
    const s = client({});
    expect(await s.c.chat.signal()).toEqual({ hasNews: false, mentions: 0 });
    expect(last(s.fetchImpl).url).toBe("/api/chat/signal");
    expect(s.c.chat.streamPath(CH)).toBe(`/api/chat/channels/${CH}/stream`);
    expect(s.c.chat.streamPath(CH, "x|1")).toBe(`/api/chat/channels/${CH}/stream?after=x%7C1`);
  });

  it("fetta 2: DM, membri, domande, ricerca, filtro per tipo", async () => {
    const PERSON = "7f1c2a1e-0000-4000-8000-0000000000e1";
    const one = client(channel);
    await one.c.chat.openDm([PERSON]);
    expect(last(one.fetchImpl)).toEqual({ url: "/api/chat/dm", method: "POST", body: { personIds: [PERSON] } });
    await one.c.chat.channels.invite(CH, [PERSON]);
    expect(last(one.fetchImpl)).toEqual({ url: `/api/chat/channels/${CH}/members`, method: "POST", body: { personIds: [PERSON] } });
    await one.c.chat.channels.removeMember(CH, PERSON);
    expect(last(one.fetchImpl)).toMatchObject({ url: `/api/chat/channels/${CH}/members/${PERSON}`, method: "DELETE" });
    const list = client({ items: [] });
    await list.c.chat.channels.list({ kind: "dm" });
    expect(last(list.fetchImpl).url).toBe("/api/chat/channels?kind=dm");
    await list.c.chat.questions();
    expect(last(list.fetchImpl).url).toBe("/api/chat/questions");
    await list.c.chat.search({ q: "pdf export", channelId: CH, peopleOnly: true, from: "2026-11-01" });
    expect(last(list.fetchImpl).url).toBe(`/api/chat/search?q=pdf+export&channelId=${CH}&peopleOnly=true&from=2026-11-01`);
    const gone = client(null, 204);
    await gone.c.chat.dismissQuestion(MSG);
    expect(last(gone.fetchImpl)).toMatchObject({ url: `/api/chat/questions/${MSG}/dismiss`, method: "POST" });
    // Uscire da un privato o da un DM che non si vede più: 204, nessun canale.
    expect(await gone.c.chat.channels.leave(CH)).toBeNull();
    expect(await gone.c.chat.channels.removeMember(CH, PERSON)).toBeNull();
  });
});
