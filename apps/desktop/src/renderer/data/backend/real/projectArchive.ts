import { ApiError } from "@stubwise/api-client";
import { archiveBusyErrorSchema, archivePreviewSchema, readerSchema } from "@stubwise/shared";
import type { ArchivedProjectRow, ArchivedProjectView } from "../../projectSettings/archive";
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
}

const previewReader = readerSchema(archivePreviewSchema);
const busyReader = readerSchema(archiveBusyErrorSchema);

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
  return { kind: "claude_session", code: null, title: null, waiting: false };
}

/** 404 e 403 come ogni lettura del progetto; il resto si propaga. */
function common(error: unknown): ProjectResult | null {
  if (error instanceof ApiError && error.status === 404) return { ok: false, error: "not_found" };
  if (error instanceof ApiError && error.status === 403) return { ok: false, error: "forbidden" };
  return null;
}

export function createRealProjectArchive(api: ProjectArchiveApi) {
  return {
    async getArchivePreview(
      projectId: string,
    ): Promise<ProjectResult<{ openAutomationRuns: number; busy: BusyReason[] }>> {
      try {
        const v = previewReader.parse(await api.preview(projectId));
        return {
          ok: true,
          openAutomationRuns: v.openAutomationRuns,
          busy: v.busy.map((r) => reasonOf(r as ServerReason)),
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
            return {
              ok: false,
              error: "busy",
              reasons: reasons.map((r) => reasonOf(r as ServerReason)),
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
};

export const liveProjectArchive = createRealProjectArchive(liveApi);
