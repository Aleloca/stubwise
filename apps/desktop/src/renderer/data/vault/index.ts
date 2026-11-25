import { accessState } from "../access/index";
import { isFullAdmin, projectRoleOf } from "../access/effective";
import { canI, nameOf } from "../admin/common";
import { requireReauth } from "../auth/reauth";
import { person as addressOf } from "../seed/mail/helpers";
import { gate, newId, now, state } from "../store";
import type {
  AccessLogView,
  Credential,
  CredentialView,
  MacView,
  PendingPersonView,
  ReadersView,
  ReaderTarget,
  ThisMac,
  VaultFailure,
  VaultSimulation,
  VaultStatusView,
} from "./types";

// La Cassaforte nel prototipo (lotto 10, shape `vault.md`; decisioni del
// maintainer del 24–25 nov 2026). Le regole di chi legge sono quelle del
// server (`docs/invariants/vault.md`): un lettore effettivo — full admin,
// chi l'ha creata, un lettore diretto o un membro del ruolo lettore — LEGGE
// solo con la propria chiave CONFERMATA e la sua copia; altrimenti aspetta.
// La chiave del Mac (associazione, Touch ID, sigillo, chiusura) è finta:
// `thisMac` per persona, la stessa forma che nell'app dà il main
// (`window.stubwise.vault`). Le viste non portano MAI la password: esce
// solo da `show`; `copy` scrive gli appunti da qui, come il main.

// --- gli appunti (il main nell'app; qui iniettabili per i test) -----------------

interface VaultClipboard {
  write: (text: string) => void;
  read: () => string | Promise<string>;
}

const navigatorClipboard: VaultClipboard = {
  write: (text) => void globalThis.navigator?.clipboard?.writeText(text),
  read: async () => (await globalThis.navigator?.clipboard?.readText?.()) ?? "",
};
let clipboard: VaultClipboard = navigatorClipboard;

/** Solo per i test: gli appunti finti. `null` torna a quelli del browser. */
export function setVaultClipboard(next: VaultClipboard | null): void {
  clipboard = next ?? navigatorClipboard;
}

/** Dopo quanto la password copiata lascia gli appunti (come il web e il main). */
export const CLIPBOARD_CLEAR_MS = 30_000;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

// --- le regole -------------------------------------------------------------------

const fail = (code: string): VaultFailure => ({ ok: false, code });
const v = () => state.vault;
const keyOf = (personId: string) => v().keys.find((k) => k.personId === personId);
const credentialById = (id: string) => v().credentials.find((c) => c.id === id);

/** La fonte per cui `personId` è lettore effettivo di `c`, o null. */
function readerSource(
  personId: string,
  c: Credential,
): "full_admin" | "created" | "direct" | "role" | null {
  if (isFullAdmin(personId)) return "full_admin";
  if (c.createdById === personId) return "created";
  const direct = v().readers.filter((r) => r.credentialId === c.id);
  if (direct.some((r) => r.personId === personId)) return "direct";
  const role = projectRoleOf(personId, c.projectId);
  if (role && direct.some((r) => r.roleId === role.id)) return "role";
  return null;
}

/** La legge davvero: lettore effettivo, chiave confermata, copia. */
function reads(personId: string, c: Credential): boolean {
  const key = keyOf(personId);
  return (
    readerSource(personId, c) !== null && key?.status === "confirmed" && key.copies.includes(c.id)
  );
}

const canManage = (me: string, c: Credential) =>
  canI(me, "credentials.edit", c.projectId) || canI(me, "credentials.share", c.projectId);

/** Come la vede chi guarda, o null (non la vede). */
function viewOf(me: string, c: Credential): CredentialView | null {
  const access = reads(me, c)
    ? "reads"
    : readerSource(me, c)
      ? "waiting"
      : canManage(me, c)
        ? "manages"
        : null;
  if (!access) return null;
  return {
    id: c.id,
    projectId: c.projectId,
    service: c.service,
    label: c.label,
    url: c.url,
    username: c.username,
    notes: c.notes,
    access,
    canEdit: canI(me, "credentials.edit", c.projectId),
    canShare: canI(me, "credentials.share", c.projectId),
    updatedAt: c.updatedAt,
  };
}

