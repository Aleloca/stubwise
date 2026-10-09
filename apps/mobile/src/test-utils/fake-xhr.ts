/**
 * Un `XMLHttpRequest` finto per i test dello stream delle sessioni
 * (`lib/agent-session-stream.ts`) e delle schermate che lo aprono.
 *
 * Serve perché sotto Jest il preset RN sostituisce il modulo nativo
 * `Networking`: un `new XMLHttpRequest()` vero non risponde mai. Il finto
 * riproduce SOLO ciò che lo stream usa, con la semantica di RN 0.87
 * (`Libraries/Network/XMLHttpRequest.js`):
 * - lo status è noto dagli header (`respond`), prima del corpo;
 * - il corpo arriva a pezzi in `responseText`, che CRESCE (`emit`): ogni pezzo
 *   è già testo decodificato (il nativo tiene da parte i byte di un carattere
 *   multibyte spezzato: carry data su iOS, `ProgressiveStringDecoder` su
 *   Android), quindi un pezzo non contiene mai mezzo carattere;
 * - anche il corpo di un errore (401, 404…) passa da `progress`;
 * - `abort()` emette `abort` e azzera `responseText`, mai `load`/`error`.
 *
 * Ogni istanza creata finisce in `FakeXhr.instances`, nell'ordine: un test
 * guarda la connessione N con `FakeXhr.instances[N]`.
 */
export class FakeXhr {
  static instances: FakeXhr[] = [];

  /** Azzera l'elenco delle istanze (da chiamare in `beforeEach`). */
  static reset(): void {
    FakeXhr.instances = [];
  }

  /** La fabbrica da passare a `createXhr`. */
  static create = (): XMLHttpRequest => {
    const xhr = new FakeXhr();
    FakeXhr.instances.push(xhr);
    return xhr as unknown as XMLHttpRequest;
  };

  method: string | null = null;
  url: string | null = null;
  headers: Record<string, string> = {};
  sent = false;
  aborted = false;
  status = 0;
  readyState = 0;
  responseText = "";
  timeout = 0;

  onreadystatechange: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  /** Gli handler assegnati al momento di `send()` (RN decide lì se mandare dati incrementali). */
  handlersAtSend: string[] = [];

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(): void {
    this.sent = true;
    this.handlersAtSend = (
      ["onreadystatechange", "onprogress", "onload", "onerror", "ontimeout"] as const
    ).filter((name) => this[name] !== null);
  }

  abort(): void {
    this.aborted = true;
    this.responseText = "";
    this.readyState = 4;
    this.onreadystatechange?.();
    this.onabort?.();
  }

  // --- comandi del test -----------------------------------------------------

  /** Arrivano gli header con questo status. */
  respond(status: number): void {
    this.status = status;
    this.readyState = 2;
    this.onreadystatechange?.();
  }

  /** Arriva un pezzo di corpo (header impliciti a 200 se non ancora arrivati). */
  emit(text: string): void {
    if (this.readyState < 2) this.respond(200);
    this.responseText += text;
    this.readyState = 3;
    this.onreadystatechange?.();
    this.onprogress?.();
  }

  /** La risposta finisce normalmente (`load`), con questo status se non c'erano ancora header. */
  finish(status?: number): void {
    if (this.readyState < 2) this.respond(status ?? 200);
    this.readyState = 4;
    this.onreadystatechange?.();
    this.onload?.();
  }

  /** La connessione cade (`error`). */
  fail(): void {
    this.readyState = 4;
    this.onreadystatechange?.();
    this.onerror?.();
  }

  /** La richiesta scade (`timeout`). */
  expire(): void {
    this.readyState = 4;
    this.onreadystatechange?.();
    this.ontimeout?.();
  }

  /** Il parametro `after` della URL, o null se assente. */
  get after(): string | null {
    // Niente `URL`: quello di React Native non implementa `searchParams`.
    const match = this.url ? /[?&]after=([^&]*)/.exec(this.url) : null;
    return match ? decodeURIComponent(match[1]!) : null;
  }
}

/** Un frame SSE `data: {json}\n\n`. */
export function sseFrame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
