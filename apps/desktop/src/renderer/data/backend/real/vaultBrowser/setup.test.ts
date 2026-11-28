import { PRF_INPUT } from "@stubwise/vault-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "./bytes";

// La fase 2 dalla parte della pagina (design §10): l'ordine delle richieste
// al worker e delle cerimonie. Il cuore si prova a sé in `core.setup.test.ts`;
// qui un worker finto che risponde come gli si dice.

const CRED = "Y3JlZC0x";
let prfBytes: Uint8Array<ArrayBuffer>;
let sent: ({ t: string } & Record<string, unknown>)[];
let answers: Record<string, unknown>;
let ceremonies: number;

class FakeWorker extends EventTarget {
  postMessage(msg: { id: number; req: { t: string } & Record<string, unknown> }) {
    sent.push(msg.req);
    if (msg.id === 0) return;
    const res =
      msg.req.t in answers
        ? answers[msg.req.t]
        : msg.req.t === "prepare"
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
    return { prf: { results: { first: prfBytes.slice().buffer } } };
  }
}

const who = () => ({ personId: "p-ada", sessionTag: "e0" });

async function load() {
  await import("./primitives");
  const client = await import("./client");
  client.__setWorkerForTests(new FakeWorker() as unknown as Worker);
  return import("./setup");
}

