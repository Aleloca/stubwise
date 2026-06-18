import { asc } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ticketTypeSchema, type TicketType } from "@stubwise/shared";
import { decrypt, instanceSettings, projects } from "@stubwise/db";
import { ProjectNotFoundError } from "../db/tickets.js";
import { createExternalTicket } from "../ingest/processor.js";
import { resolveReporter } from "../ingest/reporter.js";
import { publicUrlOrUndefined, ticketUrl } from "../ingest/shared.js";
import { apiError } from "../errors.js";
import { createSlackClient, type SlackClient } from "./api.js";
import { ACTION_IDS, BLOCK_IDS, buildTicketModal } from "./modal.js";
import { verifySlackSignature } from "./verify.js";

/**
 * Tetto al corpo delle richieste Slack (1 MiB): un payload di interactivity sta
 * largamente sotto. Protegge il parser raw da corpi smisurati.
 */
const MAX_SLACK_BODY_BYTES = 1024 * 1024;

/** Lunghezza massima del titolo, allineata alla validazione ticket. */
const TITLE_MAX = 300;

/**
 * Fabbrica del client Slack iniettabile a livello d'app: in produzione
 * costruisce il client reale dal bot token (con fetch globale); nei test si
 * passa un fake che non tocca la rete. Definita qui e referenziata da
 * BuildAppOptions tramite l'augmentation del modulo fastify.
 */
export type SlackClientFactory = (botToken: string) => SlackClient;

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
}

/** Credenziali Slack decifrate, o null se l'integrazione non è configurata. */
interface SlackCreds {
  signingSecret: string;
  botToken: string;
}

/**
 * Carica e decifra signing secret + bot token dalle instance settings
 * (singleton id=1). Ritorna null se uno dei due manca (integrazione non
 * completa) o se la decifratura fallisce (blob corrotto/chiave errata): in
 * entrambi i casi il flusso Slack è trattato come "non abilitato". I segreti
 * non vengono mai loggati.
 */
async function loadSlackCreds(instance: FastifyInstance): Promise<SlackCreds | null> {
  const [row] = await instance.db
    .select({
      signing: instanceSettings.slackSigningSecretEncrypted,
      bot: instanceSettings.slackBotTokenEncrypted,
    })
    .from(instanceSettings)
    .limit(1);
  if (!row?.signing || !row.bot) return null;
  try {
    return {
      signingSecret: decrypt(row.signing, instance.encryptionKey),
      botToken: decrypt(row.bot, instance.encryptionKey),
    };
  } catch {
    return null;
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

/** Progetti per il select del modal, ordinati per nome. */
async function listProjects(instance: FastifyInstance): Promise<{ id: string; name: string }[]> {
  return instance.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .orderBy(asc(projects.name));
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
    state?: { values?: Record<string, Record<string, SlackStateValue>> };
  };
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
  const clientFactory = opts.slackClientFactory ?? ((token: string) => createSlackClient(token));

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

      // Attribuzione best-effort: email dell'utente Slack → utente Stubwise.
      const userId = payload.user?.id;
      const email = userId ? await client.getUserEmail(userId) : null;
      const assigneeId = await resolveReporter(instance.db, email);

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
