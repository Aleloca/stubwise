import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetKeyForTests, IDLE_MS, lock, open, status, subscribe, use } from "./key";

// Dove vive la chiave della cassaforte nella scheda (design della cassaforte
// nel browser §5, §7, §8; le prove del §14): in memoria, legata a persona e
// sessione, chiusa dopo 15 minuti senza uso A ORA DI PARETE.

const ME = "p-ada";
const SESSION = "s-1";
let key: CryptoKey;

beforeEach(async () => {
  __resetKeyForTests();
  key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
});
afterEach(() => {
  vi.useRealTimers();
  __resetKeyForTests();
});

/** Un evento «vero» dell'utente: `isTrusted` lo dà solo il browser. */
function trusted(type: string): Event {
  const e = new Event(type);
  Object.defineProperty(e, "isTrusted", { value: true });
  return e;
}

describe("la chiave nella scheda", () => {
  it("aperta: `use` dà la chiave a chi l'ha aperta, con la stessa sessione", () => {
    open(key, ME, SESSION);
    expect(use(ME, SESSION)).toBe(key);
    expect(status()).toMatchObject({ state: "open" });
  });

  it("chiusa: `use` lancia `vault_locked`", () => {
    expect(() => use(ME, SESSION)).toThrow("vault_locked");
    expect(status()).toEqual({ state: "locked" });
  });

  it("I5: un'altra persona o un'altra sessione la chiude e lancia", () => {
    open(key, ME, SESSION);
    expect(() => use("p-bob", SESSION)).toThrow("vault_locked");
    expect(status()).toEqual({ state: "locked" });
    open(key, ME, SESSION);
    expect(() => use(ME, "s-2")).toThrow("vault_locked");
    expect(status()).toEqual({ state: "locked" });
  });

  it("I2: dopo 15 minuti A ORA DI PARETE si chiude al primo `use`, senza nessun timer", () => {
    // Solo `Date`: nessun setTimeout scatta, conta l'ora (un Mac sospeso, il bfcache).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    open(key, ME, SESSION);
    vi.setSystemTime(Date.now() + IDLE_MS + 1);
    expect(() => use(ME, SESSION)).toThrow("vault_locked");
    expect(status()).toEqual({ state: "locked" });
  });

  it("un uso riparte il conto; `closesAt` lo dice alla barra", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    open(key, ME, SESSION);
    vi.setSystemTime(Date.now() + IDLE_MS - 1000);
    use(ME, SESSION);
    vi.setSystemTime(Date.now() + IDLE_MS - 1000);
    expect(use(ME, SESSION)).toBe(key);
    expect(status()).toEqual({ state: "open", closesAt: Date.now() + IDLE_MS });
  });

  it("I2: un'interazione VERA allunga la vita; uno scroll o un evento sintetico no", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    open(key, ME, SESSION);
    const opened = Date.now();
    vi.setSystemTime(opened + 10 * 60_000);
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(trusted("scroll"));
    expect(status()).toEqual({ state: "open", closesAt: opened + IDLE_MS });
    window.dispatchEvent(trusted("pointerdown"));
    expect(status()).toEqual({ state: "open", closesAt: Date.now() + IDLE_MS });
  });

  it("al ritorno (visibilitychange, focus, pageshow) la scadenza passata chiude PRIMA di ogni uso", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    open(key, ME, SESSION);
    const seen: string[] = [];
    subscribe((s) => seen.push(s.state));
    vi.setSystemTime(Date.now() + IDLE_MS + 1);
    window.dispatchEvent(new Event("focus"));
    expect(status()).toEqual({ state: "locked" });
    expect(seen).toEqual(["locked"]);
  });

  it("una pagina in primo piano si chiude in tempo anche senza uso (il timer)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    open(key, ME, SESSION);
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(status()).toEqual({ state: "locked" });
  });

  it("I2: `pagehide` chiude (una pagina che entra nel bfcache torna chiusa)", () => {
    open(key, ME, SESSION);
    window.dispatchEvent(new Event("pagehide"));
    expect(status()).toEqual({ state: "locked" });
  });

  it("`lock` avvisa chi ascolta, in modo sincrono (I3)", () => {
    open(key, ME, SESSION);
    const fn = vi.fn();
    const off = subscribe(fn);
    lock("user");
    expect(fn).toHaveBeenCalledWith({ state: "locked" });
    off();
    open(key, ME, SESSION);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("I5: «Lock» in una scheda chiude le altre (solo un segnale, mai la chiave)", async () => {
    const other = new BroadcastChannel("stubwise-vault");
    const got: unknown[] = [];
    other.onmessage = (e) => got.push(e.data);
    open(key, ME, SESSION);
    lock("user");
    await vi.waitFor(() => expect(got).toEqual([{ type: "locked", personId: ME }]));
    other.close();
  });

  it("I5: il segnale di un'altra scheda chiude questa", async () => {
    open(key, ME, SESSION);
    const other = new BroadcastChannel("stubwise-vault");
    other.postMessage({ type: "logout", personId: ME });
    await vi.waitFor(() => expect(status()).toEqual({ state: "locked" }));
    other.close();
  });
});
