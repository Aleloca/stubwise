import { INSTANCE_PERMISSIONS, PRESET_ROLES } from "@stubwise/shared";
import type { QueryClient } from "@tanstack/react-query";
import { meQueryOptions } from "../lib/auth";

/**
 * Permessi da mettere nelle fixture di `/api/auth/me` dei test del web.
 *
 * Il web non deduce i permessi dal ruolo: li legge da `/me`. Una fixture con
 * il solo `{ user }` è quindi un utente SENZA permessi (come da un server più
 * vecchio) — ed è voluto: i test che lo usano verificano che la UI si degradi
 * senza crash. Chi vuole un admin o un operatore li dichiara con questi.
 */

/** Permessi d'istanza di un full admin (preset `Admin`): vale tutto, ovunque. */
export const FULL_ADMIN_PERMISSIONS = {
  instancePermissions: [...INSTANCE_PERMISSIONS],
  projectPermissions: {},
};

function preset(key: string): string[] {
  return [...PRESET_ROLES.find((role) => role.key === key)!.permissions];
}

/**
 * Un utente d'istanza `User` membro di `projectIds` col ruolo `Legacy Member`:
 * quello che un `member` è diventato dopo la conversione.
 */
export function legacyMemberPermissions(projectIds: readonly string[] = []): {
  instancePermissions: string[];
  projectPermissions: Record<string, string[]>;
} {
  return {
    instancePermissions: preset("user"),
    projectPermissions: Object.fromEntries(projectIds.map((id) => [id, preset("legacy_member")])),
  };
}

/** I permessi di un ruolo «admin» o «member» di prima, per le fixture vecchie. */
export function permissionsForRole(
  role: "admin" | "member",
  projectIds: readonly string[] = [],
): { instancePermissions: string[]; projectPermissions: Record<string, string[]> } {
  return role === "admin" ? FULL_ADMIN_PERMISSIONS : legacyMemberPermissions(projectIds);
}

/**
 * Mette `/me` direttamente nella cache di Query: per i test che montano un
 * componente da solo (senza la guardia del router che lo carica) e non
 * mockano `/api/auth/me`.
 */
export function seedMe(
  queryClient: QueryClient,
  permissions: { instancePermissions: string[]; projectPermissions: Record<string, string[]> },
  user: { id: string; email: string; role: "admin" | "member" } = {
    id: "u1",
    email: "ada@example.com",
    role: "admin",
  },
): void {
  queryClient.setQueryData(meQueryOptions.queryKey, {
    user: { ...user, language: "en", avatarUrl: null, slackUserId: null },
    ...permissions,
  });
}
