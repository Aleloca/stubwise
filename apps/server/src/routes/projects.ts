import { ArchiveError, deleteArchivedProject } from "../services/project-archive.js";
import { projectPulses } from "../services/project-pulses.js";
import { toPublicMilestone } from "./milestones.js";
import { projectPulsesQuerySchema, projectPulsesResponseSchema } from "@stubwise/shared";
import { orderedModules, patchProject } from "../services/project-patch.js";
import {
  createProjectSchema,
  decisionDraftSchema,
  decisionPatchSchema,
  decisionSourceSchema,
  projectDecisionSchema,
  projectDetailSchema,
  projectListItemSchema,
  projectPulseSummarySchema,
  projectSchema,
  projectBriefWeeklySchema,
  updateProjectSchema,
  compareProjectNames,
  needsViewer,
  TEMPLATE_MODULES,
  TEMPLATE_STATUSES,
  deleteProjectSchema,
} from "@stubwise/shared";
import { summarizeProject, userIdsWithPermission, type ProjectPulseSummary } from "@stubwise/notifications";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  inProjects,
  projectPermissionsFor,
  routePermissions,
  scopeProjectIds,
  visibleProjectIds,
  type RouteAccess,
  inProjectsStrict,
} from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import type { ProjectPermission } from "@stubwise/shared";
import {
  aiProviders,
  projectEnvironments,
  projectAccess,
  projectAccessRowCounts,
  projectMembers,
  projectStatuses,
  projects,
  repositories,
  users,
  roles,
  type Db,
} from "@stubwise/db";
import { leadRoleId } from "../services/roles.js";
import { legacyStatusesFor } from "./project-statuses.js";
import {
  authErrorResponses,
  errorSchema,
  generateIngestionKey,
  isUniqueViolation,
  uniqueViolationConstraint,
} from "./shared.js";
import { apiError } from "../errors.js";
import { deleteStoredObjects, storageKeysOfProject } from "../chat/attachments.js";
import { listProjectBriefs } from "../services/project-briefs.js";
import {
  createManualDecision,
  listProjectDecisions,
  patchDecision,
} from "../services/project-decisions.js";
import { recordChange } from "../services/change-log.js";
import { memberObject } from "../services/roles.js";

/**
 * Tentativi massimi di insert prima di arrendersi sulla generazione dello
 * slug del progetto. In pratica non si raggiunge mai: serve solo a trasformare
 * un bug in un errore esplicito invece che in un loop infinito.
 */
const MAX_SLUG_ATTEMPTS = 100;

const idParamsSchema = z.object({ projectId: z.uuid() });

/**
 * Accesso di una rotta sul progetto del path (`:projectId`): `"member"` = basta
 * vederlo (esserne membri, o full admin). Un progetto che non si vede risponde
 * 404 `not_found` come uno che non esiste (hook globale, `auth/access.ts`).
 */
function onProject(permission: ProjectPermission | "member"): RouteAccess {
  return { kind: "project", permission, project: fromParam("projectId") };
}

/**
 * Slug URL-safe dal nome: minuscole, accenti scomposti e rimossi, tutto il
 * resto collassato in trattini. Fallback fisso se non resta nulla.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "progetto";
}

/**
 * Ordinamento di `GET /api/projects/pulse` (riscritto il 28 set 2026, «i
 * progetti in ordine alfabetico, ovunque»): DUE GRUPPI, ognuno alfabetico.
 * Prima i progetti dove qualcosa aspetta CHI GUARDA — una decisione, o una PR
 * che può mergiare lui (`needsViewer` di `@stubwise/shared`) — poi tutti gli
 * altri; dentro ciascun gruppo `compareProjectNames`.
 *
 * ⚠️ **La posizione ora dice UNA cosa sola: «aspetta te, sì o no».** Fino al
 * 27 set era una scala a cinque livelli allineata alla riga del polso
 * (decisioni → PR da mergiare → lavoro in corso → PR d'altri → giorni fermo
 * → ticket fermi), e l'elenco cambiava ordine a ogni job che partiva: il
 * maintainer cercava i progetti «a occhio» e non li trovava mai nello stesso
 * posto. Per sua decisione tutto il resto lo dice la RIGA sotto il nome
 * (`pulse-line.ts`, web e app), non l'ordine. Chi reintroduce un livello «per
 * urgenza» riporta l'elenco che si rimescola da solo.
 *
 * `needsViewer` è la STESSA funzione con cui i client disegnano il confine
 * fra «Needs you» e «All projects»: l'ordine del server e le intestazioni del
 * client non possono dire due cose diverse. E `canMerge` è già calcolato qui
 * col ruolo del viewer — il divieto dell'operatore vale anche per l'ordine.
 *
 * SORT applicativo e non un `ORDER BY`: i riepiloghi vengono da più query per
 * progetto, e il Postgres è `--locale=C` (un `ORDER BY name` metterebbe
 * «Zeta» prima di «alfa»).
 */
