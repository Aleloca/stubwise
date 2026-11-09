import type { EnvironmentServer, ProjectEnvironment } from "../../data/model";

// R-L2 (maintainer, 29 ott 2026): in un ambiente il server si sceglie per
// repository. Un rilascio, il «Già su staging?» di una PR e la comparsa
// simulata guardano solo il server della LORO repository: la sua riga, o
// quella di tutto il progetto (`repositoryId: null`) se non ne ha una.

/** Il server su cui gira `repositoryId` in `env`, o `null` se non ce n'è uno. */
export function environmentServerFor(
  env: ProjectEnvironment,
  repositoryId: string,
): EnvironmentServer | null {
  return (
    env.servers.find((s) => s.repositoryId === repositoryId) ??
    env.servers.find((s) => s.repositoryId === null) ??
    null
  );
}
