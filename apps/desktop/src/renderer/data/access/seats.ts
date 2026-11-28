import type { AccessState, RoleDef, WorkspaceDef } from "./state";

// Chi vede un progetto da membro (shape `workspaces.md`): le appartenenze
// esplicite e le persone della sua workspace. È la regola UNICA del «posto»
// in un progetto: la leggono il calcolo dei permessi (`effectiveCore.ts`),
// `project.memberIds` (`state.ts`), «Chi può farlo?» e il conteggio dei
// gestori. Il ruolo per progetto e quello di workspace si sommano (D1).

/** La workspace di un progetto, o `null` (D2: al più una). */
export function workspaceOfProjectIn(s: AccessState, projectId: string): WorkspaceDef | null {
  const row = s.workspaceProjects.find((w) => w.projectId === projectId);
  return (row && s.workspaces.find((w) => w.id === row.workspaceId)) ?? null;
}

/** Il ruolo di workspace di una persona in un progetto: quello della workspace del progetto. */
export function workspaceRoleIn(
  s: AccessState,
  personId: string,
  projectId: string,
): { workspaceId: string; role: RoleDef } | null {
  const ws = workspaceOfProjectIn(s, projectId);
  if (!ws) return null;
  const m = s.workspaceMembers.find((x) => x.workspaceId === ws.id && x.personId === personId);
  const role = m && s.roles.find((r) => r.id === m.roleId);
  return role ? { workspaceId: ws.id, role } : null;
}

/** I posti: ogni coppia persona × progetto vista da membro, una volta sola. */
export function seatsIn(s: AccessState): { personId: string; projectId: string }[] {
  const out = new Map<string, { personId: string; projectId: string }>();
  for (const m of s.memberships) {
    out.set(`${m.projectId}\u0000${m.personId}`, { personId: m.personId, projectId: m.projectId });
  }
  for (const wm of s.workspaceMembers) {
    for (const wp of s.workspaceProjects) {
      if (wp.workspaceId !== wm.workspaceId) continue;
      out.set(`${wp.projectId}\u0000${wm.personId}`, { personId: wm.personId, projectId: wp.projectId });
    }
  }
  return [...out.values()];
}

/** I progetti che una persona vede da membro (esplicito o dalla workspace). */
export const seatProjectIdsIn = (s: AccessState, personId: string): string[] =>
  seatsIn(s)
    .filter((x) => x.personId === personId)
    .map((x) => x.projectId);

/** Vero se la persona vede il progetto da membro. */
export const hasSeatIn = (s: AccessState, personId: string, projectId: string): boolean =>
  s.memberships.some((m) => m.personId === personId && m.projectId === projectId) ||
  workspaceRoleIn(s, personId, projectId) !== null;
