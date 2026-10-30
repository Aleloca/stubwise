import { gate, state, visibleProjectIds } from "../store";
import { can, viewerFor } from "../viewer";
import { forbidden } from "../writer";

// I repository di tutta l'istanza (area 9b, Task 7): Amministrazione →
// Repositories, un elenco del catalogo senza azioni — per cambiarne uno si
// apre nelle impostazioni del suo progetto (`href`). Lo legge chi ha
// `repos.manage` in almeno un progetto (la voce di `adminSections`), e
// elenca i progetti dove chi guarda ha `repos.view`: gli altri non
// compaiono, nemmeno contati (R-G5, shape «Repositories»). Il nome
// dell'account git è un fatto dell'istanza: lo vede chi vede il repository.

export interface InstanceRepositoryRow {
  id: string;
  name: string;
  /** `owner/repo`, se la piattaforma lo dà. */
  fullName: string | null;
  /** Il nome dell'account git d'istanza che ci lavora; `null` se non ne ha. */
  gitAccountName: string | null;
  /** Dove si cambia: le impostazioni dei repository del progetto. */
  href: string;
}

export interface InstanceRepositoryGroup {
  projectId: string;
  projectCode: string;
  projectName: string;
  repositories: InstanceRepositoryRow[];
}

/**
 * I repository dei progetti dove `me` ha `repos.view`, un gruppo per progetto
 * (alfabetico per nome, i repository per nome); un progetto senza repository
 * non compare. `forbidden` senza `repos.manage` in almeno un progetto.
 */
export async function listAllRepositories(): Promise<InstanceRepositoryGroup[]> {
  const me = await gate("instance.listAllRepositories");
  const viewer = viewerFor(me);
  if (!can(viewer, "repos.manage")) throw forbidden();
  const visible = visibleProjectIds(me);
  return state.projects
    .filter((p) => visible.has(p.id) && can(viewer, "repos.view", p.id))
    .map((p) => ({
      projectId: p.id,
      projectCode: p.code,
      projectName: p.name,
      repositories: state.repositories
        .filter((r) => r.projectId === p.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          fullName: r.fullName ?? null,
          gitAccountName:
            state.instance.gitAccounts.find((g) => g.id === r.gitAccountId)?.name ?? null,
          href: `#/p/${p.code}/settings/repositories`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.repositories.length > 0)
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}
