import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import {
  forgetProductLive,
  liveProductPresence as live,
  setProductLiveTransport,
  type ProductLiveHandlers,
} from "./productLive";

// La scrittura dal vivo nella build app (area 11, F4; R11-4), sulle forme di
// 72 in shared (61de0e593: i frame `data: {json}` con `type`, letti da
// `parseProductLiveFrame`). Uno stream per pagina
// (`GET /api/product-pages/:id/live`), condiviso da chi la guarda; il
// battito (`client.productDocs.beat`) ogni 5 s mentre si è dentro.

const PAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const MARCO = "33333333-3333-4333-8333-000000000003";
const SARA = "44444444-4444-4444-8444-000000000004";

/** Il trasporto finto: chi apre, e come mandargli i frame. */
function fakeTransport() {
  const opened: { path: string; handlers: ProductLiveHandlers; closed: boolean }[] = [];
  setProductLiveTransport((path, handlers) => {
    const entry = { path, handlers, closed: false };
    opened.push(entry);
    return () => {
      entry.closed = true;
    };
  });
  const send = (type: string, data: Record<string, unknown>, i = opened.length - 1) =>
    opened[i]!.handlers.onFrame(`data: ${JSON.stringify({ type, ...data })}`);
  return { opened, send };
}

const marco = {
  userId: MARCO,
  name: "Marco Bellini",
  cursor: { blockId: "blk-1", offset: 4 },
  sectionId: "blk-1",
};
const sara = {
  userId: SARA,
  name: "Sara Neri",
  cursor: { blockId: "blk-2", offset: 0 },
  sectionId: "top",
};
const state = {
  seq: 7,
  presence: [marco],
  holds: [
    {
      sectionId: "blk-1",
      by: { id: MARCO, name: "Marco Bellini" },
      expiresAt: "2026-11-20T10:00:15.000Z",
    },
  ],
};
const beatOk = { body: { hold: null, busy: null } };

beforeEach(() => {
  setAppClientForTests(null);
  forgetProductLive();
  session.personId = ME_ID;
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  setProductLiveTransport(null);
  forgetProductLive();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setAppClientForTests(null);
});

