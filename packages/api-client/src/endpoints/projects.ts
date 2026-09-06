import {
  prReviewSummarySchema,
  projectDetailSchema,
  projectListItemSchema,
  projectPulseSummarySchema,
} from "@stubwise/shared";
import type {
  PrReviewSummary,
  ProjectDetail,
  ProjectListItem,
  ProjectPulseSummary,
  ProjectTimeline,
  ProjectTimelineKind,
  Reader,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

const projectListSchema = z.array(projectListItemSchema);
const pulseSchema = z.array(projectPulseSummarySchema);
const reviewsSchema = z.array(prReviewSummarySchema);

/**
 * Progetti visibili all'utente corrente.
 *
 * `pulse` (fase 4, mobile) è il "polso" per progetto — chi aspetta una
 * decisione, chi ha lavoro in corso, da quanto un progetto è fermo — nato dagli
 * stessi segnali del pulse proattivo (fase 2), letti qui sincronamente. Ordine
 * già deciso dal server (`GET /api/projects/pulse`): prima chi ha
 * `waitingForYou`, poi chi ha `running`, infine per `idleDays` decrescente.
 */
export function createProjectsEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<ProjectListItem>[]> {
      return request("GET", "/api/projects", undefined, projectListSchema);
    },

    get(projectId: string): Promise<Reader<ProjectDetail>> {
      return request("GET", `/api/projects/${seg(projectId)}`, undefined, projectDetailSchema);
    },

    pulse(): Promise<Reader<ProjectPulseSummary>[]> {
      return request("GET", "/api/projects/pulse", undefined, pulseSchema);
    },

    /** Le review AI di PR del progetto, dalla più recente (fase 5). */
    reviews(projectId: string, options: { limit?: number } = {}): Promise<Reader<PrReviewSummary>[]> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/reviews${toQuery({ limit: options.limit })}`,
        undefined,
        reviewsSchema,
      );
    },

    /**
     * La timeline di progetto (fase 5) che alimenta la pagina Roadmap.
     *
     * ⚠️ CORSIA SENZA SCHEMA, di proposito. `projectTimelineEntrySchema` è una
     * `discriminatedUnion`, e `readerSchema` non la attraversa: aprire il
     * discriminante farebbe vincere sempre la prima variante e una voce `brief`
     * verrebbe letta come `ticket_opened` perdendo i suoi campi (vedi il
     * commento sulle union in `packages/shared/src/reader.ts`). Non è una
     * lacuna da colmare in fretta: la vista roadmap mobile è esplicitamente
     * fuori dalla v1 della fase, e il solo consumatore è la SPA — che si
     * ridistribuisce a ogni deploy insieme al server. Chi porterà la roadmap
     * sull'app dovrà PRIMA progettare l'apertura del discriminante
     * (`z.union([rigido, variante_di_fallback])`), non limitarsi a passare lo
     * schema qui.
     */
    timeline(
      projectId: string,
      params: { from?: string; to?: string; kinds?: ProjectTimelineKind[] } = {},
    ): Promise<ProjectTimeline> {
      const query = toQuery({
        from: params.from,
        to: params.to,
        kinds: params.kinds?.join(","),
      });
      return request("GET", `/api/projects/${seg(projectId)}/timeline${query}`);
    },
  };
}