/** Il Mac del prototipo di chi guarda. */
function mac(me: string): ThisMac {
  let m = v().thisMac.get(me);
  if (!m) {
    m = {
      macId: null,
      open: false,
      freshlyPaired: false,
      revoked: false,
      pairing: null,
      unreachable: false,
    };
    v().thisMac.set(me, m);
  }
  // Un Mac tolto altrove (l'admin, un altro dei propri Mac) non apre più.
  if (m.macId && !v().macs.some((x) => x.id === m!.macId)) {
    m.macId = null;
    m.open = false;
    m.revoked = true;
  }
  return m;
}

const isOpen = (me: string) => mac(me).open && mac(me).macId !== null;
/** L'email di una persona del team, come la mostra il resto del prototipo. */
const emailOf = (personId: string) => addressOf(personId).email;

/** Le copie che chi non è più lettore effettivo perde (la revoca a lettura, poi la pulizia). */
function pruneCopies(c: Credential): void {
  for (const k of v().keys)
    if (!readerSource(k.personId, c)) k.copies = k.copies.filter((id) => id !== c.id);
}

/** Dà la copia a chi è lettore effettivo con la chiave confermata (una condivisione, una creazione). */
function giveCopies(c: Credential): void {
  for (const k of v().keys)
    if (k.status === "confirmed" && readerSource(k.personId, c) && !k.copies.includes(c.id))
      k.copies.push(c.id);
}

/** Un'impronta finta, deterministica (quattro gruppi di cifre esadecimali). */
function fakeFingerprint(seed: string): string {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const hex = Array.from({ length: 4 }, (_, i) =>
    ((h = Math.imul(h ^ (i + 7), 2654435761) >>> 0) & 0xffff).toString(16).padStart(4, "0"),
  );
  return hex.join(" ");
}

// --- la barra --------------------------------------------------------------------

export async function getVaultStatus(): Promise<VaultStatusView> {
  const me = await gate("vault.getVaultStatus");
  const key = keyOf(me);
  const m = mac(me);
  const own = v().macs.find((x) => x.id === m.macId);
  const base = {
    touchId: v().simulation.touchId !== "unavailable",
    macFingerprint: own?.fingerprint ?? null,
    ownFingerprint: key?.fingerprint ?? null,
    pairing: m.pairing,
  };
  const s = !v().active
    ? "inactive"
    : !key
      ? "no_key"
      : key.status === "pending"
        ? "key_pending"
        : m.revoked && !m.macId
          ? "revoked"
          : !m.macId
            ? "unpaired"
            : m.open
              ? "open"
              : m.unreachable
                ? "unreachable"
                : "locked";
  return { state: s, ...base };
}

/** Il Touch ID e l'apertura, con ciò che dice la simulazione. */
export async function unlock(): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.unlock");
  const m = mac(me);
  if (!m.macId) return fail(m.revoked ? "revoked" : "unpaired");
  if (m.open) return { ok: true };
  if (m.freshlyPaired) m.freshlyPaired = false;
  else if (v().simulation.touchId === "unavailable") return fail("touch_id_unavailable");
  else if (v().simulation.touchId === "cancelled") return fail("touch_id_cancelled");
  if (v().simulation.opening === "unreachable") {
    m.unreachable = true;
    return fail("unavailable");
  }
  if (v().simulation.opening === "revoked") {
    // D-5: il sigillo è sparito sul server; il login resta.
    v().macs = v().macs.filter((x) => x.id !== m.macId);
    m.macId = null;
    m.revoked = true;
    return fail("revoked");
  }
  m.unreachable = false;
  m.open = true;
  const own = v().macs.find((x) => x.id === m.macId);
  if (own) own.lastUsedAt = now();
  return { ok: true };
}

export async function lock(): Promise<{ ok: true }> {
  const me = await gate("vault.lock");
  mac(me).open = false;
  return { ok: true };
}

