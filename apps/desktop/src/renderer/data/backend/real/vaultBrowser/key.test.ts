import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lo stato della cassaforte nella pagina (revisione I-1): lo specchio del
// worker e i segnali della scheda, collegati al boot (§7, §8; I-2, M-4).

let toWorker: { t: string; reason?: string }[];
let worker: EventTarget & { postMessage: (m: { id: number; req: { t: string } }) => void };

/** Il worker finto: registra le richieste, risponde `ok`, e sa mandare eventi di stato. */
function fakeWorker() {
  const target = new EventTarget() as typeof worker;
  target.postMessage = (m) => {
    toWorker.push(m.req);
    const res = m.req.t === "status" ? { state: "locked" } : { ok: true };
    queueMicrotask(() => target.dispatchEvent(new MessageEvent("message", { data: { id: m.id, res } })));
  };
  return target;
}

const emit = (event: unknown) => worker.dispatchEvent(new MessageEvent("message", { data: { event } }));

function trusted(type: string): Event {
  const e = new Event(type);
  Object.defineProperty(e, "isTrusted", { value: true });
  return e;
}

let key: typeof import("./key");

beforeEach(async () => {
  toWorker = [];
  vi.resetModules();
  const client = await import("./client");
  worker = fakeWorker();
  client.__setWorkerForTests(worker as unknown as Worker);
  key = await import("./key");
  key.__resetKeyForTests();
  key.wireVault();
});
afterEach(() => key.__resetKeyForTests());

describe("lo specchio della cassaforte nella pagina", () => {
  it("segue gli eventi del worker: aperta, chiusa e perché (M-5: `reauth`)", () => {
    const seen: string[] = [];
    key.subscribe((s) => seen.push(s.state));
    emit({ t: "state", state: "open", closesAt: 1 });
    expect(key.status()).toEqual({ state: "open", closesAt: 1 });
    emit({ t: "state", state: "locked", reason: "reauth", code: "reauth_required" });
    expect(key.status()).toEqual({ state: "locked" });
    expect(key.lastLock()).toEqual({ reason: "reauth", code: "reauth_required" });
    expect(seen).toEqual(["open", "locked"]);
  });

  it("I3: «Lock» chiude la pagina SUBITO, poi lo dice al worker e alle altre schede", async () => {
    const other = new BroadcastChannel("stubwise-vault");
    const got: unknown[] = [];
    other.onmessage = (e) => got.push(e.data);
    emit({ t: "state", state: "open", closesAt: 1 });
    key.lock("user");
    expect(key.status()).toEqual({ state: "locked" });
    expect(toWorker).toContainEqual({ t: "lock", reason: "user" });
    await vi.waitFor(() => expect(got).toEqual([{ type: "locked" }]));
    other.close();
  });

  it("I-2: «Esci» si dice alle altre schede ANCHE a cassaforte chiusa", async () => {
    const other = new BroadcastChannel("stubwise-vault");
    const got: unknown[] = [];
    other.onmessage = (e) => got.push(e.data);
    key.lock("logout");
    await vi.waitFor(() => expect(got).toEqual([{ type: "logout" }]));
    other.close();
  });

  it("M-4: `pagehide` chiude SOLO questa scheda, senza segnale", async () => {
    const other = new BroadcastChannel("stubwise-vault");
    const got: unknown[] = [];
    other.onmessage = (e) => got.push(e.data);
    emit({ t: "state", state: "open", closesAt: 1 });
    window.dispatchEvent(new Event("pagehide"));
    expect(key.status()).toEqual({ state: "locked" });
    expect(toWorker).toContainEqual({ t: "lock", reason: "pagehide" });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    other.close();
  });

  it("il segnale di un'altra scheda chiude questa", async () => {
    emit({ t: "state", state: "open", closesAt: 1 });
    const other = new BroadcastChannel("stubwise-vault");
    other.postMessage({ type: "logout" });
    await vi.waitFor(() => expect(key.status()).toEqual({ state: "locked" }));
    other.close();
  });

  it("solo l'interazione VERA chiede al worker di allungare la vita", () => {
    emit({ t: "state", state: "open", closesAt: 1 });
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(trusted("scroll"));
    expect(toWorker.filter((r) => r.t === "touch")).toHaveLength(0);
    window.dispatchEvent(trusted("pointerdown"));
    expect(toWorker.filter((r) => r.t === "touch")).toHaveLength(1);
  });

  it("al ritorno si chiede al worker, che chiude se la scadenza è passata", async () => {
    emit({ t: "state", state: "open", closesAt: 1 });
    window.dispatchEvent(new Event("focus"));
    expect(toWorker).toContainEqual({ t: "status" });
    await vi.waitFor(() => expect(key.status()).toEqual({ state: "locked" }));
  });
});
