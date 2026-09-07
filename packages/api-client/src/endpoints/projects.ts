import {
  prReviewSummarySchema,
  projectBriefWeeklySchema,
  projectDecisionSchema,
  projectDetailSchema,
  projectListItemSchema,
  projectPulseSummarySchema,
} from "@stubwise/shared";
import type {
  DecisionDraft,
  DecisionPatch,
  DecisionSource,
  PrReviewSummary,
  ProjectBriefWeekly,
  ProjectDecision,
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
const briefsSchema = z.array(projectBriefWeeklySchema);
const decisionsSchema = z.array(projectDecisionSchema);

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
    reviews(
      projectId: string,
      options: { limit?: number } = {},
    ): Promise<Reader<PrReviewSummary>[]> {
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

    /**
     * I brief settimanali del progetto (fase 5), dal periodo più recente.
     *
     * A differenza della timeline questo schema PASSA da `readerSchema`: è un
     * oggetto piatto con un enum (`status`), non una `discriminatedUnion`, e
     * l'apertura dell'enum è esattamente ciò che serve a un'app installata
     * quando un domani si aggiungesse uno stato nuovo.
     */
    briefs(
      projectId: string,
      options: { limit?: number } = {},
    ): Promise<Reader<ProjectBriefWeekly>[]> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/briefs${toQuery({ limit: options.limit })}`,
        undefined,
        briefsSchema,
      );
    },

    /**
     * Rimette in coda il brief dell'ultima settimana chiusa (solo admin). A
     * generarlo è il poller del worker al tick successivo: questa risposta dice
     * che è ACCODATO, non che è pronto.
     *
     * `force` serve solo contro un brief già `done` (senza, il server risponde
     * 409 `brief_already_done`): rifare un testo già letto e già annunciato è
     * una decisione, non un click.
     */
    generateBrief(
      projectId: string,
      body: { force?: boolean } = {},
    ): Promise<Reader<ProjectBriefWeekly>> {
      return request(
        "POST",
        `/api/projects/${seg(projectId)}/briefs/generate`,
        body,
        projectBriefWeeklySchema,
      );
    },

    /**
     * UN brief per id. Sta fra gli endpoint `projects` perché il brief è di un
     * progetto, ma il PATH è di primo livello (`/api/briefs/:id`): il brief ha
     * un link proprio, che notifica, roadmap e tool MCP indirizzano per id.
     */
    brief(briefId: string): Promise<Reader<ProjectBriefWeekly>> {
      return request("GET", `/api/briefs/${seg(briefId)}`, undefined, projectBriefWeeklySchema);
    },

    /**
     * IL REGISTRO DECISIONI del progetto (fase 5), dalla più recente.
     *
     * `source` filtra per origine (`ask_user`, `plan_review`, `pulse`,
     * `manual`). Passa da `readerSchema` come tutto il resto: una sorgente
     * futura che questo client non conosce arriva come `UNKNOWN`, non fa
     * fallire il parse dell'intera lista.
     */
    decisions(
      projectId: string,
      options: { limit?: number; source?: DecisionSource } = {},
    ): Promise<Reader<ProjectDecision>[]> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/decisions${toQuery({
          limit: options.limit,
          source: options.source,
        })}`,
        undefined,
        decisionsSchema,
      );
    },

    /** Registra una decisione scritta a mano (chiunque veda il progetto). */
    createDecision(projectId: string, body: DecisionDraft): Promise<Reader<ProjectDecision>> {
      return request(
        "POST",
        `/api/projects/${seg(projectId)}/decisions`,
        body,
        projectDecisionSchema,
      );
    },

    /**
     * Corregge una decisione o la segna come superata (`supersededById`).
     * Solo l'autore o un maintainer; PATCH, quindi i campi assenti restano
     * invariati.
     */
    patchDecision(
      projectId: string,
      decisionId: string,
      body: DecisionPatch,
    ): Promise<Reader<ProjectDecision>> {
      return request(
        "PATCH",
        `/api/projects/${seg(projectId)}/decisions/${seg(decisionId)}`,
        body,
        projectDecisionSchema,
      );
    },
  };
}