/** Cosa succede la prossima volta (riquadro «Prototype only»). */
export async function setVaultSimulation(next: Partial<VaultSimulation>): Promise<void> {
  await gate("vault.setVaultSimulation");
  Object.assign(v().simulation, next);
}

// --- l'associazione --------------------------------------------------------------

let pairingSeq = 0;

/** L'esito del ritorno dal browser (nell'app lo dice il main; qui `finishPairing`). */
export type PairingResult = { ok: true } | { ok: false; code: string };
const pairingListeners = new Set<(result: PairingResult) => void>();

/** Il dialogo dell'associazione sente com'è andato il ritorno dal browser. */
export function subscribePairing(listener: (result: PairingResult) => void): () => void {
  pairingListeners.add(listener);
  return () => pairingListeners.delete(listener);
}

const tellPairing = (result: PairingResult) => {
  for (const l of pairingListeners) l(result);
};

export async function startPairing(): Promise<{ ok: true; fingerprint: string } | VaultFailure> {
  const me = await gate("vault.startPairing");
  if (!v().active) return fail("vault_not_active");
  if (keyOf(me)?.status !== "confirmed") return fail("vault_key_not_confirmed");
  // Ogni richiesta una chiave nuova (l'orologio del prototipo può essere fermo).
  pairingSeq += 1;
  const fingerprint = fakeFingerprint(`${me}:${now()}:${v().macs.length}:${pairingSeq}`);
  mac(me).pairing = { fingerprint, until: new Date(Date.parse(now()) + 10 * 60_000).toISOString() };
  return { ok: true, fingerprint };
}

/** Il ritorno dal browser (il prototipo lo simula): riuscito, scaduto, che non corrisponde. */
export async function finishPairing(
  outcome: "ok" | "expired" | "mismatch",
): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.finishPairing");
  const m = mac(me);
  const pairing = m.pairing;
  m.pairing = null;
  if (!pairing) return fail("no_pending");
  if (outcome === "expired") {
    tellPairing({ ok: false, code: "expired" });
    return fail("expired");
  }
  if (outcome === "mismatch") {
    tellPairing({ ok: false, code: "open_failed" });
    return fail("open_failed");
  }
  const id = newId("mac");
  const first = (nameOf(me) ?? "").split(" ")[0];
  v().macs.push({
    id,
    personId: me,
    name: `MacBook Pro di ${first}`,
    pairedAt: now(),
    lastUsedAt: now(),
    fingerprint: pairing.fingerprint,
  });
  m.macId = id;
  m.revoked = false;
  m.unreachable = false;
  // D-1b: subito aperta, senza tocco questa volta.
  m.open = true;
  m.freshlyPaired = false;
  tellPairing({ ok: true });
  return { ok: true };
}

export async function cancelPairing(): Promise<void> {
  const me = await gate("vault.cancelPairing");
  mac(me).pairing = null;
}

// --- i Mac -----------------------------------------------------------------------

