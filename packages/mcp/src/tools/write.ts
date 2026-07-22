import type { TicketPriority, TicketStatus, TicketType } from "@stubwise/shared";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { errorResult, resolveProject, runTool, textResult } from "./shared.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

/** Intervallo di default tra due poll dello stato del job di backlog. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Timeout complessivo di default del polling dell'intake backlog. */
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
/**
 * Numero massimo di errori CONSECUTIVI di `getBacklogJob` tollerati durante il
 * polling prima di arrendersi. Un blip transitorio (StubwiseApiError, timeout di
 * rete) su un singolo tick non deve far perdere il `jobId`: la voce è GIÀ stata
 * accodata, va solo referenziata più tardi. Un tick riuscito azzera il contatore.
 */
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

/** Attesa reale (default): usata in produzione, sostituita nei test. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- create_ticket ----------------------------------------------------------

const createTicketInput = {
  project: z
    .string()
    .optional()
    .describe("Slug del progetto. Se omesso, usa il progetto collegato al repo corrente."),
  title: z.string().min(1).describe("Titolo del ticket."),
  body: z.string().optional().describe("Corpo/descrizione del ticket (markdown)."),
  type: z
    .enum(["bug", "feature", "task", "feedback", "review"])
    .optional()
    .describe("Tipo di ticket. Default: 'task'."),
  priority: z
    .enum(["low", "medium", "high", "urgent"])
    .optional()
    .describe("Priorità del ticket."),
};

const createTicket: ToolDef = {
  name: "create_ticket",
  description:
    "Crea un nuovo ticket in un progetto Stubwise. Risolve il progetto dallo slug 'project' o dal repo collegato. Il tipo di default è 'task'. Ritorna number, id e l'URL del dettaglio.",
  inputSchema: createTicketInput,
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const resolved = await resolveProject(args.project as string | undefined, ctx);
      if (!resolved.ok) return resolved.result;

      const ticket = await ctx.client.createTicket({
        projectId: resolved.project.id,
        title: args.title as string,
        body: args.body as string | undefined,
        type: (args.type as TicketType | undefined) ?? "task",
        priority: args.priority as TicketPriority | undefined,
      });

      const url = `${ctx.config.baseUrl}/tickets/${ticket.id}`;
      return textResult(
        `Ticket #${ticket.number} creato (id: ${ticket.id}, tipo: ${ticket.type}, priorità: ${ticket.priority}).\nURL: ${url}`,
      );
    }),
};

// --- convert_backlog_to_ticket ----------------------------------------------

const convertBacklogInput = {
  id: z.string().uuid().describe("UUID della voce di backlog da convertire in ticket."),
};

const convertBacklogToTicket: ToolDef = {
  name: "convert_backlog_to_ticket",
  description:
    "Converte una voce di backlog (per id) in un ticket task aperto. Ritorna id e number del ticket creato, con l'URL del dettaglio. Può richiedere permessi elevati (403 se non autorizzato).",
  inputSchema: convertBacklogInput,
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const { ticketId, ticketNumber } = await ctx.client.convertBacklogToTicket(
        args.id as string,
      );
      const url = `${ctx.config.baseUrl}/tickets/${ticketId}`;
      return textResult(
        `Voce di backlog convertita nel ticket #${ticketNumber} (id: ${ticketId}).\nURL: ${url}`,
      );
    }),
};

// --- set_ticket_status ------------------------------------------------------

const setTicketStatusInput = {
  id: z.string().describe("UUID del ticket."),
  // z.enum REALE con i 6 stati validi: così Claude vede i valori ammessi e lo
  // schema rifiuta uno stato fuori enum prima di arrivare all'handler.
  status: z
    .enum(["open", "triaged", "in_progress", "in_review", "done", "closed"])
    .describe("Nuovo stato del ticket."),
};

const setTicketStatus: ToolDef = {
  name: "set_ticket_status",
  description:
    "Cambia lo stato di un ticket (open, triaged, in_progress, in_review, done, closed). Ritorna conferma con il nuovo stato.",
  inputSchema: setTicketStatusInput,
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const ticket = await ctx.client.setTicketStatus(
        args.id as string,
        args.status as TicketStatus,
      );
      return textResult(`Stato del ticket #${ticket.number} aggiornato a '${ticket.status}'.`);
    }),
};

// --- create_backlog_item (con POLLING dell'intake) --------------------------

const createBacklogItemInput = {
  project: z
    .string()
    .optional()
    .describe("Slug del progetto. Se omesso, usa il progetto collegato al repo corrente."),
  title: z.string().min(1).describe("Titolo della voce di backlog."),
  body: z.string().min(1).describe("Contenuto/descrizione della voce di backlog (markdown)."),
};

const createBacklogItem: ToolDef = {
  name: "create_backlog_item",
  description:
    "Crea una voce nel backlog di discovery di un progetto e ne segue l'elaborazione (intake asincrono). Risolve il progetto dallo slug 'project' o dal repo collegato. In caso di successo ritorna l'id della voce e l'URL, da referenziare nel frontmatter del documento. Se l'elaborazione non termina entro il timeout, ritorna 'accodata, in corso' (non è un errore): puoi procedere e aggiungere il riferimento più tardi.",
  inputSchema: createBacklogItemInput,
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const resolved = await resolveProject(args.project as string | undefined, ctx);
      if (!resolved.ok) return resolved.result;

      const { jobId } = await ctx.client.createBacklogItem({
        projectId: resolved.project.id,
        title: args.title as string,
        body: args.body as string,
      });

      const sleep = ctx.sleep ?? realSleep;
      // Guard su `intervalMs`: un valore 0 (config solo-test) non deve mai
      // avanzare l'elapsed a passi nulli → loop infinito. Min 1ms.
      const interval = Math.max(1, ctx.pollOptions?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      const timeoutMs = ctx.pollOptions?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

      // Polling a intervallo fisso. `elapsedMs` è un BUDGET di attese/poll: accumula
      // solo `interval` a ogni attesa (NON il wall-clock, quindi NON il tempo reale
      // delle round-trip HTTP). È deterministico per i test (uno `sleep` iniettato
      // che risolve subito forza il timeout con un `timeoutMs` piccolo e zero attese
      // reali), ma NON è un limite wall-clock stretto: con API lente la durata reale
      // del polling può superare il `timeoutMs` nominale.
      let elapsedMs = 0;
      // Errori di rete CONSECUTIVI su `getBacklogJob`. Non fanno perdere il jobId:
      // sotto soglia si continua (il tick successivo può risolvere il blip),
      // superata la soglia si esce con un esito PENDING non-eccezionale.
      let consecutiveErrors = 0;
      for (;;) {
        let job: Awaited<ReturnType<typeof ctx.client.getBacklogJob>>;
        try {
          job = await ctx.client.getBacklogJob(jobId);
          // Tick riuscito: un eventuale blip precedente è rientrato.
          consecutiveErrors = 0;
        } catch {
          // Blip transitorio (rete, StubwiseApiError): NON propagare — la voce è
          // già stata accodata, l'eccezione qui farebbe perdere il jobId a Claude.
          consecutiveErrors += 1;
          if (consecutiveErrors > MAX_CONSECUTIVE_POLL_ERRORS) {
            // Troppi errori di fila: smetti di fare polling, ma NON è un errore
            // fatale. Restituisci l'esito PENDING con il jobId così Claude può
            // referenziare la voce più tardi.
            return textResult(
              `Voce accodata (job ${jobId}), elaborazione ancora in corso: il riferimento andrà aggiunto più tardi. (verifica dello stato non riuscita)`,
            );
          }
          // Sotto soglia: aspetta e riprova, consumando comunque il budget.
          if (elapsedMs + interval > timeoutMs) {
            return textResult(
              `Voce accodata (job ${jobId}), elaborazione ancora in corso: il riferimento andrà aggiunto più tardi.`,
            );
          }
          await sleep(interval);
          elapsedMs += interval;
          continue;
        }

        if (job.status === "done") {
          // resultItemId è l'id della voce elaborata; in caso di auto-merge con
          // una voce simile esistente è l'id CANONICO di quella voce — resta il
          // riferimento corretto da usare, senza rami speciali.
          if (!job.resultItemId) {
            return errorResult(
              `Elaborazione della voce di backlog completata ma senza id risultante (job ${jobId}).`,
            );
          }
          const url = `${ctx.config.baseUrl}/backlog/${job.resultItemId}`;
          return textResult(
            `Voce di backlog elaborata (id: ${job.resultItemId}).\nURL: ${url}\nPuoi inserire questo riferimento nel frontmatter del documento. Se la voce è stata unita a una simile esistente, l'id è quello canonico da referenziare.`,
          );
        }

        if (job.status === "failed") {
          return errorResult(
            `L'elaborazione della voce di backlog è fallita: ${job.error ?? "errore sconosciuto"}`,
          );
        }

        // queued | running: continua a fare polling finché non scade il timeout.
        if (elapsedMs + interval > timeoutMs) {
          // Timeout: NON è un errore fatale. La voce è accodata; Claude può
          // procedere (committare il doc) e aggiungere il riferimento più tardi.
          return textResult(
            `Voce accodata (job ${jobId}), elaborazione ancora in corso: il riferimento andrà aggiunto più tardi.`,
          );
        }

        await sleep(interval);
        elapsedMs += interval;
      }
    }),
};

/** Tutti i tool di scrittura, nell'ordine di registrazione. */
export const writeTools: ToolDef[] = [
  createTicket,
  convertBacklogToTicket,
  setTicketStatus,
  createBacklogItem,
];

/**
 * Registra i tool di scrittura su un `McpServer`. Stessa forma di
 * `registerReadTools`: ogni tool è avvolto in una closure che gli passa il
 * `ctx` (client + config + eventuale sleep/pollOptions).
 */
export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  for (const def of writeTools) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      // Vedi nota in registerReadTools: cast al boundary dell'SDK, gli handler
      // restano tipizzati sul `ToolResult` testabile.
      ((args: Record<string, unknown>) => def.handler(args, ctx)) as Parameters<
        McpServer["registerTool"]
      >[2],
    );
  }
}