beforeEach(() => {
  sent = [];
  answers = {};
  ceremonies = 0;
  prfBytes = crypto.getRandomValues(new Uint8Array(32));
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("navigator", {
    ...navigator,
    credentials: {
      get: vi.fn(async () => {
        ceremonies += 1;
        return new FakePublicKeyCredential();
      }),
      create: vi.fn(),
    },
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const kinds = () => sent.map((r) => (r.t === "prepare" ? `prepare:${String(r.purpose ?? "open")}` : r.t));

describe("la fase 2 dalla pagina", () => {
  it("attivazione: la cerimonia PRIMA della `activate`, poi la chiave con la stessa PRF", async () => {
    const setup = await load();
    expect(await setup.activateInBrowser(who)).toEqual({ ok: true });
    expect(kinds()).toEqual(["prepare:activate", "stash", "activate", "createKey"]);
  });

  it("attivazione con una passkey senza PRF: si ferma prima di attivare", async () => {
    // Prima del boot: dopo, i metodi catturati non la vedrebbero.
    FakePublicKeyCredential.prototype.getClientExtensionResults = function () {
      return {} as never;
    };
    const setup = await load();
    try {
      expect(await setup.activateInBrowser(who)).toEqual({ ok: false, code: "passkey_unsupported" });
      expect(kinds()).toEqual(["prepare:activate"]);
    } finally {
      FakePublicKeyCredential.prototype.getClientExtensionResults = function () {
        return { prf: { results: { first: prfBytes.slice().buffer } } };
      };
    }
  });

  it("attivazione con la riconferma chiesta: il worker azzera la PRF e l'esito la chiede (`useReauth`)", async () => {
    const setup = await load();
    answers.activate = { ok: false, code: "reauth_required" };
    expect(await setup.activateInBrowser(who)).toEqual({ ok: false, code: "reauth_required", error: "reauth_required" });
    expect(kinds()).toEqual(["prepare:activate", "stash", "activate", "discard"]);
  });

  it("la propria chiave: `prepare create`, cerimonia, `createKey`; `recreate` passa", async () => {
    const setup = await load();
    expect(await setup.createKeyInBrowser(who, { recreate: true })).toEqual({ ok: true });
    expect(kinds()).toEqual(["prepare:create", "stash", "createKey"]);
    expect(sent[0]).toMatchObject({ recreate: true });
    expect(sent[2]).toMatchObject({ recreate: true, personId: "p-ada", sessionTag: "e0", credentialId: CRED });
  });

  it("una passkey in più: due cerimonie, la seconda offre la sola passkey scelta", async () => {
    const setup = await load();
    expect(await setup.addPasskeyInBrowser(who, "pk-2")).toEqual({ ok: true });
    expect(kinds()).toEqual(["prepare:open", "stash", "sealBegin", "prepare:seal", "stash", "sealFinish"]);
    expect(sent[3]).toMatchObject({ passkeyId: "pk-2" });
    expect(ceremonies).toBe(2);
  });

  it("una passkey in più: la prima metà non regge, niente seconda cerimonia", async () => {
    const setup = await load();
    answers.sealBegin = { ok: false, code: "open_failed" };
    expect(await setup.addPasskeyInBrowser(who, "pk-2")).toEqual({ ok: false, code: "open_failed" });
    expect(ceremonies).toBe(1);
    expect(kinds()).not.toContain("sealFinish");
  });

  it("una passkey in più: la seconda cerimonia annullata butta la prima metà", async () => {
    const setup = await load();
    let n = 0;
    (navigator.credentials.get as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      n += 1;
      return n === 1 ? new FakePublicKeyCredential() : null;
    });
    expect(await setup.addPasskeyInBrowser(who, "pk-2")).toEqual({ ok: false, code: "passkey_failed" });
    expect(kinds().at(-1)).toBe("discard");
  });

  it("l'associazione: lookup, poi la passkey e il sigillo con gli ultimi 4 scritti", async () => {
    const setup = await load();
    answers.pairLookup = { ok: true, deviceName: "MacBook di Ada", patCreatedAt: null, patLastUsedAt: null, expiresAt: "2026-11-28T10:10:00.000Z" };
    expect(await setup.lookupPairing("st")).toMatchObject({ ok: true, deviceName: "MacBook di Ada" });
    expect(await setup.sealPairingInBrowser(who, "st", "ab12")).toEqual({ ok: true });
    expect(kinds()).toEqual(["pairLookup", "prepare:open", "stash", "pairSeal"]);
    expect(sent.at(-1)).toMatchObject({ state: "st", typed: "ab12", personId: "p-ada" });
  });

  it("recupero e rotazione: la riconferma chiesta arriva come `error` per `useReauth`", async () => {
    const setup = await load();
    answers.recoveryLoad = { ok: false, code: "reauth_required" };
    expect(await setup.loadRecoveryKit(who, "KIT")).toEqual({ ok: false, code: "reauth_required", error: "reauth_required" });
    expect(sent.at(-1)).toMatchObject({ t: "recoveryLoad", personId: "p-ada", sessionTag: "e0" });
    answers.rotateKit = { ok: false, code: "vault_unlock_required" };
    expect(await setup.rotateKitInBrowser(who)).toEqual({ ok: false, code: "vault_unlock_required" });
  });

  it("I-1: conferma col kit: una passkey SENZA PRF, l'asserzione al worker, nessuna PRF passata", async () => {
    const setup = await load();
    answers.presenceOptions = { ok: true, options: { challenge: "Y2hhbGxlbmdl", allowCredentials: [{ id: CRED, type: "public-key" }] } };
    answers.recoveryConfirm = { ok: true, saved: 1, keyChanged: 0, notAllowed: 0, unopenable: 0, items: [] };
    expect(await setup.confirmWithRecoveryKit(who, "k-bea")).toMatchObject({ ok: true, saved: 1 });
    expect(kinds()).toEqual(["presenceOptions", "recoveryConfirm"]);
    const req = sent.at(-1)! as unknown as { presence: { kind: string; assertion: { clientExtensionResults: unknown } } };
    expect(req.presence.kind).toBe("passkey");
    expect(req.presence.assertion.clientExtensionResults).toEqual({});
    const options = (navigator.credentials.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { publicKey: { extensions?: unknown } };
    expect(options.publicKey.extensions).toBeUndefined();
  });

  it("I-1: senza passkey `code_required`; col codice, il codice al worker e nessuna cerimonia", async () => {
    const setup = await load();
    answers.presenceOptions = { ok: false, code: "no_passkeys" };
    expect(await setup.confirmWithRecoveryKit(who, "k-bea")).toEqual({ ok: false, code: "code_required" });
    expect(ceremonies).toBe(0);
    sent = [];
    answers.recoveryConfirm = { ok: true, saved: 0, keyChanged: 0, notAllowed: 0, unopenable: 0, items: [] };
    await setup.confirmWithRecoveryKit(who, "k-bea", "123456");
    expect(kinds()).toEqual(["recoveryConfirm"]);
    expect(sent[0]).toMatchObject({ presence: { kind: "code", code: "123456" } });
  });
});
