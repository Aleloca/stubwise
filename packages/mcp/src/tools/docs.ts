import { z } from "zod";

import { resolveProject, runTool, textResult } from "./shared.js";
import type { ToolDef, ToolResult } from "./types.js";

/**
 * Tool di recupero dalla documentazione di un progetto (Docs generati dai
 * repository). Solo RECUPERO, mai generazione: la risposta all'utente la scrive
 * il Claude Code che sta parlando con lui, a partire da questi passaggi (design
 * 2026-10-19, «Le risposte le scrive il Claude Code dell'utente»).
 */

/**
 * Tetto del testo di una pagina restituito da `read_doc_page`: le pagine dei
 * Docs possono essere lunghe, e il testo finisce nel contesto del Claude
 * locale. 30.000 caratteri bastano per una pagina normale.
 */
export const DOC_PAGE_MAX_CHARS = 30_000;

// --- search_project_docs ----------------------------------------------------

const searchProjectDocs: ToolDef = {
  name: "search_project_docs",
  description:
    "Cerca nella documentazione di un progetto Stubwise (tutti i suoi repository) i passaggi pertinenti a una domanda. Restituisce un elenco numerato: titolo della pagina, repository, testo del passaggio, e `repositoryId` + `slug` per leggere la pagina intera con read_doc_page. Non genera risposte: la risposta la scrivi tu, citando la pagina. Se non trova nulla lo dice: in quel caso la documentazione non copre la domanda, non inventare.",
  inputSchema: {
    project: z.string().min(1).describe("Slug del progetto (vedi list_projects)."),
    query: z.string().min(1).describe("La domanda o le parole chiave, come le direbbe l'utente."),
  },
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const resolved = await resolveProject(args.project as string, ctx);
      if (!resolved.ok) return resolved.result;
      const { project } = resolved;
      const query = args.query as string;

      const passages = await ctx.client.searchProjectDocs(project.id, query);
      if (passages.length === 0) {
        return textResult(
          `Nessun passaggio trovato nella documentazione di ${project.name} per «${query}»: la documentazione non ne parla. Non inventare una risposta: dillo all'utente, e se serve prova con altre parole o proponi di aprire una richiesta.`,
        );
      }

      const lines = [
        `Passaggi dalla documentazione di ${project.name} per «${query}» (dal più pertinente):`,
        "",
      ];
      passages.forEach((p, i) => {
        lines.push(`${i + 1}. ${p.title} — repository ${p.repositoryName}`);
        lines.push(`   ${p.snippet.replace(/\s*\n\s*/g, " ").trim()}`);
        lines.push(
          `   (pagina intera: read_doc_page con repositoryId: ${p.repositoryId}, slug: ${p.slug})`,
        );
        lines.push("");
      });
      lines.push(
        "Rispondi tu all'utente a partire da questi passaggi, citando la pagina. Se non bastano, leggi la pagina intera; se non coprono la domanda, dillo.",
      );
      return textResult(lines.join("\n"));
    }),
};

// --- read_doc_page ----------------------------------------------------------

const readDocPage: ToolDef = {
  name: "read_doc_page",
  description:
    "Legge il testo completo di una pagina della documentazione, quando i passaggi di search_project_docs non bastano. `repositoryId` e `slug` sono quelli indicati da search_project_docs. Le pagine molto lunghe sono troncate a 30.000 caratteri.",
  inputSchema: {
    repositoryId: z
      .string()
      .min(1)
      .describe("Id del repository della pagina (da search_project_docs)."),
    slug: z.string().min(1).describe("Slug della pagina (da search_project_docs)."),
  },
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const page = await ctx.client.getDocPage(args.repositoryId as string, args.slug as string);
      const truncated = page.body.length > DOC_PAGE_MAX_CHARS;
      const body = truncated ? page.body.slice(0, DOC_PAGE_MAX_CHARS) : page.body;
      const parts = [`# ${page.title}`, `(aggiornata il ${page.updatedAt.slice(0, 10)})`, "", body];
      if (truncated) {
        parts.push(
          "",
          `(pagina troncata: mostrati i primi ${DOC_PAGE_MAX_CHARS.toLocaleString("it-IT")} caratteri su ${page.body.length.toLocaleString("it-IT")})`,
        );
      }
      return textResult(parts.join("\n"));
    }),
};

/** I tool sulla documentazione, nell'ordine di registrazione. */
export const docsTools: ToolDef[] = [searchProjectDocs, readDocPage];
