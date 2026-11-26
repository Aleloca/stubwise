import { ApiError } from "@stubwise/api-client";
import { archiveBusyErrorSchema, archivePreviewSchema, readerSchema } from "@stubwise/shared";
import type {
  ArchivedProjectRow,
  ArchivedProjectView,
  DeletionCounts,
  PublicSurfaces,
} from "../../projectSettings/archive";
import type { BusyReason, ProjectResult } from "../../projectSettings/types";
import { appClient } from "./client";

// Area 9, F6: archiviare e riaprire un progetto (72, Task 3, 2d4cff4c9).
// `GET …/archive-preview` dice le esecuzioni aperte che si annulleranno e
// perché non si archivia adesso (solo il lavoro in esecuzione, L-5 = a);
// `POST …/archive` e `POST …/reopen` rispondono 204. Gli errori del server
// sono piatti (`{code, message}`): il 409 `busy` porta `reasons` nel body,
// che `ApiError.details` conserva.

/** Le rotte (sul client vero: `client.projects`). */
export interface ProjectArchiveApi {
  preview(projectId: string): Promise<unknown>;
  archive(projectId: string): Promise<void>;
  reopen(projectId: string): Promise<void>;
  archived(): Promise<unknown[]>;
  archivedView(projectId: string): Promise<unknown>;
  deletionPreview(projectId: string): Promise<unknown>;
  remove(projectId: string, confirmCode: string): Promise<void>;
}

const previewReader = readerSchema(archivePreviewSchema);
const busyReader = readerSchema(archiveBusyErrorSchema);

/** Lavoro che chi guarda non vede: un tipo ignoto, o un `busy` senza ragioni leggibili. */
const BLIND: BusyReason = { kind: "claude_session", code: null, title: null, waiting: false };

type ServerReason = {
  kind: string;
  code: string | null;
  title: string | null;
  waiting: boolean;
  repository: string | null;
  paused: boolean;
};

/**
 * Dalla forma piatta del server all'unione del renderer. Un tipo che questo
 * client non conosce non sparisce (il server non archivierebbe comunque):
 * si dice come lavoro che non vedi.
 */
function reasonOf(r: ServerReason): BusyReason {
  if (r.kind === "release") return { kind: "release", code: r.code ?? "" };
  if (r.kind === "doc_generation")
    return { kind: "doc_generation", repository: r.repository ?? "", paused: r.paused };
  if (r.kind === "claude_session")
    return { kind: "claude_session", code: r.code, title: r.title, waiting: r.waiting };
  return { ...BLIND };
}

/** 404 e 403 come ogni lettura del progetto; il resto si propaga. */
function common(error: unknown): ProjectResult | null {
  if (error instanceof ApiError && error.status === 404) return { ok: false, error: "not_found" };
  if (error instanceof ApiError && error.status === 403) return { ok: false, error: "forbidden" };
  return null;
}

