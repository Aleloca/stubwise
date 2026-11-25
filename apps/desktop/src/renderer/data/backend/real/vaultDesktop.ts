import type * as Fake from "../../api";
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
