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
  const { items } = await appClient().credentials.mine();
  const only = filter.projectIds?.length ? new Set(filter.projectIds) : null;
  return items.filter((c) => !only || only.has(c.projectId)).map(viewOf);
};

/**
 * Il dettaglio: tra «le mie»; se non c'è, nei progetti dove chi guarda
 * gestisce le credenziali (le sole dove una riga «gestita senza leggerla»
 * esiste). `null` se non la vede, come il prototipo.
 */
export const getCredential: FakeVault["getCredential"] = async (id) => {
  const mine = (await appClient().credentials.mine()).items.find((c) => c.id === id);
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
  const [p, mine] = await Promise.all([permissions(), appClient().credentials.mine()]);
  const createProjectIds = p.projectIds
    .filter((id) => p.fullAdmin || p.inProject(id).includes("credentials.create"))
    .sort();
  return {
    show: mine.items.length > 0 || createProjectIds.length > 0,
    waitingMe: false,
    createProjectIds,
  };
};
