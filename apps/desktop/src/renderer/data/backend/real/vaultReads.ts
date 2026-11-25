import { ApiError } from "@stubwise/api-client";
import type { CredentialItem, Reader } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { CredentialView } from "../../vault/types";
import { appClient } from "./client";
import { currentMe } from "./session";
import { listPending } from "./vaultDesktop";

// Fetta 2b dell'adattatore della cassaforte: le letture dalle rotte
// (`api-client`, gruppo `credentials`, 72 aeaf4c903), con le firme del
// prototipo. `access`, `canEdit` e `canShare` li calcola il server: il client
// legge, non deduce. Nessuna di queste risposte porta password o copie.

type FakeVault = typeof Fake.vault;

/** `read` → la apre; `pending` → aspetta la chiave; `manage` → la gestisce senza leggerla. */
function accessOf(access: Reader<CredentialItem>["access"]): CredentialView["access"] {
  if (access === "read") return "reads";
  if (access === "pending") return "waiting";
  // `manage`, o un valore che un server più nuovo conosce e questo client no:
  // si gestisce senza leggere (niente Show né Copy).
  return "manages";
}

const viewOf = (c: Reader<CredentialItem>): CredentialView => ({
  id: c.id,
  projectId: c.projectId,
  service: c.service,
  label: c.label,
  url: c.url,
  username: c.username,
  notes: c.notes,
  access: accessOf(c.access),
  canEdit: c.canEdit,
  canShare: c.canShare,
  updatedAt: c.updatedAt,
});

/**
 * «Le mie» credenziali: nell'app dal main (`vault:mine`, review C1: il proxy
 * rifiuta `/api/vault*` al renderer); nella build web dalla rotta.
 */
async function myCredentials(): Promise<Reader<CredentialItem>[]> {
  const b = window.stubwise?.vault;
  if (b?.mine) {
    const out = await b.mine();
    if (!out.ok) throw new Error(out.code);
    return out.items as Reader<CredentialItem>[];
  }
  return (await appClient().credentials.mine()).items;
}

/** I permessi di chi guarda in un progetto (dal server, `/api/auth/me`). */
async function permissions(): Promise<{
  fullAdmin: boolean;
  inProject: (projectId: string) => readonly string[];
  projectIds: string[];
}> {
  // La stessa lettura di `/api/auth/me` dell'ingresso: mai una seconda.
  const me = await currentMe();
  const map = me.projectPermissions as Record<string, readonly string[]>;
  return {
    fullAdmin: me.instancePermissions.includes("instance.full_admin"),
    inProject: (projectId) => map[projectId] ?? [],
    projectIds: Object.keys(map),
  };
}

export const listCredentials: FakeVault["listCredentials"] = async (filter) => {
  if (filter.projectId) {
    const { items } = await appClient().credentials.ofProject(filter.projectId);
    return items.map(viewOf);
  }
  // La pagina Vault: «le mie» (lette o in attesa), in tutti i progetti visibili.
  const items = await myCredentials();
  const only = filter.projectIds?.length ? new Set(filter.projectIds) : null;
  return items.filter((c) => !only || only.has(c.projectId)).map(viewOf);
};

/**
 * Il dettaglio: tra «le mie»; se non c'è, nei progetti dove chi guarda
 * gestisce le credenziali (le sole dove una riga «gestita senza leggerla»
 * esiste). `null` se non la vede, come il prototipo.
 */
export const getCredential: FakeVault["getCredential"] = async (id) => {
  const mine = (await myCredentials()).find((c) => c.id === id);
  if (mine) return viewOf(mine);
  const p = await permissions();
  for (const projectId of p.projectIds) {
    const perms = p.inProject(projectId);
    if (!p.fullAdmin && !perms.includes("credentials.edit") && !perms.includes("credentials.share"))
      continue;
    const found = (await appClient().credentials.ofProject(projectId)).items.find(
      (c) => c.id === id,
    );
    if (found) return viewOf(found);
  }
  return null;
};

