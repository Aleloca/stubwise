import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { forgetProductDocs, liveProductDocs as docs } from "./productDocs";
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

  it("la sezione in cui scrive chi c'è arriva con la presenza (la presa); `hold`/`release` non cambiano gli avatar", async () => {
    const { send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("state", state);
    expect((await live.getProductPresence!(PAGE))[0]).toMatchObject({
      personId: MARCO,
      sectionId: "blk-1",
    });
    send("hold", {
      hold: {
        sectionId: "blk-5",
        by: { id: SARA, name: "Sara Neri" },
        expiresAt: "2026-11-20T10:00:15.000Z",
      },
    });
    send("release", { sectionId: "blk-1" });
    expect(events).toEqual(["presence"]);
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
    // La chiusura svuota la presenza («presence»), la ripresa allo stesso seq non rilegge.
    expect(events).toEqual(["presence", "presence", "presence"]);
    opened[1]!.handlers.onClose({});
    vi.advanceTimersByTime(10_000);
    send("state", { ...state, seq: 9 });
    expect(events).toEqual(["presence", "presence", "presence", "presence", "presence", "blocks"]);
  });
});

describe("il battito", () => {
  it("entrare manda subito il battito e poi ogni 5 s; uscire lo ferma (e manda il rilascio)", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    });
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
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(4);
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

describe("le correzioni della revisione di R11-4", () => {
  it("1 — il cursore non supera il tetto: posizioni fitte si accodano (al più una al secondo); un 429 ferma i battiti per 10 s", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    });
    fakeTransport();
    let limited = false;
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: () =>
        limited ? { status: 429, body: { code: "rate_limited", message: "x" } } : beatOk,
    });
    await live.joinProductPage!(PAGE);
    const posts = () => seen.filter((r) => r.method === "POST").length;
    expect(posts()).toBe(1);
    for (let i = 0; i < 30; i++) {
      void live.setProductPresence!(PAGE, { anchorId: "blk-1", offset: i });
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posts()).toBeLessThanOrEqual(3);
    // L'ultima posizione è quella mandata.
    expect((seen.at(-1)!.body as { cursor: { offset: number } }).cursor.offset).toBe(29);
    // Il battito delle 5 s prende un 429: per 10 s non parte niente, poi si riprende.
    limited = true;
    await vi.advanceTimersByTimeAsync(3_200);
    const afterLimit = posts();
    limited = false;
    await vi.advanceTimersByTimeAsync(9_500);
    expect(posts()).toBe(afterLimit);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posts()).toBeGreaterThan(afterLimit);
  });

  it("4 — la sezione del cursore viene dalla vista dell'editor (un blocco appena creato non è «top»)", async () => {
    fakeTransport();
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: beatOk,
    });
    live.rememberBlocks(
      PAGE,
      [{ id: "blk-0", type: "paragraph", content: { text: "Intro.", marks: [] } }],
      7,
    );
    await live.setProductPresence!(PAGE, { anchorId: "blk-new", offset: 0, sectionId: "h-1" });
    expect(seen.at(-1)!.body).toMatchObject({
      cursor: { blockId: "blk-new", offset: 0 },
      sectionId: "h-1",
    });
  });

  it("5 — solo 401/403/404 e `gone` chiudono per sempre; il tetto della finestra, un rifiuto o un rinvio riprovano", () => {
    vi.useFakeTimers();
    const { opened } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    opened[0]!.handlers.onClose({ status: 429 });
    vi.advanceTimersByTime(20_000);
    expect(opened).toHaveLength(2);
    expect(events).not.toContain("gone");
    opened[1]!.handlers.onClose({ status: 404, fatal: true });
    expect(events).toContain("gone");
    vi.advanceTimersByTime(20_000);
    expect(opened).toHaveLength(2);
  });

  it("5 (desktop) — la fine del main: `limit`, `rejected`, `redirect` riprovano col backoff; solo 401/403/404 è «gone»", () => {
    vi.useFakeTimers();
    setProductLiveTransport(null);
    const opens: ((message: unknown) => void)[] = [];
    vi.stubGlobal("stubwise", {
      api: {},
      openStream: (_path: string, onMessage: (message: unknown) => void) => {
        opens.push(onMessage);
        return () => undefined;
      },
    });
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    for (const reason of ["limit", "rejected", "redirect"]) {
      opens.at(-1)!({ type: "end", reason, fatal: true });
      vi.advanceTimersByTime(20_000);
    }
    expect(events).not.toContain("gone");
    expect(opens).toHaveLength(4);
    opens.at(-1)!({ type: "end", reason: "http", fatal: true, status: 403 });
    expect(events).toEqual(["gone"]);
    // Il frame scartato dal main (troppo grande) fa rileggere.
    vi.advanceTimersByTime(20_000);
    expect(opens).toHaveLength(4);
    vi.unstubAllGlobals();
  });

  it("7 — il primo `state` si confronta col `seq` della lettura della pagina", () => {
    const { send } = fakeTransport();
    live.rememberBlocks(PAGE, [], 7);
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("state", { ...state, seq: 9 });
    expect(events).toEqual(["presence", "blocks"]);
  });

  it("8 — alla chiusura gli avatar e le prese se ne vanno", async () => {
    vi.useFakeTimers();
    const { opened, send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("state", state);
    expect(await live.getProductPresence!(PAGE)).toHaveLength(1);
    opened[0]!.handlers.onClose({});
    expect(await live.getProductPresence!(PAGE)).toEqual([]);
    expect(events.at(-1)).toBe("presence");
  });

  it("11 — uscire manda il rilascio (`sectionId: null`)", async () => {
    fakeTransport();
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: beatOk,
    });
    await live.joinProductPage!(PAGE);
    live.leaveProductPageAs!(ME_ID, PAGE);
    await vi.waitFor(() => expect(seen.filter((r) => r.method === "POST")).toHaveLength(2));
    expect(seen.at(-1)!.body).toMatchObject({ cursor: null, sectionId: null });
  });

  it("13 — un frame scartato dal trasporto (troppo grande) fa rileggere la pagina", () => {
    const { opened } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    opened[0]!.handlers.onDropped?.();
    expect(events).toEqual(["blocks"]);
  });

  it("15 — il backoff cresce a ogni caduta e si azzera al primo frame", () => {
    vi.useFakeTimers();
    const { opened, send } = fakeTransport();
    live.subscribeProductPage!(PAGE, () => undefined);
    opened[0]!.handlers.onClose({});
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(2);
    opened[1]!.handlers.onClose({});
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(3);
    send("state", state);
    opened[2]!.handlers.onClose({});
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(4);
  });
});

