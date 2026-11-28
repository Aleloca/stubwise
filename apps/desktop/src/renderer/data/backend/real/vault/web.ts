import type { VaultStatusResponse } from "@stubwise/shared";
import { keyFingerprint } from "@stubwise/vault-crypto";
import type * as Fake from "../../../api";
import { onLoggedOut, onSessionLost, onSessionStarted } from "../../../sessionEvents";
import type { VaultStatusView } from "../../../vault/types";
import { appClient, session } from "../client";
import { partialNamespace } from "../notIntegrated";
import { request } from "../vaultBrowser/client";
import { clearNow, copyWithAutoClear } from "../vaultBrowser/clipboard";
import {
  confirmInWorker,
  createInWorker,
  pendingInWorker,
  rejectInWorker,
  removeReaderInWorker,
  revealPassword,
  setPasswordInWorker,
  shareInWorker,
} from "../vaultBrowser/credentials";
import * as key from "../vaultBrowser/key";
import { freshPresence, unlockInBrowser } from "../vaultBrowser/unlock";
import * as liveVaultReads from "../vaultReads";
import { setVaultTransport } from "../vaultReads";
import { listMacsOf, removeMacOf } from "../vaultMacsOf";

// La cassaforte della build web servita su `/app` (`@backend/vault`, target
// `web`, design della cassaforte nel browser; revisione di sicurezza I-1): la
// chiave, la crittografia e la rete della cassaforte stanno nel worker
// (`vaultBrowser/worker.ts`); qui gli esiti per la barra e le pagine. Questo
// modulo NON nomina il ponte del desktop (`check-vault-target.mjs`).

/**
 * La sessione a cui la chiave è legata (I5, I-3): la persona di adesso e
 * un'etichetta di sessione. Finché il server non dà il suo `sessionTag`, è
 * un'epoca del client che cambia (e chiude) a sessione persa e a «Esci».
 */
let epoch = 0;
const sessionTag = () => `e${epoch}`;
const who = () => ({ personId: session.personId, sessionTag: sessionTag() });
/** Persona e sessione per la fase 2 (`setup-web.ts`): le stesse dello sblocco. */
export const vaultWho = who;

onSessionLost(() => {
  epoch += 1;
  key.lock("session");
});
onLoggedOut(() => {
  epoch += 1;
  // I-2: «Esci» si dice alle altre schede sempre, anche a cassaforte chiusa.
  key.lock("logout");
});

// I-3: una sessione nuova qui la dicono le altre schede (che chiudono).
onSessionStarted(() => {
  epoch += 1;
  key.announceLogin();
});

/**
 * Chi aspetta che io confermi: dal worker, senza la chiave (anche a
 * cassaforte chiusa) e senza le copie, col progetto di ogni credenziale (il
 * punto «ti aspetta»). I nomi dalla rubrica del team; l'email se manca.
 */
const listPending: typeof Fake.vault.listPending = async () => {
  const out = await pendingInWorker();
  // Un errore è un errore: la pagina lo dice, invece di «nessuno aspetta».
  // (I conteggi di `vaultReads` lo intercettano da sé.)
  if (!out.ok) throw new Error(out.code);
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
    credentials: p.credentials.map((c) => ({ id: c.id, service: c.service, projectId: c.projectId })),
  }));
};

// Le scritture cifrate passano dal worker (crea, cambia); «le mie» sono una
// lettura della rotta, senza copie.
setVaultTransport({
  mine: async () => (await appClient().credentials.mine()).items,
  create: (projectId, fields, password) => createInWorker(projectId, fields, password),
  setPassword: async (id, password) => {
    const w = who();
    if (!w.personId) return { ok: false, code: "unauthenticated" };
    return setPasswordInWorker(id, password, w.personId, w.sessionTag);
  },
  pending: listPending,
});

/** L'ultima apertura ha usato una passkey senza PRF: la barra lo dice finché un'apertura riesce. */
let passkeyUnsupported = false;

