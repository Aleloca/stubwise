import type { ColleaguePrMode } from "@stubwise/shared";
import type { Repository } from "../../model";
import type { RepositorySettings } from "../../releases";
import { inPrototypeWords } from "./automationRefs";

// Le impostazioni di rilascio dei repository nella build app (area 8, F1,
// `releases-repo-settings`) sopra `GET /api/repositories?projectId=` e la
// PATCH per slug di 72 (S6), con le firme del prototipo
// (`getRepositorySettings`, `setRepoPrMode`, `setReleasePipeline`). Chi le
// cambia (`repos.manage`) lo dice il server (i permessi di chi guarda).

/**
 * Un repository come lo legge il client (`Reader`): gli enum possono avere un
 * valore che questa build non conosce (`__unknown__`), letto con prudenza.
 */
interface RepoRow {
  id: string;
  name: string;
  slug: string;
  repoUrl: string;
  defaultBranch: string;
  releaseBranch: string | null;
  releasePipeline: { mode: string; names?: string[] };
  ciProvider: string | null;
  colleaguePrs: string;
}

const PR_MODES: readonly string[] = ["analyze_and_fix", "analyze_only", "off"];
const CI_PROVIDERS: readonly string[] = ["github_actions", "bitbucket_pipelines"];

export interface RepoSettingsApi {
  list(projectId: string): Promise<RepoRow[]>;
  update(
    slug: string,
    patch: {
      releaseBranch?: string | null;
      releasePipeline?: { mode: "auto" } | { mode: "named"; names: string[] };
      colleaguePrs?: ColleaguePrMode;
    },
  ): Promise<unknown>;
  /** `repos.manage` di chi guarda nel progetto (dai permessi di `/api/auth/me`). */
  canManage(projectId: string): Promise<boolean>;
}

/** `owner/repo` dall'indirizzo del repository (il nome da solo se non si legge). */
function fullNameOf(r: RepoRow): string {
  try {
    const path = new URL(r.repoUrl).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return path.includes("/") ? path : r.name;
  } catch {
    return r.name;
  }
}

export function createRealRepoSettings(api: RepoSettingsApi) {
  // Le pagine vanno per id del repository, la PATCH per slug.
  const slugs = new Map<string, string>();
  const slugOf = (repositoryId: string) => {
    const slug = slugs.get(repositoryId);
    if (!slug) throw new Error("not_found");
    return slug;
  };

  return {
    async getRepositorySettings(projectId: string): Promise<RepositorySettings | null> {
      const [repos, canManage] = await Promise.all([api.list(projectId), api.canManage(projectId)]);
      return {
        canManage,
        repositories: repos.map((r) => {
          slugs.set(r.id, r.slug);
          const pipeline: NonNullable<Repository["releasePipeline"]> =
            r.releasePipeline.mode === "named"
              ? { mode: "named", names: r.releasePipeline.names ?? [] }
              : { mode: "auto" };
          return {
            id: r.id,
            name: r.name,
            fullName: fullNameOf(r),
            // Un valore che questa build non conosce: il più prudente (nessuna correzione).
            colleaguePrs: (PR_MODES.includes(r.colleaguePrs)
              ? r.colleaguePrs
              : "analyze_only") as ColleaguePrMode,
            // null = il ramo di default del repository.
            releaseBranch: r.releaseBranch ?? r.defaultBranch,
            releasePipeline: pipeline,
            ciProvider: (r.ciProvider && CI_PROVIDERS.includes(r.ciProvider)
              ? r.ciProvider
              : null) as (Repository["ciProvider"] & string) | null,
          };
        }),
      };
    },

    async setRepoPrMode(repositoryId: string, mode: ColleaguePrMode): Promise<void> {
      await inPrototypeWords(() => api.update(slugOf(repositoryId), { colleaguePrs: mode }));
    },

    async setReleasePipeline(
      repositoryId: string,
      pipeline: NonNullable<Repository["releasePipeline"]>,
      branch: string,
    ): Promise<void> {
      if (!branch.trim()) throw new Error("invalid: branch");
      const releasePipeline =
        pipeline.mode === "named"
          ? { mode: "named" as const, names: [...pipeline.names] }
          : { mode: "auto" as const };
      await inPrototypeWords(() =>
        api.update(slugOf(repositoryId), { releasePipeline, releaseBranch: branch.trim() }),
      );
    },
  };
}
