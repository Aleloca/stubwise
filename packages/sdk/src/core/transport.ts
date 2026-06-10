import type { IngestEvent } from "@stubwise/shared";

export interface ParsedDsn {
  /** URL completo dell'endpoint di ingestion (`https://host[/prefix]/ingest/slug`). */
  endpoint: string;
  /** Chiave di ingestion da inviare nell'header `X-Stubwise-Key`. */
  key: string;
}

const DSN_PATH = /^(?<prefix>(?:\/[^/]+)*)\/p\/(?<slug>[^/]+)\/?$/;

/**
 * Estrae endpoint e chiave da un DSN nel formato `https://KEY@host/p/slug`.
 * Il path `/p/slug` del DSN viene mappato su `/ingest/slug` sul filo;
 * porta ed eventuale prefisso di path vengono preservati.
 *
 * Unico punto dell'SDK autorizzato a lanciare: un DSN malformato è un
 * errore di configurazione e deve fallire forte all'init, non in silenzio
 * a runtime.
 */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    // niente DSN grezzo nel messaggio: potrebbe contenere la chiave di ingestion
    throw new Error("[stubwise] DSN malformato: la stringa fornita non è un URL valido (atteso https://KEY@host/p/slug)");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`[stubwise] DSN malformato: protocollo "${url.protocol}" non supportato`);
  }
  const key = decodeURIComponent(url.username);
  if (!key) {
    throw new Error("[stubwise] DSN malformato: chiave di ingestion mancante (atteso https://KEY@host/p/slug)");
  }
  const match = DSN_PATH.exec(url.pathname);
  const slug = match?.groups?.["slug"];
  if (!slug) {
    throw new Error(`[stubwise] DSN malformato: path "${url.pathname}" non corrisponde a /p/<slug>`);
  }
  const prefix = match?.groups?.["prefix"] ?? "";
  return { endpoint: `${url.protocol}//${url.host}${prefix}/ingest/${slug}`, key };
}

export interface TransportOptions {
  dsn: string;
  /** Intervallo di flush automatico in millisecondi. Default 3000. */
  flushIntervalMs?: number;
  /** Dimensione massima della coda; oltre, i più vecchi vengono scartati. Default 100. */
  maxQueue?: number;
  /** Tentativi massimi di invio di un batch prima di scartarlo. Default 3. */
  maxRetries?: number;
  /** Implementazione di fetch iniettabile (test, ambienti custom). Default globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface FlushOptions {
  /**
   * Marca le fetch come `keepalive`, così il browser non le aborta quando
   * la pagina viene nascosta o chiusa (pagehide/visibilitychange). I body
   * keepalive hanno un cap di ~64KB: batch più grandi vengono spezzati in
   * più POST sotto il cap.
   */
  keepalive?: boolean;
}

type SendOutcome = "ok" | "retry" | "drop";

/** Cap prudente sotto il limite ~64KB imposto dai browser ai body keepalive. */
const KEEPALIVE_BODY_CAP_BYTES = 60000;

/** Byte UTF-8 di una stringa (i body JSON viaggiano in UTF-8). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Spezza un batch in chunk il cui body serializzato resta sotto il cap
 * keepalive. Greedy, ordine preservato; un singolo evento sopra il cap fa
 * chunk a sé (non è ulteriormente divisibile).
 */
