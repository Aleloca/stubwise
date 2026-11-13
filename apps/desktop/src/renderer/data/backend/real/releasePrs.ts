import { ApiError } from "@stubwise/api-client";
import type {
  MyReleases as ServerMyReleases,
  OpenPrState,
  OpenPull,
  PrReleaseNotes,
  ReleaseQueueItem,
  ReleaseRow,
} from "@stubwise/shared";
import type { PrAutoCorrection } from "../../model";
import type {
  CorrectionRequestResult,
  MergeError,
  MyReleases,
  MergeResult,
  OpenPrView,
  QueueItem,
  ReleaseView,
} from "../../releases";
import { asPrototypeError, orNull } from "./automationRefs";

// Le PR aperte della build app (area 8, F1, `releases-prs`) sopra le rotte
// vere, con le firme del prototipo (`data/releases/reads.ts`, `writes.ts`).
// Stato (`prStateOf`), prontezza (`isReadyForRelease`) e permessi li
// calcola il server: il client li legge, non li deduce. Ciò che il server non
// legge non si inventa: niente rischio per una PR esterna, niente autore
// esterno, `mergeable` non letto (`null`, mai «conflitti»).

/** Le rotte (sul client vero: `client.releases` e `client.tickets`, S12). */
export interface PrsApi {
  pulls(projectId: string): Promise<{ items: OpenPull[] }>;
  /** La coda di rilascio di chi ha `release.merge` (403 o vuota per gli altri). */
  queue(): Promise<{ items: ReleaseQueueItem[] }>;
  merge(
    ticketId: string,
    repositoryId: string,
  ): Promise<{ merged: true; sha: string; releaseCode?: string | null }>;
  requestCorrection(
    ticketId: string,
    repositoryId: string,
    body: { note?: string },
  ): Promise<{ correctionId: string }>;
  /** La Home «Rilasci» (`GET /api/me/releases`). */
  myReleases(): Promise<ServerMyReleases>;
  releaseNotes(repositoryId: string, prNumber: number): Promise<PrReleaseNotes>;
  putReleaseNotes(repositoryId: string, prNumber: number, body: string): Promise<PrReleaseNotes>;
  analysisOnly(
    repositoryId: string,
    prNumber: number,
    on: boolean,
  ): Promise<{ analysisOnly: { byId: string | null; at: string } | null }>;
}

const CHECKS: Record<string, OpenPrView["checks"]> = {
  success: "passing",
  // Nessun controllo configurato: niente che fallisca (la regola della coda).
  no_checks: "passing",
  failure: "failing",
  pending: "pending",
};

const ANALYZING: OpenPrState = { state: "analyzing", autoRound: 0, canAutoCorrect: false };

const MERGE_ERRORS: ReadonlySet<string> = new Set<MergeError>([
  "forbidden",
  "not_found",
  "already_closed",
  "checks_failed",
  "checks_unreadable",
  "not_mergeable",
  "merge_forbidden",
  "merge_failed",
]);

const CORRECTION_ERRORS: Record<string, Exclude<CorrectionRequestResult, { ok: true }>["error"]> = {
  correction_in_flight: "in_flight",
  job_in_flight: "in_flight",
  pr_not_open: "already_closed",
  colleague_analysis_only: "analysis_only",
  needs_maintainer: "needs_maintainer",
  not_fixable: "not_fixable",
  monthly_budget: "monthly_budget",
  // Review F1, I2: una PR di un collega, ognuno con le sue parole.
  pr_not_found: "pr_not_found",
  adopted_pr_admin_only: "adopted_pr_admin_only",
  not_stubwise_pr: "not_stubwise_pr",
  adopted_branch_protected: "adopted_branch_protected",
};

interface PrRef {
  projectId: string;
  ticketId: string;
  repositoryId: string;
  prNumber: number;
}

