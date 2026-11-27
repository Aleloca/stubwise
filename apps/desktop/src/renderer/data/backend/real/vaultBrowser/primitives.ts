// Le primitive della cassaforte nel browser, CATTURATE al primo import
// (design §2.4, revisione di sicurezza I-1). La build web importa questo
// modulo per PRIMO (`@backend/vault-boot` in `main.tsx`).
//
// La crittografia, la chiave di persona e la rete della cassaforte stanno in
// un Dedicated Worker (`worker.ts`), un reame che gli script della pagina non
// raggiungono. Nella pagina resta solo la cerimonia WebAuthn, e per lei si
// catturano i METODI, non gli oggetti, in forma «uncurried» (`call` legato
// all'originale): sostituire dopo un prototipo (`getClientExtensionResults`,
// `postMessage`, `slice`…) non cambia ciò che usa la cassaforte. La PRF passa
// al worker per transfer, subito dopo la cerimonia, e non resta qui.
// È un argine, non un muro (chi gira PRIMA vince): per questo vengono prima
// la CSP e i Trusted Types.

type Uncurried<F extends (...args: never[]) => unknown> = (self: unknown, ...args: Parameters<F>) => ReturnType<F>;

const call = Function.prototype.call;
/** `fn` legato a `Function.prototype.call` di adesso: `uncurry(m)(obj, ...args)` = `m.call(obj, ...args)`. */
function uncurry<F extends (...args: never[]) => unknown>(fn: F): Uncurried<F> {
  return call.bind(fn) as unknown as Uncurried<F>;
}

const realCredentials = typeof navigator !== "undefined" ? navigator.credentials : undefined;
const credentialsGet = realCredentials?.get ? uncurry(realCredentials.get) : null;
const credentialsCreate = realCredentials?.create ? uncurry(realCredentials.create) : null;
const getExtensionResults =
  typeof PublicKeyCredential !== "undefined" && PublicKeyCredential.prototype.getClientExtensionResults
    ? uncurry(PublicKeyCredential.prototype.getClientExtensionResults)
    : null;
const sliceBuffer = uncurry(ArrayBuffer.prototype.slice);
const WorkerCtor = typeof Worker !== "undefined" ? Worker : null;
const postToWorker = WorkerCtor
  ? (call.bind(WorkerCtor.prototype.postMessage) as unknown as (self: Worker, message: unknown, transfer: Transferable[]) => void)
  : null;
const addListener = uncurry(EventTarget.prototype.addEventListener);
const removeListener = uncurry(EventTarget.prototype.removeEventListener);
const Channel = typeof BroadcastChannel !== "undefined" ? BroadcastChannel : null;
const postToChannel = Channel ? uncurry(Channel.prototype.postMessage) : null;
const realFetch = globalThis.fetch;
const isView = ArrayBuffer.isView;

export const primitives = Object.freeze({
  fetch: realFetch.bind(globalThis) as typeof fetch,
  credentialsGet: (options: CredentialRequestOptions): Promise<Credential | null> =>
    credentialsGet && realCredentials
      ? credentialsGet(realCredentials, options)
      : Promise.reject(new Error("webauthn_unavailable")),
  credentialsCreate: (options: CredentialCreationOptions): Promise<Credential | null> =>
    credentialsCreate && realCredentials
      ? credentialsCreate(realCredentials, options)
      : Promise.reject(new Error("webauthn_unavailable")),
  /** I risultati delle estensioni con il metodo del primo import. */
  extensionResults: (credential: Credential): AuthenticationExtensionsClientOutputs =>
    getExtensionResults
      ? getExtensionResults(credential)
      : (credential as PublicKeyCredential).getClientExtensionResults(),
  /** Una copia d'un ArrayBuffer (o della sua parte), con lo `slice` del primo import. */
  copyBuffer: (source: ArrayBuffer | ArrayBufferView): ArrayBuffer =>
    isView(source)
      ? (sliceBuffer(source.buffer, source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer)
      : (sliceBuffer(source, 0) as ArrayBuffer),
  /** Un worker del bundle, col costruttore del primo import. */
  newWorker: (url: URL, options: WorkerOptions): Worker | null => (WorkerCtor ? new WorkerCtor(url, options) : null),
  postToWorker: (worker: Worker, message: unknown, transfer: Transferable[]): void => {
    if (postToWorker) postToWorker(worker, message, transfer);
    else worker.postMessage(message, transfer);
  },
  // Nel browser il metodo catturato vale per ogni EventTarget, `window`
  // compreso. Il ripiego sul metodo dell'oggetto serve solo a un DOM finto
  // (happy-dom, nei test), che implementa `window` fuori da EventTarget.
  on: (target: EventTarget, type: string, fn: (event: Event) => void, options?: AddEventListenerOptions): void => {
    try {
      addListener(target, type, fn as EventListener, options);
    } catch {
      target.addEventListener(type, fn, options);
    }
  },
  off: (target: EventTarget, type: string, fn: (event: Event) => void, options?: EventListenerOptions): void => {
    try {
      removeListener(target, type, fn as EventListener, options);
    } catch {
      target.removeEventListener(type, fn, options);
    }
  },
  newChannel: (name: string): BroadcastChannel | null => (Channel ? new Channel(name) : null),
  postToChannel: (channel: BroadcastChannel, message: unknown): void => {
    if (postToChannel) postToChannel(channel, message);
    else channel.postMessage(message);
  },
});
