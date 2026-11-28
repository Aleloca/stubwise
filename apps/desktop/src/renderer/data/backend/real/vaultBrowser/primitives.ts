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
//
// Revisione I-A (seconda revisione di sicurezza): la PRF si rubava ancora
// dopo il boot, da tre porte che il codice della cerimonia attraversava:
// un `instanceof ArrayBuffer` (`Symbol.hasInstance`, o un `ArrayBuffer`
// globale sostituito), i GETTER della credenziale e della risposta (dentro
// un getter sostituito si chiama il `getClientExtensionResults` nativo) e
// l'`await` sulla promessa della piattaforma (`then` e `constructor` di
// `Promise.prototype`). Per questo qui si catturano anche quei getter, il
// `then` e il `byteLength` di `ArrayBuffer.prototype`, e `harden()` (al
// boot) congela i prototipi che la cerimonia attraversa.

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
// Trusted Types (revisione I-4): la politica del worker si crea con il
// `createPolicy` del primo import.
type TrustedTypesFactory = {
  createPolicy: (name: string, rules: { createScriptURL: (input: string) => string }) => {
    createScriptURL: (input: string) => unknown;
  };
};
const trustedTypes = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
const createPolicy = trustedTypes ? uncurry(trustedTypes.createPolicy) : null;
const isView = ArrayBuffer.isView;
const ITERATOR: typeof Symbol.iterator = Symbol.iterator;
const PromiseCtor = Promise;
const promiseThen = uncurry(Promise.prototype.then) as unknown as <T>(
  self: Promise<T>,
  onFulfilled: (value: T) => void,
  onRejected: (reason: unknown) => void,
) => unknown;

type Getter = (self: unknown) => unknown;
/** Il getter `name` di `proto` (cercato sulla catena) catturato uncurried, o `null`. */
function getterOf(proto: object | undefined, name: string): Getter | null {
  for (let p: object | null | undefined = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d) return d.get ? (uncurry(d.get) as Getter) : null;
  }
  return null;
}
const protoOf = (name: string): object | undefined =>
  (globalThis as unknown as Record<string, { prototype?: object } | undefined>)[name]?.prototype;
const credentialGetters = {
  id: getterOf(protoOf("PublicKeyCredential"), "id"),
  type: getterOf(protoOf("PublicKeyCredential"), "type"),
  rawId: getterOf(protoOf("PublicKeyCredential"), "rawId"),
  response: getterOf(protoOf("PublicKeyCredential"), "response"),
  authenticatorAttachment: getterOf(protoOf("PublicKeyCredential"), "authenticatorAttachment"),
};
const responseGetters = {
  clientDataJSON: getterOf(protoOf("AuthenticatorAssertionResponse"), "clientDataJSON"),
  authenticatorData: getterOf(protoOf("AuthenticatorAssertionResponse"), "authenticatorData"),
  signature: getterOf(protoOf("AuthenticatorAssertionResponse"), "signature"),
  userHandle: getterOf(protoOf("AuthenticatorAssertionResponse"), "userHandle"),
};
const bufferByteLength = getterOf(ArrayBuffer.prototype, "byteLength");
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype) as object;
const viewBuffer = getterOf(typedArrayProto, "buffer");
const viewOffset = getterOf(typedArrayProto, "byteOffset");
const viewLength = getterOf(typedArrayProto, "byteLength");
const Bytes = Uint8Array;
const fillBytes = uncurry(Uint8Array.prototype.fill);

/** Legge `name` col getter catturato; senza (un DOM finto, nei test) la proprietà. */
function read(getter: Getter | null, self: unknown, name: string): unknown {
  return getter ? getter(self) : (self as Record<string, unknown>)[name];
}

/** È un `ArrayBuffer` vero? Il `byteLength` catturato lancia su tutto il resto (I-A: niente `instanceof`). */
function isArrayBuffer(x: unknown): boolean {
  if (!bufferByteLength) return false;
  try {
    bufferByteLength(x);
    return true;
  } catch {
    return false;
  }
}

/**
 * Una lista di transfer che non passa da `Array.prototype[Symbol.iterator]`
 * né dall'iteratore degli array: un iterabile coi SUOI metodi (la
 * conversione WebIDL della sequenza legge le proprietà proprie).
 * I-B2: nessuna copia e nessuna assegnazione (`copy[i] = …` è un [[Set]], e
 * un setter «0» sulla catena vedrebbe la PRF): si LEGGE l'elenco dato, che
 * il chiamante scrive come letterale (`[prf]`, dove gli elementi nascono
 * come proprietà proprie, senza [[Set]]).
 */
