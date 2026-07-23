import type {
  BacklogItemStatus,
  TicketPriority,
  TicketStatus,
  TicketType,
} from "@stubwise/shared";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Urgency } from "../client.js";
import { resolveProject, runTool, textResult } from "./shared.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

/**
 * Normalizza `statuses` di `list_tickets`, accettato sia come array di stringhe
 * sia come CSV (comodo per chi lo passa a mano). Ritorna `undefined` quando
 * vuoto, così il filtro non viene inviato affatto.
 */
function normalizeStatuses(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : value.split(",");
  const cleaned = list.map((s) => s.trim()).filter((s) => s.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

// --- list_projects ----------------------------------------------------------

const listProjects: ToolDef = {
  name: "list_projects",
  description:
    "Elenca tutti i progetti Stubwise dell'istanza (id, slug, name). Usa lo slug per collegare un repo con /stubwise:init o per i filtri degli altri tool.",
  inputSchema: {},
  handler: (_args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const projects = await ctx.client.listProjects();
      if (projects.length === 0) return textResult("Nessun progetto visibile con questo token.");
      const lines = projects.map((p) => `- ${p.name} (slug: ${p.slug}, id: ${p.id})`);
      return textResult(`Progetti (${projects.length}):\n${lines.join("\n")}`);
    }),
};

// --- list_backlog -----------------------------------------------------------

const listBacklogInput = {
  project: z
    .string()
    .optional()
    .describe("Slug del progetto. Se omesso, usa il progetto collegato al repo corrente."),
  status: z
    .string()
    .optional()
    .describe("Filtra per stato dell'item di backlog: new, refining, ready, converted, archived."),
  urgency: z
    .string()
    .optional()
    .describe("Filtra per urgenza (scala priority): low, medium, high, urgent."),
  q: z.string().optional().describe("Ricerca testuale libera."),
  limit: z.number().int().positive().optional().describe("Numero massimo di item."),
};

const listBacklog: ToolDef = {
  name: "list_backlog",
  description:
    "Mostra cosa c'è nel backlog di discovery di un progetto (idee/feature in raffinamento). Ogni voce ha id, titolo, stato, urgenza, effort e rischio. Risolve il progetto dallo slug 'project' o dal repo collegato.",
  inputSchema: listBacklogInput,
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const resolved = await resolveProject(args.project as string | undefined, ctx);
      if (!resolved.ok) return resolved.result;

      const page = await ctx.client.listBacklog({
        projectId: resolved.project.id,
        status: args.status as BacklogItemStatus | undefined,
        urgency: args.urgency as Urgency | undefined,
        q: args.q as string | undefined,
        limit: args.limit as number | undefined,
      });

      if (page.items.length === 0) {
        return textResult(`Nessuna voce di backlog per il progetto '${resolved.project.slug}'.`);
      }

      const lines = page.items.map((item) => {
        const parts = [`stato: ${item.status}`];
        if (item.urgency) parts.push(`urgenza: ${item.urgency}`);
        if (item.effort !== null) parts.push(`effort: ${item.effort}`);
        if (item.risk) parts.push(`rischio: ${item.risk}`);
        return `- ${item.title} [${parts.join(", ")}] (id: ${item.id})`;
      });
      return textResult(
        `Backlog di '${resolved.project.slug}' (${page.items.length}):\n${lines.join("\n")}`,
      );
    }),
};

// --- get_backlog_item -------------------------------------------------------

const getBacklogItemInput = {
  id: z.string().uuid().describe("UUID della voce di backlog."),
};

const getBacklogItem: ToolDef = {
  name: "get_backlog_item",
  description:
    "Recupera una singola voce di backlog per id, con i metadati e il DOCUMENTO completo (il contenuto testuale del refinement). Usalo per leggere il dettaglio prima di raffinare o convertire in ticket.",
  inputSchema: getBacklogItemInput,
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const item = await ctx.client.getBacklogItem(args.id as string);
      const meta = {
        id: item.id,
        projectId: item.projectId,
        title: item.title,
        status: item.status,
        urgency: item.urgency,
        effort: item.effort,
        risk: item.risk,
        riskNote: item.riskNote,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      const plan = item.implementationPlan ?? "(nessun piano di implementazione)";
      const origin = item.originContent ?? "(nessun contenuto d'origine: nessun design attivo)";
      return textResult(
        `${JSON.stringify(meta, null, 2)}\n\n--- Documento ---\n${item.document}` +
          `\n\n--- Piano di implementazione ---\n${plan}` +
          `\n\n--- Contenuto d'origine ---\n${origin}`,
      );
    }),
};

