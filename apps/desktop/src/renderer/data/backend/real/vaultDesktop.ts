import { ApiError } from "@stubwise/api-client";
import { keyFingerprint } from "@stubwise/vault-crypto";
import type * as Fake from "../../api";
import { appClient } from "./client";
import type { MacView, VaultStatusView } from "../../vault/types";

// La cassaforte nella build app (lotto 10, fetta 1 dell'adattatore): lo stato
// della barra, aprire e chiudere, l'associazione, i propri Mac — tutto dal
// main (`window.stubwise.vault`, `src/main/vault*.ts`), con le firme del
// prototipo (`data/vault/index.ts`). La chiave non passa mai di qui: il main
// dà stati ed esiti. Senza il ponte (la build web servita su `/app`) la
// cassaforte del desktop non c'è: `unsupported`, si apre dal browser.

type FakeVault = typeof Fake.vault;
type Bridge = NonNullable<NonNullable<Window["stubwise"]>["vault"]>;

const bridge = (): Bridge | null => window.stubwise?.vault ?? null;

function need(): Bridge {
  const b = bridge();
  if (!b) throw new Error("vault_bridge_missing");
  return b;
}

export const getVaultStatus: FakeVault["getVaultStatus"] = async () => {
  const b = bridge();
  if (!b) {
    return {
      state: "unsupported",
      touchId: false,
      macFingerprint: null,
      ownFingerprint: null,
      pairing: null,
    };
  }
  const s = await b.status();
  const view: VaultStatusView = {
    state: s.state,
    touchId: s.touchId,
    macFingerprint: s.fingerprint,
    ownFingerprint: null,
    pairing: null,
  };
  // Il main sa già che dal Mac non si apre: il server non serve.
  if (s.state === "disabled" || s.state === "unsupported") return view;
  // Fetta 2a: la propria chiave dal server (`GET /api/vault/status`,
  // `desktopRead`): cassaforte non attivata, nessuna chiave, chiave da
  // confermare. Con la chiave confermata decide il Mac.
  let server: Awaited<ReturnType<ReturnType<typeof appClient>["vault"]["status"]>>;
  try {
    server = await appClient().vault.status();
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === "vault_desktop_disabled"
    )
      return { ...view, state: "disabled" };
    // Il server non risponde: la barra resta quella del Mac (aprire lo dirà).
    return view;
  }
  if (!server.activated) return { ...view, state: "inactive" };
  const myKey = server.myKey;
  // Una chiave rifiutata o sostituita non apre più niente: va ricreata nel browser.
  if (!myKey || myKey.status === "rejected" || myKey.status === "superseded")
    return { ...view, state: "no_key" };
  if (myKey.status === "pending") {
    const pub = myKey.publicKey ?? null;
    return {
      ...view,
      state: "key_pending",
      ownFingerprint: pub ? await keyFingerprint(pub).catch(() => null) : null,
    };
  }
  return view;
};

export const unlock: FakeVault["unlock"] = async () => {
  const out = await need().unlock();
  return out.ok ? { ok: true } : { ok: false, code: out.code };
};

export const lock: FakeVault["lock"] = async () => {
  await need().lock();
  return { ok: true };
};

export const startPairing: FakeVault["startPairing"] = async () => {
  const out = await need().pairStart();
  return out.ok ? { ok: true, fingerprint: out.fingerprint } : { ok: false, code: out.code };
};

export const cancelPairing: FakeVault["cancelPairing"] = async () => {
  await need().pairCancel();
};

/** L'esito del ritorno dal browser (`vault:paired`), al dialogo dell'associazione. */
export const subscribePairing: FakeVault["subscribePairing"] = (listener) => {
  const b = bridge();
  if (!b) return () => {};
  return b.onPaired((r) => listener(r.ok ? { ok: true } : { ok: false, code: r.code }));
};

/** Il main dice che lo stato è cambiato (chiusura a tempo, sospensione, revoca). */
export const subscribeVaultChanges: FakeVault["subscribeVaultChanges"] = (listener) => {
  const b = bridge();
  if (!b) return () => {};
  return b.onChanged(() => listener());
};

export const listMyMacs: FakeVault["listMyMacs"] = async () => {
  const out = await need().macs();
  if (!out.ok) throw new Error(out.code);
  return out.items satisfies MacView[];
};

export const forgetThisMac: FakeVault["forgetThisMac"] = async () => {
  const out = await need().forget();
  if (!out.ok) throw new Error(out.code);
  return out;
};

export const removeMac: FakeVault["removeMac"] = async (macId) => {
  const out = await need().removeMac(macId);
  return out.ok ? { ok: true } : { ok: false, code: out.code };
};