export const getCredentialsEntry: FakeVault["getCredentialsEntry"] = async (projectId) => {
  const [p, list] = await Promise.all([
    permissions(),
    appClient().credentials.ofProject(projectId),
  ]);
  const perms = p.inProject(projectId);
  const canCreate = p.fullAdmin || perms.includes("credentials.create");
  const canSeeLog =
    p.fullAdmin || perms.includes("credentials.edit") || perms.includes("credentials.share");
  // `waitingMe` (il punto «ti aspetta»): chi aspetta lo sa solo il main a
  // cassaforte aperta; qui resta spento (fetta 3).
  return { show: list.items.length > 0 || canCreate, waitingMe: false, canCreate, canSeeLog };
};

export const getVaultEntry: FakeVault["getVaultEntry"] = async () => {
  const [p, mine, waiting] = await Promise.all([
    permissions(),
    myCredentials().then((items) => ({ items })),
    // Il punto «ti aspetta» [VA 2]: chi aspetta lo sa il main, a cassaforte aperta.
    listPending().catch(() => []),
  ]);
  const createProjectIds = p.projectIds
    .filter((id) => p.fullAdmin || p.inProject(id).includes("credentials.create"))
    .sort();
  return {
    show: mine.items.length > 0 || createProjectIds.length > 0,
    waitingMe: waiting.length > 0,
    createProjectIds,
  };
};

// --- fetta 2c: lettori, registro, «Share with» ---------------------------------

/** I nomi delle persone (la rubrica del team); chi non c'è resta con l'email. */
async function namesById(): Promise<Map<string, string>> {
  const people = await appClient().people.list();
  return new Map(people.map((p) => [p.id, p.name]));
}

type ReaderPerson = Reader<
  Awaited<ReturnType<ReturnType<typeof appClient>["credentials"]["readers"]>>
>["people"][number];

/** Il perché di chi aspetta, dal server: nessuna chiave, chiave da confermare, copia da ricevere. */
function stateOf(p: ReaderPerson): "reads" | "no_key" | "key_pending" | "waiting_copy" {
  if (p.status === "can_read") return "reads";
  if (p.keyStatus === "none") return "no_key";
  if (p.keyStatus === "pending") return "key_pending";
  return "waiting_copy";
}

export const listReaders: FakeVault["listReaders"] = async (id) => {
  const [view, readers, names] = await Promise.all([
    getCredential(id),
    appClient().credentials.readers(id),
    namesById(),
  ]);
  const creators = new Set(
    readers.readers.filter((r) => r.creator && r.userId).map((r) => r.userId!),
  );
  const directPeople = new Set(readers.readers.filter((r) => r.userId).map((r) => r.userId!));
  return {
    // Chi l'ha creata è lettrice diretta dalla creazione: sta in «Who reads it»
    // («created it»), non fra gli aggiunti (non si toglie da qui).
    direct: readers.readers
      .filter((r) => !r.creator)
      .map((r) =>
        r.userId
          ? {
              readerId: r.id,
              kind: "person" as const,
              id: r.userId,
              name: names.get(r.userId) ?? r.email ?? r.userId,
              addedAt: r.createdAt,
            }
          : {
              readerId: r.id,
              kind: "role" as const,
              id: r.roleId ?? r.id,
              name: r.roleName ?? "",
              addedAt: r.createdAt,
            },
      ),
    effective: readers.people.map((p) => ({
      personId: p.userId,
      name: names.get(p.userId) ?? p.email,
      source: p.fullAdmin
        ? ("full_admin" as const)
        : creators.has(p.userId)
          ? ("created" as const)
          : directPeople.has(p.userId)
            ? ("direct" as const)
            : ("role" as const),
      // Il server non dice per quale ruolo: la riga dice solo «role».
      roleName: null,
      state: stateOf(p),
    })),
    canShare: view?.canShare === true,
  };
};