export function createRealProjectArchive(api: ProjectArchiveApi) {
  return {
    async getArchivePreview(projectId: string): Promise<
      ProjectResult<{
        openAutomationRuns: number;
        busy: BusyReason[];
        publicSurfaces: PublicSurfaces;
      }>
    > {
      try {
        const v = previewReader.parse(await api.preview(projectId));
        return {
          ok: true,
          openAutomationRuns: v.openAutomationRuns,
          busy: v.busy.map((r) => reasonOf(r as ServerReason)),
          // Da un server più vecchio tutto false (`publicSurfacesSchema`, i default).
          publicSurfaces: { ...v.publicSurfaces },
        };
      } catch (error) {
        const refused = common(error);
        if (refused) return refused as ProjectResult<never>;
        throw error;
      }
    },

    async archiveProject(projectId: string): Promise<ProjectResult> {
      try {
        await api.archive(projectId);
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          if (error.code === "busy") {
            const body = busyReader.safeParse(error.details);
            const reasons = body.success ? body.data.reasons : [];
            // Un corpo che non si legge (o senza ragioni) non è «niente da
            // aspettare»: una ragione cieca, come un tipo ignoto (review F6, M4).
            return {
              ok: false,
              error: "busy",
              reasons: reasons.length
                ? reasons.map((r) => reasonOf(r as ServerReason))
                : [{ ...BLIND }],
            };
          }
          if (error.code === "already_archived")
            return { ok: false, error: "invalid", reason: "already_archived" };
        }
        const refused = common(error);
        if (refused) return refused;
        throw error;
      }
    },

    /** La scheda «Archived»: le righe come le calcola il server (`canReopen`, `canDelete` compresi). */
    async listArchivedProjects(): Promise<ArchivedProjectRow[]> {
      return (await api.archived()) as ArchivedProjectRow[];
    },

    /**
     * La pagina dell'archiviato (`/archived/<CODE>`): il server la dà per id,
     * il codice si cerca fra gli archiviati che chi guarda vede. `null` per
     * un codice che non c'è o un 404 (riaperto nel frattempo, o estraneo).
     */
    async getArchivedProject(code: string): Promise<ArchivedProjectView | null> {
      const row = ((await api.archived()) as ArchivedProjectRow[]).find((r) => r.code === code);
      if (!row) return null;
      try {
        return (await api.archivedView(row.projectId)) as ArchivedProjectView;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },

    /** Cosa toglie Delete e cosa resta senza progetto (Task 5 di 72): solo il full admin, solo su un archiviato. */
    async getDeletionPreview(projectId: string): Promise<
      ProjectResult<{
        counts: DeletionCounts;
        orphanServers: string[];
        detachedRepositories: string[];
      }>
    > {
      try {
        const v = (await api.deletionPreview(projectId)) as {
          counts: DeletionCounts;
          orphanServers: string[];
          detachedRepositories: string[];
        };
        return {
          ok: true,
          counts: v.counts,
          orphanServers: v.orphanServers,
          detachedRepositories: v.detachedRepositories,
        };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.code === "not_archived")
          return { ok: false, error: "invalid", reason: "not_archived" };
        const refused = common(error);
        if (refused) return refused as ProjectResult<never>;
        throw error;
      }
    },

    /**
     * Elimina per sempre (+R): il codice scritto va al server, che lo
     * confronta esatto (`code_mismatch`). `reauth_required` lo chiede la
     * pagina con la riconferma; `second_factor_setup_required` resta un
     * `forbidden`, come in F5.
     */
    async deleteProject(projectId: string, input: { confirmCode: string }): Promise<ProjectResult> {
      try {
        await api.remove(projectId, input.confirmCode);
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === "code_mismatch")
            return { ok: false, error: "invalid", reason: "code_mismatch" };
          if (error.status === 409 && error.code === "not_archived")
            return { ok: false, error: "invalid", reason: "not_archived" };
          if (error.code === "reauth_required") return { ok: false, error: "reauth_required" };
        }
        const refused = common(error);
        if (refused) return refused;
        throw error;
      }
    },

    async reopenProject(projectId: string): Promise<ProjectResult> {
      try {
        await api.reopen(projectId);
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.code === "not_archived")
          return { ok: false, error: "invalid", reason: "not_archived" };
        const refused = common(error);
        if (refused) return refused;
        throw error;
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: ProjectArchiveApi = {
  preview: (projectId) => appClient().projects.archivePreview(projectId),
  archive: (projectId) => appClient().projects.archive(projectId),
  reopen: (projectId) => appClient().projects.reopen(projectId),
  archived: () => appClient().projects.archived(),
  archivedView: (projectId) => appClient().projects.archivedView(projectId),
  deletionPreview: (projectId) => appClient().projects.deletionPreview(projectId),
  remove: (projectId, confirmCode) => appClient().projects.delete(projectId, confirmCode),
};

export const liveProjectArchive = createRealProjectArchive(liveApi);