const hasLiveKey = (s: VaultStatusResponse) =>
  s.myKey !== null && (s.myKey.status === "pending" || s.myKey.status === "confirmed");

const getVaultStatus: typeof Fake.vault.getVaultStatus = async (): Promise<VaultStatusView> => {
  const base = { touchId: false, macFingerprint: null, ownFingerprint: null, pairing: null };
  const out = await request<{ ok: true; status: VaultStatusResponse } | { ok: false; code: string }>({ t: "serverStatus" });
  if (!out.ok) {
    if (out.code === "network" || out.code === "worker_unavailable") return { ...base, state: "unreachable" };
    throw new Error(out.code);
  }
  const s = out.status;
  if (!s.activated) return { ...base, state: "inactive" };
  if (!hasLiveKey(s)) return { ...base, state: "no_key" };
  if (s.myKey!.status === "pending") {
    const pub = s.myKey!.publicKey;
    return { ...base, state: "key_pending", ownFingerprint: pub ? await keyFingerprint(pub).catch(() => null) : null };
  }
  if (key.status().state === "open") return { ...base, state: "open" };
  return { ...base, state: passkeyUnsupported ? "passkey_unsupported" : "locked" };
};

const unlock: typeof Fake.vault.unlock = async () => {
  const out = await unlockInBrowser(who);
  passkeyUnsupported = !out.ok && out.code === "passkey_unsupported";
  return out;
};

const lock: typeof Fake.vault.lock = async () => {
  key.lock("user");
  return { ok: true };
};

const subscribeVaultChanges: typeof Fake.vault.subscribeVaultChanges = (listener) => key.subscribe(() => listener());

// Alla chiusura, per qualunque motivo, gli appunti si svuotano (design §6).
key.subscribe((st) => {
  if (st.state === "locked") void clearNow();
});

const show: typeof Fake.vault.show = async (id) => {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  return revealPassword(id, "show", w.personId, w.sessionTag);
};

const copy: typeof Fake.vault.copy = async (id) => {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  const out = await revealPassword(id, "copy", w.personId, w.sessionTag);
  if (!out.ok) return out;
  await copyWithAutoClear(out.password);
  return { ok: true };
};

/** «Share»: il bersaglio del prototipo (`personId`) è un `userId` per il server. */
const share: typeof Fake.vault.share = async (id, target) => {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  return shareInWorker(
    id,
    "personId" in target ? { userId: target.personId } : { roleId: target.roleId },
    w.personId,
    w.sessionTag,
  );
};

/**
 * Revisione finale, punto 3 (come M5 del desktop, che chiede un Touch ID):
 * togliere un lettore, confermare e rifiutare una chiave vogliono un tocco
 * NUOVO della passkey, che vale per quell'operazione sola.
 */
const removeReader: typeof Fake.vault.removeReader = async (id, readerId) => {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  const touched = await freshPresence(who);
  if (!touched.ok) return { ok: false, code: touched.code };
  return removeReaderInWorker(id, readerId, w.personId, w.sessionTag, touched.presence);
};

const confirm: typeof Fake.vault.confirm = async (keyId) => {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  const touched = await freshPresence(who);
  if (!touched.ok) return { ok: false, code: touched.code };
  return confirmInWorker(keyId, w.personId, w.sessionTag, touched.presence);
};

const reject: typeof Fake.vault.reject = async (keyId) => {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  const touched = await freshPresence(who);
  if (!touched.ok) return { ok: false, code: touched.code };
  return rejectInWorker(keyId, w.personId, w.sessionTag, touched.presence);
};

export const vault: typeof Fake.vault = partialNamespace<typeof Fake.vault>("vault", {
  getVaultStatus,
  unlock,
  lock,
  subscribeVaultChanges,
  show,
  copy,
  share,
  removeReader,
  listPending,
  confirm,
  reject,
  // Ritiro del web vecchio (inventario 1.2): i Mac di un'altra persona.
  listMacsOf,
  removeMacOf,
  ...liveVaultReads,
});