function pulseOrder(a: ProjectPulseSummary, b: ProjectPulseSummary): number {
  const group = (s: ProjectPulseSummary) => (needsViewer(s) ? 0 : 1);
  const byGroup = group(a) - group(b);
  if (byGroup !== 0) return byGroup;
  return compareProjectNames(
    { id: a.projectId, name: a.projectName },
    { id: b.projectId, name: b.projectName },
  );
}

type ProjectRow = typeof projects.$inferSelect;

/**
 * Chi vede ciascun progetto: i membri più i full admin, membri impliciti di
 * ogni progetto (`docs/invariants/permissions.md`). Due query per tutta la
 * pagina, non una per progetto. Derivato a lettura (integrazione area 2): il
 * renderer ne prende gli assegnatari proposti.
 */
async function effectiveMemberIds(db: Db, projectIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (projectIds.length === 0) return result;
  const [members, admins] = await Promise.all([
    // Membri espliciti e persone di workspace (0239), come `projectViewerIdsByProject`.
    db
      .selectDistinct({ projectId: projectAccess.projectId, userId: projectAccess.userId })
      .from(projectAccess)
      .where(and(inArray(projectAccess.projectId, projectIds), projectAccessRowCounts)),
    userIdsWithPermission(db, null, null),
  ]);
  for (const id of projectIds) result.set(id, [...admins]);
  for (const m of members) {
    const list = result.get(m.projectId)!;
    if (!list.includes(m.userId)) list.push(m.userId);
  }
  return result;
}

/**
 * Proiezione pubblica del progetto (gruppo): campi elencati esplicitamente,
 * mai spread della riga. Porta le impostazioni di prodotto (provider AI,
 * auto-update docs) che valgono per tutti i repository del progetto.
 */
/**
 * Area 9, F4 (J-6 = a): i nomi di chi ha messo in pausa le code di questi
 * progetti, in UNA query (la `toPublicProject` resta sincrona).
 */
async function pauserNames(db: Db, rows: ProjectRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => (r.queuePausedAt && r.queuePausedByUserId ? [r.queuePausedByUserId] : [])))];
  if (ids.length === 0) return new Map();
  const found = await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.name ?? u.email]));
}