describe("il salvataggio e lo stream (revisione di R11-4, 15)", () => {
  it("il salvataggio registra la sua sessione PRIMA del frame: la sua revisione non fa rileggere", async () => {
    forgetProductDocs();
    const { send } = fakeTransport();
    const events: string[] = [];
    live.subscribeProductPage!(PAGE, (e) => events.push(e));
    send("state", state);
    const page = {
      id: PAGE,
      code: "AUD-D5",
      projectId: "11111111-1111-4111-8111-111111111111",
      parentId: null,
      order: 0,
      title: "Sign-in",
      excerpt: "",
      updatedAt: "2026-11-20T10:00:00.000Z",
      updatedById: null,
      blocks: [],
      seq: 7,
      createdById: null,
      createdAt: "2026-11-19T10:00:00.000Z",
      breadcrumbs: [],
      decisions: {},
      following: false,
      permissions: { edit: true, delete: true },
    };
    installFakeServer({
      "GET /api/product-pages/by-code/AUD-D5": { body: page },
      [`POST /api/product-pages/${PAGE}/ops`]: () => {
        // Il frame della revisione arriva mentre la scrittura è ancora in volo.
        send("revision", {
          seq: 8,
          kind: "edit",
          actorId: ME_ID,
          sessionId: "ses-editor",
          ops: [],
        });
        return { body: { seq: 8, revisionId: "bbbbbbbb-0000-4000-8000-000000000001" } };
      },
    });
    await docs.getProductPage!("AUD-D5");
    await docs.saveProductBlocks!(
      PAGE,
      [{ op: "insert", afterId: null, block: { id: "blk-n", type: "divider" } }],
      {
        sessionId: "ses-editor",
      },
    );
    expect(events).toEqual(["presence"]);
  });
});

describe("la finestra in secondo piano lascia la sezione (decisione del maintainer, R11-4 punto 6)", () => {
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => setHidden(false));

  it("nascosta: subito `sectionId: null`, e i battiti dopo non riprendono la presa; tornata visibile, la riprende solo il cursore", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    });
    fakeTransport();
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: beatOk,
    });
    const bodies = () =>
      seen.filter((r) => r.method === "POST").map((r) => r.body as Record<string, unknown>);
    await live.joinProductPage!(PAGE);
    await vi.advanceTimersByTimeAsync(2_000);
    await live.setProductPresence!(PAGE, { anchorId: "blk-1", offset: 0, sectionId: "h-1" });
    expect(bodies().at(-1)).toMatchObject({ sectionId: "h-1" });
    setHidden(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies().at(-1)).toMatchObject({ cursor: null, sectionId: null });
    // I battiti a finestra nascosta non riprendono la presa.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bodies().at(-1)).toMatchObject({ sectionId: null });
    setHidden(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bodies().at(-1)).toMatchObject({ sectionId: null });
    // Il primo battito col cursore dentro un blocco la riprende.
    await vi.advanceTimersByTimeAsync(1_000);
    await live.setProductPresence!(PAGE, { anchorId: "blk-1", offset: 2, sectionId: "h-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bodies().at(-1)).toMatchObject({ sectionId: "h-1" });
  });

  it("scrivendo senza pause a finestra visibile la presa resta", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    });
    fakeTransport();
    const { seen } = installFakeServer({
      [`POST /api/product-pages/${PAGE}/live/presence`]: beatOk,
    });
    await live.joinProductPage!(PAGE);
    await vi.advanceTimersByTimeAsync(1_000);
    await live.setProductPresence!(PAGE, { anchorId: "blk-1", offset: 0, sectionId: "h-1" });
    await vi.advanceTimersByTimeAsync(15_000);
    const last = seen.filter((r) => r.method === "POST").at(-1)!.body as Record<string, unknown>;
    expect(last).toMatchObject({ sectionId: "h-1" });
  });
});