describe("lo stream di una pagina", () => {
  it("UNO stream per pagina, condiviso: chi ascolta per secondo non ne apre un altro; l'ultimo che esce lo chiude", () => {
    const { opened } = fakeTransport();
    const a = live.subscribeProductPage!(PAGE, () => undefined);
    const b = live.subscribeProductPage!(PAGE, () => undefined);
    expect(opened.map((o) => o.path)).toEqual([`/api/product-pages/${PAGE}/live`]);
    a();
    expect(opened[0]!.closed).toBe(false);
    b();
    expect(opened[0]!.closed).toBe(true);
  });

  it("lo stato all'apertura: gli altri presenti coi cursori, col colore e le iniziali", async () => {
    const { send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("state", state);
    expect(events).toEqual(["presence"]);
    const others = await live.getProductPresence!(PAGE);
    expect(others).toEqual([
      expect.objectContaining({
        pageId: PAGE,
        personId: MARCO,
        name: "Marco Bellini",
        initials: "MB",
        anchorId: "blk-1",
        offset: 4,
      }),
    ]);
    expect(others[0]!.color).toBeGreaterThanOrEqual(1);
  });

  it("una revisione di un altro (o del worker, senza sessione): «blocks»; una di questo editor si scarta", () => {
    const { send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("state", state);
    live.rememberSession("ses-mine");
    const revision = (sessionId: string | null, seq: number) => ({
      seq,
      kind: "edit",
      actorId: null,
      sessionId,
      ops: [],
    });
    send("revision", revision("ses-mine", 8));
    expect(events).toEqual(["presence"]);
    send("revision", revision("ses-other", 9));
    send("revision", revision(null, 10));
    expect(events).toEqual(["presence", "blocks", "blocks"]);
  });

  it("la presenza arriva intera ogni volta; un cursore sposta chi c'è già", async () => {
    const { send } = fakeTransport();
    live.subscribeProductPage!(PAGE, () => undefined);
    send("state", state);
    send("presence", { presence: [marco, sara] });
    send("cursor", { userId: MARCO, cursor: { blockId: "blk-9", offset: 1 } });
    expect((await live.getProductPresence!(PAGE)).map((p) => [p.personId, p.anchorId])).toEqual([
      [MARCO, "blk-9"],
      [SARA, "blk-2"],
    ]);
    send("presence", { presence: [sara] });
    expect((await live.getProductPresence!(PAGE)).map((p) => p.personId)).toEqual([SARA]);
  });

  it("un frame malformato o di un tipo ignoto si scarta senza rompere gli altri", () => {
    const { opened } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    opened[0]!.handlers.onFrame("data: {oops");
    opened[0]!.handlers.onFrame('data: {"type":"future_thing"}');
    expect(events).toEqual([]);
  });

  it("le prese delle sezioni: chi tiene una sezione, fino a `release`; un nome che non si vede non si dice", () => {
    const { send } = fakeTransport();
    live.subscribeProductPage!(PAGE, () => undefined);
    send("state", state);
    expect(live.sectionHolder(PAGE, "blk-1")).toBe("Marco Bellini");
    send("release", { sectionId: "blk-1" });
    expect(live.sectionHolder(PAGE, "blk-1")).toBeNull();
    send("hold", {
      hold: {
        sectionId: "blk-5",
        by: { id: SARA, name: null },
        expiresAt: "2026-11-20T10:00:15.000Z",
      },
    });
    expect(live.sectionHolder(PAGE, "blk-5")).toBeNull();
    send("hold", {
      hold: {
        sectionId: "blk-5",
        by: { id: SARA, name: "Sara Neri" },
        expiresAt: "2026-11-20T10:00:15.000Z",
      },
    });
    expect(live.sectionHolder(PAGE, "blk-5")).toBe("Sara Neri");
  });

  it("`gone` (accesso tolto, pagina eliminata) e la chiusura per sempre (403/404): «gone», nessuna riapertura", () => {
    const { opened, send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("gone", {});
    expect(events).toEqual(["gone"]);
    opened[0]!.handlers.onClose({ fatal: true, status: 403 });
    expect(events).toEqual(["gone", "gone"]);
    expect(opened).toHaveLength(1);
  });

  it("una caduta: si riapre dopo un'attesa; il `state` della ripresa fa rileggere solo se il `seq` è più avanti", () => {
    vi.useFakeTimers();
    const { opened, send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("state", state);
    opened[0]!.handlers.onClose({});
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(opened).toHaveLength(2);
    send("state", state);
    expect(events).toEqual(["presence", "presence"]);
    opened[1]!.handlers.onClose({});
    vi.advanceTimersByTime(10_000);
    send("state", { ...state, seq: 9 });
    expect(events).toEqual(["presence", "presence", "presence", "blocks"]);
  });
});

describe("il battito", () => {
  it("entrare manda subito il battito e poi ogni 5 s; uscire lo ferma", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    fakeTransport();
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: beatOk,
    });
    await live.joinProductPage!(PAGE);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(3);
    live.leaveProductPageAs!(ME_ID, PAGE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(3);
  });

  it("dove scrive chi guarda: il cursore e la sezione (`sectionKeyOf`, «top» in cima) nel battito; senza, lascia le prese", async () => {
    fakeTransport();
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: beatOk,
    });
    live.rememberBlocks(PAGE, [
      { id: "blk-0", type: "paragraph", content: { text: "Intro.", marks: [] } },
      { id: "h-1", type: "heading", level: 2, content: { text: "Rules", marks: [] } },
      { id: "blk-2", type: "paragraph", content: { text: "Only Google.", marks: [] } },
    ]);
    await live.setProductPresence!(PAGE, { anchorId: "blk-2", offset: 3 });
    // Una presenza per scheda (72, b138abc37): lo stesso `sessionId` in ogni battito di questa finestra.
    const tab = (seen.at(-1)!.body as { sessionId: string }).sessionId;
    expect(tab).toMatch(/^tab-/);
    expect(seen.at(-1)!.body).toEqual({
      cursor: { blockId: "blk-2", offset: 3 },
      sectionId: "h-1",
      sessionId: tab,
    });
    await live.setProductPresence!(PAGE, { anchorId: "blk-0", offset: 0 });
    expect(seen.at(-1)!.body).toEqual({
      cursor: { blockId: "blk-0", offset: 0 },
      sectionId: "top",
      sessionId: tab,
    });
    await live.setProductPresence!(PAGE, null);
    expect(seen.at(-1)!.body).toEqual({ cursor: null, sectionId: null, sessionId: tab });
  });
});
