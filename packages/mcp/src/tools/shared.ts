import type { Project } from "@stubwise/shared";

import { StubwiseApiError } from "../client.js";
import type { ToolContext, ToolResult } from "./types.js";

/** Costruisce un `ToolResult` di successo con un unico blocco di testo. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Costruisce un `ToolResult` d'errore (isError:true) con un messaggio parlante. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Esegue `fn` catturando qualsiasi errore e traducendolo in un `ToolResult`
 * d'errore leggibile: gli handler dei tool MCP NON devono propagare eccezioni
 * (un throw dentro un tool è un crash opaco per il client), quindi ogni chiamata
 * al client va incapsulata qui. Gli `StubwiseApiError` portano già un messaggio
 * parlante; per gli altri errori usiamo `err.message` con un fallback generico.
 */
export async function runTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StubwiseApiError) return errorResult(err.message);
    if (err instanceof Error) return errorResult(err.message);
    return errorResult("Errore inatteso durante l'operazione su Stubwise");
  }
}

/**
 * Esito della risoluzione del progetto: o il progetto trovato, o un `ToolResult`
 * d'errore già pronto da restituire (con messaggio parlante che invita a
 * collegare il repo o a passare `project` esplicitamente).
 */
export type ProjectResolution =
  | { ok: true; project: Project }
  | { ok: false; result: ToolResult };

/**
 * Risolve il progetto su cui operare, con questa precedenza:
 *  1. lo slug passato esplicitamente nell'argomento del tool (`argSlug`),
 *  2. altrimenti il `projectSlug` di default della config (da `.stubwise.json`).
 *
 * Se nessuno slug è disponibile → errore che invita a `/stubwise:init` o a
 * passare `project`. Se lo slug non corrisponde a nessun progetto → errore
 * "Progetto '<slug>' non trovato". Non lancia mai: gli errori del client sono
 * catturati e restituiti come `ToolResult`.
 */
export async function resolveProject(
  argSlug: string | undefined,
  ctx: ToolContext,
): Promise<ProjectResolution> {
  const slug = argSlug?.trim() || ctx.config.projectSlug;
  if (!slug) {
    return {
      ok: false,
      result: errorResult(
        "Questo repo non è collegato a un progetto Stubwise: lancia /stubwise:init, oppure passa 'project' esplicitamente.",
      ),
    };
  }

  let project: Project | null;
  try {
    project = await ctx.client.getProjectBySlug(slug);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Errore inatteso durante il recupero del progetto";
    return { ok: false, result: errorResult(message) };
  }

  if (!project) {
    return { ok: false, result: errorResult(`Progetto '${slug}' non trovato.`) };
  }

  return { ok: true, project };
}
