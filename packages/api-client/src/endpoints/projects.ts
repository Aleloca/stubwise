import {
  archivedProjectRowSchema,
  archivedProjectViewSchema,
  archivePreviewSchema,
  deletionPreviewSchema,
  memberPreviewSchema,
  projectMembersViewSchema,
  projectMemberSchema,
  milestoneWithCountsSchema,
  projectBriefWeeklySchema,
  projectDecisionSchema,
  projectDetailSchema,
  projectListItemSchema,
  projectPulseSummarySchema,
  projectSchema,
  chronologyPageSchema,
  ingestionKeyResultSchema,
  projectIntegrationSchema,
  projectPluginsViewSchema,
  weeklyBriefViewSchema,
} from "@stubwise/shared";
import type {
  ArchivedProjectRow,
  ArchivedProjectView,
  ArchivePreview,
  DeletionPreview,
  MemberPreview,
  ProjectMembersView,
  ProjectMember,
  PutProjectMemberInput,
  ChronologyPage,
  CreateProjectInput,
  DecisionDraft,
  DecisionPatch,
  DecisionSource,
  ProjectBriefWeekly,
  ProjectDecision,
  MilestoneWithCounts,
  ProjectDetail,
  ProjectListItem,
  ProjectPulseSummary,
  Project,
  Reader,
  UpdateProjectInput,
  WeeklyBriefView,
  IngestionKeyResult,
  ProjectIntegration,
  ProjectPlugin,
  ProjectPluginsView,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

const projectListSchema = z.array(projectListItemSchema);
const pulseSchema = z.array(projectPulseSummarySchema);
const briefsSchema = z.array(projectBriefWeeklySchema);
const decisionsSchema = z.array(projectDecisionSchema);
const milestonesSchema = z.array(milestoneWithCountsSchema);

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
    /**
     * Area 9, F4: la pausa della coda (chi gestisce il progetto). Solo la coda
     * di Stubwise: il lavoro nuovo aspetta, quello partito finisce. 409
     * `already_paused` / `not_paused`.
     */
    pauseQueue(projectId: string): Promise<void> {
      return request("POST", `/api/projects/${seg(projectId)}/queue/pause`);
    },
    resumeQueue(projectId: string): Promise<void> {
      return request("POST", `/api/projects/${seg(projectId)}/queue/resume`);
    },
    /**
     * Area 9, F6: cosa dice il dialogo prima di archiviare (le esecuzioni che
     * si annulleranno, le ragioni di `busy`). `project.settings.manage`.
     */
    archivePreview(projectId: string): Promise<Reader<ArchivePreview>> {
      return request("GET", `/api/projects/${seg(projectId)}/archive-preview`, undefined, archivePreviewSchema);
    },
    /**
     * Archivia. Rifiuti in `ApiError`: 409 `busy` (le ragioni nei `details`,
     * `archiveBusyErrorSchema`), 409 `already_archived`.
     */
    archive(projectId: string): Promise<void> {
      return request("POST", `/api/projects/${seg(projectId)}/archive`);
    },
    /** La scheda «Archived»: gli archiviati che chi guarda vede, dal più recente. */
    archived(): Promise<Reader<ArchivedProjectRow>[]> {
      return request("GET", "/api/projects/archived", undefined, z.array(archivedProjectRowSchema));
    },
    /** La pagina di un archiviato; 404 per chi non lo vede da archiviato o per un progetto aperto. */
    archivedView(projectId: string): Promise<Reader<ArchivedProjectView>> {
      return request("GET", `/api/projects/${seg(projectId)}/archived-view`, undefined, archivedProjectViewSchema);
    },
    /**
     * Cosa toglie Delete: i conteggi, i server che restano senza ambienti
     * (`SRV-<n>`), i repository che restano staccati. Solo un full admin
     * (403), solo un archiviato (409 `not_archived`).
     */
    deletionPreview(projectId: string): Promise<Reader<DeletionPreview>> {
      return request("GET", `/api/projects/${seg(projectId)}/deletion-preview`, undefined, deletionPreviewSchema);
    },
    /**
     * Elimina un archiviato: solo un full admin, con la riconferma e il
     * codice scritto esatto. Rifiuti: 400 `code_mismatch`, 409
     * `not_archived`, 403 `reauth_required` / `forbidden`.
     */
    delete(projectId: string, confirmCode: string): Promise<void> {
      return request("DELETE", `/api/projects/${seg(projectId)}`, { confirmCode });
    },
    /** Riapre un archiviato; 409 `not_archived` se non lo è. */
    reopen(projectId: string): Promise<void> {
      return request("POST", `/api/projects/${seg(projectId)}/reopen`);
    },
    /**
     * Area 9, F5: una chiave d'ingestione nuova (`project.settings.manage`,
     * riconferma: 403 `reauth_required`). La nuova si legge solo qui; la
     * vecchia smette subito.
     */
    regenerateIngestionKey(projectId: string): Promise<Reader<IngestionKeyResult>> {
      return request("POST", `/api/projects/${seg(projectId)}/ingestion-key`, undefined, ingestionKeyResultSchema);
    },
    /**
     * Area 9, F5 (I2): l'Integrazione in lettura — le ultime 4 della chiave
     * (mai intera), quando e da chi, il DSN senza chiave, l'URL in entrata, i
     * webhook git a chi vede i repository, i permessi calcolati dal server.
     */
    integration(projectId: string): Promise<Reader<ProjectIntegration>> {
      return request("GET", `/api/projects/${seg(projectId)}/integration`, undefined, projectIntegrationSchema);
    },
    /** Area 9, F5: le abilitazioni dei plugin, con la `version` da rimandare come `ifMatch`, e il registro. */
    plugins(projectId: string): Promise<Reader<ProjectPluginsView>> {
      return request("GET", `/api/projects/${seg(projectId)}/plugins`, undefined, projectPluginsViewSchema);
    },
    /**
     * L'insieme COMPLETO delle abilitazioni. Con `ifMatch` (la `version`
     * letta): se nel frattempo qualcuno ha salvato, 409 `stale` con la
     * versione e lo stato di adesso in `ApiError.details`
     * (`projectPluginsStaleSchema`), e niente è scritto.
     */
    setPlugins(projectId: string, plugins: ProjectPlugin[], ifMatch?: string | null): Promise<Reader<ProjectPluginsView>> {
      return request("PUT", `/api/projects/${seg(projectId)}/plugins`, { plugins, ...(ifMatch ? { ifMatch } : {}) }, projectPluginsViewSchema);
    },
    list(): Promise<Reader<ProjectListItem>[]> {
      return request("GET", "/api/projects", undefined, projectListSchema);
    },

    get(projectId: string): Promise<Reader<ProjectDetail>> {
      return request("GET", `/api/projects/${seg(projectId)}`, undefined, projectDetailSchema);
    },

    /**
     * Modifica le impostazioni di un progetto (23 set 2026, hub di progetto,
     * tappa 3). Solo con `project.settings.manage`: la rotta lo chiede, e un 403 arriva
     * come `ApiError` — chi chiama lo MOSTRA, non lo ingoia.
     *
     * ⚠️ È una PATCH e va usata come tale: il corpo porta SOLO i campi che
     * l'utente ha cambiato. Mandare l'oggetto intero farebbe sovrascrivere a
     * due persone, che salvano dalla stessa schermata aperta da prima, i
     * campi che nessuna delle due ha toccato. `updateProjectSchema` è già a
     * campi tutti opzionali — la forma che un client che si aggiorna dagli
     * store richiede: un campo nuovo del corpo non diventa mai obbligatorio.
     *
     * La risposta è il `Project` SENZA i repository (è quello che la rotta
     * restituisce): chi mostra il dettaglio lo rilegge invalidando la sua
     * chiave, invece di rattoppare la cache a mano.
     */
    /**
     * Crea un progetto (`projects.create`). Fetta 4: `code` (409 `code_taken`
     * se è già usato), `template` (gli stati del modello), `clientName` e
     * `modules`; senza, come prima.
     */
    create(body: CreateProjectInput): Promise<Reader<Project>> {
      return request("POST", "/api/projects", body, projectSchema);
    },

    patch(projectId: string, body: UpdateProjectInput): Promise<Reader<Project>> {
      return request("PATCH", `/api/projects/${seg(projectId)}`, body, projectSchema);
    },

    /**
     * Le milestone del progetto, già ordinate dal server: le APERTE per prime,
     * poi per scadenza (senza scadenza in fondo), poi per nome. È l'elenco
     * dietro il selettore "milestone" di un ticket.
     *
     * Sta nel gruppo dei progetti benché la rotta sia `/api/milestones`: una
     * milestone è sempre di UN progetto (il `projectId` è obbligatorio), e il
     * gruppo segue la cosa, non il path — come già `brief(briefId)`, che
     * chiama `/api/briefs/:id`.
     */
    milestones(projectId: string): Promise<Reader<MilestoneWithCounts>[]> {
      return request("GET", `/api/milestones${toQuery({ projectId })}`, undefined, milestonesSchema);
    },

    pulse(): Promise<Reader<ProjectPulseSummary>[]> {
      return request("GET", "/api/projects/pulse", undefined, pulseSchema);
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
     * UN brief per id. Sta fra gli endpoint `projects` perché il brief è di un
     * progetto, ma il PATH è di primo livello (`/api/briefs/:id`): il brief ha
     * un link proprio, che notifica, roadmap e tool MCP indirizzano per id.
     */
    /**
     * La cronologia dell'Overview (fetta 4), dalla più recente, a pagine di 28
     * giorni: senza `before` la prima (con i traguardi futuri), poi
     * `nextBefore` della pagina prima («Load older»).
     */
    chronology(projectId: string, before?: string): Promise<Reader<ChronologyPage>> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/chronology${toQuery({ before })}`,
        undefined,
        chronologyPageSchema,
      );
    },

    /** Il brief più recente pronto, come lo mostra l'Overview (testo generato); null se non ce n'è. */
    latestBrief(projectId: string): Promise<Reader<WeeklyBriefView> | null> {
      return request("GET", `/api/projects/${seg(projectId)}/briefs/latest`, undefined, weeklyBriefViewSchema.nullable());
    },

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

    /**
     * Area 9, F1: i membri espliciti coi permessi EFFETTIVI e la loro
     * provenienza (`permissions[].sources`); i full admin sono impliciti.
     */
    /**
     * I membri del progetto. Con `include: "workspace"` (M4, additivo) anche
     * chi lo vede SOLO per la sua workspace (`explicit: false`, col ruolo di
     * workspace): quelli non si tolgono dal progetto, si tolgono dalla workspace.
     */
    members(projectId: string, options: { include?: "workspace" } = {}): Promise<Reader<ProjectMember>[]> {
      const query = options.include ? `?include=${options.include}` : "";
      return request("GET", `/api/projects/${seg(projectId)}/members${query}`, undefined, z.array(projectMemberSchema));
    },

    /**
     * Aggiunge o cambia un membro (riconferma). `permissions` sono i
     * personali e, se mandato, SOSTITUISCE l'insieme; assente li lascia.
     * Errori: 403 `escalation`, 409 `last_manager`, 422 `unknown_permission`.
     */
    putMember(projectId: string, userId: string, body: PutProjectMemberInput): Promise<Reader<ProjectMember>> {
      return request("PUT", `/api/projects/${seg(projectId)}/members/${seg(userId)}`, body, projectMemberSchema);
    },

    /** Toglie un membro (riconferma): 204. 409 `last_manager`. */
    removeMember(projectId: string, userId: string): Promise<void> {
      return request("DELETE", `/api/projects/${seg(projectId)}/members/${seg(userId)}`);
    },

    /** Area 9, F1 (R8): la vista di gestione dei membri, coi campi calcolati. */
    membersView(projectId: string): Promise<Reader<ProjectMembersView>> {
      return request("GET", `/api/projects/${seg(projectId)}/members/view`, undefined, projectMembersViewSchema);
    },

    /** Il giudizio di una bozza del pannello del membro, lo stesso del salvataggio. */
    previewMember(projectId: string, userId: string, draft: { roleId: string; granted: string[] }): Promise<Reader<MemberPreview>> {
      return request("POST", `/api/projects/${seg(projectId)}/members/${seg(userId)}/preview`, draft, memberPreviewSchema);
    },
  };
}
