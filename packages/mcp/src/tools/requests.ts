import type { BacklogItemStatus, TicketStatus } from "@stubwise/shared";
import { z } from "zod";

import type { BacklogItemSummary, TicketCommentSummary, TicketSummary } from "../client.js";
import { resolveProject, runTool, textResult } from "./shared.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

/**
 * `my_requests`: i bug (ticket) e le richieste (voci di backlog) che l'utente
 * del token ha aperto, con lo stato in parole semplici — per chi chiede «a che
 * punto è la mia richiesta?» senza conoscere gli stati interni di Stubwise.
 * «Mie» lo decide il server (`mine=true`), non questo tool.
 */

/** Stati di un ticket che contano come «ancora aperto». */
const OPEN_TICKET_STATUSES: TicketStatus[] = ["open", "triaged", "in_progress", "in_review"];

/** Stato di un ticket in parole semplici. */
export const TICKET_STATUS_WORDS: Record<TicketStatus, string> = {
  open: "ricevuta, non ancora presa in carico",
  triaged: "ricevuta, non ancora presa in carico",
  in_progress: "in lavorazione",
  in_review: "in verifica",
  done: "rilasciata",
  closed: "chiusa",
};

/** Stato di una voce di backlog in parole semplici (`converted` a parte: dipende dal ticket). */
export const ITEM_STATUS_WORDS: Record<Exclude<BacklogItemStatus, "converted">, string> = {
  new: "ricevuta",
  refining: "in valutazione",
  ready: "pronta per essere sviluppata",
  archived: "archiviata",
};

/** Quanti commenti umani mostrare per ticket (i più recenti). */
const MAX_NOTES = 3;
/** Una pagina sola per lista: l'API non ne dà più di 100. */
const LIST_LIMIT = 100;

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Gli ultimi commenti UMANI non eliminati, dal più vecchio al più recente. */
function humanNotes(comments: TicketCommentSummary[]): TicketCommentSummary[] {
  return comments
    .filter((c) => c.author === "user" && !c.deletedAt && c.body.trim() !== "")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_NOTES);
}

function noteLine(c: TicketCommentSummary): string {
  return `    · ${day(c.createdAt)}: ${c.body.replace(/\s*\n\s*/g, " ").trim()}`;
}

interface ConvertedInfo {
  ticketNumber: number | null;
  ticket: TicketSummary | null;
  ticketId: string | null;
}

/** In quale ticket è finita una voce convertita, e a che punto è. Fail-open. */
async function convertedInfo(ctx: ToolContext, item: BacklogItemSummary): Promise<ConvertedInfo> {
  const detail = await ctx.client.getBacklogItem(item.id).catch(() => null);
  const linked =
    detail?.tickets?.find((t) => t.role === "converted_to") ?? detail?.tickets?.[0] ?? null;
  if (!linked) return { ticketNumber: null, ticket: null, ticketId: null };
  const ticket = await ctx.client.getTicket(linked.id).catch(() => null);
  return { ticketNumber: linked.number, ticket, ticketId: linked.id };
}

