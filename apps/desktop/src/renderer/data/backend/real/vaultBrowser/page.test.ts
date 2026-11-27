import { PRF_INPUT } from "@stubwise/vault-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "./bytes";

// La pagina nella cassaforte nel browser (revisione di sicurezza I-1): dopo
// il boot uno script sostituisce i PROTOTIPI che toccherebbero il segreto, e
// lo sblocco non glielo fa vedere. La PRF esce dalla pagina solo per TRANSFER
// verso il worker. (Il worker qui è finto: il suo reame separato lo dà il
// browser; il cuore si prova a sé in `core.test.ts`.)

const CRED = "Y3JlZC0x";
let prfBytes: Uint8Array<ArrayBuffer>;
let toWorker: { msg: { id: number; req: { t: string } & Record<string, unknown> }; transfer: Transferable[] }[];
let seen: string[];

class FakeWorker extends EventTarget {
  postMessage(msg: { id: number; req: { t: string } }, transfer: Iterable<Transferable> = []) {
    // La lista arriva come un iterabile coi suoi metodi (I-A), non un array.
    toWorker.push({ msg: msg as never, transfer: Array.from(transfer) });
    const res =
      msg.req.t === "prepare"
        ? {
            ok: true,
            onlyCredentialIds: [CRED],
            options: { challenge: "Y2hhbGxlbmdl", allowCredentials: [{ id: CRED, type: "public-key" }], extensions: { prf: { eval: { first: toBase64Url(PRF_INPUT) } } } },
          }
        : { ok: true };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: msg.id, res } })));
  }
}

class FakePublicKeyCredential {
  id = CRED;
  rawId = new Uint8Array([1, 2, 3]).buffer;
  type = "public-key";
  authenticatorAttachment = null;
  response = {
    authenticatorData: new Uint8Array([4]).buffer,
    clientDataJSON: new Uint8Array([5]).buffer,
    signature: new Uint8Array([6]).buffer,
    userHandle: null,
  };
  getClientExtensionResults() {
    return { prf: { results: { first: prfBytes.buffer } } };
  }
}

/** Registra un argomento se contiene i byte della PRF. */
const watch = (where: string, value: unknown) => {
  const hex = toBase64Url(prfBytes).slice(0, 12);
  try {
    if (value instanceof ArrayBuffer && toBase64Url(value).includes(hex)) seen.push(where);
    else if (ArrayBuffer.isView(value) && toBase64Url(value).includes(hex)) seen.push(where);
  } catch {
    // un buffer trasferito (staccato) non si legge: va bene.
  }
};

beforeEach(() => {
  toWorker = [];
  seen = [];
  prfBytes = crypto.getRandomValues(new Uint8Array(32));
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("navigator", {
    ...navigator,
    credentials: { get: vi.fn(async () => new FakePublicKeyCredential()), create: vi.fn() },
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

describe("la pagina non vede il segreto", () => {
  it("I-1: prototipi sostituiti DOPO il boot non ricevono la PRF; la PRF va al worker per transfer", async () => {
    await import("./primitives");
    const client = await import("./client");
    client.__setWorkerForTests(new FakeWorker() as unknown as Worker);
    const { unlockInBrowser } = await import("./unlock");
    // Arriva uno script dopo il boot.
    FakePublicKeyCredential.prototype.getClientExtensionResults = function () {
      seen.push("getClientExtensionResults");
      return {};
    } as never;
    for (const [proto, names] of [
      [Uint8Array.prototype, ["slice", "set", "fill", "subarray"]],
      [ArrayBuffer.prototype, ["slice"]],
      [SubtleCrypto.prototype, ["importKey", "decrypt", "deriveBits", "exportKey"]],
      [Response.prototype, ["json"]],
      [FakeWorker.prototype, ["postMessage"]],
    ] as const) {
      for (const name of names) {
        const orig = (proto as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
        (proto as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
          watch(`${name}:this`, this);
          for (const a of args) watch(`${name}:arg`, a);
          if (name === "postMessage") seen.push("postMessage");
          return orig.apply(this, args);
        };
      }
    }
    const parse = JSON.parse;
    JSON.parse = ((text: string, ...rest: unknown[]) => {
      seen.push("JSON.parse");
      return (parse as (...a: unknown[]) => unknown)(text, ...rest);
    }) as typeof JSON.parse;
    try {
      expect(await unlockInBrowser(() => ({ personId: "p-ada", sessionTag: "t" }))).toEqual({ ok: true });
    } finally {
      JSON.parse = parse;
    }
    expect(seen).toEqual([]);
    // I-A: la PRF parte per PRIMA, per transfer, in un messaggio a sé; lo sblocco non la porta.
    expect(toWorker.map((w) => w.msg.req.t)).toEqual(["prepare", "stash", "unlock"]);
    const stash = toWorker.find((w) => w.msg.req.t === "stash")!;
    expect(stash.transfer).toHaveLength(1);
    expect(stash.transfer[0]).toBe(stash.msg.req.prf);
    const unlock = toWorker.find((w) => w.msg.req.t === "unlock")!;
    expect(unlock.msg.req).not.toHaveProperty("prf");
    expect(unlock.transfer).toEqual([]);
    expect((unlock.msg.req.assertion as { clientExtensionResults: unknown }).clientExtensionResults).toEqual({});
  });

  it("senza PRF al worker non va lo sblocco (né, quindi, la verifica)", async () => {
    FakePublicKeyCredential.prototype.getClientExtensionResults = () => ({}) as never;
    await import("./primitives");
    const client = await import("./client");
    client.__setWorkerForTests(new FakeWorker() as unknown as Worker);
    const { unlockInBrowser } = await import("./unlock");
    expect(await unlockInBrowser(() => ({ personId: "p-ada", sessionTag: "t" }))).toEqual({
      ok: false,
      code: "passkey_unsupported",
    });
    expect(toWorker.map((w) => w.msg.req.t)).toEqual(["prepare"]);
    FakePublicKeyCredential.prototype.getClientExtensionResults = function (this: FakePublicKeyCredential) {
      return { prf: { results: { first: prfBytes.buffer } } };
    } as never;
  });

  it("M-3: cambiata la sessione durante la cerimonia, il worker azzera la PRF ricevuta", async () => {
    await import("./primitives");
    const client = await import("./client");
    client.__setWorkerForTests(new FakeWorker() as unknown as Worker);
    const { unlockInBrowser } = await import("./unlock");
    let tag = "t1";
    const who = () => ({ personId: "p-ada", sessionTag: tag });
    const pending = unlockInBrowser(() => {
      const w = who();
      tag = "t2";
      return w;
    });
    expect(await pending).toEqual({ ok: false, code: "session" });
    expect(toWorker.map((w) => w.msg.req.t)).toEqual(["prepare", "stash", "discard"]);
  });
});
