import { onCoreEvent, request } from "./client";
import type { CoreEvent, LockReason } from "./core";
import { primitives } from "./primitives";

// Lo stato della cassaforte nella PAGINA (revisione di sicurezza I-1): uno
// specchio di ciò che dice il worker, che tiene la chiave e la scadenza a ora
// di parete (`core.ts`). Qui nessuna `CryptoKey` e nessun segreto: solo lo
// stato per la barra e le righe, e i SEGNALI della scheda, collegati al boot
// (`boot.ts`, `wireVault`):
// - l'interazione vera (`isTrusted`: pointerdown, keydown, touchstart,
//   wheel) allunga la vita; mai lo scroll né il movimento;
// - al ritorno (`visibilitychange`, `focus`, `pageshow`) si chiede al worker,
//   che chiude se la scadenza è passata;
// - `pagehide` chiude SOLO questa scheda, senza segnale (M-4: si propagano
//   solo «Lock» ed «Esci», design §8);
// - fra le schede (`BroadcastChannel("stubwise-vault")`) solo segnali
//   `locked` e `logout`; «Esci» si manda SEMPRE, anche a cassaforte chiusa
//   (I-2). Ricevuto, la scheda chiude.

export { IDLE_MS } from "./core";
export type { LockReason } from "./core";

export type VaultKeyStatus = { state: "locked" } | { state: "open"; closesAt: number };

/** Il canale fra le schede: solo segnali. */
export const CHANNEL = "stubwise-vault";

let current: VaultKeyStatus = { state: "locked" };
let lastReason: { reason: LockReason; code?: string } | null = null;
const listeners = new Set<(s: VaultKeyStatus) => void>();
let channel: BroadcastChannel | null = null;
let wired = false;
let lastTouch = 0;
/** Un `touch` al worker al più ogni tanto: basta a tenere viva la chiave. */
const TOUCH_EVERY_MS = 15_000;

export function status(): VaultKeyStatus {
  return current;
}

/** L'ultima chiusura e il suo motivo (`reauth`: la barra lo dice). */
export function lastLock(): { reason: LockReason; code?: string } | null {
  return lastReason;
}

function set(next: VaultKeyStatus): void {
  current = next;
  for (const fn of [...listeners]) fn(next);
}

/** Chi ascolta: la barra, le righe mostrate. In modo sincrono (I3). */
export function subscribe(fn: (s: VaultKeyStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function onEvent(event: CoreEvent): void {
  if (event.state === "open") {
    lastReason = null;
    set({ state: "open", closesAt: event.closesAt });
  } else {
    lastReason = { reason: event.reason, ...(event.code ? { code: event.code } : {}) };
    set({ state: "locked" });
  }
}

function signal(type: "locked" | "logout"): void {
  if (channel) primitives.postToChannel(channel, { type });
}

/**
 * Chiude: la pagina lo vede SUBITO (I3), poi lo dice al worker. «Lock» e
 * «Esci» lo dicono alle altre schede; «Esci» anche a cassaforte chiusa (I-2).
 */
export function lock(reason: LockReason): void {
  const wasOpen = current.state === "open";
  if (wasOpen) {
    lastReason = { reason };
    set({ state: "locked" });
  }
  void request({ t: "lock", reason });
  if (reason === "logout") signal("logout");
  else if (reason === "user" && wasOpen) signal("locked");
}

function activity(event: Event): void {
  if (current.state !== "open" || event.isTrusted !== true) return;
  const now = Date.now();
  if (now - lastTouch < TOUCH_EVERY_MS) return;
  lastTouch = now;
  void request({ t: "touch" });
}

function returned(): void {
  if (document.visibilityState === "hidden") return;
  void request<VaultKeyStatus>({ t: "status" }).then((s) => {
    if (s && s.state === "locked" && current.state === "open") set({ state: "locked" });
  });
}

function onPagehide(): void {
  lock("pagehide");
}

function onSignal(event: Event): void {
  const data = (event as MessageEvent).data as { type?: string } | null;
  if (data?.type === "locked" || data?.type === "logout") lock("remote");
}

const ACTIVITY = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/** Al boot (`boot.ts`): gli ascoltatori della scheda e il canale, una volta sola. */
export function wireVault(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onCoreEvent(onEvent);
  for (const type of ACTIVITY) primitives.on(window, type, activity, { capture: true, passive: true });
  primitives.on(window, "focus", returned);
  primitives.on(window, "pageshow", returned);
  primitives.on(document, "visibilitychange", returned);
  primitives.on(window, "pagehide", onPagehide);
  channel = primitives.newChannel(CHANNEL);
  if (channel) primitives.on(channel, "message", onSignal);
}

/** Solo per i test: tutto da capo. Non entra nel bundle (lo chiamano solo i test). */
export function __resetKeyForTests(): void {
  current = { state: "locked" };
  lastReason = null;
  listeners.clear();
  lastTouch = 0;
  if (wired && typeof window !== "undefined") {
    for (const type of ACTIVITY) primitives.off(window, type, activity, { capture: true });
    primitives.off(window, "focus", returned);
    primitives.off(window, "pageshow", returned);
    primitives.off(document, "visibilitychange", returned);
    primitives.off(window, "pagehide", onPagehide);
  }
  channel?.close();
  channel = null;
  wired = false;
}