function splitForKeepalive(batch: IngestEvent[]): IngestEvent[][] {
  const wrapperBytes = byteLength('{"events":[]}');
  const chunks: IngestEvent[][] = [];
  let current: IngestEvent[] = [];
  let currentBytes = wrapperBytes;
  for (const event of batch) {
    // +1 per la virgola di separazione (stima per eccesso sul primo elemento)
    const eventBytes = byteLength(JSON.stringify(event)) + 1;
    if (current.length > 0 && currentBytes + eventBytes > KEEPALIVE_BODY_CAP_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = wrapperBytes;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Trasporto con batching, retry e backoff. Invariante di affidabilità:
 * dopo il costruttore (che valida il DSN) nessun metodo lancia mai —
 * l'SDK gira dentro le app degli utenti e non deve mai romperle.
 */
export class Transport {
  private readonly endpoint: string;
  private readonly key: string;
  private readonly flushIntervalMs: number;
  private readonly maxQueue: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  private queue: IngestEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  /** Fallimenti consecutivi del batch corrente. */
  private attempt = 0;

  constructor(options: TransportOptions) {
    const { endpoint, key } = parseDsn(options.dsn);
    this.endpoint = endpoint;
    this.key = key;
    this.flushIntervalMs = options.flushIntervalMs ?? 3000;
    this.maxQueue = options.maxQueue ?? 100;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  /** Accoda un evento e avvia (pigramente) il timer di flush. Non lancia mai. */
  enqueue(event: IngestEvent): void {
    try {
      this.queue.push(event);
      if (this.queue.length > this.maxQueue) {
        this.queue.splice(0, this.queue.length - this.maxQueue);
      }
      this.scheduleFlush(this.flushIntervalMs);
    } catch {
      // mai propagare nell'app ospite
    }
  }

  /**
   * Invia subito tutto ciò che è in coda. Si risolve sempre, non rigetta mai.
   * Con `{ keepalive: true }` le fetch sopravvivono allo scarico della pagina.
   */
  async flush(options?: FlushOptions): Promise<void> {
    try {
      this.clearTimer();
      await this.flushInternal(options?.keepalive === true);
    } catch {
      // mai propagare nell'app ospite
    }
  }

  /**
   * Il timer parte solo al primo enqueue (niente lavoro su app inattive)
   * e non sovrascrive mai un timer già pendente, così il delay di backoff
   * non viene accorciato da enqueue successivi. Chi ha bisogno di
   * riprogrammare con un delay diverso (es. il backoff dei retry) deve
   * prima chiamare clearTimer().
   */
  private scheduleFlush(delayMs: number): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushInternal().catch(() => undefined);
    }, delayMs);
    // in Node il timer non deve tenere vivo il processo
    const maybeUnref = this.timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Una singola POST verso l'endpoint di ingestion. Non lancia mai. */
  private async sendBatch(events: IngestEvent[], keepalive: boolean): Promise<SendOutcome> {
    try {
      const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Stubwise-Key": this.key,
        },
        body: JSON.stringify({ events }),
      };
      // impostato solo quando serve: un flush normale non deve pagare il
      // cap di ~64KB che i browser applicano ai body keepalive
      if (keepalive) init.keepalive = true;
      const response = await this.fetchImpl(this.endpoint, init);
      if (response.ok) return "ok";
      if (response.status === 429 || response.status >= 500) return "retry";
      // 4xx (401/422...): errore di configurazione, ritentare non aiuta
      try {
        console.warn(
          `[stubwise] il server ha rifiutato un batch di ${events.length} eventi con status ${response.status}: batch scartato`,
        );
      } catch {
        // anche un console.warn rotto non deve propagare
      }
      return "drop";
    } catch {
      // errore di rete (o fetchImpl rotto): trattato come transitorio
      return "retry";
    }
  }

  private async flushInternal(keepalive = false): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    // batch = tutta la coda (cap a maxQueue ⇒ sempre ≤ 100, il limite del server)
    const batch = this.queue;
    this.queue = [];
    let outcome: SendOutcome = "retry";
    try {
      if (keepalive && byteLength(JSON.stringify({ events: batch })) > KEEPALIVE_BODY_CAP_BYTES) {
        // body oltre il cap keepalive: spezzato in più POST, ognuna sotto il
        // cap. Best effort: la pagina sta scomparendo, un retry non avrebbe
        // mai il tempo di partire, quindi i chunk falliti vengono scartati.
        const results = await Promise.all(
          splitForKeepalive(batch).map((chunk) => this.sendBatch(chunk, true)),
        );
        outcome = results.every((r) => r === "ok") ? "ok" : "drop";
      } else {
        outcome = await this.sendBatch(batch, keepalive);
      }
    } catch {
      outcome = "retry";
    } finally {
      this.flushing = false;
    }

    if (outcome === "ok" || outcome === "drop") {
      this.attempt = 0;
      // eventi accodati durante l'invio ripartono con il ritmo normale
      if (this.queue.length > 0) this.scheduleFlush(this.flushIntervalMs);
      return;
    }

    // outcome === "retry"
    this.attempt += 1;
    if (this.attempt >= this.maxRetries) {
      // batch scartato dopo maxRetries tentativi; si riparte puliti
      this.attempt = 0;
      if (this.queue.length > 0) this.scheduleFlush(this.flushIntervalMs);
      return;
    }
    // rimette il batch in testa (preserva l'ordine) rispettando il cap.
    // Nota: il batch rimesso in coda condivide il contatore `attempt` con gli
    // eventi accodati nel frattempo — se il batch unito continua a fallire,
    // anche i nuovi eventi vengono scartati al raggiungimento di maxRetries,
    // prima di aver avuto "i loro" tentativi. Compromesso accettato per
    // tenere semplice il trasporto.
    this.queue = [...batch, ...this.queue];
    if (this.queue.length > this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    // un enqueue arrivato mentre il fetch era in volo può aver schedulato un
    // timer a intervallo normale: va cancellato, altrimenti scheduleFlush
    // farebbe no-op e il backoff verrebbe accorciato a 1× intervallo
    this.clearTimer();
    this.scheduleFlush(2 ** this.attempt * this.flushIntervalMs);
  }
}
