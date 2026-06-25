import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ticketTypeSchema, type TicketType } from "@stubwise/shared";
import { docPages, projects, users } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { ProjectNotFoundError } from "../db/tickets.js";
import { createExternalTicket } from "../ingest/processor.js";
import { resolveReporter, resolveReporterBySlackId } from "../ingest/reporter.js";
import { publicUrlOrUndefined, ticketUrl } from "../ingest/shared.js";
import { apiError } from "../errors.js";
import type { ChatLlm } from "../routes/chat-llm.js";
import { answerDocsQuestion } from "../routes/docs-rag.js";
import { isUniqueViolation } from "../routes/shared.js";
import { ACTION_IDS, BLOCK_IDS, buildTicketModal } from "./modal.js";
import {
  buildDocsQueryModal,
  DOCS_ACTION_IDS,
  DOCS_BLOCK_IDS,
  DOCS_QUERY_CALLBACK_ID,
} from "./docs-modal.js";
import { loadSlackCreds, defaultSlackClientFactory, type SlackClientFactory } from "./creds.js";
import { verifySlackSignature } from "./verify.js";

/**
 * Tetto al corpo delle richieste Slack (1 MiB): un payload di interactivity sta
 * largamente sotto. Protegge il parser raw da corpi smisurati.
 */
const MAX_SLACK_BODY_BYTES = 1024 * 1024;

/** Lunghezza massima del titolo, allineata alla validazione ticket. */
const TITLE_MAX = 300;

// SlackClientFactory è definita in ./creds.js (condivisa con le route admin di
// gestione identità); re-export per compatibilità con gli import esistenti.
export type { SlackClientFactory } from "./creds.js";

export interface SlackRoutesOptions {
  /**
   * Fabbrica del client Slack. Default: client reale via fetch globale.
   * Override nei test per iniettare un fake (niente rete).
   */
  slackClientFactory?: SlackClientFactory;
  /**
   * Sorgente del tempo per la verifica della firma (anti-replay). Default:
   * Date.now. Iniettabile nei test per firmare con un timestamp deterministico.
   */
  now?: () => number;
  /**
   * Client di embedding per il retrieval RAG dei Docs (risposta `/docs` via
   * Slack). Default: `instance.embeddingClient` (lo stesso decorato sull'app e
   * usato dalla chat web). Override nei test per iniettare un fake.
   */
  embeddingClient?: EmbeddingClient;
  /**
   * LLM della chat RAG per generare la risposta `/docs`. Default:
   * `instance.chatLlm` (la stessa istanza usata dalla chat web). Override nei
   * test per iniettare un fake.
   */
  chatLlm?: ChatLlm;
  /**
   * URL pubblico dell'istanza, per comporre i link alle citazioni
   * (`${publicUrl}/docs/:projectId/:slug`). Default: `instance.publicUrl` se
   * configurato, altrimenti undefined (le citazioni elencano solo i titoli).
   */
  publicUrl?: string;
  /**
   * POST best-effort verso un response_url di Slack (risposta differita post-ack).
   * Default: `fetch` JSON con try/catch (gli errori sono assorbiti: la risposta
   * differita è best-effort, mai un 5xx verso Slack). Iniettabile nei test come
   * spy senza toccare la rete.
   */
  postResponse?: (url: string, payload: unknown) => Promise<void>;
}

/**
 * POST best-effort di default verso un response_url Slack: JSON via fetch, con
 * gli errori assorbiti (la risposta differita non deve mai propagare un errore
 * né bloccare l'ack già inviato).
 */
async function defaultPostResponse(url: string, payload: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort: niente da fare se Slack non è raggiungibile.
  }
}

/**
 * Verifica la firma Slack sul raw body. Ritorna true se valida; in caso
 * contrario risponde 401 e ritorna false (il chiamante interrompe).
 */
