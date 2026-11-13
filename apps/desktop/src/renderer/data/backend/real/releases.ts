import type { ReleaseDetail, ReleaseRow, ReleaseStatus } from "@stubwise/shared";
import type { FixResult, ReleaseView } from "../../releases";
import { inPrototypeWords, orNull } from "./automationRefs";

// I rilasci della build app (area 8, F1) sopra le rotte vere, con le firme
// del prototipo (`data/releases/reads.ts`, `writes.ts`). Lo stato DERIVATO e
// i permessi li calcola il server (il client li legge, non li deduce). I
// campi che un server di prima non manda hanno il default PRUDENTE: nessun
// bottone, nessun punto nella colonna, una task di riparazione esistente
// conta come aperta. Il log delle run non c'è nell'app (P-1 = a): solo il
// link al provider.

/** I campi che le pagine leggono e che il server aggiunge in S5/S7 (facoltativi). */
interface RowExtras {
  fixTask: { id: string; code: string; title?: string; open?: boolean } | null;
  permissions?: { fix?: boolean; startFix?: boolean };
  waitsOnViewer?: boolean;
}
interface DetailExtras extends RowExtras {
  relatedTaskCode?: string | null;
  fixBlock?: { reason: "monthly_budget" } | null;
  productionServer?: { serverCode: string; reportedSha: string | null } | null;
}

/** Le rotte (sul client vero: `client.releases`, S12). */
export interface ReleasesApi {
  list(projectId: string): Promise<{ items: ReleaseRow[] }>;
  get(code: string): Promise<ReleaseDetail>;
  fix(
    code: string,
    body: { note?: string },
  ): Promise<{ taskId: string; taskCode: string; existing?: boolean; noteAdded?: boolean }>;
}

function viewOf(
  r: (ReleaseRow & RowExtras) | (ReleaseDetail & DetailExtras),
  projectCode: string,
): ReleaseView {
  const d = "runs" in r ? (r as ReleaseDetail & DetailExtras) : null;
  const runs = (d?.runs ?? []).map((x) => ({
    id: x.id,
    name: x.name,
    status: x.status,
    url: x.url ?? "",
    failedStep: x.failedStep,
    log: null,
    logHidden: false,
    startedAt: x.startedAt ?? r.mergedAt,
    endedAt: x.endedAt,
  }));
  const failed = runs.find((x) => x.status === "failed");
  return {
    id: r.id,
    code: r.code,
    projectId: r.projectId,
    repositoryId: r.repositoryId,
    pr: { repo: r.repositoryName, number: r.prNumber ?? 0 },
    title: r.title,
    mergeSha: r.mergeSha,
    mergedAt: r.mergedAt,
    mergedById: r.mergedById,
    mergedGitName: r.mergedGitName ?? "",
    viaStubwise: r.viaStubwise,
    runs,
    seenInProductionAt: d?.seenInProductionAt ?? null,
    fixTaskId: r.fixTask?.id ?? null,
    releaseNotes: d?.releaseNotes ?? null,
    projectCode,
    status: r.status as ReleaseStatus,
    fixTask: r.fixTask
      ? {
          id: r.fixTask.id,
          code: r.fixTask.code,
          title: r.fixTask.title ?? r.fixTask.code,
          open: r.fixTask.open ?? true,
        }
      : null,
    fixPreview: {
      step: failed?.failedStep ?? null,
      relatedTaskCode: d?.relatedTaskCode ?? null,
      logLines: false,
    },
    canFix: r.permissions?.fix ?? false,
    canStartFix: r.permissions?.startFix ?? false,
    fixBlock: d?.fixBlock ?? null,
    waitsOnViewer: r.waitsOnViewer ?? false,
    productionServer: d?.productionServer ?? null,
  };
}

export function createRealReleases(
  api: ReleasesApi,
  /** Il codice di un progetto (`AUD`) dal suo id, per i link delle pagine. */
  projectCodeOf: (projectId: string) => Promise<string>,
) {
  return {
    async listReleases(projectId: string): Promise<ReleaseView[]> {
      // Un progetto invisibile (404) non ha rilasci, come nel prototipo.
      const page = await orNull(() => api.list(projectId));
      if (!page) return [];
      const code = await projectCodeOf(projectId);
      return page.items.map((r) => viewOf(r, code));
    },

    async getRelease(code: string): Promise<ReleaseView | null> {
      const d = await orNull(() => api.get(code));
      return d ? viewOf(d, await projectCodeOf(d.projectId)) : null;
    },

    /** «Fai sistemare a Claude»: le pagine leggono codice ed esito (`existing`, `noteAdded`). */
    async fixRelease(code: string, note?: string): Promise<FixResult> {
      const res = await inPrototypeWords(() =>
        api.fix(code, note?.trim() ? { note: note.trim() } : {}),
      );
      return {
        id: res.taskId,
        code: res.taskCode,
        existing: res.existing ?? false,
        noteAdded: res.noteAdded ?? false,
      } as FixResult;
    },
  };
}