// --- list_tickets -----------------------------------------------------------

const listTicketsInput = {
  project: z
    .string()
    .optional()
    .describe("Slug del progetto. Se omesso, usa il progetto collegato al repo corrente."),
  statuses: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe(
      "Filtra per stati (array di stringhe o CSV): open, triaged, in_progress, in_review, done, closed.",
    ),
  type: z
    .string()
    .optional()
    .describe("Filtra per tipo di ticket: bug, feature, task, feedback, review."),
  priority: z
    .string()
    .optional()
    .describe("Filtra per priorità: low, medium, high, urgent."),
  q: z.string().optional().describe("Ricerca testuale libera."),
  limit: z.number().int().positive().optional().describe("Numero massimo di ticket."),
};

const listTickets: ToolDef = {
  name: "list_tickets",
  description:
    "Elenca i ticket di un progetto (number, title, status, type, priority), con filtri opzionali per stato/tipo/priorità e ricerca testuale. Risolve il progetto dallo slug 'project' o dal repo collegato.",
  inputSchema: listTicketsInput,
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const resolved = await resolveProject(args.project as string | undefined, ctx);
      if (!resolved.ok) return resolved.result;

      const page = await ctx.client.listTickets({
        projectId: resolved.project.id,
        statuses: normalizeStatuses(args.statuses as string[] | string | undefined) as
          | TicketStatus[]
          | undefined,
        type: args.type as TicketType | undefined,
        priority: args.priority as TicketPriority | undefined,
        q: args.q as string | undefined,
        limit: args.limit as number | undefined,
      });

      if (page.items.length === 0) {
        return textResult(`Nessun ticket per il progetto '${resolved.project.slug}'.`);
      }

      const lines = page.items.map(
        (t) =>
          `- #${t.number} ${t.title} [stato: ${t.status}, tipo: ${t.type}, priorità: ${t.priority}] (id: ${t.id})`,
      );
      return textResult(
        `Ticket di '${resolved.project.slug}' (${page.items.length}):\n${lines.join("\n")}`,
      );
    }),
};

// --- get_ticket -------------------------------------------------------------

const getTicketInput = {
  id: z.string().uuid().describe("UUID del ticket."),
};

const getTicket: ToolDef = {
  name: "get_ticket",
  description:
    "Recupera un singolo ticket per id, con tutti i campi (titolo, corpo, tipo, priorità, stato, labels, assegnatario). Usalo per leggere il dettaglio di un ticket.",
  inputSchema: getTicketInput,
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const ticket = await ctx.client.getTicket(args.id as string);
      // Corpo e piano/origine possono essere lunghi: fuori dal JSON dei metadati,
      // in sezioni leggibili con empty state esplicito quando null.
      const { implementationPlan, originContent, ...meta } = ticket;
      const plan = implementationPlan ?? "(nessun piano di implementazione)";
      const origin = originContent ?? "(nessun contenuto d'origine: nessun design attivo)";
      return textResult(
        `${JSON.stringify(meta, null, 2)}` +
          `\n\n--- Piano di implementazione ---\n${plan}` +
          `\n\n--- Contenuto d'origine ---\n${origin}`,
      );
    }),
};

/** Tutti i tool di lettura, nell'ordine di registrazione. */
export const readTools: ToolDef[] = [
  listProjects,
  listBacklog,
  getBacklogItem,
  listTickets,
  getTicket,
];

/**
 * Registra i tool di lettura su un `McpServer`. Ogni tool è avvolto in una
 * closure che gli passa il `ctx` (client + config): l'SDK invoca la callback con
 * solo gli argomenti validati, il contesto arriva da qui.
 */
export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  for (const def of readTools) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      // Il nostro `ToolResult` è strutturalmente un `CallToolResult` valido ma
      // non ne ha la index signature `[x: string]: unknown` (usata dall'SDK per
      // il passthrough di `_meta`): cast al boundary, gli handler restano
      // tipizzati sul `ToolResult` testabile.
      ((args: Record<string, unknown>) => def.handler(args, ctx)) as Parameters<
        McpServer["registerTool"]
      >[2],
    );
  }
}
