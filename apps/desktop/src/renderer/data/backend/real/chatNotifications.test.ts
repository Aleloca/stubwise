import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID, serverProject } from "./fakeServer";
import { listNotifications } from "./notifications";

// Le menzioni della Chat nell'inbox della build app (area 4, fetta 1): la card
// `chat.mention` derivata dal server (`item.chat`) apre il messaggio nel suo
// canale, o nel suo thread; un messaggio eliminato o un canale che non si vede
// più danno una card senza link (`objectGone`).

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const MSG = "7f1c2a1e-0000-4000-8000-0000000000d1";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d0";
const MARTA = "55555555-5555-4555-8555-555555555555";

const card = (over: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  kind: "chat.mention",
  status: "open",
  text: "Marta Rinaldi mentioned you in AUD · design",
  actions: ["open"],
  projectId: PROJECT_ID,
  ticketId: null,
  jobId: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  readAt: null,
  snoozedUntil: null,
  handledAt: null,
  handledBy: null,
  chat: {
    channelId: CH,
    channelName: "design",
    messageId: MSG,
    threadRootId: null,
    authorId: MARTA,
    authorName: "Marta Rinaldi",
    excerpt: "@Ada can you look?",
  },
  ...over,
});

function inbox(items: unknown[]) {
  return installFakeServer({
    "GET /api/inbox": ({ path }) => ({ body: { items: path.includes("status=open") ? items : [], nextCursor: null } }),
    "GET /api/projects": { body: [serverProject()] },
  });
}

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le menzioni della Chat nell'inbox", () => {
  it("apre il messaggio nel suo canale, col canale come oggetto e l'estratto come testo", async () => {
    inbox([card()]);
    const [n] = await listNotifications();
    expect(n).toMatchObject({
      kind: "chat.mention",
      objectCode: "AUD · design",
      title: "Marta Rinaldi mentioned you in AUD · design",
      body: "@Ada can you look?",
      link: `#/chat/${CH}?message=${MSG}`,
      chatMessageId: MSG,
    });
    expect(n!).not.toHaveProperty("webHref");
  });

  // Registro, A4 r.169 (72, d6a0a83d2): la card di un avviso di gruppo dice
  // quale gruppo nel testo del server (`notify.chatMention.group`), derivato
  // a lettura; il campo additivo `chat.group` non cambia il resto della card.
  it("un avviso di gruppo («@channel»): il titolo è quello del server, il messaggio si apre come gli altri", async () => {
    inbox([
      card({
        text: "Marta Rinaldi mentioned @channel in #design",
        chat: { ...card().chat, excerpt: "@channel the release is out", group: "@channel" },
      }),
    ]);
    const [n] = await listNotifications();
    expect(n).toMatchObject({
      kind: "chat.mention",
      title: "Marta Rinaldi mentioned @channel in #design",
      body: "@channel the release is out",
      link: `#/chat/${CH}?message=${MSG}`,
      chatMessageId: MSG,
    });
  });

  it("una risposta in un thread apre il thread", async () => {
    inbox([card({ chat: { ...card().chat, threadRootId: ROOT } })]);
    const [n] = await listNotifications();
    expect(n!.link).toBe(`#/chat/${CH}?thread=${ROOT}&message=${MSG}`);
  });

  it("un messaggio eliminato o un canale che non si vede più: niente link", async () => {
    inbox([card({ chat: null, objectGone: true })]);
    const [n] = await listNotifications();
    expect(n).toMatchObject({ objectGone: true, link: "" });
  });
});
