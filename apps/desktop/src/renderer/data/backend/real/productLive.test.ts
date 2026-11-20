import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import {
  forgetProductLive,
  liveProductPresence as live,
  parseProductLiveFrame,
  setProductLiveTransport,
  type ProductLiveHandlers,
} from "./productLive";

// La scrittura dal vivo nella build app (area 11, F4; R11-4), contro le forme
// del piano F4 con un parser PROVVISORIO (`parseProductLiveFrame`), che
// diventa quello di shared quando 72 lo pubblica. Uno stream per pagina
// (`GET /api/product-pages/:id/live`), condiviso da chi la guarda; il
// battito (`POST …/live/presence`) ogni 5 s mentre si è dentro. Dietro
// `product-live`, spento.

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
  const send = (event: string, data: unknown, i = opened.length - 1) =>
    opened[i]!.handlers.onFrame(`event: ${event}\ndata: ${JSON.stringify(data)}`);
  return { opened, send };
}

const snapshot = {
  seq: 7,
  present: [
    { userId: ME_ID, name: "Laura Costa", cursor: null },
    { userId: MARCO, name: "Marco Bellini", cursor: { blockId: "blk-1", offset: 4 } },
  ],
  holds: [{ sectionId: "blk-1", userId: MARCO, name: "Marco Bellini" }],
};

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

describe("il parser provvisorio dei frame", () => {
  it("evento e dati JSON; un frame senza evento, con JSON rotto o un evento ignoto è `null`", () => {
    expect(parseProductLiveFrame('event: release\ndata: {"sectionId":"blk-1"}')).toEqual({
      type: "release",
      sectionId: "blk-1",
    });
    expect(parseProductLiveFrame('data: {"sectionId":"blk-1"}')).toBeNull();
    expect(parseProductLiveFrame("event: release\ndata: {oops")).toBeNull();
    expect(parseProductLiveFrame('event: future_thing\ndata: {"a":1}')).toBeNull();
  });
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

  it("lo stato all'apertura: gli altri presenti coi cursori (mai chi guarda), col colore e le iniziali", async () => {
    const { send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("snapshot", snapshot);
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

  it("una revisione di un altro: «blocks» (la pagina si rilegge); arrivi, cursori e uscite: «presence»", async () => {
    const { send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("snapshot", snapshot);
    send("revision", { seq: 8, revisionId: "r-1", ops: [] });
    send("presence", { userId: SARA, name: "Sara Neri", present: true });
    send("cursor", { userId: SARA, cursor: { blockId: "blk-2", offset: 0 } });
    expect(events).toEqual(["presence", "blocks", "presence", "presence"]);
    expect((await live.getProductPresence!(PAGE)).map((p) => [p.personId, p.anchorId])).toEqual([
      [MARCO, "blk-1"],
      [SARA, "blk-2"],
    ]);
    send("presence", { userId: MARCO, name: "Marco Bellini", present: false });
    expect((await live.getProductPresence!(PAGE)).map((p) => p.personId)).toEqual([SARA]);
  });

  it("un nome che chi guarda non vede (`null`, R-G5): quella persona non si mostra", async () => {
    const { send } = fakeTransport();
    live.subscribeProductPage!(PAGE, () => undefined);
    send("snapshot", { ...snapshot, present: [{ userId: MARCO, name: null, cursor: null }] });
    expect(await live.getProductPresence!(PAGE)).toEqual([]);
  });

  it("le prese delle sezioni: chi tiene una sezione, fino a `release`", () => {
    const { send } = fakeTransport();
    live.subscribeProductPage!(PAGE, () => undefined);
    send("snapshot", snapshot);
    expect(live.sectionHolder(PAGE, "blk-1")).toBe("Marco Bellini");
    send("release", { sectionId: "blk-1" });
    expect(live.sectionHolder(PAGE, "blk-1")).toBeNull();
    send("hold", { sectionId: "blk-5", userId: SARA, name: "Sara Neri" });
    expect(live.sectionHolder(PAGE, "blk-5")).toBe("Sara Neri");
  });

  it("chiuso per sempre (403, 404: la pagina non si legge più): «gone», e nessuna riapertura", () => {
    const { opened } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    opened[0]!.handlers.onClose({ fatal: true, status: 403 });
    expect(events).toEqual(["gone"]);
    expect(opened).toHaveLength(1);
  });

  it("una caduta di rete: si riapre dopo un'attesa, e alla ripresa la pagina si rilegge («blocks»)", () => {
    vi.useFakeTimers();
    const { opened } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    opened[0]!.handlers.onClose({});
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(opened).toHaveLength(2);
    expect(events).toContain("blocks");
  });
});

describe("il battito", () => {
  it("entrare manda subito il battito e poi ogni 5 s; uscire lo ferma", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    fakeTransport();
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: { status: 204 },
    });
    await live.joinProductPage!(PAGE);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(3);
    live.leaveProductPageAs!(ME_ID, PAGE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(3);
  });

  it("dove scrive chi guarda: il cursore e la sezione del blocco nel battito (che rinnova la presa)", async () => {
    fakeTransport();
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: { status: 204 },
    });
    live.rememberBlocks(PAGE, [
      { id: "h-1", type: "heading", level: 2, content: { text: "Rules", marks: [] } },
      { id: "blk-2", type: "paragraph", content: { text: "Only Google.", marks: [] } },
    ]);
    await live.setProductPresence!(PAGE, { anchorId: "blk-2", offset: 3 });
    expect(seen.at(-1)!.body).toEqual({
      cursor: { blockId: "blk-2", offset: 3 },
      sectionId: "h-1",
    });
    await live.setProductPresence!(PAGE, null);
    expect(seen.at(-1)!.body).toEqual({});
  });
});
