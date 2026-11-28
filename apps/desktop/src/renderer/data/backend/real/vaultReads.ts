import { ApiError } from "@stubwise/api-client";
import type { CredentialItem, Reader } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { CredentialView } from "../../vault/types";
import { appClient } from "./client";
import { currentMe } from "./session";

// Fetta 2b dell'adattatore della cassaforte: le letture dalle rotte
// (`api-client`, gruppo `credentials`, 72 aeaf4c903), con le firme del
// prototipo. `access`, `canEdit` e `canShare` li calcola il server: il client
// legge, non deduce. Nessuna di queste risposte porta password o copie.

type FakeVault = typeof Fake.vault;

/**
 * Cassaforte nel browser, fase 1 (design §4): le letture e scritture che
 * dipendono da DOVE vive la chiave passano da un trasporto, scelto AL BUILD
 * dal modulo del target (`@backend/vault`): il main del desktop
 * (`vault/electron.ts`) o la scheda (`vault/web.ts`). Questo file non nomina
 * il ponte del desktop, così nella build web non c'è.
 */
export interface VaultTransport {
  /** «Le mie» credenziali (dal main sul desktop, dalla rotta nel browser). */
  mine(): Promise<Reader<CredentialItem>[]>;
  /** La password nuova, cifrata dove sta la chiave; `resaved` se ha risalvato per i lettori. */
  setPassword(id: string, password: string): Promise<{ ok: true; resaved?: boolean } | { ok: false; code: string }>;
  /** Una credenziale nuova, cifrata per i destinatari. */
  create(
    projectId: string,
    fields: Omit<Parameters<FakeVault["createCredential"]>[1], "password">,
    password: string,
  ): Promise<{ ok: true; id: string; resaved?: boolean } | { ok: false; code: string }>;
  /** Chi aspetta che chi guarda confermi la sua chiave. */
  pending: FakeVault["listPending"];
}

/** Senza un trasporto impostato (i test, una build senza il modulo del target): solo le rotte, nessuna cifratura. */
const httpOnly: VaultTransport = {
  mine: async () => (await appClient().credentials.mine()).items,
  setPassword: async () => ({ ok: false, code: "unsupported" }),
  create: async () => ({ ok: false, code: "unsupported" }),
  pending: async () => [],
};

let transport: VaultTransport = httpOnly;

/** Lo imposta il modulo del target, al suo import. */
export function setVaultTransport(next: VaultTransport | null): void {
  transport = next ?? httpOnly;
}

const listPending: FakeVault["listPending"] = () => transport.pending();

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
  canSeeLog: c.canSeeLog,
  updatedAt: c.updatedAt,
});

/**
 * «Le mie» credenziali: nell'app dal main (`vault:mine`, review C1: il proxy
 * rifiuta `/api/vault*` al renderer); nella build web dalla rotta.
 */
async function myCredentials(): Promise<Reader<CredentialItem>[]> {
  return transport.mine();
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
  const [p, list, waiting] = await Promise.all([
    permissions(),
    appClient().credentials.ofProject(projectId),
    listPending().catch(() => []),
  ]);
  const perms = p.inProject(projectId);
  const canCreate = p.fullAdmin || perms.includes("credentials.create");
  // Il punto «ti aspetta»: qualcuno aspetta da me una credenziale DI QUESTO
  // progetto (`projectId` dal server, via `vault:pending`; il server mette
  // solo le credenziali che chi guarda apre, nei progetti dove condivide).
  // `canSeeLog` lo calcola il server, anche a elenco vuoto (review M4).
  return {
    show: list.items.length > 0 || canCreate,
    waitingMe: waiting.some((w) => w.credentials.some((c) => c.projectId === projectId)),
    canCreate,
    canSeeLog: list.canSeeLog,
  };
};

export const getVaultEntry: FakeVault["getVaultEntry"] = async () => {
  const [p, mine, waiting] = await Promise.all([
    permissions(),
    myCredentials().then((items) => ({ items })),
    // Il punto «ti aspetta» [VA 2]: chi aspetta lo sa il main (senza chiave, I1).
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
      // Il ruolo nel progetto, quando è fra i lettori invitati (72, f9e9193ce);
      // `null` da un server di prima: la riga dice «via a role».
      roleName: p.roleName ?? null,
      state: stateOf(p),
    })),
    canShare: view?.canShare === true,
  };
};

export const listAccessLog: FakeVault["listAccessLog"] = async (filter) => {
  // Review M4: un 403 è un errore (la voce compare solo con `canSeeLog`),
  // non «nessuno l'ha vista».
  const { items } = await appClient().credentials.log(filter.projectId, {
    ...(filter.credentialId ? { credentialId: filter.credentialId } : {}),
  });
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
    // D16: anche chi vede il progetto solo per la workspace, che il server accetta come lettore.
    appClient().projects.members(view.projectId, { include: "workspace" }),
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
  // [VA 6]: il main dice se ha risalvato per i lettori cambiati.
  let resaved = false;
  if (password !== undefined && password !== "") {
    const out = await transport.setPassword(id, password);
    if (!out.ok) return { ok: false, code: out.code };
    resaved = out.resaved === true;
  }
  if (Object.keys(plain).length === 0) return { ok: true, resaved };
  try {
    await appClient().credentials.update(id, plain);
    return { ok: true, resaved };
  } catch (error) {
    return failOf(error);
  }
};

/** Una credenziale nuova: la cifra il main per i destinatari (non vuole la cassaforte aperta). */
export const createCredential: FakeVault["createCredential"] = async (projectId, input) => {
  const { password, ...fields } = input;
  const out = await transport.create(projectId, fields, password);
  return out.ok
    ? { ok: true, id: out.id, resaved: out.resaved === true }
    : { ok: false, code: out.code };
};

export const deleteCredential: FakeVault["deleteCredential"] = async (id) => {
  try {
    await appClient().credentials.remove(id);
    return { ok: true };
  } catch (error) {
    return failOf(error);
  }
};
