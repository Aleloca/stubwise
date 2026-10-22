import { useQuery } from "@tanstack/react-query";
import {
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  type ProjectPermission,
  type Reader,
  type SessionResponse,
} from "@stubwise/shared";
import { useAuth } from "../app/auth-context";
import { meKeys } from "./query-keys";

/**
 * Permessi nell'app (22 ott 2026, design
 * `docs/plans/2026-10-22-permessi-progetto-design.md`): **il server decide, il
 * client legge.** I permessi effettivi arrivano calcolati da `/api/auth/me`
 * (`instancePermissions`, `projectPermissions` per progetto) e dal dettaglio
 * progetto (`myPermissions`); l'app non confronta mai il ruolo (`role ===
 * "admin"`), e un test (`permissions.test.ts`) fallisce se lo si reintroduce.
 *
 * Gemello di `apps/web/src/lib/permissions.ts` (non importabile da qui). Qui,
 * a differenza del web, le risposte si PARSANO (`readerSchema`), quindi i
 * `.default()` girano: un server più vecchio dà «nessun permesso», mai un
 * crash. La difesa `?? []` resta solo per i doppi dei test, che non parsano.
 */

export type Permission = InstancePermission | ProjectPermission;

const INSTANCE_SET: ReadonlySet<string> = new Set(INSTANCE_PERMISSIONS);

/** I campi di `/me` che servono qui. */
export type PermissionSource = Partial<
  Pick<Reader<SessionResponse>, "instancePermissions" | "projectPermissions">
>;

/**
 * `me` ha `permission`?
 *
 * - Un full admin li ha tutti (`instance.full_admin` è la DEFINIZIONE della
 *   chiave, come sul server).
 * - Un permesso d'istanza si legge da `instancePermissions`.
 * - Uno di progetto con `projectId` si legge dai permessi di QUEL progetto.
 * - Uno di progetto SENZA `projectId` vuol dire «in almeno un progetto»: solo
 *   per voci di menu e guardie trasversali, dove il server filtra poi.
 */
export function hasPermission(
  me: PermissionSource | undefined | null,
  permission: Permission,
  projectId?: string,
): boolean {
  if (!me) return false;
  const instance = me.instancePermissions ?? [];
  if (instance.includes("instance.full_admin")) return true;
  if (INSTANCE_SET.has(permission)) return instance.includes(permission);
  const byProject = me.projectPermissions ?? {};
  if (projectId !== undefined) return (byProject[projectId] ?? []).includes(permission);
  return Object.values(byProject).some((perms) => (perms ?? []).includes(permission));
}

/** `/me` dalla cache di Query (ricaricato ogni minuto); `undefined` finché non c'è. */
export function useMe() {
  const { client } = useAuth();
  return useQuery({
    queryKey: meKeys.current(),
    queryFn: () => {
      if (!client) throw new Error("useMe richiede un client autenticato");
      return client.auth.me();
    },
    enabled: client !== null,
    staleTime: 60_000,
  });
}

/**
 * La funzione `can(permission, projectId?)` sullo stesso `/me`. Finché `/me`
 * non è arrivato (o se la lettura fallisce) risponde `false`: l'errore costa
 * un bottone nascosto, mai uno che il server rifiuterebbe.
 */
export function useCan(): (permission: Permission, projectId?: string) => boolean {
  const { data: me } = useMe();
  return (permission, projectId) => hasPermission(me, permission, projectId);
}