export const listAccessLog: FakeVault["listAccessLog"] = async (filter) => {
  let items;
  try {
    items = (
      await appClient().credentials.log(filter.projectId, {
        ...(filter.credentialId ? { credentialId: filter.credentialId } : {}),
      })
    ).items;
  } catch (error) {
    // Chi non gestisce le credenziali del progetto non legge il registro: niente righe.
    if (error instanceof ApiError && error.status === 403) return [];
    throw error;
  }
  const names = await namesById();
  return items.map((e) => ({
    id: e.id,
    at: e.createdAt,
    personId: e.userId ?? "",
    name: (e.userId && names.get(e.userId)) || e.userEmail,
    credentialId: e.credentialId ?? "",
    service: e.credentialSnapshot,
    action: e.action === "show" ? ("shown" as const) : ("copied" as const),
    via: e.via === "desktop" ? ("mac" as const) : ("browser" as const),
  }));
};

/** «Share with»: persone e ruoli del progetto, tolti i già aggiunti; vuoto senza `canShare`. */
export const listShareTargets: FakeVault["listShareTargets"] = async (id) => {
  const view = await getCredential(id);
  if (!view?.canShare) return { people: [], roles: [] };
  const [members, readers, names] = await Promise.all([
    appClient().projects.members(view.projectId),
    appClient().credentials.readers(id),
    namesById(),
  ]);
  const directPeople = new Set(readers.readers.map((r) => r.userId).filter(Boolean));
  const directRoles = new Set(readers.readers.map((r) => r.roleId).filter(Boolean));
  const people = [...new Map(members.map((m) => [m.userId, m])).values()]
    .filter((m) => !directPeople.has(m.userId))
    .map((m) => ({ personId: m.userId, name: names.get(m.userId) ?? m.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const roles = [...new Map(members.map((m) => [m.roleId, m.roleName])).entries()]
    .filter(([roleId]) => !directRoles.has(roleId))
    .map(([roleId, name]) => ({ roleId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { people, roles };
};

// --- fetta 2d: i campi in chiaro e Delete -------------------------------------

const failOf = (error: unknown): { ok: false; code: string } => ({
  ok: false,
  code: error instanceof ApiError && error.code ? error.code : "failed",
});

/**
 * La modifica: una password nuova la cifra il main (fetta 4, con la
 * cassaforte aperta) PRIMA dei campi in chiaro, così a cassaforte chiusa
 * non si salva niente a metà; i campi in chiaro con `PATCH` (un campo
 * assente resta com'è, `null` lo svuota). La password non va MAI sulla rotta.
 */
export const updateCredential: FakeVault["updateCredential"] = async (id, input) => {
  const { password, ...plain } = input;
  if (password !== undefined && password !== "") {
    const b = window.stubwise?.vault;
    if (!b) return { ok: false, code: "unsupported" };
    const out = await b.setPassword(id, password);
    if (!out.ok) return { ok: false, code: out.code };
  }
  if (Object.keys(plain).length === 0) return { ok: true };
  try {
    await appClient().credentials.update(id, plain);
    return { ok: true };
  } catch (error) {
    return failOf(error);
  }
};

/** Una credenziale nuova: la cifra il main per i destinatari (non vuole la cassaforte aperta). */
export const createCredential: FakeVault["createCredential"] = async (projectId, input) => {
  const b = window.stubwise?.vault;
  if (!b) return { ok: false, code: "unsupported" };
  const { password, ...fields } = input;
  const out = await b.create(projectId, fields, password);
  return out.ok ? { ok: true, id: out.id } : { ok: false, code: out.code };
};

export const deleteCredential: FakeVault["deleteCredential"] = async (id) => {
  try {
    await appClient().credentials.remove(id);
    return { ok: true };
  } catch (error) {
    return failOf(error);
  }
};
