import type {
  BacklogItemStatus,
  TicketPriority,
  TicketStatus,
  TicketType,
} from "@stubwise/shared";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { InboxItemSummary, InboxPulseProposal, Urgency } from "../client.js";
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

// --- list_proposals ---------------------------------------------------------

/** "fermo da N giorni", con il singolare quando serve. */
function idleLabel(days: number): string {
  return days === 1 ? "fermo da 1 giorno" : `fermo da ${days} giorni`;
}

/** Una proposta come riga numerata, con i metadati che ne hanno deciso l'ordine. */
function proposalLine(proposal: InboxPulseProposal, index: number): string {
  const parts = [
    `urgenza: ${proposal.urgency ?? "non stimata"}`,
    `effort: ${proposal.effort ?? "non stimato"}`,
    proposal.hasAnalysis ? "analisi tecnica: pronta" : "analisi tecnica: assente",
  ];
  return `  ${index + 1}. ${proposal.title} [${parts.join(", ")}] (backlog id: ${proposal.backlogItemId})`;
}

/**
 * Rende una riga di pulse. Il blocco `pulse` è OPZIONALE — il server lo omette
 * quando il payload non è leggibile o non è allineato alle opzioni — e la sua
 * assenza NON è un errore: la proposta esiste comunque, si perde solo il
 * dettaglio, che resta leggibile dall'inbox web. Nessuna deduzione dell'indice
 * da altre fonti: senza il blocco non si nomina nessuna voce.
 */
function renderPulseItem(item: InboxItemSummary): string {
  const lines: string[] = [];
  if (item.pulse) {
    lines.push(
      `- ${item.pulse.projectName} — ${idleLabel(item.pulse.idleDays)} (notifica: ${item.id})`,
    );
    if (item.pulse.proposals.length === 0) {
      lines.push("  (nessuna proposta elencata)");
    } else {
      lines.push(...item.pulse.proposals.map(proposalLine));
    }
  } else {
    lines.push(`- ${item.text} (notifica: ${item.id})`);
    lines.push("  (dettaglio delle proposte non disponibile qui: aprila nell'inbox della web app)");
  }
  if (item.url) lines.push(`  Apri: ${item.url}`);
  return lines.join("\n");
}

const listProposals: ToolDef = {
  name: "list_proposals",
  description:
    "Elenca le proposte APERTE del pulse proattivo indirizzate A TE (l'utente del token): per ogni progetto fermo, le voci di backlog da cui Stubwise suggerisce di ripartire, con urgenza, effort e id della voce. " +
    "Serve a SAPERE, non ad agire: da qui NON si avvia niente e non esiste un tool MCP che risponda a una proposta. Si sceglie dalla card in inbox nella web app o dal DM Slack, e il resto (ticket + run che si ferma sull'approvazione del piano) parte da solo. " +
    "Il pulse è per DESTINATARIO, non per progetto: una lista vuota significa solo che a te non ne è arrivato nessuno di aperto — non che i progetti non abbiano proposte.",
  inputSchema: {},
  handler: (_args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const page = await ctx.client.listInbox({ status: "open", kind: "project.pulse" });

      if (page.items.length === 0) {
        // Lista vuota = risposta legittima, non un errore: si spiega perché può
        // essere vuota, così nessuno la legge come "il progetto non ha proposte".
        return textResult(
          "Nessuna proposta del pulse aperta per te.\n" +
            "Il pulse arriva solo a chi ne è destinatario (maintainer e chi segue il progetto) e solo sui progetti che lo hanno acceso: l'assenza qui non dice nulla sul backlog di un progetto (per quello usa list_backlog).",
        );
      }

      const blocks = page.items.map(renderPulseItem);
      return textResult(
        `Proposte del pulse aperte per te (${page.items.length}):\n${blocks.join("\n")}\n\n` +
          "Per avviarne una si risponde dall'inbox della web app o dal DM Slack: non c'è un tool MCP per farlo da qui. " +
          "Una volta scelta, la voce diventa un ticket e il run si ferma sull'approvazione del piano di un maintainer.",
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
  listProposals,
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
