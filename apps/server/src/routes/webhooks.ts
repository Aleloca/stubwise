import { getProvider } from "@stubwise/git";
import { t } from "@stubwise/i18n";
import { publishNotification } from "@stubwise/notifications";
import { and, count, desc, eq, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "@stubwise/db";
import {
  activityRecountJobs,
  aiJobs,
  comments,
  docAutoUpdateJobs,
  docGenerations,
  graphJobs,
  instanceSettings,
  prReviewJobs,
  prReviews,
  projects,
  recordTicketStatusChange,
  repositories,
  ticketRepositories,
  tickets,
} from "@stubwise/db";
import { getContentLanguage } from "../settings.js";
import { apiError } from "../errors.js";

/**
 * Tetto al corpo del webhook: 1 MiB. I payload di Bitbucket/GitHub per una PR
 * stanno largamente sotto; il limite protegge il parser da corpi smisurati
 * (DoS di memoria). Fastify risponde 413 quando lo supera.
 */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** I rami stubwise sono `stubwise/ticket-<N>`: da lì si estrae il numero del ticket. */
const STUBWISE_BRANCH_RE = /^stubwise\/ticket-(\d+)$/;

/**
 * Finestra di debounce dell'auto-aggiornamento Docs ai push: ogni push sul
 * branch di default sposta `not_before` di questo intervallo nel futuro, così
 * il poller del worker reclama il job solo quando i push si fermano per almeno
 * questo tempo (raffica di commit/merge → una sola rigenerazione). 5 minuti è
 * un compromesso tra reattività e accorpamento; costante hardcoded di proposito
 * (non vale una variabile d'ambiente in più da propagare in buildApp/compose).
 */
const DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * Debounce dell'automazione PR Review: ogni opened/synchronize sposta
 * `not_before` di questo intervallo, così una raffica di push sulla PR produce
 * una sola review sulla head finale. Più corto del debounce Docs: la review
 * serve "presto" dopo l'apertura, e i push su una PR sono meno frequenti dei
 * push su main.
 */
const PR_REVIEW_DEBOUNCE_MS = 90 * 1000;

/**
 * Debounce del recount dei report attività: ogni push su un repo di un progetto
 * con i report giornalieri attivi sposta `not_before` di questo intervallo, così
 * una raffica di push accorpa in un solo recount (il worker lo reclama quando i
 * push si fermano per almeno questo tempo). Più corto degli altri: il recount è
 * un'aggregazione leggera e conviene tenerlo reattivo.
 */
const ACTIVITY_RECOUNT_DEBOUNCE_MS = 60 * 1000;

/**
 * Debounce della build del knowledge graph: ogni push sul branch di default di
 * un repository con `graphEnabled` sposta il `not_before` del job `build`
 * queued, così una raffica di push produce una sola estrazione (il poller del
 * worker reclama i job solo quando `not_before` è passato). Stessa finestra del
 * recount: la build è incrementale e conviene tenerla reattiva.
 */
const GRAPH_BUILD_DEBOUNCE_MS = 60 * 1000;

/**
 * Accoda (in debounce) una build del grafo per il repository. Non usa un
 * `ON CONFLICT` sull'indice unico parziale `graph_jobs_active_unique` ma la
 * forma UPDATE-poi-INSERT, perché il target dell'upsert non è filtrabile per
 * stato: un job `running` matcherebbe il conflitto e il SET ne sposterebbe il
 * `not_before` mentre la build è in corso. Qui invece:
 *
 *  - esiste un job `queued` → UPDATE del solo `not_before` (+ `updated_at`, che
 *    lo schema non mantiene da solo): la finestra di debounce scorre in avanti;
 *  - esiste un job `running` → l'INSERT viola l'indice parziale e il
 *    `onConflictDoNothing` lo assorbe: nessun secondo job, la build in corso
 *    resta intatta. Sta lavorando su uno sha vecchio, ma il push successivo (o
 *    la generazione manuale) riaccoderà;
 *  - nessun job attivo → INSERT del job `queued`.
 *
 * `force` non viene mai chiesto dal webhook: servirebbe l'elenco dei file
 * CANCELLATI dal push, che il contratto `PushWebhookEvent` di @stubwise/git non
 * espone (i suoi `commits` hanno solo sha e messaggio) e che il payload
 * Bitbucket `repo:push` non contiene affatto — scoprirlo richiederebbe una
 * chiamata API in più al provider. L'UPDATE non tocca quindi il campo, così un
 * `force` acceso altrove (generazione manuale) non viene spento da un push.
 */
async function enqueueGraphBuildOnPush(db: Db, repositoryId: string): Promise<void> {
  const notBefore = new Date(Date.now() + GRAPH_BUILD_DEBOUNCE_MS);
  const updated = await db
    .update(graphJobs)
    .set({ notBefore, updatedAt: new Date() })
    .where(
      and(
        eq(graphJobs.repositoryId, repositoryId),
        eq(graphJobs.kind, "build"),
        eq(graphJobs.status, "queued"),
      ),
    )
    .returning({ id: graphJobs.id });
  if (updated.length > 0) return;

  await db
    .insert(graphJobs)
    .values({ repositoryId, kind: "build", notBefore })
    // Senza target: assorbe la violazione dell'indice parziale sia per un job
    // `running` sia per la corsa con un push concorrente che ha appena inserito.
    .onConflictDoNothing();
}

/**
 * Normalizza gli header Fastify (string | string[] | undefined) nella
 * Record<string,string> richiesta dal contratto di @stubwise/git: chiavi in
 * minuscolo (Fastify le fornisce già così) e, per gli header multi-valore, si
 * tiene il primo. Gli undefined vengono saltati.
 */
function normalizeHeaders(raw: FastifyRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return out;
}

/**
 * Compone l'URL assoluto del ticket a partire dal base pubblico. Il getter
 * `instance.publicUrl` normalizza già togliendo gli slash finali; questo helper
 * si limita a comporre il path, allineato al `ticketUrl` del processor.
 */
function ticketUrl(base: string, ticketId: string): string {
  return `${base}/tickets/${ticketId}`;
}

/**
 * Route del webhook git per la chiusura automatica dei ticket al merge:
 * POST /webhooks/git/:projectSlug.
 *
 * Chiamante esterno (Bitbucket/GitHub), quindi NIENTE sessione: l'unica
 * autenticazione è la firma HMAC sul corpo grezzo. Lo slug sconosciuto e la
 * firma errata producono lo stesso 401, come per l'ingestion: niente
 * enumerazione degli slug.
 *
 * L'HMAC si calcola sul corpo grezzo, che Fastify normalmente scarta dopo il
 * JSON.parse. Questo scope registra un content-type parser per
 * application/json che cattura il Buffer grezzo su request.rawBody e poi fa il
 * parse; è scoped a questo plugin, /api e /ingest mantengono il parser di
 * default. La verifica della firma sta in preValidation (dopo il parse): un
 * corpo JSON malformato con la firma corretta risponde 400 (errore di parse
 * dal parser), tutto il resto che non passa la firma risponde 401.
 */
export async function webhookRoutes(instance: FastifyInstance): Promise<void> {
  // Parser JSON con cattura del raw body, limitato a questo scope.
  instance.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: MAX_WEBHOOK_BODY_BYTES },
    (request, body: Buffer, done) => {
      request.rawBody = body;
      try {
        // Corpo vuoto → null, coerente col comportamento di default di Fastify.
        const parsed: unknown = body.length === 0 ? null : JSON.parse(body.toString("utf8"));
        done(null, parsed);
      } catch {
        const error = new Error("Corpo del webhook non è JSON valido") as Error & {
          statusCode: number;
        };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  instance.post<{ Params: { projectSlug: string } }>(
    "/git/:projectSlug",
    {
      // La verifica della firma sta dopo il parse del corpo (preValidation):
      // request.rawBody è già popolato dal parser. Una firma assente/errata, un
      // progetto sconosciuto o col segreto vuoto chiudono qui con 401.
      preValidation: async (request, reply) => {
        const { projectSlug } = request.params;
        const [repository] = await instance.db
          .select({
            id: repositories.id,
            provider: repositories.provider,
            webhookSecret: repositories.webhookSecret,
          })
          .from(repositories)
          .where(eq(repositories.slug, projectSlug));

        // Slug sconosciuto o segreto vuoto (legacy, non verificabile): 401,
        // indistinguibile da una firma errata.
        if (!repository || repository.webhookSecret === "") {
          return apiError(reply, 401, "webhook_unauthorized", "Webhook unauthorized");
        }
        const provider = getProvider(repository.provider);
        const headers = normalizeHeaders(request.headers);
        const rawBody = request.rawBody ?? Buffer.alloc(0);
        if (!provider.verifyWebhook(headers, rawBody, repository.webhookSecret)) {
          return apiError(reply, 401, "webhook_unauthorized", "Webhook unauthorized");
        }

        request.webhookContext = { repositoryId: repository.id, provider: repository.provider };
      },
    },
    async (request, reply) => {
      const context = request.webhookContext!;
      const provider = getProvider(context.provider);
      const headers = normalizeHeaders(request.headers);

      // Ramo push (auto-aggiornamento Docs), valutato PRIMA del flusso PR. I due
      // non si calpestano: parsePushEvent ritorna null per gli eventi PR e
      // parseWebhook null per i push, quindi al più uno dei due rami è attivo.
      const push = provider.parsePushEvent(headers, request.body);
      if (push) {
        // Il toggle docAutoUpdate è salito al PROGETTO: si legge via join dal
        // repository al suo progetto. defaultBranch/currentDocGenerationId
        // restano sul repository.
        const [repository] = await instance.db
          .select({
            projectId: repositories.projectId,
            defaultBranch: repositories.defaultBranch,
            docAutoUpdate: projects.docAutoUpdate,
            dailyReportEnabled: projects.dailyReportEnabled,
            graphEnabled: repositories.graphEnabled,
            currentDocGenerationId: repositories.currentDocGenerationId,
          })
          .from(repositories)
          .innerJoin(projects, eq(projects.id, repositories.projectId))
          .where(eq(repositories.id, context.repositoryId));

        // Recount dei report attività: indipendente dal branch e dal toggle
        // Docs. Qualunque push su un repo di un progetto con i report giornalieri
        // attivi accoda (in debounce) un recount, che il worker processerà.
        // L'upsert sulla PK (project_id) tiene un solo job pending per progetto:
        // push ravvicinati spostano solo la finestra di debounce in avanti.
        if (repository?.dailyReportEnabled === true) {
          const recountNotBefore = new Date(Date.now() + ACTIVITY_RECOUNT_DEBOUNCE_MS);
          await instance.db
            .insert(activityRecountJobs)
            .values({ projectId: repository.projectId, notBefore: recountNotBefore })
            .onConflictDoUpdate({
              target: activityRecountJobs.projectId,
              set: { notBefore: recountNotBefore },
            });
        }

        // Build del grafo: indipendente dal toggle Docs (ha il suo, per
        // repository) ma limitata al branch di default, perché il job estrae il
        // grafo dalla HEAD del default branch — un push su un branch di feature
        // rifarebbe la stessa build. Best-effort: l'accodamento non deve far
        // fallire la risposta al provider (un webhook in errore verrebbe
        // ri-consegnato e ripeterebbe anche il resto del ramo push).
        if (repository?.graphEnabled === true && push.branch === repository.defaultBranch) {
          try {
            await enqueueGraphBuildOnPush(instance.db, context.repositoryId);
          } catch (error) {
            instance.log.error({ err: error }, "accodamento della build del grafo fallito");
          }
        }

        // Gate: si agisce solo sui push al branch di default di un repository il
        // cui progetto ha il toggle attivo. Tutto il resto è no-op (un push su un
        // branch di feature o con auto-update spento non innesca nulla).
        if (
          !repository ||
          push.branch !== repository.defaultBranch ||
          repository.docAutoUpdate !== true
        ) {
          return reply.code(204).send();
        }

        // Base del diff all'INSERIMENTO del job: il commit della generazione Docs
        // corrente, se presente e registrato; altrimenti il `before` del push.
        // Su conflitto NON si tocca `fromSha`, così accumula dal primo push.
        let fromShaOnInsert = push.beforeSha;
        if (repository.currentDocGenerationId) {
          const [generation] = await instance.db
            .select({ commitSha: docGenerations.commitSha })
            .from(docGenerations)
            .where(eq(docGenerations.id, repository.currentDocGenerationId));
          if (generation?.commitSha) fromShaOnInsert = generation.commitSha;
        }

        // Upsert sul vincolo unique (repository_id): un solo job pending per
        // repository. Push ravvicinati aggiornano solo head e finestra di debounce.
        const notBefore = new Date(Date.now() + DEBOUNCE_MS);
        await instance.db
          .insert(docAutoUpdateJobs)
          .values({
            repositoryId: context.repositoryId,
            fromSha: fromShaOnInsert,
            toSha: push.afterSha,
            notBefore,
          })
          .onConflictDoUpdate({
            target: docAutoUpdateJobs.repositoryId,
            set: { toSha: push.afterSha, notBefore },
          });

        return reply.code(204).send();
      }

      // Ramo PR Review: apertura/aggiornamento di una PR. Mutuamente esclusivo
      // con gli altri due (parsePushEvent copre solo i push, parseWebhook solo
      // le chiusure). Gate sul toggle d'istanza: spento = no-op.
      const prEvent = provider.parsePrEvent(headers, request.body);
      if (prEvent) {
        const [settings] = await instance.db
          .select({ enabled: instanceSettings.prReviewEnabled })
          .from(instanceSettings)
          .where(eq(instanceSettings.id, 1));
        if (settings?.enabled !== true) return reply.code(204).send();

        // Upsert sul vincolo (repository, PR): un solo pending per PR, i push
        // ravvicinati aggiornano head/metadati e allungano il debounce.
        const notBefore = new Date(Date.now() + PR_REVIEW_DEBOUNCE_MS);
        await instance.db
          .insert(prReviewJobs)
          .values({
            repositoryId: context.repositoryId,
            prNumber: prEvent.prNumber,
            prUrl: prEvent.prUrl,
            prTitle: prEvent.title,
            prBody: prEvent.description,
            sourceBranch: prEvent.sourceBranch,
            targetBranch: prEvent.targetBranch,
            headSha: prEvent.headSha,
            notBefore,
          })
          .onConflictDoUpdate({
            target: [prReviewJobs.repositoryId, prReviewJobs.prNumber],
            set: {
              prUrl: prEvent.prUrl,
              prTitle: prEvent.title,
              prBody: prEvent.description,
              sourceBranch: prEvent.sourceBranch,
              targetBranch: prEvent.targetBranch,
              headSha: prEvent.headSha,
              notBefore,
              // $onUpdate di Drizzle non scatta su onConflictDoUpdate: aggiorniamo
              // updated_at a mano (utile come segnale di quando è arrivato l'ultimo push).
              updatedAt: new Date(),
            },
          });
        return reply.code(204).send();
      }

      const event = provider.parseWebhook(headers, request.body);
      // Non è un merge di PR che ci interessa: ignorato (204), niente da fare.
      if (!event) return reply.code(204).send();

      // Lato PR Review, per QUALUNQUE PR chiusa: il pending in coda non serve
      // più (la review di una PR chiusa è inutile), e l'eventuale ticket di
      // tipo `review` della PR si chiude da solo (done se mergiata, closed se
      // rifiutata). Vale anche per le PR stubwise (che però non hanno mai un
      // ticket review: le query sotto sono no-op in quel caso). Il numero PR
      // può mancare (provider anomalo): in quel caso si salta solo il cleanup,
      // la chiusura del ticket del fix sotto non ne dipende.
      if (event.prNumber != null) {
        await instance.db
          .delete(prReviewJobs)
          .where(
            and(
              eq(prReviewJobs.repositoryId, context.repositoryId),
              eq(prReviewJobs.prNumber, event.prNumber),
            ),
          );

        // Solo le righe CON ticket: quelle failed/running hanno ticketId null
        // e una re-review fallita più recente maschererebbe la review
        // completata che il ticket l'ha creato (stessa lookup di resolveTicket
        // nel worker).
        const [reviewRow] = await instance.db
          .select({ ticketId: prReviews.ticketId })
          .from(prReviews)
          .where(
            and(
              eq(prReviews.repositoryId, context.repositoryId),
              eq(prReviews.prNumber, event.prNumber),
              isNotNull(prReviews.ticketId),
            ),
          )
          .orderBy(desc(prReviews.createdAt))
          .limit(1);
        if (reviewRow?.ticketId) {
          const [reviewTicket] = await instance.db
            .select({ id: tickets.id, status: tickets.status, type: tickets.type })
            .from(tickets)
            .where(eq(tickets.id, reviewRow.ticketId));
          // Si auto-chiude SOLO il ticket di tipo review ancora aperto: il
          // ticket di un fix stubwise ha già il suo flusso di chiusura sotto.
          // Il check di status qui è un fast-path (evita lookup lingua e
          // transazione sulle ri-consegne): il gate VERO è il predicato
          // dell'UPDATE sotto, atomico dentro la transazione.
          if (
            reviewTicket &&
            reviewTicket.type === "review" &&
            reviewTicket.status !== "done" &&
            reviewTicket.status !== "closed"
          ) {
            const lang = await getContentLanguage(instance.db);
            await instance.db.transaction(async (tx) => {
              const nextStatus = event.kind === "merged" ? "done" : "closed";
              // Lo stato PRECEDENTE si rilegge DENTRO la transazione: quello
              // letto fuori serviva solo al fast-path, e l'audit deve dire da
              // dove il ticket è partito davvero.
              const [before] = await tx
                .select({ status: tickets.status })
                .from(tickets)
                .where(eq(tickets.id, reviewTicket.id));
              // Il predicato sullo status rende chiusura+commento atomici: due
              // consegne CONCORRENTI leggono entrambe lo status "aperto" fuori
              // transazione, ma solo quella il cui UPDATE tocca davvero la riga
              // (ticket non ancora done/closed) inserisce il commento di
              // sistema — mai duplicati.
              const updated = await tx
                .update(tickets)
                .set({ status: nextStatus })
                .where(
                  and(
                    eq(tickets.id, reviewTicket.id),
                    notInArray(tickets.status, ["done", "closed"]),
                  ),
                )
                .returning({ id: tickets.id });
              if (updated.length > 0) {
                await tx.insert(comments).values({
                  ticketId: reviewTicket.id,
                  authorType: "system",
                  body: t(
                    lang,
                    event.kind === "merged" ? "comment.prMerged" : "comment.prClosed",
                    { url: event.prUrl },
                  ),
                });
                // Audit della transizione: nessun umano dietro (actorId null).
                // Sta dentro lo stesso `updated.length > 0` del commento, così
                // una ri-consegna che non tocca la riga non lascia un evento.
                if (before) {
                  await recordTicketStatusChange(tx, {
                    ticketId: reviewTicket.id,
                    from: before.status,
                    to: nextStatus,
                    actorId: null,
                  });
                }
              }
            });
          }
        }
      }

      const match = STUBWISE_BRANCH_RE.exec(event.branch);
      // Ramo non gestito da Stubwise: ignorato.
      if (!match) return reply.code(204).send();
      const ticketNumber = Number(match[1]);

      // Il ticket appartiene solo al PROGETTO (Fase 3, tickets.repositoryId
      // rimosso): il webhook (per-repo) risolve il ticket per (progetto del
      // repo del webhook, N). Poiché N è unico per progetto (Fase 3, Task 1),
      // (progetto, N) risolve al più UN ticket. La chiusura è AGGREGATA
      // (Task 5): il merge marca la riga ticket_repositories di QUESTO repo e
      // porta il ticket a `done` solo quando TUTTE le righe del ticket sono
      // `merged` (vedi sotto).
      const [ticket] = await instance.db
        .select({
          id: tickets.id,
          status: tickets.status,
          number: tickets.number,
          title: tickets.title,
          // Ancora della notifica job.pr_closed (vedi in fondo al ramo).
          projectId: tickets.projectId,
        })
        .from(tickets)
        .innerJoin(repositories, eq(repositories.projectId, tickets.projectId))
        .where(and(eq(repositories.id, context.repositoryId), eq(tickets.number, ticketNumber)));

      // Lingua dei contenuti d'istanza, risolta UNA VOLTA prima della
      // transazione (una sola select, non allunga la tx): i body dei commenti
      // di sistema parlano la lingua configurata, fallback 'en'.
      const lang = await getContentLanguage(instance.db);

      if (event.kind === "merged") {
        // Nessun ticket per quel numero, o già chiuso/concluso: nulla da fare,
        // idempotente. Non si crea un secondo commento di sistema.
        if (!ticket || ticket.status === "done" || ticket.status === "closed") {
          return reply.code(204).send();
        }

        // Chiusura AGGREGATA multi-repo. Regole:
        //  1. Marca la riga ticket_repositories di QUESTO repo come `merged`.
        //     Se la riga manca (caso limite: PR mergiata ma riga assente — es.
        //     legacy single-repo dove il worker non l'ha popolata, o disallineo
        //     DB), la si CREA `merged`: la PR mergiata è la fonte di verità, e
        //     creare la riga è più sicuro che ignorare il merge (che lascerebbe
        //     il ticket bloccato). L'upsert sull'unique (ticketId, repositoryId)
        //     rende l'operazione idempotente: una ri-consegna non duplica.
        //  2. Il ticket va a `done` SOLO SE, dopo l'upsert, TUTTE le sue righe
        //     sono `merged`. Una riga `open` (repo con PR ancora da mergiare) o
        //     `closed_unmerged` (repo la cui PR è stata rifiutata e attende un
        //     nuovo fix) tiene il ticket in `in_review`. Le righe
        //     `closed_unmerged` impediscono il `done` finché quel repo non viene
        //     ri-fixato e la nuova PR mergiata (che rimette la riga a `merged`).
        //     Fonte di verità = l'insieme attuale delle righe: un re-run che
        //     restringe i repo toccati rimpiazza le righe (upsert per repo), non
        //     lascia righe stale di repo non più modificati.
        await instance.db.transaction(async (tx) => {
          // Stato della riga di QUESTO repo prima dell'upsert: distingue la
          // prima consegna del merge (riga assente o `open`/`closed_unmerged`)
          // da una ri-consegna (riga già `merged`). Serve a non scrivere un
          // secondo commento di sistema quando il merge dello stesso repo viene
          // riconsegnato mentre il ticket è ancora `in_review` (merge parziale).
          const [existingRow] = await tx
            .select({ prState: ticketRepositories.prState })
            .from(ticketRepositories)
            .where(
              and(
                eq(ticketRepositories.ticketId, ticket.id),
                eq(ticketRepositories.repositoryId, context.repositoryId),
              ),
            );
          const alreadyMerged = existingRow?.prState === "merged";

          await tx
            .insert(ticketRepositories)
            .values({
              ticketId: ticket.id,
              repositoryId: context.repositoryId,
              branch: event.branch,
              prUrl: event.prUrl,
              prState: "merged",
            })
            .onConflictDoUpdate({
              target: [ticketRepositories.ticketId, ticketRepositories.repositoryId],
              set: { prState: "merged", prUrl: event.prUrl },
            });

          // Ri-consegna dello stesso repo già `merged`: idempotente, niente
          // commento né transizioni. (La riga era già merged; il gate sotto non
          // cambierebbe nulla.)
          if (alreadyMerged) return;

          // Commento di sistema: una PR di questo repo è stata mergiata.
          await tx.insert(comments).values({
            ticketId: ticket.id,
            authorType: "system",
            body: t(lang, "comment.prMerged", { url: event.prUrl }),
          });

          // Gate aggregato: esiste ancora una riga NON `merged`? Se sì, il
          // ticket resta in review; se no (tutte merged), va a `done`.
          const [pending] = await tx
            .select({ value: count() })
            .from(ticketRepositories)
            .where(
              and(
                eq(ticketRepositories.ticketId, ticket.id),
                ne(ticketRepositories.prState, "merged"),
              ),
            );
          const allMerged = (pending?.value ?? 0) === 0;
          if (!allMerged) return;

          const [beforeDone] = await tx
            .select({ status: tickets.status })
            .from(tickets)
            .where(eq(tickets.id, ticket.id));
          await tx.update(tickets).set({ status: "done" }).where(eq(tickets.id, ticket.id));
          // Audit della chiusura: è l'evento DATATO su cui si appoggia la
          // timeline di progetto per "ticket chiuso" — `updated_at` direbbe
          // solo quando la riga è cambiata l'ultima volta. actorId null: la
          // decisione è del merge, non di una persona.
          if (beforeDone) {
            await recordTicketStatusChange(tx, {
              ticketId: ticket.id,
              from: beforeDone.status,
              to: "done",
              actorId: null,
            });
          }
          // Allinea il job AI alla realtà: la PR aperta dalla pipeline è stata
          // mergiata. Si tocca SOLO il job in stato `pr_opened` (al più uno per
          // ticket), così una ri-consegna del webhook trova zero righe da
          // aggiornare (idempotenza) e gli altri stati restano intatti. Il job
          // passa a `pr_merged` quando il TICKET va a `done` (semantica job
          // coerente col ticket: un solo job per ticket, non per repo).
          await tx
            .update(aiJobs)
            .set({
              status: "pr_merged",
              finishedAt: sql`coalesce(${aiJobs.finishedAt}, now())`,
              lastActivityAt: sql`now()`,
            })
            .where(and(eq(aiJobs.ticketId, ticket.id), eq(aiJobs.status, "pr_opened")));
        });

        return reply.code(204).send();
      }

      // event.kind === "closed_unmerged": riapertura del ticket per QUESTO repo.
      // Agiamo SOLO se il ticket è ancora in review (la pipeline ci ha appena
      // aperto la PR). Qualunque altro stato → 204 idempotente: una ri-consegna,
      // o un ticket già ripreso/concluso a mano, non deve produrre effetti.
      if (!ticket || ticket.status !== "in_review") return reply.code(204).send();

      // Job AI riallineato dalla transazione qui sotto: è l'ancora `jobId` della
      // notifica (nessuna riga = nessun job `pr_opened`, l'evento resta legato
      // a ticket e progetto).
      let closedJobId: string | undefined;
      await instance.db.transaction(async (tx) => {
        // Marca la riga ticket_repositories di QUESTO repo come
        // `closed_unmerged`, senza toccare le righe/PR degli altri repo (lo
        // scope ticketId+repositoryId isola l'update). La riga tornerà `merged`
        // solo quando quel repo verrà ri-fixato e la nuova PR mergiata; finché
        // resta `closed_unmerged` il gate aggregato del merge non porterà mai il
        // ticket a `done`. Update mirato (non upsert): se la riga manca — PR
        // rifiutata senza che il fix ne abbia mai aperta una tracciata — non c'è
        // uno stato per-repo da mantenere, ma il ticket rientra comunque in
        // lavorazione (transizione sotto), coerente col comportamento pre-Fase 3.
        await tx
          .update(ticketRepositories)
          .set({ prState: "closed_unmerged", prUrl: event.prUrl })
          .where(
            and(
              eq(ticketRepositories.ticketId, ticket.id),
              eq(ticketRepositories.repositoryId, context.repositoryId),
            ),
          );
        await tx.update(tickets).set({ status: "triaged" }).where(eq(tickets.id, ticket.id));
        // Audit della riapertura. Qui lo stato precedente è certo: il ramo è
        // guardato da `ticket.status !== "in_review"` poche righe sopra.
        await recordTicketStatusChange(tx, {
          ticketId: ticket.id,
          from: "in_review",
          to: "triaged",
          actorId: null,
        });
        await tx.insert(comments).values({
          ticketId: ticket.id,
          authorType: "system",
          body: t(lang, "comment.prClosed", { url: event.prUrl }),
        });
        // Allinea il job AI: la PR aperta dalla pipeline è stata chiusa senza
        // merge. Si tocca SOLO il job `pr_opened` (idempotenza: una ri-consegna
        // non trova righe), gli altri stati restano intatti.
        const closed = await tx
          .update(aiJobs)
          .set({
            status: "pr_closed",
            finishedAt: sql`coalesce(${aiJobs.finishedAt}, now())`,
            lastActivityAt: sql`now()`,
          })
          .where(and(eq(aiJobs.ticketId, ticket.id), eq(aiJobs.status, "pr_opened")))
          .returning({ id: aiJobs.id });
        closedJobId = closed[0]?.id;
      });

      // Notifica best-effort job.pr_closed DOPO il commit (riflette realtà
      // committata). Il gating del toggle `notifyPrClosed` decide solo la
      // consegna al webhook d'istanza ed è centralizzato dentro
      // publishNotification: qui non si decide nulla. publishNotification non
      // lancia mai, ma il nome del progetto è in una query a parte: la
      // racchiudiamo comunque in try/catch per non far fallire la 204.
      try {
        const [repository] = await instance.db
          .select({ name: repositories.name })
          .from(repositories)
          .where(eq(repositories.id, context.repositoryId));
        await publishNotification(
          instance.db,
          {
            kind: "job.pr_closed",
            ticketNumber: ticket.number,
            ticketTitle: ticket.title,
            projectName: repository?.name ?? "",
            prUrl: event.prUrl,
            ticketUrl: ticketUrl(instance.publicUrl, ticket.id),
          },
          {
            projectId: ticket.projectId,
            ticketId: ticket.id,
            ...(closedJobId !== undefined ? { jobId: closedJobId } : {}),
          },
        );
      } catch {
        // Best-effort: una notifica mancata non deve disfare la riapertura.
      }

      return reply.code(204).send();
    },
  );
}

declare module "fastify" {
  interface FastifyRequest {
    /** Corpo grezzo del webhook, catturato dal content-type parser per l'HMAC. */
    rawBody?: Buffer;
    /** Repository e provider autenticati dalla verifica della firma del webhook. */
    webhookContext?: { repositoryId: string; provider: "bitbucket" | "github" };
  }
}