function macsOf(personId: string, currentId: string | null): MacView[] {
  return v()
    .macs.filter((m) => m.personId === personId)
    .map((m) => ({
      id: m.id,
      name: m.name,
      pairedAt: m.pairedAt,
      lastUsedAt: m.lastUsedAt,
      fingerprint: m.fingerprint,
      current: m.id === currentId,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.pairedAt.localeCompare(a.pairedAt));
}

export async function listMyMacs(): Promise<MacView[]> {
  const me = await gate("vault.listMyMacs");
  return macsOf(me, mac(me).macId);
}

/** «Dimentica questo Mac»: il proprio sigillo e il locale; il login resta. */
export async function forgetThisMac(): Promise<{ ok: true; remote: boolean }> {
  const me = await gate("vault.forgetThisMac");
  const m = mac(me);
  v().macs = v().macs.filter((x) => x.id !== m.macId);
  Object.assign(m, {
    macId: null,
    open: false,
    freshlyPaired: false,
    revoked: false,
    pairing: null,
    unreachable: false,
  });
  return { ok: true, remote: true };
}

/**
 * Un ALTRO proprio Mac, da qui (VA-Q4, maintainer; e5b85be0e): con la
 * riconferma del desktop E la cassaforte aperta (la prova della propria
 * chiave). L'ordine dei controlli è quello del server: riconferma, il
 * proprio Mac (`use_mine`), la prova, poi un Mac che non è suo (404).
 */
export async function removeMac(macId: string): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.removeMac");
  if (requireReauth(me, "vault.removeMac")) return fail("reauth_required");
  if (macId === mac(me).macId) return fail("use_mine");
  if (!isOpen(me)) return fail("vault_locked");
  if (!v().macs.some((x) => x.id === macId && x.personId === me)) return fail("not_found");
  v().macs = v().macs.filter((x) => x.id !== macId);
  return { ok: true };
}

/** I Mac di un'altra persona (D-6): solo full admin. */
export async function listMacsOf(
  personId: string,
): Promise<{ ok: true; macs: MacView[] } | VaultFailure> {
  const me = await gate("vault.listMacsOf");
  if (!isFullAdmin(me)) return fail("forbidden");
  return { ok: true, macs: macsOf(personId, null) };
}

export async function removeMacOf(
  personId: string,
  macId: string,
): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.removeMacOf");
  if (!isFullAdmin(me)) return fail("forbidden");
  if (!v().macs.some((x) => x.id === macId && x.personId === personId)) return fail("not_found");
  if (requireReauth(me, "vault.removeMacOf")) return fail("reauth_required");
  v().macs = v().macs.filter((x) => x.id !== macId);
  return { ok: true };
}

// --- le credenziali ----------------------------------------------------------------

/** Le credenziali che chi guarda vede: di un progetto, o di tutti (la pagina «Vault»). */
export async function listCredentials(filter: {
  projectId?: string;
  projectIds?: string[];
}): Promise<CredentialView[]> {
  const me = await gate("vault.listCredentials");
  if (!v().active) return [];
  const projects = filter.projectId
    ? [filter.projectId]
    : filter.projectIds?.length
      ? filter.projectIds
      : null;
  return v()
    .credentials.filter((c) => !projects || projects.includes(c.projectId))
    .flatMap((c) => viewOf(me, c) ?? [])
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.service.localeCompare(b.service));
}

/**
 * La voce «Credentials» della colonna del progetto (shape §3, «Dove si
 * entra»): c'è se la cassaforte è attiva e chi guarda vede almeno una
 * credenziale o può crearne lì; `waitingMe` accende il punto «ti aspetta»
 * quando c'è chi aspetta che sia lui a confermarlo.
 */
export async function getCredentialsEntry(
  projectId: string,
): Promise<{ show: boolean; waitingMe: boolean; canCreate: boolean }> {
  const me = await gate("vault.getCredentialsEntry");
  if (!v().active) return { show: false, waitingMe: false, canCreate: false };
  const sees = v().credentials.some((c) => c.projectId === projectId && viewOf(me, c));
  const canCreate = canI(me, "credentials.create", projectId);
  const show = sees || canCreate;
  const waitingMe =
    show && v().keys.some((k) => passable(me, k.personId).some((c) => c.projectId === projectId));
  return { show, waitingMe, canCreate };
}

/**
 * La voce «Vault» della barra laterale (shape §3, VA-Q1): c'è se la
 * cassaforte è attiva e chi guarda vede almeno una credenziale (anche in
 * attesa) o può crearne in almeno un progetto; `waitingMe` accende il punto
 * quando c'è chi aspetta che sia lui a confermarlo; `createProjectIds` sono i
 * progetti dove «New credential» può creare.
 */
export async function getVaultEntry(): Promise<{
  show: boolean;
  waitingMe: boolean;
  createProjectIds: string[];
}> {
  const me = await gate("vault.getVaultEntry");
  if (!v().active) return { show: false, waitingMe: false, createProjectIds: [] };
  const projectIds = [...new Set(accessState().memberships.map((m) => m.projectId))];
  const createProjectIds = projectIds.filter((p) => canI(me, "credentials.create", p)).sort();
  const sees = v().credentials.some((c) => viewOf(me, c));
  const show = sees || createProjectIds.length > 0;
  const waitingMe = show && v().keys.some((k) => passable(me, k.personId).length > 0);
  return { show, waitingMe, createProjectIds };
}

