import {
  isAllowedProductLiveStreamPath,
  parseProductLiveFrame,
  productLiveStreamPath,
  sectionKeyOf,
  splitSseFrames,
  streamBackoffMs,
  type ProductLiveFrame,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ProductBlock, ProductPageEvent, ProductPresenceView } from "../../types";
import { initialsOf, presenceColor } from "../../../domain/productDocs/presence";
import { ApiError } from "@stubwise/api-client";
import { appClient, session } from "./client";

// La scrittura dal vivo di una pagina di prodotto nella build app (area 11,
// F4; R11-4), sulle forme di 72 in shared (61de0e593: `parseProductLiveFrame`,
// gli schemi dei frame, `sectionKeyOf`):
// - UNO stream per pagina (`GET /api/product-pages/:id/live`), condiviso da
//   chi la guarda: all'apertura (e a ogni ripresa) `state` (gli ALTRI presenti
//   coi cursori, le prese delle sezioni, l'ultimo `seq`), poi `revision`,
//   `presence` (la lista intera), `cursor`, `hold`, `release`, `gone`. Una
//   revisione di un altro dice «blocks»: la pagina si rilegge (le operazioni
//   sono nell'evento, ma rileggere tiene una sola strada per il corpo, quella
//   di F1; una revisione del worker arriva senza operazioni). Le revisioni
//   delle sessioni di questo editor arrivano anche qui, col loro
//   `sessionId`: si scartano, la pagina le ha già;
// - il trasporto è quello della Chat: sul web `fetch` col cookie e il
//   watchdog dei ping, sul desktop `window.stubwise.openStream` del main
//   (allowlist stretta, Bearer nel main) che consegna il frame com'è
//   (`productFrame`). Il main non riconnette: qui la ripresa, col backoff
//   delle sessioni, e alla ripresa la pagina si rilegge. 401/403/404 chiude:
//   la pagina non si vede più («gone»);
// - il battito (`POST …/live/presence`) ogni 5 s mentre si è dentro, col
//   cursore e la sezione del blocco (che rinnova la presa); il server fa
//   scadere a 15 s chi non batte;
// - chi tiene una sezione con un nome `null` (R-G5) non si dice.
// Dietro `product-live`.

// --- il trasporto (lo stesso della Chat) ---------------------------------------------

export interface ProductLiveEnd {
  fatal?: boolean;
  status?: number;
}
export interface ProductLiveHandlers {
  /** Un frame com'è (testo SSE, senza i ping). */
  onFrame(raw: string): void;
  /** Un frame scartato perché troppo grande: si rilegge la pagina (revisione di R11-4, 13). */
  onDropped?(): void;
  onClose(end: ProductLiveEnd | null): void;
}
export type ProductLiveTransport = (path: string, handlers: ProductLiveHandlers) => () => void;

const FATAL_STATUS = new Set([401, 403, 404]);
/** Il server manda `: ping`: senza un byte per questo tempo la connessione è morta (come la Chat). */
const PING_TIMEOUT_MS = 60_000;

