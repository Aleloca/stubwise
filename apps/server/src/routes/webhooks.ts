import { getProvider } from "@stubwise/git";
import { t } from "@stubwise/i18n";
import { dispatchNotification } from "@stubwise/notifications";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { aiJobs, comments, docAutoUpdateJobs, docGenerations, projects, tickets } from "@stubwise/db";
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
        const [project] = await instance.db
          .select({
            id: projects.id,
            provider: projects.provider,
            webhookSecret: projects.webhookSecret,
          })
          .from(projects)
          .where(eq(projects.slug, projectSlug));

        // Slug sconosciuto o segreto vuoto (legacy, non verificabile): 401,
        // indistinguibile da una firma errata.
        if (!project || project.webhookSecret === "") {
          return apiError(reply, 401, "webhook_unauthorized", "Webhook unauthorized");
        }
        const provider = getProvider(project.provider);
        const headers = normalizeHeaders(request.headers);
        const rawBody = request.rawBody ?? Buffer.alloc(0);
        if (!provider.verifyWebhook(headers, rawBody, project.webhookSecret)) {
          return apiError(reply, 401, "webhook_unauthorized", "Webhook unauthorized");
        }

        request.webhookContext = { projectId: project.id, provider: project.provider };
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
        const [project] = await instance.db
          .select({
            defaultBranch: projects.defaultBranch,
            docAutoUpdate: projects.docAutoUpdate,
            currentDocGenerationId: projects.currentDocGenerationId,
          })
          .from(projects)
          .where(eq(projects.id, context.projectId));

        // Gate: si agisce solo sui push al branch di default di un progetto col
        // toggle attivo. Tutto il resto è no-op (un push su un branch di feature
        // o con auto-update spento non innesca nulla).
        if (!project || push.branch !== project.defaultBranch || project.docAutoUpdate !== true) {
          return reply.code(204).send();
        }

        // Base del diff all'INSERIMENTO del job: il commit della generazione Docs
        // corrente, se presente e registrato; altrimenti il `before` del push.
        // Su conflitto NON si tocca `fromSha`, così accumula dal primo push.
        let fromShaOnInsert = push.beforeSha;
        if (project.currentDocGenerationId) {
          const [generation] = await instance.db
            .select({ commitSha: docGenerations.commitSha })
            .from(docGenerations)
            .where(eq(docGenerations.id, project.currentDocGenerationId));
          if (generation?.commitSha) fromShaOnInsert = generation.commitSha;
        }

        // Upsert sul vincolo unique (project_id): un solo job pending per
        // progetto. Push ravvicinati aggiornano solo head e finestra di debounce.
        const notBefore = new Date(Date.now() + DEBOUNCE_MS);
        await instance.db
          .insert(docAutoUpdateJobs)
          .values({
            projectId: context.projectId,
            fromSha: fromShaOnInsert,
            toSha: push.afterSha,
            notBefore,
          })
          .onConflictDoUpdate({
            target: docAutoUpdateJobs.projectId,
            set: { toSha: push.afterSha, notBefore },
          });

        return reply.code(204).send();
      }

      const event = provider.parseWebhook(headers, request.body);
      // Non è un merge di PR che ci interessa: ignorato (204), niente da fare.
      if (!event) return reply.code(204).send();

      const match = STUBWISE_BRANCH_RE.exec(event.branch);
      // Ramo non gestito da Stubwise: ignorato.
      if (!match) return reply.code(204).send();
      const ticketNumber = Number(match[1]);

      const [ticket] = await instance.db
        .select({
          id: tickets.id,
          status: tickets.status,
          number: tickets.number,
          title: tickets.title,
        })
        .from(tickets)
        .where(and(eq(tickets.projectId, context.projectId), eq(tickets.number, ticketNumber)));

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

        await instance.db.transaction(async (tx) => {
          await tx.update(tickets).set({ status: "done" }).where(eq(tickets.id, ticket.id));
          await tx.insert(comments).values({
            ticketId: ticket.id,
            authorType: "system",
            body: t(lang, "comment.prMerged", { url: event.prUrl }),
          });
          // Allinea il job AI alla realtà: la PR aperta dalla pipeline è stata
          // mergiata. Si tocca SOLO il job in stato `pr_opened` (al più uno per
          // ticket), così una ri-consegna del webhook trova zero righe da
          // aggiornare (idempotenza) e gli altri stati restano intatti.
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

      // event.kind === "closed_unmerged": riapertura del ticket.
      // Agiamo SOLO se il ticket è ancora in review (la pipeline ci ha appena
      // aperto la PR). Qualunque altro stato → 204 idempotente: una ri-consegna,
      // o un ticket già ripreso/concluso a mano, non deve produrre effetti.
      if (!ticket || ticket.status !== "in_review") return reply.code(204).send();

      await instance.db.transaction(async (tx) => {
        await tx.update(tickets).set({ status: "triaged" }).where(eq(tickets.id, ticket.id));
        await tx.insert(comments).values({
          ticketId: ticket.id,
          authorType: "system",
          body: t(lang, "comment.prClosed", { url: event.prUrl }),
        });
        // Allinea il job AI: la PR aperta dalla pipeline è stata chiusa senza
        // merge. Si tocca SOLO il job `pr_opened` (idempotenza: una ri-consegna
        // non trova righe), gli altri stati restano intatti.
        await tx
          .update(aiJobs)
          .set({
            status: "pr_closed",
            finishedAt: sql`coalesce(${aiJobs.finishedAt}, now())`,
            lastActivityAt: sql`now()`,
          })
          .where(and(eq(aiJobs.ticketId, ticket.id), eq(aiJobs.status, "pr_opened")));
      });

      // Notifica best-effort job.pr_closed DOPO il commit (riflette realtà
      // committata). Il gating del toggle `notifyPrClosed` è centralizzato in
      // dispatchNotification, qui non si decide nulla. dispatchNotification non
      // lancia mai, ma il nome del progetto è in una query a parte: la
      // racchiudiamo comunque in try/catch per non far fallire la 204.
      try {
        const [project] = await instance.db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, context.projectId));
        await dispatchNotification(instance.db, {
          kind: "job.pr_closed",
          ticketNumber: ticket.number,
          ticketTitle: ticket.title,
          projectName: project?.name ?? "",
          prUrl: event.prUrl,
          ticketUrl: ticketUrl(instance.publicUrl, ticket.id),
        });
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
    /** Progetto e provider autenticati dalla verifica della firma del webhook. */
    webhookContext?: { projectId: string; provider: "bitbucket" | "github" };
  }
}