export async function getCredential(id: string): Promise<CredentialView | null> {
  const me = await gate("vault.getCredential");
  const c = credentialById(id);
  return c ? viewOf(me, c) : null;
}

/** La password per chi la legge, a cassaforte aperta; il registro dice «shown, from the Mac». */
async function reveal(
  me: string,
  id: string,
  action: "shown" | "copied",
): Promise<string | VaultFailure> {
  const c = credentialById(id);
  const view = c ? viewOf(me, c) : null;
  if (!c || !view || view.access === "manages") return fail("not_found");
  if (!isOpen(me)) return fail("vault_locked");
  if (view.access === "waiting") return fail("waiting");
  v().log.push({
    id: newId("al"),
    credentialId: c.id,
    projectId: c.projectId,
    service: c.service,
    personId: me,
    action,
    via: "mac",
    at: now(),
  });
  return c.password;
}

export async function show(id: string): Promise<{ ok: true; password: string } | VaultFailure> {
  const me = await gate("vault.show");
  const out = await reveal(me, id, "shown");
  return typeof out === "string" ? { ok: true, password: out } : out;
}

/** Copy: gli appunti li scrive il livello dati (nell'app, il main): la pagina non ha la password. */
export async function copy(id: string): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.copy");
  const out = await reveal(me, id, "copied");
  if (typeof out !== "string") return out;
  clipboard.write(out);
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    void Promise.resolve(clipboard.read()).then(
      (current) => {
        if (current === out) clipboard.write("");
      },
      () => clipboard.write(""),
    );
  }, CLIPBOARD_CLEAR_MS);
  return { ok: true };
}

export interface CredentialInput {
  service: string;
  label: string | null;
  url: string | null;
  username: string | null;
  notes: string | null;
  password: string;
}

export async function createCredential(
  projectId: string,
  input: CredentialInput,
): Promise<{ ok: true; id: string } | VaultFailure> {
  const me = await gate("vault.createCredential");
  if (!v().active) return fail("vault_not_active");
  if (!canI(me, "credentials.create", projectId)) return fail("forbidden");
  if (!input.service.trim()) return fail("invalid: service");
  if (!input.password) return fail("invalid: password");
  const c: Credential = {
    id: newId("cred"),
    projectId,
    ...input,
    service: input.service.trim(),
    createdById: me,
    createdAt: now(),
    updatedAt: now(),
  };
  v().credentials.push(c);
  giveCopies(c);
  return { ok: true, id: c.id };
}

/** I campi in chiaro; la password nuova vuole la cassaforte aperta (le copie le fa il main). */
export async function updateCredential(
  id: string,
  input: Partial<CredentialInput>,
): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.updateCredential");
  const c = credentialById(id);
  if (!c || !viewOf(me, c)) return fail("not_found");
  if (!canI(me, "credentials.edit", c.projectId)) return fail("forbidden");
  if (input.password !== undefined && input.password !== "" && !isOpen(me))
    return fail("vault_locked");
  if (input.service !== undefined && !input.service.trim()) return fail("invalid: service");
  const { password, ...plain } = input;
  Object.assign(c, plain, password ? { password } : {}, { updatedAt: now() });
  return { ok: true };
}

export async function deleteCredential(id: string): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.deleteCredential");
  const c = credentialById(id);
  if (!c || !viewOf(me, c)) return fail("not_found");
  if (!canI(me, "credentials.edit", c.projectId)) return fail("forbidden");
  v().credentials = v().credentials.filter((x) => x.id !== id);
  v().readers = v().readers.filter((r) => r.credentialId !== id);
  for (const k of v().keys) k.copies = k.copies.filter((x) => x !== id);
  return { ok: true };
}

// --- i lettori -----------------------------------------------------------------------

const roleName = (roleId: string) =>
  accessState().roles.find((r) => r.id === roleId)?.name ?? roleId;