/** Il frame più grande che si legge, come il main (1 MB): oltre, si rilegge la pagina. */
const FRAME_MAX = 1_000_000;

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
        for (const raw of frames) {
          if (onlyComments(raw)) continue;
          if (raw.length > FRAME_MAX) handlers.onDropped?.();
          else handlers.onFrame(raw);
        }
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
    else if (message.type === "productFrameDropped") handlers.onDropped?.();
    else if (message.type === "end") {
      done = true;
      // Solo 401/403/404 chiudono per sempre (la pagina non si legge più). Il
      // main dice `fatal` anche per il tetto della finestra, un percorso
      // rifiutato o un rinvio: per il dal vivo si riprova col backoff
      // (revisione di R11-4, 5).
      handlers.onClose({
        fatal: message.status !== undefined && FATAL_STATUS.has(message.status),
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
  pageId: string;
  listeners: Set<(event: ProductPageEvent) => void>;
  present: Map<
    string,
    { name: string; cursor: { blockId: string; offset: number } | null; sectionId: string | null }
  >;
  close: (() => void) | null;
  /** L'ultimo `seq` visto (stato o revisione); `null` prima del primo `state`. */
  seq: number | null;
  attempts: number;
  retry: ReturnType<typeof setTimeout> | null;
}

const pages = new Map<string, PageLive>();
/** Le sessioni dell'editor di questa finestra (le revisioni loro non si rileggono). */
const mySessions = new Set<string>();
/** I battiti in corso, per pagina, e l'ultimo cursore mandato. */
const beats = new Map<string, BeatEntry>();
/** I blocchi di adesso di una pagina (per la sezione del cursore): li dà la lettura della pagina. */
const blocksOf = new Map<string, readonly ProductBlock[]>();
/** Il `seq` dell'ultima lettura di ogni pagina: il primo `state` si confronta con questo. */
const knownSeq = new Map<string, number>();

type Presence = { cursor: { blockId: string; offset: number } | null; sectionId?: string | null };

/** Il battito ogni quanto (il server fa scadere a 15 s). */
const BEAT_MS = 5_000;

const emit = (page: PageLive, event: ProductPageEvent) => {
  for (const fn of [...page.listeners]) fn(event);
};

/**
 * Un frame sullo stato della pagina, e cosa dire a chi ascolta. `state`
 * arriva all'apertura e a ogni ripresa: se il suo `seq` è più avanti
 * dell'ultimo visto, intanto è cambiato il corpo e la pagina si rilegge.
 */
function apply(page: PageLive, f: ProductLiveFrame): ProductPageEvent[] {
  switch (f.type) {
    case "state": {
      // Il primo `state` si confronta col `seq` della lettura della pagina (revisione di R11-4, 7).
      const seen = page.seq ?? knownSeq.get(page.pageId) ?? null;
      const behind = seen !== null && f.seq > seen;
      page.seq = f.seq;
      page.present = new Map(
        f.presence.map((p) => [
          p.userId,
          { name: p.name, cursor: p.cursor, sectionId: p.sectionId },
        ]),
      );
      return behind ? ["presence", "blocks"] : ["presence"];
    }
    case "revision":
      page.seq = Math.max(page.seq ?? 0, f.seq);
      return f.sessionId !== null && mySessions.has(f.sessionId) ? [] : ["blocks"];
    case "presence":
      page.present = new Map(
        f.presence.map((p) => [
          p.userId,
          { name: p.name, cursor: p.cursor, sectionId: p.sectionId },
        ]),
      );
      return ["presence"];
    case "cursor": {
      const was = page.present.get(f.userId);
      if (!was) return [];
      page.present.set(f.userId, { ...was, cursor: f.cursor });
      return ["presence"];
    }
    // Le prese non si tengono qui: chi scrive in una sezione lo dice la presenza
    // (`sectionId`), che l'editor mostra nel blocco col fuoco.
    case "hold":
    case "release":
      return [];
    case "gone":
      return ["gone"];
    default:
      return [];
  }
}

function connect(pageId: string, page: PageLive): void {
  const path = productLiveStreamPath(pageId);
  if (!isAllowedProductLiveStreamPath(path)) return;
  page.close = currentTransport()(path, {
    onFrame(raw) {
      for (const frame of parseProductLiveFrame(raw)) {
        page.attempts = 0;
        for (const event of apply(page, frame)) emit(page, event);
      }
    },
    onDropped() {
      emit(page, "blocks");
    },
    onClose(end) {
      page.close = null;
      if (end === null || !pages.has(pageId)) return;
      // Col server giù avatar e prese non restano a schermo (revisione di R11-4, 8).
      if (page.present.size > 0) {
        page.present = new Map();
        emit(page, "presence");
      }
      if (end.fatal) {
        emit(page, "gone");
        return;
      }
      // Una caduta: si riapre dopo il backoff; il `state` della ripresa dice se rileggere.
      page.retry = setTimeout(() => {
        page.retry = null;
        if (pages.get(pageId) === page) connect(pageId, page);
      }, streamBackoffMs(page.attempts++));
    },
  });
}

/** Solo nei test, e al cambio di persona: chiude ogni stream e ferma ogni battito. */
export function forgetProductLive(): void {
  for (const page of pages.values()) {
    page.close?.();
    if (page.retry) clearTimeout(page.retry);
  }
  pages.clear();
  for (const beat of beats.values()) {
    clearInterval(beat.timer);
    if (beat.later) clearTimeout(beat.later);
  }
  beats.clear();
  blocksOf.clear();
  knownSeq.clear();
  mySessions.clear();
}

/**
 * La scheda di questa finestra (72, b138abc37): due schede della stessa
 * persona sono due presenze, e una che lascia le prese non toglie quella
 * dell'altra che scrive.
 */
const TAB_ID = `tab-${crypto.randomUUID()}`;

/** Un battito subito, fuori dalla cadenza (l'uscita). */
const beatNow = (pageId: string, at: Presence | null) =>
  appClient()
    .productDocs.beat(pageId, { ...(at ?? {}), sessionId: TAB_ID })
    .then(
      () => undefined,
      () => undefined,
    );

/** Al più un battito ogni tanto: il server ne ammette 120 al minuto per persona (revisione di R11-4, 1). */
const BEAT_MIN_MS = 1_000;
/** Dopo un 429 si aspetta tanto prima del battito dopo. */
const LIMITED_MS = 10_000;

/**
 * Manda l'ultima posizione della pagina, rispettando la cadenza: subito se
 * l'ultimo battito è di più di `BEAT_MIN_MS` fa, altrimenti alla fine
 * dell'attesa (le posizioni intermedie si saltano). Un 429 ferma i battiti
 * per `LIMITED_MS`. Un altro errore non dice niente: il prossimo rimedia.
 */
function flush(pageId: string, entry: BeatEntry): Promise<void> {
  const now = Date.now();
  const at = Math.max(entry.lastSent + BEAT_MIN_MS, entry.pausedUntil);
  if (now < at) {
    if (!entry.later) {
      entry.later = setTimeout(() => {
        entry.later = null;
        if (beats.get(pageId) === entry) void flush(pageId, entry);
      }, at - now);
    }
    return Promise.resolve();
  }
  entry.lastSent = now;
  return appClient()
    .productDocs.beat(pageId, { ...(entry.at ?? {}), sessionId: TAB_ID })
    .then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 429)
          entry.pausedUntil = Date.now() + LIMITED_MS;
      },
    );
}

