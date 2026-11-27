// Dove vive la chiave della cassaforte nella build web (`/app`): design
// `docs/plans/2026-11-27-cassaforte-browser-design.md` §5, §7, §8.
//
// - SOLO in memoria, in questo modulo, come `CryptoKey` non estraibile: mai
//   in `localStorage`, `sessionStorage`, IndexedDB, Service Worker, nella
//   cache di React Query o in un log (un test sul sorgente lo vieta in
//   `vaultBrowser/`).
// - Legata a persona e sessione (I5): un cambio dell'una o dell'altra la
//   rende inutilizzabile alla prossima `use`.
// - Chiusa dopo 15 minuti senza uso, A ORA DI PARETE (I2): la scadenza si
//   controlla a ogni `use()` e al ritorno della pagina (`visibilitychange`,
//   `focus`, `pageshow`); il timer serve solo a chiudere in tempo una pagina
//   in primo piano. Un Mac sospeso o una pagina nel bfcache tornano chiusi.
// - Conta come uso solo l'interazione vera (`isTrusted`: pointerdown,
//   keydown, touchstart, wheel), mai lo scroll né il movimento del mouse, e
//   ogni `use()` della chiave.
// - `pagehide` chiude. Fra le schede viaggiano solo SEGNALI (`locked`,
//   `logout`), mai la chiave: ogni scheda ha il suo sblocco (C4).

/** 15 minuti senza uso (design §7, come il Mac). */
export const IDLE_MS = 15 * 60_000;

export type LockReason = "user" | "idle" | "logout" | "pagehide" | "session" | "remote";

export type VaultKeyStatus = { state: "locked" } | { state: "open"; closesAt: number };

/** Il canale fra le schede: solo segnali, con chi (`personId`). */
export const CHANNEL = "stubwise-vault";

type Signal = { type: "locked" | "logout"; personId: string };

interface OpenKey {
  key: CryptoKey;
  personId: string;
  sessionId: string;
  openedAt: number;
  lastUseAt: number;
}

let current: OpenKey | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(s: VaultKeyStatus) => void>();
let channel: BroadcastChannel | null = null;
let wired = false;

const now = () => Date.now();

export function status(): VaultKeyStatus {
  return current ? { state: "open", closesAt: current.lastUseAt + IDLE_MS } : { state: "locked" };
}

function emit(): void {
  const s = status();
  for (const fn of [...listeners]) fn(s);
}

/** Chi ascolta: la barra, le righe mostrate, la cache delle query. Restituisce chi smette. */
export function subscribe(fn: (s: VaultKeyStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function arm(): void {
  clearTimeout(timer);
  if (!current) return;
  const left = current.lastUseAt + IDLE_MS - now();
  timer = setTimeout(() => expireIfDue(), Math.max(0, left) + 1);
}

/** Chiude se la scadenza è passata (a ora di parete). Vero se ha chiuso. */
function expireIfDue(): boolean {
  if (current && now() - current.lastUseAt > IDLE_MS) {
    lock("idle");
    return true;
  }
  if (current) arm();
  return false;
}

function post(signal: Signal): void {
  try {
    channel?.postMessage(signal);
  } catch {
    // Un canale chiuso non ferma la chiusura di questa scheda.
  }
}

/** Apre: tiene la chiave legata a persona e sessione. Riparte il conto dei 15 minuti. */
export function open(key: CryptoKey, personId: string, sessionId: string): void {
  wire();
  const t = now();
  current = { key, personId, sessionId, openedAt: t, lastUseAt: t };
  arm();
  emit();
}

/**
 * La chiave per UN uso (reveal, wrap, unwrap). Chiusa, scaduta, o con persona
 * o sessione diverse da quelle di adesso: chiude e lancia `vault_locked`. Un
 * uso riparte il conto.
 */
export function use(personId: string, sessionId: string): CryptoKey {
  if (!current) throw new Error("vault_locked");
  if (current.personId !== personId || current.sessionId !== sessionId) {
    lock("session");
    throw new Error("vault_locked");
  }
  if (expireIfDue()) throw new Error("vault_locked");
  current.lastUseAt = now();
  arm();
  return current.key;
}

/** Chiude: butta la chiave, avvisa chi ascolta e, se la chiusura nasce qui, le altre schede. */
export function lock(reason: LockReason): void {
  const was = current;
  current = null;
  clearTimeout(timer);
  timer = undefined;
  if (!was) return;
  if (reason !== "remote") post({ type: reason === "logout" ? "logout" : "locked", personId: was.personId });
  emit();
}

/** Un'interazione vera della persona: allunga la vita della chiave aperta. */
function activity(event: Event): void {
  if (!current || event.isTrusted !== true) return;
  if (expireIfDue()) return;
  current.lastUseAt = now();
  arm();
}

/** Il ritorno della pagina: la scadenza passata chiude prima di ogni uso. */
function returned(): void {
  if (document.visibilityState === "hidden") return;
  expireIfDue();
}

const ACTIVITY = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  for (const type of ACTIVITY) window.addEventListener(type, activity, { capture: true, passive: true });
  window.addEventListener("focus", returned);
  window.addEventListener("pageshow", returned);
  document.addEventListener("visibilitychange", returned);
  window.addEventListener("pagehide", onPagehide);
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = onSignal;
  }
}

function onPagehide(): void {
  lock("pagehide");
}

function onSignal(event: MessageEvent): void {
  const data = event.data as Partial<Signal> | null;
  if (data?.type === "locked" || data?.type === "logout") lock("remote");
}

/** Solo per i test: tutto da capo, senza ascoltatori né canale. */
export function __resetKeyForTests(): void {
  current = null;
  clearTimeout(timer);
  timer = undefined;
  listeners.clear();
  if (wired && typeof window !== "undefined") {
    for (const type of ACTIVITY) window.removeEventListener(type, activity, { capture: true });
    window.removeEventListener("focus", returned);
    window.removeEventListener("pageshow", returned);
    document.removeEventListener("visibilitychange", returned);
    window.removeEventListener("pagehide", onPagehide);
  }
  channel?.close();
  channel = null;
  wired = false;
}