function toPublicProject(row: ProjectRow, pausers: Map<string, string> = new Map()): z.infer<typeof projectSchema> {
  return {
    queuePause: row.queuePausedAt
      ? { byId: row.queuePausedByUserId, byName: row.queuePausedByUserId ? (pausers.get(row.queuePausedByUserId) ?? "") : "", since: row.queuePausedAt.toISOString() }
      : null,
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    aiProviderId: row.aiProviderId,
    aiProviderExclusive: row.aiProviderExclusive,
    docAutoUpdate: row.docAutoUpdate,
    // Standup giornaliero (report attività): se true il worker genera ogni
    // notte lo standup dai commit del giorno dei repository del progetto.
    dailyReportEnabled: row.dailyReportEnabled,
    // Backlog di discovery: se true i ticket feedback/feature vengono deviati
    // all'intake del backlog invece di entrare nella pipeline fix.
    backlogEnabled: row.backlogEnabled,
    // Pulse proattivo: se attivo, quando il progetto è fermo il poller propone
    // voci del backlog da cui ripartire, ogni `pulseEveryDays` giorni.
    // `pulseLastSentAt` NON fa parte della proiezione: è stato interno del
    // poller (il gate di idempotenza), non un'impostazione.
    pulseEnabled: row.pulseEnabled,
    pulseEveryDays: row.pulseEveryDays,
    // Brief settimanale (Fase 5): indipendente dal backlog, al contrario del
    // pulse — il brief racconta quello che è già successo, e ha qualcosa da
    // dire anche su un progetto senza backlog di discovery.
    weeklyBriefEnabled: row.weeklyBriefEnabled,
    // Ciclo di correzione (30 set 2026): tetto delle correzioni automatiche
    // per tornata; 0 = ciclo automatico spento.
    prCorrectionMaxRounds: row.prCorrectionMaxRounds,
    // Area 9, F5 (I2): la chiave d'ingestione NON esce più da una lettura
    // (la vedeva ogni membro del progetto). Si legge solo dalla rigenerazione,
    // una volta; l'Integrazione (`GET …/integration`) ne dà le ultime 4. Il
    // campo resta, `null`, per i client che lo nominano.
    ingestionKey: null,
    nextTicketNumber: row.nextTicketNumber,
    createdAt: row.createdAt.toISOString(),
    // Integrazione area 2: il codice (le task sono `<CODICE>-<number>`) e le
    // soglie «ferma» del progetto.
    code: row.code,
    stallThresholds: { activeDays: row.stallActiveDays, todoDays: row.stallTodoDays },
    // Fetta 4: modello, moduli (in ordine), cliente e `kind` derivato.
    template: row.template,
    modules: orderedModules(row.modules),
    clientName: row.clientName,
    kind: row.clientName ? "client" : "internal",
  };
}

/**
 * Route dei progetti (gruppi), registrate sotto /api/projects. Lettura per chi
 * vede il progetto (membro o full admin); creazione `projects.create`
 * (d'istanza), modifica ed eliminazione `project.settings.manage`. Il
 * progetto raggruppa 1:N repository e porta le impostazioni di prodotto
 * (provider AI, auto-update docs).
 */