export function createRealPrs(
  api: PrsApi,
  projectCodeOf: (projectId: string) => Promise<string>,
  /** Il rilascio nato dal merge, per il suo codice (`getRelease` dei rilasci). */
  releaseByCode: (code: string) => Promise<ReleaseView | null>,
  /** Una riga di rilascio nella forma del prototipo (`fromRow` dei rilasci). */
  releaseFromRow: (row: ReleaseRow) => Promise<ReleaseView> = async () => {
    throw new Error("not_found");
  },
) {
  // Le pagine vanno per id della PR; le rotte per ticket, repository e numero.
  const refs = new Map<string, PrRef>();

  function viewOf(
    projectId: string,
    projectCode: string,
    p: OpenPull & { releaseNotes?: string | null },
  ): OpenPrView {
    const prNumber = p.prNumber ?? 0;
    const id = `${p.repositoryId}#${prNumber}`;
    refs.set(id, { projectId, ticketId: p.ticketId, repositoryId: p.repositoryId, prNumber });
    const stubwise = p.origin === "stubwise";
    const headSha = p.headSha ?? "";
    return {
      id,
      projectId,
      repositoryId: p.repositoryId,
      repo: p.repositoryFullName ?? p.repositoryName,
      // L'indirizzo vero (GitHub o Bitbucket): i link non lo costruiscono.
      url: p.prUrl,
      number: prNumber,
      title: p.ticketTitle,
      // Le PR di Stubwise le scrive Claude; per un'esterna il server non ha l'autore.
      authorId: null,
      authorName: stubwise ? "Claude" : "",
      origin: stubwise ? "stubwise" : "colleague",
      taskId: stubwise ? p.ticketId : null,
      branch: p.branch,
      baseBranch: p.baseBranch ?? "",
      headSha,
      fromFork: p.fromFork ?? false,
      branchProtected: false,
      analysisOnly: p.analysisOnly
        ? { byId: p.analysisOnly.byId ?? "", at: p.analysisOnly.at }
        : null,
      analysis:
        p.analysis.verdict === null
          ? null
          : {
              // Una review su un'altra testa: l'analisi è vecchia (R-K9).
              sha: p.analysis.stale ? "" : headSha,
              status: "done",
              summary: p.analysis.summary ?? "",
              risk: null,
              issues: p.issues ?? [],
              at: p.createdAt,
            },
      // La storia dal server, dalla più vecchia (senza le annullate); assente
      // da un server di prima: nessuna riga, mai righe ricostruite da un conteggio.
      corrections: (p.correctionHistory ?? []).map(
        (c): PrAutoCorrection => ({
          id: c.id,
          trigger: c.trigger,
          byId: c.byId,
          fromSha: "",
          state: c.state,
          commitSha: c.commitSha,
          why: c.why ?? "",
          at: c.at,
        }),
      ),
      checks: CHECKS[p.checks.status] ?? "unreadable",
      mergeable: p.mergeable ?? null,
      state: "open",
      openedAt: p.createdAt,
      prState: p.prState ?? ANALYZING,
      cap: p.cap,
      taskCode: stubwise ? `${projectCode}-${p.ticketNumber}` : null,
      actions: {
        analysisOnly: p.permissions.analysisOnly,
        requestCorrection: p.permissions.requestCorrection,
      },
      canEditReleaseNotes: p.permissions.editReleaseNotes,
      onStaging: p.onStaging ?? false,
      ...(p.prState?.state === "analysis_off"
        ? {
            analysisOff:
              !stubwise && p.colleaguePrs === "off"
                ? ("repository" as const)
                : ("instance" as const),
          }
        : {}),
      // Le note scritte da una persona (una bozza di Claude non arriva mai qui da sola).
      releaseNotes: p.releaseNotes ?? null,
    };
  }

  async function list(projectId: string): Promise<{ view: OpenPrView; ready: boolean }[]> {
    const page = await orNull(() => api.pulls(projectId));
    if (!page) return [];
    const code = await projectCodeOf(projectId);
    return page.items.map((p) => ({ view: viewOf(projectId, code, p), ready: p.ready ?? false }));
  }

  const ref = (prId: string): PrRef => {
    const r = refs.get(prId);
    if (!r) throw new Error("not_found");
    return r;
  };

  return {
    /**
     * La Home «Rilasci»: i rilasci falliti che mi riguardano e le PR pronte
     * dei progetti dove ho `release.merge` (quindi `canMerge`). Una PR senza
     * `projectId` (un server di prima) si salta: senza progetto non ha link.
     */
    async listMyReleases(): Promise<MyReleases> {
      const mine = await orNull(() => api.myReleases());
      if (!mine) return { failed: [], ready: [] };
      const failed = await Promise.all(mine.failed.map((row) => releaseFromRow(row)));
      const ready: QueueItem[] = [];
      for (const p of mine.ready as (OpenPull & { projectId?: string })[]) {
        if (!p.projectId) continue;
        const view = viewOf(p.projectId, p.projectCode ?? (await projectCodeOf(p.projectId)), p);
        ready.push({ ...view, canMerge: true });
      }
      return { failed, ready };
    },

    async listOpenPrs(projectId: string): Promise<OpenPrView[]> {
      return (await list(projectId)).map((p) => p.view);
    },

    /** Le pronte per il server (`ready`); `canMerge` = la PR è nella coda di chi guarda. */
    async listReleaseQueue(projectId: string): Promise<QueueItem[]> {
      const prs = await list(projectId);
      let queue: ReleaseQueueItem[] = [];
      try {
        queue = (await api.queue()).items;
      } catch (error) {
        if (!(error instanceof ApiError && (error.status === 403 || error.status === 404)))
          throw error;
      }
      const mergeable = new Set(queue.map((q) => `${q.repositoryId}#${q.prNumber ?? 0}`));
      return prs
        .filter((p) => p.ready)
        .map(({ view }) => ({ ...view, canMerge: mergeable.has(view.id) }));
    },

    async mergePr(prId: string): Promise<MergeResult> {
      const r = ref(prId);
      try {
        const res = await api.merge(r.ticketId, r.repositoryId);
        return { ok: true, release: res.releaseCode ? await releaseByCode(res.releaseCode) : null };
      } catch (error) {
        const code = error instanceof ApiError ? error.code : undefined;
        if (error instanceof ApiError && error.status === 403)
          return { ok: false, error: "forbidden" };
        if (error instanceof ApiError && error.status === 404)
          return { ok: false, error: "not_found" };
        if (code && MERGE_ERRORS.has(code)) return { ok: false, error: code as MergeError };
        throw asPrototypeError(error);
      }
    },

    async requestPrCorrection(prId: string, text: string): Promise<CorrectionRequestResult> {
      const r = ref(prId);
      try {
        await api.requestCorrection(
          r.ticketId,
          r.repositoryId,
          text.trim() ? { note: text.trim() } : {},
        );
        // La correzione la segue la sessione della task; la riga la rilegge l'elenco.
        return { ok: true, correction: null, sessionId: null };
      } catch (error) {
        const mapped =
          error instanceof ApiError && error.code ? CORRECTION_ERRORS[error.code] : undefined;
        if (mapped) return { ok: false, error: mapped };
        throw asPrototypeError(error);
      }
    },

    /** Le note della PR (vuote = nessuna nota): `release.merge` o `tickets.edit`, lo controlla il server. */
    async setPrReleaseNotes(prId: string, text: string): Promise<OpenPrView> {
      const r = ref(prId);
      try {
        await api.putReleaseNotes(r.repositoryId, r.prNumber, text);
      } catch (error) {
        throw asPrototypeError(error);
      }
      const fresh = (await list(r.projectId)).find((p) => p.view.id === prId);
      if (!fresh) throw new Error("not_found");
      return fresh.view;
    },

    /** La bozza calcolata dal server (`releaseNotesDraft` di shared); `null` per chi non può scriverle. */
    async releaseNotesDraft(prId: string): Promise<{ text: string; sources: string[] } | null> {
      const r = refs.get(prId);
      if (!r) return null;
      const notes = await orNull(() => api.releaseNotes(r.repositoryId, r.prNumber));
      return notes?.canEdit ? notes.draft : null;
    },

    async setPrAnalysisOnly(prId: string, on: boolean): Promise<OpenPrView> {
      const r = ref(prId);
      try {
        await api.analysisOnly(r.repositoryId, r.prNumber, on);
      } catch (error) {
        throw asPrototypeError(error);
      }
      const fresh = (await list(r.projectId)).find((p) => p.view.id === prId);
      if (!fresh) throw new Error("not_found");
      return fresh.view;
    },
  };
}
