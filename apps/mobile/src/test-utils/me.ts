import { INSTANCE_PERMISSIONS, PRESET_ROLES } from "@stubwise/shared";
import type { StubwiseClient } from "@stubwise/api-client";

/**
 * Permessi da mettere nel doppio del client dei test dell'app. L'app non
 * deduce i permessi dal ruolo: li legge da `/me` (`client.auth.me`). Un doppio
 * SENZA `auth.me` è un utente senza permessi (la query fallisce, `useCan` dà
 * `false`): voluto per i test «member»; chi vuole un maintainer usa `withMe`.
 */
export const FULL_ADMIN_PERMISSIONS = {
  instancePermissions: [...INSTANCE_PERMISSIONS] as string[],
  projectPermissions: {} as Record<string, string[]>,
};

/** Un `member` di prima: ruolo d'istanza `user` + `legacy_member` nei progetti dati. */
export function legacyMemberPermissions(projectIds: readonly string[] = []) {
  const preset = (key: string): string[] => [...PRESET_ROLES.find((role) => role.key === key)!.permissions];
  return {
    instancePermissions: preset("user"),
    projectPermissions: Object.fromEntries(projectIds.map((id) => [id, preset("legacy_member")])),
  };
}

/** Il doppio con `auth.me` aggiunto (senza toccare il resto). */
export function withMe(
  client: StubwiseClient,
  role: "admin" | "member",
  projectIds: readonly string[] = [],
): StubwiseClient {
  // Un doppio che dichiara già il proprio `auth.me` (test con permessi su
  // misura) non si tocca.
  if ((client as { auth?: unknown }).auth !== undefined) return client;
  const permissions = role === "admin" ? FULL_ADMIN_PERMISSIONS : legacyMemberPermissions(projectIds);
  return {
    ...client,
    auth: {
      me: jest.fn().mockResolvedValue({
        user: { id: "viewer-1", email: "op@example.com", role, language: "it", avatarUrl: null, slackUserId: null },
        ...permissions,
      }),
    },
  } as unknown as StubwiseClient;
}