const myRequests: ToolDef = {
  name: "my_requests",
  description:
    "Elenca i bug e le richieste che l'utente ha aperto su Stubwise, con lo stato in parole semplici (ricevuta, in valutazione, in lavorazione, in verifica, rilasciata, archiviata o chiusa) e, per i bug, gli ultimi commenti del team da riassumere. Senza 'project' guarda tutti i progetti. Di default solo quelle ancora aperte; con status 'all' anche rilasciate, chiuse e archiviate.",
  inputSchema: {
    project: z
      .string()
      .optional()
      .describe("Slug del progetto. Se omesso, le richieste su tutti i progetti."),
    status: z
      .enum(["open", "all"])
      .optional()
      .describe("'open' (default): solo quelle ancora aperte. 'all': anche quelle concluse."),
  },
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const onlyOpen = (args.status as string | undefined) !== "all";

      let projectId: string | undefined;
      const projectNames = new Map<string, string>();
      const slug = (args.project as string | undefined)?.trim();
      if (slug) {
        const resolved = await resolveProject(slug, ctx);
        if (!resolved.ok) return resolved.result;
        projectId = resolved.project.id;
        projectNames.set(resolved.project.id, resolved.project.name);
      } else {
        // Solo per i nomi: se l'elenco non arriva, le righe restano senza.
        const projects = await ctx.client.listProjects().catch(() => []);
        for (const p of projects) projectNames.set(p.id, p.name);
      }

      const [ticketPage, itemPage] = await Promise.all([
        ctx.client.listTickets({
          projectId,
          mine: true,
          statuses: onlyOpen ? OPEN_TICKET_STATUSES : undefined,
          limit: LIST_LIMIT,
        }),
        ctx.client.listBacklog({ projectId, mine: true, limit: LIST_LIMIT }),
      ]);

      const where = (pid: string) => {
        const name = projectNames.get(pid);
        return name ? ` — ${name}` : "";
      };

      // Richieste (voci di backlog). Una voce convertita mostra il SUO ticket,
      // che quindi non si ripete fra i bug.
      const shownTicketIds = new Set<string>();
      const converted = await Promise.all(
        itemPage.items.map((item) =>
          item.status === "converted" ? convertedInfo(ctx, item) : Promise.resolve(null),
        ),
      );
      const itemLines: string[] = [];
      itemPage.items.forEach((item, i) => {
        const info = converted[i];
        let label: string;
        if (info) {
          if (info.ticketId) shownTicketIds.add(info.ticketId);
          const ticketStatus = info.ticket?.status;
          if (onlyOpen && (ticketStatus === "done" || ticketStatus === "closed")) return;
          label =
            info.ticketNumber !== null
              ? `in sviluppo (ticket #${info.ticketNumber})${ticketStatus ? `: ${TICKET_STATUS_WORDS[ticketStatus] ?? ticketStatus}` : ""}`
              : "in sviluppo";
        } else {
          if (item.status === "converted") return; // non succede: info c'è sempre
          if (onlyOpen && item.status === "archived") return;
          // Uno stato che questo pacchetto non conosce (server più nuovo) resta leggibile.
          label = ITEM_STATUS_WORDS[item.status] ?? item.status;
        }
        itemLines.push(
          `- «${item.title}»${where(item.projectId)} — ${label} — chiesta il ${day(item.createdAt)}`,
        );
      });

      // Segnalazioni (ticket), con gli ultimi commenti umani. I commenti si
      // leggono in parallelo, e un ticket i cui commenti non si leggono resta
      // comunque nell'elenco.
      const tickets = ticketPage.items.filter(
        (t) => !shownTicketIds.has(t.id) && (!onlyOpen || OPEN_TICKET_STATUSES.includes(t.status)),
      );
      const notesByTicket = await Promise.all(
        tickets.map((t) =>
          ctx.client
            .listTicketComments(t.id)
            .then(humanNotes)
            .catch((): TicketCommentSummary[] => []),
        ),
      );
      const ticketLines: string[] = [];
      tickets.forEach((t, i) => {
        ticketLines.push(
          `- #${t.number} «${t.title}»${where(t.projectId)} — ${TICKET_STATUS_WORDS[t.status] ?? t.status} — aperta il ${day(t.createdAt)}`,
        );
        const notes = notesByTicket[i] ?? [];
        if (notes.length > 0) {
          ticketLines.push("  Ultimi commenti del team:");
          for (const n of notes) ticketLines.push(noteLine(n));
        }
      });

      if (ticketLines.length === 0 && itemLines.length === 0) {
        return textResult(
          onlyOpen
            ? "Nessuna segnalazione o richiesta aperta a nome dell'utente. (Con status 'all' si vedono anche quelle concluse.)"
            : "Nessuna segnalazione o richiesta a nome dell'utente.",
        );
      }

      const out = [
        onlyOpen
          ? "Segnalazioni e richieste ancora aperte dell'utente:"
          : "Tutte le segnalazioni e richieste dell'utente:",
      ];
      if (ticketLines.length > 0) out.push("", "Segnalazioni (ticket):", ...ticketLines);
      if (itemLines.length > 0) out.push("", "Richieste:", ...itemLines);
      out.push(
        "",
        "Riferisci gli stati con queste parole; se ci sono commenti del team, riassumili in breve.",
      );
      return textResult(out.join("\n"));
    }),
};

/** I tool sulle richieste dell'utente, nell'ordine di registrazione. */
export const requestTools: ToolDef[] = [myRequests];