function transferList(items: readonly Transferable[]): Iterable<Transferable> {
  return {
    [ITERATOR]: () => {
      let i = 0;
      return { next: () => (i < items.length ? { done: false, value: items[i++]! } : { done: true, value: undefined }) };
    },
  } as Iterable<Transferable>;
}

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
  /**
   * Un worker del bundle, col costruttore del primo import. Con i Trusted
   * Types (I-4) l'URL passa da una politica che accetta SOLO quell'URL.
   */
  newWorker: (url: string, options: WorkerOptions): Worker | null => {
    if (!WorkerCtor) return null;
    if (!createPolicy || !trustedTypes) return new WorkerCtor(url, options);
    const policy = createPolicy(trustedTypes, "stubwise-vault-worker", {
      createScriptURL: (input) => {
        if (input !== url) throw new TypeError("vault_worker_url");
        return input;
      },
    });
    return new WorkerCtor(policy.createScriptURL(url) as unknown as string, options);
  },
  postToWorker: (worker: Worker, message: unknown, transfer: Transferable[]): void => {
    const list = transferList(transfer) as unknown as Transferable[];
    if (postToWorker) postToWorker(worker, message, list);
    else worker.postMessage(message, list);
  },
  /** Azzera un buffer col `fill` del primo import. */
  zero: (buffer: ArrayBuffer): void => {
    fillBytes(new Bytes(buffer), 0);
  },
  /** Il `then` di `Promise.prototype` del primo import, sulla promessa data (I-A: niente `await`). */
  then: <T>(promise: Promise<T>, onFulfilled: (value: T) => void, onRejected: (reason: unknown) => void): void => {
    promiseThen(promise, onFulfilled, onRejected);
  },
  /** Una promessa col costruttore del primo import. */
  newPromise: <T>(executor: (resolve: (value: T) => void) => void): Promise<T> => new PromiseCtor<T>(executor),
  /** Le proprietà della credenziale e della risposta coi getter del primo import. */
  credential: (credential: unknown, name: keyof typeof credentialGetters): unknown =>
    read(credentialGetters[name], credential, name),
  assertionResponse: (response: unknown, name: keyof typeof responseGetters): unknown =>
    read(responseGetters[name], response, name),
  /**
   * L'uscita PRF come un `ArrayBuffer` da TRASFERIRE: lo stesso, se lo è;
   * da una vista tipizzata, una copia (e l'originale si azzera); altro, `null`.
   */
  ownBuffer: (value: unknown): ArrayBuffer | null => {
    if (isArrayBuffer(value)) return value as ArrayBuffer;
    if (!isView(value) || !viewBuffer || !viewOffset || !viewLength) return null;
    try {
      const buffer = viewBuffer(value) as ArrayBuffer;
      const offset = viewOffset(value) as number;
      const length = viewLength(value) as number;
      const copy = sliceBuffer(buffer, offset, offset + length) as ArrayBuffer;
      fillBytes(new Bytes(buffer, offset, length), 0);
      return copy;
    } catch {
      return null;
    }
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

/**
 * I-A: congela i prototipi (e i costruttori) che la cerimonia attraversa,
 * così uno script arrivato dopo il boot non ci mette un getter né un `then`.
 * Lo chiama `boot.ts`; nessun codice dell'app e nessuna libreria del bundle
 * scrive su questi oggetti (controllato sul bundle web). `targets` è per i test.
 */
export function harden(
  targets: readonly unknown[] = defaultHardenTargets(),
  thenless: readonly object[] = defaultThenless(),
): void {
  // I-B1: la promessa della piattaforma si risolve con la credenziale, e la
  // risoluzione legge `then` risalendo la catena fino a `Object.prototype`
  // (che non si congela: lo toccano le librerie). Un `then` proprio e non
  // scrivibile su `Credential.prototype` ferma la ricerca lì.
  for (const o of thenless) {
    if (!Object.isFrozen(o) && !Object.prototype.hasOwnProperty.call(o, "then")) {
      Object.defineProperty(o, "then", { value: undefined, writable: false, enumerable: false, configurable: false });
    }
  }
  for (const t of targets) {
    if (t && (typeof t === "object" || typeof t === "function")) Object.freeze(t);
  }
}

function defaultThenless(): object[] {
  const ctor = (globalThis as unknown as { Credential?: { prototype?: object } }).Credential;
  return ctor?.prototype ? [ctor.prototype] : [];
}

function defaultHardenTargets(): unknown[] {
  const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
  const out: unknown[] = [Promise, Promise.prototype, ArrayBuffer, ArrayBuffer.prototype];
  for (const name of ["Credential", "PublicKeyCredential", "AuthenticatorResponse", "AuthenticatorAssertionResponse"]) {
    const ctor = g[name];
    if (ctor) out.push(ctor, ctor.prototype);
  }
  return out;
}