function verifyOrReject(
  request: FastifyRequest,
  reply: FastifyReply,
  signingSecret: string,
  now: () => number,
): boolean {
  const ok = verifySlackSignature({
    rawBody: request.rawBody?.toString("utf8") ?? "",
    signature: header(request, "x-slack-signature"),
    timestamp: header(request, "x-slack-request-timestamp"),
    signingSecret,
    now: now(),
  });
  if (!ok) {
    apiError(reply, 401, "slack_unauthorized", "Invalid Slack signature");
    return false;
  }
  return true;
}

/** Estrae un header come stringa singola (Fastify dà string | string[]). */
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Riconosce il comando di interrogazione dei Docs. Oltre a `/docs`, accetta le
 * varianti con namespace/suffisso che l'utente può scegliere in Slack (es.
 * `/stubwise:docs`, `/qualcosa-docs`): il campo `command` arriva col nome esatto
 * configurato e non possiamo imporlo. Ogni altro comando cade nel ramo ticket.
 */
function isDocsCommand(command: string | undefined): boolean {
  if (!command) return false;
  return command === "/docs" || command.endsWith(":docs") || command.endsWith("-docs");
}

/** Progetti per il select del modal, ordinati per nome. */
async function listProjects(instance: FastifyInstance): Promise<{ id: string; name: string }[]> {
  return instance.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .orderBy(asc(projects.name));
}

/**
 * Progetti CON documentazione — stesso criterio dell'hub `GET /api/docs/spaces`:
 * almeno una pagina visibile (generazione corrente OR manuale). Restituisce
 * id/name/slug; popolano le option dello static_select progetto del modal /docs.
 * Il join sulle pagine è ristretto come in docs.ts così le generazioni stale non
 * fanno comparire un progetto come "con documentazione".
 */
async function listProjectsWithDocs(
  db: Db,
): Promise<{ id: string; name: string; slug: string }[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      pageCount: sql<number>`count(${docPages.id})::int`,
    })
    .from(projects)
    .leftJoin(
      docPages,
      and(
        eq(docPages.projectId, projects.id),
        or(
          eq(docPages.generationId, projects.currentDocGenerationId),
          isNull(docPages.generationId),
        ),
      ),
    )
    .groupBy(projects.id, projects.name, projects.slug)
    .orderBy(asc(projects.name));
  return rows
    .filter((r) => r.pageCount > 0)
    .map((r) => ({ id: r.id, name: r.name, slug: r.slug }));
}

/**
 * Genera la risposta RAG ai Docs e la posta sul response_url di Slack (fase
 * differita, DOPO l'ack della view_submission). Best-effort end-to-end: ogni
 * esito (chat non disponibile, errore di generazione) si traduce in un messaggio
 * leggibile via response_url; NON propaga MAI (il chiamante la lancia
 * fire-and-forget).
 */
async function answerAndPostToSlack(
  deps: {
    db: Db;
    embeddingClient: EmbeddingClient;
    chatLlm: ChatLlm;
    postResponse: (url: string, payload: unknown) => Promise<void>;
    publicUrl?: string;
  },
  input: { projectId: string; question: string; responseUrl: string },
): Promise<void> {
  // Pre-flight: se l'LLM espone isAvailable e la chat non è servibile (tipico:
  // nessun provider api_key), rispondi con un messaggio chiaro invece di
  // fallire a metà generazione.
  if (deps.chatLlm.isAvailable) {
    const availability = await deps.chatLlm.isAvailable();
    if (!availability.available) {
      await deps.postResponse(input.responseUrl, {
        response_type: "ephemeral",
        text: "La chat AI non è disponibile (configura un provider con API key).",
      });
      return;
    }
  }

  try {
    const { text, citations } = await answerDocsQuestion(
      { db: deps.db, embeddingClient: deps.embeddingClient, chatLlm: deps.chatLlm },
      { projectId: input.projectId, question: input.question },
    );

    // Risposta come blocco mrkdwn: il markdown del modello passa così com'è
    // (Slack ne rende un sottoinsieme). I link cliccabili sono nei blocchi
    // dedicati alle fonti.
    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: text || "(nessuna risposta)" } },
    ];
    if (citations.length > 0) {
      const sources = citations
        .map((c) =>
          deps.publicUrl
            ? `<${deps.publicUrl}/docs/${input.projectId}/${c.slug}|${c.title}>`
            : c.title,
        )
        .join("  ·  ");
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `*Fonti:* ${sources}` }],
      });
    }

    await deps.postResponse(input.responseUrl, { response_type: "in_channel", blocks });
  } catch {
    // Best-effort: errore di generazione/retrieval → messaggio effimero. Niente
    // throw (fire-and-forget); il chiamante logga via .catch.
    await deps.postResponse(input.responseUrl, {
      response_type: "ephemeral",
      text: "Errore durante la ricerca nella documentazione.",
    });
  }
}