interface BeatEntry {
  timer: ReturnType<typeof setInterval>;
  at: Presence | null;
  lastSent: number;
  pausedUntil: number;
  later: ReturnType<typeof setTimeout> | null;
}

type ProductDocs = typeof Fake.productDocs;

export const liveProductPresence: Partial<ProductDocs> & {
  /** I blocchi di adesso di una pagina e il loro `seq` (la sezione del cursore, il primo `state`). */
  rememberBlocks(pageId: string, blocks: readonly ProductBlock[], seq?: number): void;
  /** Una sessione dell'editor di questa finestra: le sue revisioni non si rileggono. */
  rememberSession(sessionId: string): void;
} = {
  subscribeProductPage(pageId, cb) {
    let page = pages.get(pageId);
    if (!page) {
      page = {
        pageId,
        listeners: new Set(),
        present: new Map(),
        close: null,
        seq: null,
        attempts: 0,
        retry: null,
      };
      pages.set(pageId, page);
      page.listeners.add(cb);
      connect(pageId, page);
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
      personId === me
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
              // La sezione in cui scrive (la presa): l'editor la dice nel blocco col fuoco.
              ...(p.sectionId ? { sectionId: p.sectionId } : {}),
              initials: initialsOf(p.name),
              color: presenceColor(personId),
            },
          ],
    );
  },

  async joinProductPage(pageId) {
    if (beats.has(pageId)) return;
    const entry: BeatEntry = {
      timer: setInterval(() => void flush(pageId, entry), BEAT_MS),
      at: null,
      lastSent: 0,
      pausedUntil: 0,
      later: null,
    };
    beats.set(pageId, entry);
    await flush(pageId, entry);
  },

  leaveProductPageAs(_me, pageId) {
    const entry = beats.get(pageId);
    if (!entry) return;
    clearInterval(entry.timer);
    if (entry.later) clearTimeout(entry.later);
    beats.delete(pageId);
    // Uscire lascia le prese di questa scheda (revisione di R11-4, 11).
    void beatNow(pageId, { cursor: null, sectionId: null });
  },

  async setProductPresence(pageId, at) {
    // Con l'ancora: il cursore e la sua sezione (`sectionKeyOf`, `top` in cima),
    // che rinnova la presa; senza, `sectionId: null` lascia le prese di chi guarda.
    // La sezione la dà l'editor (la sua vista con la fila: un blocco appena
    // creato c'è già, revisione di R11-4, 4); senza, dai blocchi dell'ultima lettura.
    const next: Presence = at
      ? {
          cursor: { blockId: at.anchorId, offset: at.offset },
          sectionId: at.sectionId ?? sectionKeyOf(blocksOf.get(pageId) ?? [], at.anchorId),
        }
      : { cursor: null, sectionId: null };
    const entry = beats.get(pageId);
    if (!entry) return beatNow(pageId, next);
    entry.at = next;
    await flush(pageId, entry);
  },

  rememberBlocks(pageId, blocks, seq) {
    blocksOf.set(pageId, blocks);
    if (seq !== undefined) knownSeq.set(pageId, seq);
  },

  rememberSession(sessionId) {
    mySessions.add(sessionId);
  },
};
