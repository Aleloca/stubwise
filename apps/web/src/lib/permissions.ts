import { useQuery } from "@tanstack/react-query";
import {
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  type ProjectPermission,
} from "@stubwise/shared";
import type { MeResponse } from "./api";
import { meQueryOptions } from "./auth";
import { repositoriesQueryOptions } from "./queries";

/**
 * Permessi nel web (22 ott 2026, design
 * `docs/plans/2026-10-22-permessi-progetto-design.md`): **il server decide, il
 * client legge.** I permessi effettivi arrivano calcolati da `/api/auth/me`
 * (`instancePermissions`, `projectPermissions` per progetto) e dal dettaglio
 * progetto (`myPermissions`); il web non confronta mai il ruolo (`role ===
 * "admin"`), e un test (`permissions.test.ts`) fallisce se lo si reintroduce.
 *
 * ⚠️ Il web non parsa le risposte (cast, vedi il docblock di `api.ts`): i
 * `.default()` degli schemi qui non girano. Un server più vecchio non manda i
 * campi dei permessi, e ogni lettura va difesa (`?? []`, `?? {}`): campo
 * assente = nessun permesso, mai un crash.
 */

export type Permission = InstancePermission | ProjectPermission;

const INSTANCE_SET: ReadonlySet<string> = new Set(INSTANCE_PERMISSIONS);

/** I campi di `/me` che servono qui: tutti opzionali, perché il web non parsa. */
export type PermissionSource = Pick<
  Partial<MeResponse>,
  "instancePermissions" | "projectPermissions"
>;

/**
 * `me` ha `permission`?
 *
 * - Un full admin li ha tutti (vedi sotto).
 * - Un permesso d'istanza si legge da `instancePermissions`.
 * - Uno di progetto con `projectId` si legge dai permessi di QUEL progetto.
 * - Uno di progetto SENZA `projectId` vuol dire «in almeno un progetto»: serve
 *   alle voci di menu e alle pagine trasversali (coda di rilascio, aggiunta di
 *   un repository col progetto scelto nel form), dove il server filtra poi per
 *   progetto.
 */
export function hasPermission(
  me: PermissionSource | undefined,
  permission: Permission,
  projectId?: string,
): boolean {
  if (!me) return false;
  const instance = me.instancePermissions ?? [];
  // `instance.full_admin` vale ogni permesso su ogni progetto, come sul server
  // (`effectiveProjectPermissions`): è la DEFINIZIONE della chiave, non una
  // deduzione dal ruolo, e copre anche un progetto creato dopo l'ultimo `/me`.
  if (instance.includes("instance.full_admin")) return true;
  if (INSTANCE_SET.has(permission)) return instance.includes(permission);
  const byProject = me.projectPermissions ?? {};
  if (projectId !== undefined) return (byProject[projectId] ?? []).includes(permission);
  return Object.values(byProject).some((perms) => (perms ?? []).includes(permission));
}

/**
 * Hook: l'utente corrente ha `permission` (nel progetto `projectId`, se dato)?
 * Legge `/me` dalla cache di Query (caricato dalla guardia del layout
 * autenticato); finché non c'è, la risposta è `false`.
 */
export function useCan(permission: Permission, projectId?: string): boolean {
  const { data: me } = useQuery(meQueryOptions);
  return hasPermission(me, permission, projectId);
}

/**
 * Hook: la funzione `can(permission, projectId?)` sullo stesso `/me`, per i
 * componenti che decidono più permessi o su più progetti (una riga per
 * progetto) senza chiamare un hook per ciascuno.
 */
export function useCanFn(): (permission: Permission, projectId?: string) => boolean {
  const { data: me } = useQuery(meQueryOptions);
  return (permission, projectId) => hasPermission(me, permission, projectId);
}

/**
 * Hook: `permission` nel progetto del REPOSITORY `repositoryId` — per le viste
 * chiavate sul repository (spazio Docs, grafo), dove il progetto non è
 * nell'URL. Il progetto si legge dall'elenco dei repository (già in cache
 * altrove); finché non c'è, la risposta è `false`. Un full admin, e chi il
 * permesso non l'ha in nessun progetto, non ne hanno bisogno e non fanno
 * partire la query.
 */
export function useCanOnRepository(permission: Permission, repositoryId: string): boolean {
  const { data: me } = useQuery(meQueryOptions);
  const fullAdmin = hasPermission(me, "instance.full_admin");
  // Chi non ha il permesso in NESSUN progetto non ha bisogno di sapere di
  // quale progetto è il repository: la risposta è già `false`.
  const anywhere = hasPermission(me, permission);
  const { data: repositories } = useQuery({
    ...repositoriesQueryOptions(),
    enabled: anywhere && !fullAdmin,
  });
  if (fullAdmin) return true;
  if (!anywhere) return false;
  const projectId = repositories?.find((repository) => repository.id === repositoryId)?.projectId;
  return projectId !== undefined && hasPermission(me, permission, projectId);
}
