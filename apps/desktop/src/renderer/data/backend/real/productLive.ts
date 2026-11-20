import { splitSseFrames, streamBackoffMs } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ProductBlock, ProductPageEvent, ProductPresenceView } from "../../types";
import { initialsOf, presenceColor } from "../../../domain/productDocs/presence";
import { sectionOf } from "../../../domain/productDocs/sections";
import { appClient, session } from "./client";

// La scrittura dal vivo di una pagina di prodotto nella build app (area 11,
// F4; R11-4), contro le forme del piano F4:
// - UNO stream per pagina (`GET /api/product-pages/:id/live`), condiviso da
//   chi la guarda: all'apertura lo stato (`snapshot`: chi c'è coi cursori, le
//   prese delle sezioni, l'ultimo `seq`), poi `revision`, `presence`,
//   `cursor`, `hold`, `release`. Una revisione dice «blocks»: la pagina si
//   rilegge (le operazioni sono nell'evento, ma rileggere tiene una sola
//   strada per il corpo, quella di F1);
// - il trasporto è quello della Chat: sul web `fetch` col cookie e il
//   watchdog dei ping, sul desktop `window.stubwise.openStream` del main
//   (allowlist stretta, Bearer nel main) che consegna il frame com'è
//   (`productFrame`). Il main non riconnette: qui la ripresa, col backoff
//   delle sessioni, e alla ripresa la pagina si rilegge. 401/403/404 chiude:
//   la pagina non si vede più («gone»);
// - il battito (`POST …/live/presence`) ogni 5 s mentre si è dentro, col
//   cursore e la sezione del blocco (che rinnova la presa); il server fa
//   scadere a 15 s chi non batte;
// - un nome `null` (chi guarda non vede quella persona, R-G5) non si mostra.
// Il parser dei frame è PROVVISORIO: diventa quello di shared con F4 di 72.
// Dietro `product-live`, spento.

/** Un evento dello stream, nella forma del piano F4 (provvisoria). */
export type ProductLiveEvent =
  | {
      type: "snapshot";
      seq: number;
      present: {
        userId: string;
        name: string | null;
        cursor: { blockId: string; offset: number } | null;
      }[];
      holds: { sectionId: string; userId: string; name: string | null }[];
    }
  | { type: "revision"; seq: number }
  | { type: "presence"; userId: string; name: string | null; present: boolean }
  | { type: "cursor"; userId: string; cursor: { blockId: string; offset: number } | null }
  | { type: "hold"; sectionId: string; userId: string; name: string | null }
  | { type: "release"; sectionId: string };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const str = (x: unknown): x is string => typeof x === "string";
const nameOf = (x: unknown): string | null => (str(x) ? x : null);
const cursorOf = (x: unknown): { blockId: string; offset: number } | null =>
  isObject(x) && str(x.blockId) && typeof x.offset === "number"
    ? { blockId: x.blockId, offset: x.offset }
    : null;

/** Un frame SSE (testo, senza i ping) come evento; `null` se non si legge o è di un tipo ignoto. */
export function parseProductLiveFrame(raw: string): ProductLiveEvent | null {
  let type: string | null = null;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!type || data.length === 0) return null;
  let d: unknown;
  try {
    d = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  if (!isObject(d)) return null;
  switch (type) {
    case "snapshot":
      return {
        type,
        seq: typeof d.seq === "number" ? d.seq : 0,
        present: (Array.isArray(d.present) ? d.present : []).flatMap((p) =>
          isObject(p) && str(p.userId)
            ? [{ userId: p.userId, name: nameOf(p.name), cursor: cursorOf(p.cursor) }]
            : [],
        ),
        holds: (Array.isArray(d.holds) ? d.holds : []).flatMap((h) =>
          isObject(h) && str(h.sectionId) && str(h.userId)
            ? [{ sectionId: h.sectionId, userId: h.userId, name: nameOf(h.name) }]
            : [],
        ),
      };
    case "revision":
      return typeof d.seq === "number" ? { type, seq: d.seq } : null;
    case "presence":
      return str(d.userId) && typeof d.present === "boolean"
        ? { type, userId: d.userId, name: nameOf(d.name), present: d.present }
        : null;
    case "cursor":
      return str(d.userId) ? { type, userId: d.userId, cursor: cursorOf(d.cursor) } : null;
    case "hold":
      return str(d.sectionId) && str(d.userId)
        ? { type, sectionId: d.sectionId, userId: d.userId, name: nameOf(d.name) }
        : null;
    case "release":
      return str(d.sectionId) ? { type, sectionId: d.sectionId } : null;
    default:
      return null;
  }
}

// --- il trasporto (lo stesso della Chat) ---------------------------------------------