/** Estrae un valore di static_select da view.state.values, o undefined. */
function selectedValue(
  values: Record<string, Record<string, SlackStateValue>> | undefined,
  blockId: string,
  actionId: string,
): string | undefined {
  return values?.[blockId]?.[actionId]?.selected_option?.value;
}

/** Estrae un valore di plain_text_input da view.state.values, o undefined. */
function inputValue(
  values: Record<string, Record<string, SlackStateValue>> | undefined,
  blockId: string,
  actionId: string,
): string | undefined {
  const raw = values?.[blockId]?.[actionId]?.value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

interface SlackStateValue {
  value?: string;
  selected_option?: { value?: string };
}

interface SlackInteractionPayload {
  type?: string;
  trigger_id?: string;
  user?: { id?: string; username?: string; name?: string };
  message?: { text?: string };
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, SlackStateValue>> };
  };
  // Presenti su `block_suggestions` (autocomplete external_select): il testo
  // digitato e l'action_id dell'elemento che sta suggerendo.
  value?: string;
  action_id?: string;
}

/** Contesto serializzato nel private_metadata del modal /docs. */
interface DocsQueryMetadata {
  responseUrl?: string;
  channelId?: string;
  slackUserId?: string;
}

/** Acknowledgement vuoto e immediato (200): chiude il modal / conferma a Slack. */
function ack(reply: FastifyReply): FastifyReply {
  return reply.code(200).send();
}

/**
 * Route dell'integrazione Slack, registrate sotto /api/slack. Comprende lo
 * slash command (`/commands`) e l'interactivity (`/interactions`).
 *
 * RAW BODY: la firma Slack è calcolata sul corpo grezzo. Questo scope registra
 * un content-type parser per `application/x-www-form-urlencoded` LIMITATO a
 * questo plugin che cattura il Buffer su `request.rawBody` e poi parsa i campi
 * in un oggetto via URLSearchParams. Essendo scoped, /api, /ingest e i webhook
 * git mantengono i loro parser. Slack invia sempre urlencoded (anche
 * l'interactivity, che mette il JSON dentro il campo `payload`).
 *
 * "SLACK NON ABILITATO": se signing secret o bot token mancano (o non sono
 * decifrabili), gli endpoint NON lanciano 500. `/commands` risponde 200 con un
 * messaggio effimero ("non configurato"), così l'utente lo vede in Slack senza
 * errori; `/interactions` risponde 200 vuoto (non c'è interazione possibile
 * senza credenziali, e Slack non deve vedere un 5xx).
 */