export async function listReaders(id: string): Promise<ReadersView> {
  const me = await gate("vault.listReaders");
  const c = credentialById(id);
  const empty: ReadersView = { direct: [], effective: [], canShare: false };
  if (!c || !viewOf(me, c)) return empty;
  const direct = v()
    .readers.filter((r) => r.credentialId === c.id)
    .map((r) =>
      r.personId
        ? {
            readerId: r.id,
            kind: "person" as const,
            id: r.personId,
            name: nameOf(r.personId) ?? r.personId,
            addedAt: r.addedAt,
          }
        : {
            readerId: r.id,
            kind: "role" as const,
            id: r.roleId!,
            name: roleName(r.roleId!),
            addedAt: r.addedAt,
          },
    );
  const people = [
    ...new Set([
      ...accessState().people.map((p) => p.personId),
      ...accessState()
        .memberships.filter((m) => m.projectId === c.projectId)
        .map((m) => m.personId),
    ]),
  ];
  const effective = people.flatMap((personId) => {
    const source = readerSource(personId, c);
    if (!source) return [];
    const key = keyOf(personId);
    const st = !key
      ? "no_key"
      : key.status === "pending"
        ? "key_pending"
        : key.copies.includes(c.id)
          ? "reads"
          : "waiting_copy";
    const role = source === "role" ? projectRoleOf(personId, c.projectId) : null;
    return [
      {
        personId,
        name: nameOf(personId) ?? personId,
        source,
        roleName: role?.name ?? null,
        state: st,
      } as const,
    ];
  });
  const order = { full_admin: 2, created: 0, direct: 1, role: 1 };
  effective.sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name));
  return { direct, effective, canShare: canI(me, "credentials.share", c.projectId) };
}

/**
 * Con chi si può condividere (il campo «Share with»): le persone e i ruoli
 * del progetto della credenziale, tolti quelli già aggiunti direttamente.
 * Vuoto per chi non ha `credentials.share`.
 */
