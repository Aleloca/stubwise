import { can, viewerFor } from "../viewer";

// Chi ferma una correzione di server (area 8, F4b, review I5, come il
// server): `servers.operate` o `plans.approve` nel progetto della task. Un
// modulo a sé, senza lo stato né le scritture: lo leggono `reads.ts` (la
// vista della correzione) e `fixDecide.ts` (lo Stop), e le letture dei
// server non devono arrivare a `secrets.ts` (test d'architettura).

export const canStopServerFix = (me: string, projectId: string): boolean => {
  const viewer = viewerFor(me);
  return can(viewer, "servers.operate", projectId) || can(viewer, "plans.approve", projectId);
};