export async function slackRoutes(
  instance: FastifyInstance,
  opts: SlackRoutesOptions = {},
): Promise<void> {
  const now = opts.now ?? Date.now;
  const clientFactory = opts.slackClientFactory ?? defaultSlackClientFactory;
  const postResponse = opts.postResponse ?? defaultPostResponse;
  // embeddingClient/chatLlm/publicUrl: di default le STESSE istanze decorate
  // sull'app (usate dalla chat web). publicUrl ha un getter che lancia se non
  // configurato: lo si legge in modo difensivo (le citazioni elencano i soli
  // titoli se manca).
  const embeddingClient = opts.embeddingClient ?? instance.embeddingClient;
  const chatLlm = opts.chatLlm ?? instance.chatLlm;
  let publicUrl = opts.publicUrl;
  if (publicUrl === undefined) {
    try {
      publicUrl = instance.publicUrl;
    } catch {
      publicUrl = undefined;
    }
  }

  // Parser urlencoded con cattura del raw body, limitato a questo scope.
  instance.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer", bodyLimit: MAX_SLACK_BODY_BYTES },
    (request, body: Buffer, done) => {
      request.rawBody = body;
      // Parsing dei campi form in un oggetto piatto (l'ultimo valore vince).
      const params = new URLSearchParams(body.toString("utf8"));
      done(null, Object.fromEntries(params));
    },
  );

  // POST /api/slack/commands — slash command /stubwise.
  instance.post("/commands", async (request, reply) => {
    const creds = await loadSlackCreds(instance);
    if (!creds) {
      // Non abilitato: 200 + messaggio effimero (lo vede solo chi ha lanciato).
      return reply
        .code(200)
        .send({ response_type: "ephemeral", text: "Slack integration is not configured." });
    }
    if (!verifyOrReject(request, reply, creds.signingSecret, now)) return reply;

    const body = request.body as Record<string, string>;
    const command = body.command;

    // Branch /docs: apre il modal di interrogazione dei Docs, ma SOLO per gli
    // utenti Slack già collegati a un account Stubwise. Additivo: il ramo
    // ticket sottostante resta invariato per ogni altro comando.
    if (isDocsCommand(command)) {
      // Auth: l'utente Slack dev'essere mappato a un utente Stubwise.
      const [linked] = body.user_id
        ? await instance.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.slackUserId, body.user_id))
        : [];
      if (!linked) {
        // Non collegato (o user id assente): messaggio effimero, niente modal.
        return reply.code(200).send({
          response_type: "ephemeral",
          text: "Non sei collegato a un account Stubwise. Chiedi a un admin di collegarti dalle impostazioni.",
        });
      }

      // Progetti CON documentazione: popolano il static_select del modal. Se
      // nessuno ha ancora docs generate, non c'è nulla da interrogare → messaggio
      // effimero (lo static_select non può avere zero option).
      const docsProjects = await listProjectsWithDocs(instance.db);
      if (docsProjects.length === 0) {
        return reply.code(200).send({
          response_type: "ephemeral",
          text: "Nessun progetto ha ancora documentazione generata. Genera prima la documentazione di un progetto.",
        });
      }

      const docsTriggerId = body.trigger_id;
      if (docsTriggerId) {
        const client = clientFactory(creds.botToken);
        await client.openView(
          docsTriggerId,
          buildDocsQueryModal({
            projects: docsProjects.map((p) => ({ id: p.id, name: p.name })),
            prefillQuestion: body.text?.trim() || undefined,
            privateMetadata: JSON.stringify({
              responseUrl: body.response_url,
              channelId: body.channel_id,
              slackUserId: body.user_id,
            }),
          }),
        );
      }
      return ack(reply);
    }

    const triggerId = body.trigger_id;
    if (triggerId) {
      const client = clientFactory(creds.botToken);
      const projectList = await listProjects(instance);
      // Il testo digitato dopo `/stubwise` (campo `text` dello slash command)
      // precompila il titolo, troncato al limite del titolo ticket. Vuoto/assente
      // → modal senza prefill.
      const text = body.text?.trim();
      const prefill = text ? { title: text.slice(0, TITLE_MAX) } : undefined;
      // best-effort: se views.open fallisce, l'utente non vede il modal, ma
      // non c'è nulla di utile da dire a Slack oltre al 200 d'ack.
      await client.openView(triggerId, buildTicketModal({ projects: projectList, prefill }));
    }
    // Ack immediato (entro 3s): nessuna creazione qui.
    return ack(reply);
  });

  // POST /api/slack/interactions — interactivity (message action + view submit).
  instance.post("/interactions", async (request, reply) => {
    const creds = await loadSlackCreds(instance);
    // Non abilitato: 200 vuoto, niente 5xx verso Slack.
    if (!creds) return ack(reply);
    if (!verifyOrReject(request, reply, creds.signingSecret, now)) return reply;

    const body = request.body as Record<string, string>;
    let payload: SlackInteractionPayload;
    try {
      payload = JSON.parse(body.payload ?? "{}") as SlackInteractionPayload;
    } catch {
      // Payload non valido: ack 200, non è un errore lato Slack da segnalare.
      return ack(reply);
    }

    const client = clientFactory(creds.botToken);

    if (payload.type === "message_action") {
      // Apre il modal precompilato dal testo del messaggio: prima riga (max
      // 300) come titolo, testo intero come descrizione.
      const text = payload.message?.text ?? "";
      const firstLine = text.split("\n", 1)[0] ?? "";
      const title = firstLine.slice(0, TITLE_MAX);
      if (payload.trigger_id) {
        const projectList = await listProjects(instance);
        await client.openView(
          payload.trigger_id,
          buildTicketModal({
            projects: projectList,
            prefill: { title, description: text },
          }),
        );
      }
      return ack(reply);
    }

    if (payload.type === "view_submission") {
      // Branch /docs: la view di interrogazione dei Docs (callback_id dedicato).
      // Additivo, PRIMA della logica ticket; se il callback_id non è quello,
      // prosegue invariato col flusso ticket sottostante.
      if (payload.view?.callback_id === DOCS_QUERY_CALLBACK_ID) {
        const docsValues = payload.view?.state?.values;
        const docsProjectId = selectedValue(
          docsValues,
          DOCS_BLOCK_IDS.project,
          DOCS_ACTION_IDS.project,
        );
        const question = inputValue(docsValues, DOCS_BLOCK_IDS.question, DOCS_ACTION_IDS.question);

        // Contesto dello slash command, propagato via private_metadata. Se non
        // parsabile, non c'è response_url su cui rispondere: ack e basta.
        let meta: DocsQueryMetadata;
        try {
          meta = JSON.parse(payload.view.private_metadata ?? "{}") as DocsQueryMetadata;
        } catch {
          return ack(reply);
        }

        // Validazione: progetto + domanda obbligatori, errori ancorati ai block.
        const docsErrors: Record<string, string> = {};
        if (!docsProjectId) docsErrors[DOCS_BLOCK_IDS.project] = "Seleziona un progetto.";
        if (!question) docsErrors[DOCS_BLOCK_IDS.question] = "Inserisci una domanda.";
        if (Object.keys(docsErrors).length > 0) {
          return reply.code(200).send({ response_action: "errors", errors: docsErrors });
        }

        // Ri-auth: lo Slack user del submit deve essere ancora collegato a un
        // utente Stubwise (lo stesso dello slash command). Se non lo è più, ack
        // + messaggio effimero best-effort (la generazione non parte).
        const [linked] = meta.slackUserId
          ? await instance.db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.slackUserId, meta.slackUserId))
          : [];
        if (!linked) {
          if (meta.responseUrl) {
            await postResponse(meta.responseUrl, {
              response_type: "ephemeral",
              text: "Non sei più collegato a Stubwise.",
            });
          }
          return ack(reply);
        }

        // Senza response_url non c'è dove postare la risposta differita: ack.
        if (!meta.responseUrl) return ack(reply);

        // ACK IMMEDIATO (entro 3s) + generazione ASYNC fire-and-forget: l'ack
        // chiude il modal subito, il RAG prosegue dopo e posta via response_url.
        // L'ack NON deve aspettare il RAG.
        const ackReply = ack(reply);
        const responseUrl = meta.responseUrl;
        void answerAndPostToSlack(
          { db: instance.db, embeddingClient, chatLlm, postResponse, publicUrl },
          { projectId: docsProjectId!, question: question!, responseUrl },
        ).catch((err) => {
          request.log.warn({ err }, "[slack] docs answer failed");
        });
        return ackReply;
      }

      const values = payload.view?.state?.values;
      const projectId = selectedValue(values, BLOCK_IDS.project, ACTION_IDS.project);
      const title = inputValue(values, BLOCK_IDS.title, ACTION_IDS.title);
      const description = inputValue(values, BLOCK_IDS.description, ACTION_IDS.description);
      const typeRaw = selectedValue(values, BLOCK_IDS.type, ACTION_IDS.type);

      // Validazione: campi obbligatori + tipo nell'enum. Mancante/invalido →
      // response_action: errors, ancorato al block corrispondente, nessun
      // ticket creato.
      const errors: Record<string, string> = {};
      if (!projectId) errors[BLOCK_IDS.project] = "Seleziona un progetto.";
      if (!title) errors[BLOCK_IDS.title] = "Inserisci un titolo.";
      const typeParsed = ticketTypeSchema.safeParse(typeRaw);
      if (!typeParsed.success) errors[BLOCK_IDS.type] = "Seleziona un tipo valido.";
      if (Object.keys(errors).length > 0 || !typeParsed.success) {
        return reply.code(200).send({ response_action: "errors", errors });
      }
      const type: TicketType = typeParsed.data;

      // Attribuzione best-effort. Si tenta prima il match diretto sullo Slack
      // user id (utente già linkato): immediato e senza chiamate a Slack. Se
      // non c'è match, si ripiega sul profilo Slack (email) → utente Stubwise,
      // e — se il match avviene per email su un utente non ancora linkato — si
      // fa un auto-link best-effort dello Slack id/avatar.
      const slackUserId = payload.user?.id;
      let assigneeId = await resolveReporterBySlackId(instance.db, slackUserId);
      if (assigneeId === null && slackUserId) {
        // Recupera il profilo una sola volta: serve sia per l'email (fallback)
        // sia per l'avatar dell'auto-link.
        const profile = await client.getUserProfile(slackUserId);
        assigneeId = await resolveReporter(instance.db, profile?.email);
        // Auto-link best-effort: l'utente è stato trovato per email ma non ha
        // ancora uno Slack id. Lo si valorizza (+ avatar se mancante) in modo
        // che le prossime attribuzioni passino dal match diretto. Qualsiasi
        // errore (unique violation per id già di un altro utente, problema
        // Slack) viene assorbito: NON deve impedire la creazione del ticket.
        if (assigneeId !== null) {
          try {
            await instance.db
              .update(users)
              .set({
                slackUserId,
                ...(profile?.avatarUrl ? { slackAvatarUrl: profile.avatarUrl } : {}),
              })
              .where(and(eq(users.id, assigneeId), isNull(users.slackUserId)));
          } catch (err) {
            if (!isUniqueViolation(err)) {
              request.log.warn({ err }, "[slack] auto-link Slack id fallito (ignorato)");
            }
          }
        }
      }

      const who = payload.user?.username ?? payload.user?.name ?? "unknown";
      const reporterNote =
        assigneeId === null
          ? `Reported via Slack by @${who} (no Stubwise account)`
          : `Reported via Slack by @${who}`;

      let ticket;
      try {
        ticket = await createExternalTicket(
          instance.db,
          { id: projectId! },
          {
            title: title!,
            body: description,
            type,
            priority: "medium",
            source: "slack",
            assigneeId,
            reporterNote,
          },
        );
      } catch (err) {
        // Progetto inesistente (cancellato tra apertura del modal e submit, o id
        // stantio): niente 500 verso Slack. Errore leggibile sul block progetto.
        if (err instanceof ProjectNotFoundError) {
          return reply.code(200).send({
            response_action: "errors",
            errors: { [BLOCK_IDS.project]: "This project no longer exists. Please pick another." },
          });
        }
        throw err;
      }

      // Log col link al ticket (best-effort, non blocca l'ack che chiude il modal).
      const url = ticketUrl(publicUrlOrUndefined(instance), ticket.id);
      request.log.info(`[slack] ticket #${ticket.number} creato (${url})`);

      // Ack vuoto: chiude il modal.
      return ack(reply);
    }

    // Tipo non gestito (es. block_actions): ack 200.
    return ack(reply);
  });
}