export interface ProductLiveEnd {
  fatal?: boolean;
  status?: number;
}
export interface ProductLiveHandlers {
  /** Un frame com'è (testo SSE, senza i ping). */
  onFrame(raw: string): void;
  onClose(end: ProductLiveEnd | null): void;
}
export type ProductLiveTransport = (path: string, handlers: ProductLiveHandlers) => () => void;

const FATAL_STATUS = new Set([401, 403, 404]);
/** Il server manda `: ping`: senza un byte per questo tempo la connessione è morta (come la Chat). */
const PING_TIMEOUT_MS = 60_000;

const onlyComments = (raw: string) =>
  raw.split("\n").every((line) => line === "" || line.startsWith(":"));

/** Il web: `fetch` streaming sulla stessa origine, col cookie, e il watchdog dei ping. */
const fetchTransport: ProductLiveTransport = (path, handlers) => {
  const abort = new AbortController();
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (end: ProductLiveEnd | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    handlers.onClose(end);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      abort.abort();
      finish({});
    }, PING_TIMEOUT_MS);
  };
  void (async () => {
    arm();
    try {
      const res = await globalThis.fetch(path, {
        credentials: "include",
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (!res.ok || !res.body)
        return finish({ status: res.status, fatal: FATAL_STATUS.has(res.status) });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        arm();
        const { frames, rest } = splitSseFrames(buffer + decoder.decode(value, { stream: true }));
        buffer = rest;
        for (const raw of frames) if (!onlyComments(raw)) handlers.onFrame(raw);
      }
      finish({});
    } catch {
      finish({});
    }
  })();
  return () => {
    abort.abort();
    finish(null);
  };
};

/** Il desktop: la connessione la apre il main, che consegna il frame com'è (`productFrame`). */
const ipcTransport: ProductLiveTransport = (path, handlers) => {
  const openStream = window.stubwise?.openStream;
  if (!openStream) {
    queueMicrotask(() => handlers.onClose({}));
    return () => undefined;
  }
  let done = false;
  const close = openStream(path, (message) => {
    if (done) return;
    if (message.type === "productFrame") handlers.onFrame(message.raw);
    else if (message.type === "end") {
      done = true;
      handlers.onClose({
        fatal: message.fatal || (message.status !== undefined && FATAL_STATUS.has(message.status)),
        ...(message.status !== undefined ? { status: message.status } : {}),
      });
    }
  });
  return () => {
    done = true;
    close();
  };
};

let transport: ProductLiveTransport | null = null;

/** Solo nei test: un trasporto finto (`null` torna a quello vero). */
export function setProductLiveTransport(next: ProductLiveTransport | null): void {
  transport = next;
}

const currentTransport = (): ProductLiveTransport =>
  transport ?? (window.stubwise?.api ? ipcTransport : fetchTransport);

// --- lo stato di ogni pagina ---------------------------------------------------------

interface PageLive {
  listeners: Set<(event: ProductPageEvent) => void>;
  present: Map<string, { name: string | null; cursor: { blockId: string; offset: number } | null }>;
  holds: Map<string, { userId: string; name: string | null }>;
  close: (() => void) | null;
  attempts: number;
  retry: ReturnType<typeof setTimeout> | null;
}

const pages = new Map<string, PageLive>();
/** I battiti in corso, per pagina, e l'ultimo cursore mandato. */
const beats = new Map<string, { timer: ReturnType<typeof setInterval>; at: Presence | null }>();
/** I blocchi di adesso di una pagina (per la sezione del cursore): li dà la lettura della pagina. */
const blocksOf = new Map<string, readonly ProductBlock[]>();

type Presence = { cursor: { blockId: string; offset: number }; sectionId?: string };

/** Il battito ogni quanto (il server fa scadere a 15 s). */
const BEAT_MS = 5_000;

const emit = (page: PageLive, event: ProductPageEvent) => {
  for (const fn of [...page.listeners]) fn(event);
};

function apply(page: PageLive, e: ProductLiveEvent): ProductPageEvent {
  switch (e.type) {
    case "snapshot":
      page.present = new Map(e.present.map((p) => [p.userId, { name: p.name, cursor: p.cursor }]));
      page.holds = new Map(e.holds.map((h) => [h.sectionId, { userId: h.userId, name: h.name }]));
      return "presence";
    case "revision":
      return "blocks";
    case "presence":
      if (e.present)
        page.present.set(e.userId, {
          name: e.name,
          cursor: page.present.get(e.userId)?.cursor ?? null,
        });
      else page.present.delete(e.userId);
      return "presence";
    case "cursor": {
      const was = page.present.get(e.userId);
      page.present.set(e.userId, { name: was?.name ?? null, cursor: e.cursor });
      return "presence";
    }
    case "hold":
      page.holds.set(e.sectionId, { userId: e.userId, name: e.name });
      return "presence";
    case "release":
      page.holds.delete(e.sectionId);
      return "presence";
  }
}

