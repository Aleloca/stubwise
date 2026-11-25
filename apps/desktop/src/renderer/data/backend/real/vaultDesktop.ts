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
  // Review C1: nell'app ogni `/api/vault*` passa dal main (il proxy le
  // rifiuta al renderer): lo stato della propria chiave ha il suo canale.
  const out = await b.serverStatus();
  if (!out.ok) {
    if (out.code === "disabled" || out.code === "vault_desktop_disabled")
      return { ...view, state: "disabled" };
    // Il server non risponde: la barra resta quella del Mac (aprire lo dirà).
    return view;
  }
  const server = out;
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

// --- fetta 3: le operazioni con la chiave, dal main ------------------------------

const outcome = <T extends object>(out: ({ ok: true } & T) | { ok: false; code: string }) =>
  out.ok ? out : { ok: false as const, code: out.code };

/** «Show»: la password arriva dal main (che la registra); resta nello stato di chi la mostra. */
export const show: FakeVault["show"] = async (id) => outcome(await need().show(id));

/** «Copy»: gli appunti li scrive il main; qui non torna mai la password. */
export const copy: FakeVault["copy"] = async (id) => {
  const out = await need().copy(id);
  return out.ok ? { ok: true } : { ok: false, code: out.code };
};

/** «Share»: il bersaglio del prototipo (`personId`) è un `userId` per il main. */
export const share: FakeVault["share"] = async (id, target) =>
  outcome(
    await need().share(
      id,
      "personId" in target ? { userId: target.personId } : { roleId: target.roleId },
    ),
  );

export const removeReader: FakeVault["removeReader"] = async (id, readerId) => {
  const out = await need().removeReader(id, readerId);
  return out.ok ? { ok: true } : { ok: false, code: out.code };
};

/**
 * Chi aspetta che io confermi: il main lo legge con la chiave, quindi a
 * cassaforte chiusa nessuno (la riga «waiting for access» non c'è). I nomi
 * dalla rubrica del team; l'email se manca.
 */
export const listPending: FakeVault["listPending"] = async () => {
  const b = bridge();
  if (!b) return [];
  const out = await b.pending();
  if (!out.ok) return [];
  const people = await appClient()
    .people.list()
    .catch(() => []);
  const names = new Map(people.map((p) => [p.id, p.name]));
  return out.items.map((p) => ({
    keyId: p.personKeyId,
    personId: p.userId,
    name: names.get(p.userId) ?? p.email,
    email: p.email,
    createdAt: p.createdAt,
    device: p.device,
    fingerprint: p.fingerprint,
    // Il main non dice il progetto: la scheda mostra solo quante sono.
    credentials: p.credentials.map((c) => ({ id: c.id, service: c.service, projectId: "" })),
  }));
};

export const confirm: FakeVault["confirm"] = async (keyId) => outcome(await need().confirm(keyId));

export const reject: FakeVault["reject"] = async (keyId) => {
  const out = await need().reject(keyId);
  return out.ok ? { ok: true } : { ok: false, code: out.code };
};