export async function listShareTargets(id: string): Promise<{
  people: { personId: string; name: string }[];
  roles: { roleId: string; name: string }[];
}> {
  const me = await gate("vault.listShareTargets");
  const c = credentialById(id);
  if (!c || !viewOf(me, c) || !canI(me, "credentials.share", c.projectId))
    return { people: [], roles: [] };
  const direct = v().readers.filter((r) => r.credentialId === c.id);
  const members = accessState().memberships.filter((m) => m.projectId === c.projectId);
  const people = [...new Set(members.map((m) => m.personId))]
    .filter((p) => !direct.some((r) => r.personId === p))
    .map((personId) => ({ personId, name: nameOf(personId) ?? personId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const roles = [...new Set(members.map((m) => m.roleId))]
    .filter((r) => !direct.some((d) => d.roleId === r))
    .map((roleId) => ({ roleId, name: roleName(roleId) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { people, roles };
}

/** Condivide: chi ha la chiave confermata riceve la copia subito; gli altri aspettano. */
export async function share(
  id: string,
  target: ReaderTarget,
): Promise<{ ok: true; waiting: string[] } | VaultFailure> {
  const me = await gate("vault.share");
  const c = credentialById(id);
  if (!c || !viewOf(me, c)) return fail("not_found");
  if (!canI(me, "credentials.share", c.projectId)) return fail("forbidden");
  if (!isOpen(me)) return fail("vault_locked");
  if (!reads(me, c)) return fail("not_allowed");
  const exists = v().readers.some(
    (r) =>
      r.credentialId === id &&
      ("personId" in target ? r.personId === target.personId : r.roleId === target.roleId),
  );
  if (!exists)
    v().readers.push({
      id: newId("rd"),
      credentialId: id,
      personId: "personId" in target ? target.personId : null,
      roleId: "roleId" in target ? target.roleId : null,
      addedById: me,
      addedAt: now(),
    });
  giveCopies(c);
  // Chi la condivisione raggiunge e non può ancora leggerla (senza chiave, o in attesa).
  const reached =
    "personId" in target
      ? [target.personId]
      : accessState()
          .memberships.filter((m) => m.projectId === c.projectId && m.roleId === target.roleId)
          .map((m) => m.personId);
  const waiting = reached.filter((p) => !reads(p, c)).map(emailOf);
  return { ok: true, waiting };
}

export async function removeReader(
  id: string,
  readerId: string,
): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.removeReader");
  const c = credentialById(id);
  if (!c || !viewOf(me, c)) return fail("not_found");
  if (!canI(me, "credentials.share", c.projectId)) return fail("forbidden");
  if (!isOpen(me)) return fail("vault_locked");
  if (!v().readers.some((r) => r.id === readerId && r.credentialId === id))
    return fail("not_found");
  v().readers = v().readers.filter((r) => r.id !== readerId);
  pruneCopies(c);
  return { ok: true };
}

// --- gli accessi da confermare -------------------------------------------------------

/** Le credenziali che `me` può passare a `personId`: le legge, può condividere, l'altro ne è lettore senza copia. */
function passable(me: string, personId: string): Credential[] {
  const key = keyOf(personId);
  if (!key || personId === me) return [];
  return v().credentials.filter(
    (c) =>
      reads(me, c) &&
      (isFullAdmin(me) || canI(me, "credentials.share", c.projectId)) &&
      readerSource(personId, c) !== null &&
      !key.copies.includes(c.id),
  );
}

export async function listPending(): Promise<PendingPersonView[]> {
  const me = await gate("vault.listPending");
  return v().keys.flatMap((k) => {
    const creds = passable(me, k.personId);
    if (creds.length === 0) return [];
    return [
      {
        keyId: `vk-${k.personId}`,
        personId: k.personId,
        name: nameOf(k.personId) ?? k.personId,
        email: emailOf(k.personId),
        createdAt: k.createdAt,
        device: k.device,
        fingerprint: k.fingerprint,
        credentials: creds.map((c) => ({ id: c.id, service: c.service, projectId: c.projectId })),
      },
    ];
  });
}

const personOfKey = (keyId: string) => keyId.replace(/^vk-/, "");

export async function confirm(
  keyId: string,
): Promise<
  | { ok: true; saved: number; keyChanged: number; notAllowed: number; unopenable: number }
  | VaultFailure
> {
  const me = await gate("vault.confirm");
  const personId = personOfKey(keyId);
  const key = keyOf(personId);
  if (!key || personId === me) return fail("not_found");
  if (!isOpen(me)) return fail("vault_locked");
  const creds = passable(me, personId);
  if (creds.length === 0) return fail("nothing_to_confirm");
  key.status = "confirmed";
  key.copies.push(...creds.map((c) => c.id));
  return { ok: true, saved: creds.length, keyChanged: 0, notAllowed: 0, unopenable: 0 };
}

export async function reject(keyId: string): Promise<{ ok: true } | VaultFailure> {
  const me = await gate("vault.reject");
  const personId = personOfKey(keyId);
  if (!keyOf(personId) || personId === me || passable(me, personId).length === 0)
    return fail("not_found");
  if (!isOpen(me)) return fail("vault_locked");
  // Rifiutata: non riceve nulla, e dovrà ricreare la chiave nel browser.
  v().keys = v().keys.filter((k) => k.personId !== personId);
  return { ok: true };
}

// --- il registro ---------------------------------------------------------------------

/** Chi gestisce le credenziali del progetto (o un full admin) legge il registro, con «da dove» (VA-Q5). */
export async function listAccessLog(filter: {
  projectId: string;
  credentialId?: string;
}): Promise<AccessLogView[]> {
  const me = await gate("vault.listAccessLog");
  const allowed =
    isFullAdmin(me) ||
    canI(me, "credentials.edit", filter.projectId) ||
    canI(me, "credentials.share", filter.projectId);
  if (!allowed) return [];
  return v()
    .log.filter(
      (e) =>
        e.projectId === filter.projectId &&
        (!filter.credentialId || e.credentialId === filter.credentialId),
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((e) => ({
      id: e.id,
      at: e.at,
      personId: e.personId,
      name: nameOf(e.personId) ?? e.personId,
      credentialId: e.credentialId,
      service: e.service,
      action: e.action,
      via: e.via,
    }));
}