function connect(pageId: string, page: PageLive, again: boolean): void {
  page.close = currentTransport()(`/api/product-pages/${encodeURIComponent(pageId)}/live`, {
    onFrame(raw) {
      const event = parseProductLiveFrame(raw);
      if (!event) return;
      page.attempts = 0;
      emit(page, apply(page, event));
    },
    onClose(end) {
      page.close = null;
      if (end === null || !pages.has(pageId)) return;
      if (end.fatal) {
        emit(page, "gone");
        return;
      }
      // Una caduta: si riapre dopo il backoff, e si rilegge ciò che è cambiato intanto.
      page.retry = setTimeout(() => {
        page.retry = null;
        if (pages.get(pageId) === page) connect(pageId, page, true);
      }, streamBackoffMs(page.attempts++));
    },
  });
  if (again) emit(page, "blocks");
}

/** Solo nei test, e al cambio di persona: chiude ogni stream e ferma ogni battito. */
export function forgetProductLive(): void {
  for (const page of pages.values()) {
    page.close?.();
    if (page.retry) clearTimeout(page.retry);
  }
  pages.clear();
  for (const beat of beats.values()) clearInterval(beat.timer);
  beats.clear();
  blocksOf.clear();
}

const beat = (pageId: string, at: Presence | null) =>
  appClient()
    .request("POST", `/api/product-pages/${encodeURIComponent(pageId)}/live/presence`, at ?? {})
    // Un battito che non passa non dice niente: il prossimo rimedia.
    .catch(() => undefined);

type ProductDocs = typeof Fake.productDocs;

export const liveProductPresence: Partial<ProductDocs> & {
  /** Chi tiene una sezione (`null`: libera, o chi la tiene non si vede). */
  sectionHolder(pageId: string, sectionId: string): string | null;
  /** I blocchi di adesso di una pagina, per la sezione del cursore nel battito. */
  rememberBlocks(pageId: string, blocks: readonly ProductBlock[]): void;
} = {
  subscribeProductPage(pageId, cb) {
    let page = pages.get(pageId);
    if (!page) {
      page = {
        listeners: new Set(),
        present: new Map(),
        holds: new Map(),
        close: null,
        attempts: 0,
        retry: null,
      };
      pages.set(pageId, page);
      page.listeners.add(cb);
      connect(pageId, page, false);
    } else page.listeners.add(cb);
    const mine = page;
    return () => {
      mine.listeners.delete(cb);
      if (mine.listeners.size > 0) return;
      mine.close?.();
      if (mine.retry) clearTimeout(mine.retry);
      pages.delete(pageId);
    };
  },

  async getProductPresence(pageId) {
    const page = pages.get(pageId);
    if (!page) return [];
    const me = session.personId;
    return [...page.present.entries()].flatMap(([personId, p]): ProductPresenceView[] =>
      personId === me || p.name === null
        ? []
        : [
            {
              pageId,
              personId,
              anchorId: p.cursor?.blockId ?? null,
              offset: p.cursor?.offset ?? 0,
              selection: null,
              seq: 0,
              name: p.name,
              initials: initialsOf(p.name),
              color: presenceColor(personId),
            },
          ],
    );
  },

  async joinProductPage(pageId) {
    if (beats.has(pageId)) return;
    const entry = {
      timer: setInterval(() => void beat(pageId, entry.at), BEAT_MS),
      at: null as Presence | null,
    };
    beats.set(pageId, entry);
    await beat(pageId, null);
  },

  leaveProductPageAs(_me, pageId) {
    const entry = beats.get(pageId);
    if (!entry) return;
    clearInterval(entry.timer);
    beats.delete(pageId);
  },

  async setProductPresence(pageId, at) {
    const blocks = blocksOf.get(pageId) ?? [];
    const section = at ? sectionOf(blocks, at.anchorId) : null;
    const next: Presence | null = at
      ? {
          cursor: { blockId: at.anchorId, offset: at.offset },
          ...(section ? { sectionId: section } : {}),
        }
      : null;
    const entry = beats.get(pageId);
    if (entry) entry.at = next;
    await beat(pageId, next);
  },

  sectionHolder(pageId, sectionId) {
    const hold = pages.get(pageId)?.holds.get(sectionId);
    if (!hold || hold.userId === session.personId) return null;
    return hold.name;
  },

  rememberBlocks(pageId, blocks) {
    blocksOf.set(pageId, blocks);
  },
};