export async function projectRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      config: { access: { kind: "instance", permission: "projects.create" }, mcp: { action: "projects.create", summary: "Crea un progetto (serve `projects.create` d'istanza).", effect: "write" } },
      schema: {
        body: createProjectSchema,
        response: {
          201: projectSchema,
          400: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      // Chi crea il progetto ne diventa membro `Project Lead` (o del primo
      // ruolo di progetto con tutti i permessi, se il preset non c'è più).
      // Senza un ruolo così, chi non è full admin creerebbe un progetto che
      // poi non vede: meglio non crearlo.
      const leadRole = await leadRoleId(app.db);
      if (!leadRole && !request.user!.instancePermissions.has("instance.full_admin")) {
        return apiError(
          reply,
          409,
          "no_lead_role",
          "No project role with every permission exists to make you the project's lead",
        );
      }
      const {
        name,
        description,
        aiProviderId,
        aiProviderExclusive,
        docAutoUpdate,
        dailyReportEnabled,
        backlogEnabled,
        pulseEnabled,
        pulseEveryDays,
        weeklyBriefEnabled,
        code,
        template,
        clientName,
        modules,
      } = request.body;

      // Fetta 4: un codice già usato è un 409 prima di creare qualunque cosa
      // (la violazione unique dentro la transazione resta l'arbitro sotto concorrenza).
      if (code !== undefined) {
        const [taken] = await app.db.select({ id: projects.id }).from(projects).where(eq(projects.code, code));
        if (taken) return apiError(reply, 409, "code_taken", "Another project already uses this code");
      }

      // Provider AI opzionale: se valorizzato deve riferire una riga esistente
      // (non serve enabled: è configurazione, l'enabled si valuta all'esecuzione).
      if (aiProviderId !== undefined && aiProviderId !== null) {
        const [aiProvider] = await app.db
          .select({ id: aiProviders.id })
          .from(aiProviders)
          .where(eq(aiProviders.id, aiProviderId));
        if (!aiProvider) {
          return apiError(reply, 400, "ai_provider_not_found", "AI provider not found");
        }
      }

      const baseSlug = slugify(name);
      // Unicità dello slug per insert-e-riprova: in caso di collisione si
      // aggiunge un suffisso numerico. Il vincolo unique del DB è l'arbitro
      // anche sotto richieste concorrenti.
      for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
        const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
        try {
          const created = await app.db.transaction(async (tx) => {
            const [created] = await tx
              .insert(projects)
              .values({
                name,
                slug,
                description: description ?? null,
                aiProviderId: aiProviderId ?? null,
                // «Solo questo» senza provider non ha senso: non si scrive mai acceso.
                aiProviderExclusive: aiProviderId != null && aiProviderExclusive === true,
                ...(docAutoUpdate !== undefined ? { docAutoUpdate } : {}),
                ...(dailyReportEnabled !== undefined ? { dailyReportEnabled } : {}),
                ...(backlogEnabled !== undefined ? { backlogEnabled } : {}),
                ...(pulseEnabled !== undefined ? { pulseEnabled } : {}),
                ...(pulseEveryDays !== undefined ? { pulseEveryDays } : {}),
                ...(weeklyBriefEnabled !== undefined ? { weeklyBriefEnabled } : {}),
                // Chiave di ingestion del progetto per gli SDK (Fase 3): 32 hex,
                // stesso generatore usato finora per i repository. UNIQUE: in caso
                // di collisione (astronomicamente improbabile) l'insert rilancia e
                // il giro dopo ne genera un'altra insieme allo slug.
                ingestionKey: generateIngestionKey(),
                // Area 9, F5 (I2): quando e da chi, per l'Integrazione.
                ingestionKeyCreatedAt: new Date(),
                ingestionKeyCreatedByUserId: request.user!.id,
                ...(code !== undefined ? { code } : {}),
                ...(template !== undefined ? { template } : {}),
                ...(clientName != null ? { clientName } : {}),
                modules: orderedModules(modules ?? TEMPLATE_MODULES[template ?? "software"]),
              })
              .returning();
            if (!created) throw new Error("insert del progetto non ha restituito la riga");
            // Fetta 4: con un modello esplicito gli stati sono i SUOI, al posto di
            // quelli che il trigger `projects_default_statuses` ha appena messo
            // (il progetto è nato in questa transazione: nessuna task li usa).
            // Senza modello (un client di prima) restano quelli di default.
            if (template !== undefined) {
              const statuses = TEMPLATE_STATUSES[template];
              const legacy = legacyStatusesFor(statuses.map((st) => st.family));
              await tx.delete(projectStatuses).where(eq(projectStatuses.projectId, created.id));
              await tx.insert(projectStatuses).values(
                statuses.map((st, position) => ({
                  projectId: created.id,
                  name: st.name,
                  family: st.family,
                  position,
                  legacyStatus: legacy[position]!,
                })),
              );
            }
            // Fase 8: ogni progetto ha SEMPRE un ambiente `test` — è l'invariante
            // che la migrazione 0074 stabilisce per i progetti esistenti col
            // backfill, e che qui si mantiene per ogni progetto NUOVO creato dopo
            // di essa. Senza questo, un progetto nato oggi non avrebbe un target
            // valido per i file d'ambiente finché un admin non ne crea uno a mano.
            await tx.insert(projectEnvironments).values({
              projectId: created.id,
              name: "test",
              kind: "test",
            });
            if (leadRole) {
              await tx
                .insert(projectMembers)
                .values({ projectId: created.id, userId: request.user!.id, roleId: leadRole });
              // Area 9, F2: chi crea il progetto ne entra come lead.
              const [lead] = await tx.select({ name: roles.name }).from(roles).where(eq(roles.id, leadRole));
              await recordChange(tx, { type: "member.added", actor: request.user!, projectId: created.id, data: { object: memberObject(request.user!), after: lead?.name ?? null } });
            }
            return created;
          });
          // Area 9, F5 (decisione D): la chiave d'ingestione intera, UNA volta,
          // a chi crea (come una rigenerazione); ogni lettura poi la tace.
          return await reply.code(201).header("cache-control", "no-store").send({ ...toPublicProject(created), ingestionKey: created.ingestionKey });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // Il codice preso da una richiesta concorrente: niente di creato (transazione), 409.
          if (code !== undefined && uniqueViolationConstraint(error) === "projects_code_unique") {
            return apiError(reply, 409, "code_taken", "Another project already uses this code");
          }
        }
      }
      throw new Error(`impossibile generare uno slug unico per "${baseSlug}"`);
    },
  );

  app.get(
    "/",
    {
      // Solo i progetti che chi chiede vede (membro, o full admin): filtro
      // nella WHERE, sotto.
      config: {
        access: { kind: "user" },
        mcp: { action: "projects.list", summary: "Elenca i progetti che vedi (di cui sei membro, o tutti se sei full admin), con id, slug e nome.", effect: "read" },
      },
      schema: { response: { 200: z.array(projectListItemSchema), ...authErrorResponses } },
    },
    async (request) => {
      const visible = await visibleProjectIds(app.db, request.user!);
      // In ordine ALFABETICO (28 set 2026), e in TypeScript: il Postgres è
      // `--locale=C`, dove «Zeta» viene prima di «alfa». Da qui passano i
      // selettori di app e web, che non riordinano.
      const rows = (
        await app.db.select().from(projects).where(inProjects(projects.id, visible))
      ).sort(compareProjectNames);
      // Conteggio dei repository per progetto in una sola query, poi unito.
      const counts = await app.db
        .select({
          projectId: repositories.projectId,
          count: sql<number>`count(*)::int`,
        })
        .from(repositories)
        .where(inProjectsStrict(repositories.projectId, visible))
        .groupBy(repositories.projectId);
      const countByProject = new Map(counts.map((c) => [c.projectId, c.count]));
      const membersOf = await effectiveMemberIds(app.db, rows.map((r) => r.id));
      const pausers = await pauserNames(app.db, rows);
      return rows.map((row) => ({
        ...toPublicProject(row, pausers),
        repositoryCount: countByProject.get(row.id) ?? 0,
        memberIds: membersOf.get(row.id) ?? [],
      }));
    },
  );

  /**
   * Lotto 7, voce 4: il polso della nuova app calcolato sul server
   * (`services/project-pulses.ts`), al posto delle otto letture per progetto
   * del renderer e senza il tetto delle 2000 righe. Letterale: PRIMA di
   * `GET /:projectId` (vedi la nota di `/pulse` qui sotto).
   */
  app.get(
    "/pulses",
    {
      config: { access: { kind: "user" }, mcp: { action: "projects.pulses", summary: "Il polso dei progetti che vedi: cosa si muove, cosa è fermo, cosa aspetta te.", effect: "read" } },
      schema: {
        querystring: projectPulsesQuerySchema,
        response: { 200: projectPulsesResponseSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const rows = await projectPulses(app.db, request.user!, request.query.projectIds);
      return { items: rows.map((r) => ({ ...r, nextMilestone: r.nextMilestone ? toPublicMilestone(r.nextMilestone) : null })) };
    },
  );

  /**
   * IL "polso" dei progetti: chi aspetta cosa, cosa gira, cosa langue —
   * l'app mobile la usa come vista di apertura (Fase 4).
   *
   * ⚠️ DEVE restare registrata PRIMA di `GET /:projectId`: Fastify sceglie la
   * rotta più specifica quando ce n'è una, ma qui "/pulse" e "/:projectId" sono
   * ENTRAMBE candidate per lo stesso path — se questa venisse dichiarata dopo,
   * "pulse" verrebbe letto come `projectId` e fallirebbe la validazione UUID
   * dei `params` (400), mai raggiungendo questo handler. Un test in
   * `projects.test.ts` lo verifica chiamando `/api/projects/pulse` e
   * controllando che NON torni l'errore di validazione di `/:projectId`.
   *
   * I progetti sono quelli che chi guarda VEDE (`visibleProjectIds`: membro,
   * o tutti per un full admin), non più quelli che segue: il follow non dà
   * accesso, e un progetto di cui si è membri ha uno stato che riguarda chi
   * guarda anche senza seguirlo.
   */
  app.get(
    "/pulse",
    {
      config: { access: { kind: "user" }, mcp: { action: "projects.pulse", summary: "Il polso dei progetti del web: per ogni progetto che vedi, cosa si muove, cosa è fermo e cosa aspetta merge.", effect: "read" } },
      schema: { response: { 200: z.array(projectPulseSummarySchema), ...authErrorResponses } },
    },
    async (request) => {
      const visible = await visibleProjectIds(app.db, request.user!);
      const projectIds = await scopeProjectIds(app.db, visible);

      const summaries = (
        await Promise.all(
          projectIds.map(async (id) =>
            summarizeProject(app.db, id, {
              userId: request.user!.id,
              // I permessi del viewer in QUESTO progetto (`canMerge` =
              // `release.merge`): per progetto, mai uno solo per tutti.
              permissions: (await projectPermissionsFor(app.db, request.user!, id)) ?? new Set(),
            }),
          ),
        )
      ).filter((summary): summary is ProjectPulseSummary => summary !== null);

      return summaries.sort(pulseOrder);
    },
  );

  /**
   * I BRIEF SETTIMANALI del progetto (Fase 5), dal più recente.
   *
   * ACL: `tickets.view_all` (ruling R49). Il brief racconta il progetto
   * intero, ticket di tutti compresi, ed è narrativa generata: non si può
   * filtrare frase per frase, quindi lo legge solo chi vede tutti i ticket.
   * ⚠️ Registrata PRIMA di `/:projectId` come ogni rotta con suffisso letterale
   * su questo prefisso (vedi il commento su `/pulse`).
   */
  app.get(
    "/:projectId/briefs",
    {
      config: { access: onProject("tickets.view_all"), mcp: { action: "projects.briefs", owner: "mcp", summary: "I brief settimanali di un progetto, dal più recente (narrativa generata).", effect: "read" } },
      schema: {
        params: idParamsSchema,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
        response: {
          200: z.array(projectBriefWeeklySchema),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      return listProjectBriefs(app.db, request.params.projectId, request.query.limit ?? 20);
    },
  );

  /**
   * IL REGISTRO DECISIONI del progetto (Fase 5): i fatti decisi da persone —
   * risposte alle domande dell'agente, piani approvati o rifiutati con
   * indicazioni, proposte del pulse prese — più le voci scritte a mano.
   *
   * ⚠️ Registrata PRIMA di `/:projectId`, come ogni rotta con suffisso
   * letterale su questo prefisso (vedi il commento su `/pulse`).
   *
   * ACL di LETTURA come timeline e brief: chi vede il progetto; "non membro"
   * e "inesistente" rispondono 404.
   */
  app.get(
    "/:projectId/decisions",
    {
      config: { access: onProject("member"), mcp: { action: "decisions.log", summary: "Il registro decisioni di un progetto: fatti decisi da persone, compresi quelli superati.", effect: "read" } },
      schema: {
        params: idParamsSchema,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          source: decisionSourceSchema.optional(),
        }),
        response: {
          200: z.array(projectDecisionSchema),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      return listProjectDecisions(app.db, request.params.projectId, {
        limit: request.query.limit ?? 50,
        ...(request.query.source ? { source: request.query.source } : {}),
        // Il riferimento a un ticket che chi legge non vede si toglie (R49).
        viewer: { userId: request.user!.id, permissions: routePermissions(request) },
      });
    },
  );

  /**
   * Registra una decisione SCRITTA A MANO: `decisions.record`. Non serve
   * essere maintainer: chi lavora al progetto è chi ha deciso, e un registro
   * che solo gli admin possono alimentare si svuota.
   */
  app.post(
    "/:projectId/decisions",
    {
      config: { access: onProject("decisions.record"), mcp: { action: "decisions.record", summary: "Registra a mano una decisione nel registro del progetto (serve `decisions.record`).", effect: "write", note: "Solo con le parole dell'utente, mai un riassunto tuo." } },
      schema: {
        params: idParamsSchema,
        body: decisionDraftSchema,
        response: {
          201: projectDecisionSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const result = await createManualDecision(app.db, {
        projectId,
        authorId: request.user!.id,
        title: request.body.title,
        decision: request.body.decision,
        ...(request.body.context ? { context: request.body.context } : {}),
        ...(request.body.consequences ? { consequences: request.body.consequences } : {}),
        ...(request.body.ticketId ? { ticketId: request.body.ticketId } : {}),
        ...(request.body.decidedAt ? { decidedAt: request.body.decidedAt } : {}),
        ...(request.body.supersedesId ? { supersedesId: request.body.supersedesId } : {}),
        actor: { id: request.user!.id, permissions: routePermissions(request) },
      });
      if (!result.ok) {
        if (result.error === "forbidden") {
          return apiError(reply, 403, "decision_forbidden", "Only the author or a maintainer can supersede this decision");
        }
        if (result.error === "already_superseded") {
          return apiError(reply, 409, "already_superseded", "This decision has already been superseded");
        }
        return apiError(reply, 400, "invalid_supersede", "supersedesId must be a decision of the same project");
      }
      return reply.code(201).send(result.decision);
    },
  );

  /**
   * Corregge una decisione o la segna come SUPERATA da un'altra
   * (`supersededById`). Serve `decisions.record`, e poi solo l'autore o chi
   * ha `project.settings.manage` (vedi `canEditDecision`): una decisione non è un
   * wiki, e riscrivere il fatto altrui è la cosa che questo registro non deve
   * permettere.
   *
   * `superseded` non cancella: la voce vecchia resta, e sapere che è stata
   * cambiata vale quanto sapere che era stata presa.
   */
  app.patch(
    "/:projectId/decisions/:decisionId",
    {
      config: { access: onProject("decisions.record"), mcp: { action: "decisions.update", summary: "Corregge una decisione o la segna superata da un'altra (l'autore, o chi gestisce il progetto).", effect: "write", note: "Solo con le parole dell'utente, mai un riassunto tuo." } },
      schema: {
        params: z.object({ projectId: z.uuid(), decisionId: z.uuid() }),
        body: decisionPatchSchema,
        response: {
          200: projectDecisionSchema,
          400: errorSchema,
          404: errorSchema,
          // 403 arriva da `authErrorResponses`: qui lo usa anche la regola
          // "solo l'autore o un maintainer", non solo il gate di sessione.
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, decisionId } = request.params;
      const result = await patchDecision(app.db, {
        projectId,
        decisionId,
        actor: { id: request.user!.id, permissions: routePermissions(request) },
        patch: request.body,
      });
      if (result.ok) return result.decision;
      if (result.error === "not_found") {
        return apiError(reply, 404, "decision_not_found", "Decision not found");
      }
      if (result.error === "forbidden") {
        return apiError(
          reply,
          403,
          "decision_forbidden",
          "Only the author or a maintainer can edit this decision",
        );
      }
      // Il testo di una voce automatica non si riscrive: è un fatto, non una
      // nota. Resta ammesso `supersededById` (vedi `patchDecision`).
      if (result.error === "decision_immutable") {
        return apiError(
          reply,
          403,
          "decision_immutable",
          "The text of an automatic decision cannot be edited; it can only be superseded",
        );
      }
      if (result.error === "decision_cycle") {
        return apiError(reply, 400, "decision_cycle", "This would make the superseded-by chain a loop");
      }
      return apiError(
        reply,
        400,
        "invalid_supersede",
        "supersededById must be another decision of the same project",
      );
    },
  );

  app.get(
    "/:projectId",
    {
      config: { access: onProject("member"), mcp: { action: "projects.get", summary: "Il dettaglio di un progetto che vedi: nome, codice, slug, repository e impostazioni principali.", effect: "read" } },
      schema: {
        params: idParamsSchema,
        response: { 200: projectDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(projects)
        .where(eq(projects.id, request.params.projectId));
      if (!row) return apiError(reply, 404, "project_not_found", "Project not found");
      const repos = await app.db
        .select({
          id: repositories.id,
          name: repositories.name,
          slug: repositories.slug,
          provider: repositories.provider,
        })
        .from(repositories)
        .where(eq(repositories.projectId, row.id))
        .orderBy(repositories.createdAt);
      return {
        ...toPublicProject(row, await pauserNames(app.db, [row])),
        repositories: repos,
        myPermissions: [...routePermissions(request)],
        memberIds: (await effectiveMemberIds(app.db, [row.id])).get(row.id) ?? [],
      };
    },
  );

  app.patch(
    "/:projectId",
    {
      config: { mcp: { action: "projects.update", summary: "Modifica un progetto: nome, codice, cliente, descrizione, provider AI, moduli accesi, polso, brief, Docs notturni, tetto delle correzioni.", effect: "write", note: "Spegnere un modulo lo toglie a tutti i membri. Cambia cosa possono fare altre persone: dillo all'utente nella riga che annuncia l'azione." }, access: onProject("project.settings.manage") },
      schema: {
        params: idParamsSchema,
        body: updateProjectSchema,
        response: {
          200: projectSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      // Area 9, F7: il servizio, lo stesso delle azioni di Claude.
      const outcome = await patchProject(app.db, request.user!, request.params.projectId, request.body);
      if (!outcome.ok) {
        if (outcome.error === "not_found") return apiError(reply, 404, "project_not_found", "Project not found");
        if (outcome.error === "ai_provider_not_found") return apiError(reply, 400, "ai_provider_not_found", "AI provider not found");
        if (outcome.error === "code_taken") return apiError(reply, 409, "code_taken", "Another project already uses this code");
        return apiError(reply, 400, "pulse_needs_backlog", "The pulse proposes from the backlog: turn on backlog discovery first");
      }
      return toPublicProject(outcome.row);
    },
  );

  // Area 9, F6 (D-8): si elimina SOLO un archiviato, SOLO un full admin, con
  // la riconferma e il codice scritto esatto (`{ confirmCode }`). I
  // repository restano, staccati (L-2); di un progetto restano solo codice,
  // nome e membri (`deleted_projects`); la voce `project.deleted` è
  // d'istanza. Un client vecchio riceve 403 (chi non è full admin) o 400
  // (senza corpo). Prima era `project.settings.manage`, senza archivio né
  // riconferma.
  app.delete(
    "/:projectId",
    {
      config: { access: onProject("member"), archived: "write", reauth: true },
      schema: {
        params: idParamsSchema,
        body: deleteProjectSchema,
        response: { 204: z.null(), 400: errorSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // Gli allegati (Chat e ticket) vanno via in cascata col progetto: le chiavi
      // dello storage si leggono prima, e si tolgono dopo il commit (review
      // della fetta 4 della Chat). Lo storage giù non fa fallire l'eliminazione.
      let keys: string[];
      try {
        ({ storageKeys: keys } = await deleteArchivedProject(app.db, request.user!, request.params.projectId, request.body.confirmCode, storageKeysOfProject));
      } catch (error) {
        if (error instanceof ArchiveError) return apiError(reply, error.status, error.code, error.message);
        throw error;
      }
      if (keys.length > 0) {
        try {
          await deleteStoredObjects(await app.storage(), keys, (m) => request.log.warn(m));
        } catch (error) {
          request.log.warn({ err: error }, "storage non raggiungibile: oggetti degli allegati del progetto da togliere a mano");
        }
      }
      return reply.code(204).send(null);
    },
  );
}
