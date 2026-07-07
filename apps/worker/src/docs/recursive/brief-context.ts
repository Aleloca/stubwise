import { docGenerations, type Db } from "@stubwise/db";
import {
  briefPromptContext,
  type ProjectBrief,
} from "@stubwise/docs-engine";
import { eq } from "drizzle-orm";

/**
 * CONTESTO DEL BRIEF per i prompt downstream (explore / synthesize).
 *
 * Il brief del prodotto è persistito su `doc_generations.brief` (jsonb, prodotto nel primo
 * step dell'orientamento; nullable — se il run brief fallisce/non è parsabile resta null).
 * Explore e synthesize lo iniettano nei loro prompt come sezione PROJECT CONTEXT
 * (glossario/attori/invarianti) per la coerenza terminologica. I SEGRETI (confidentialFacts)
 * NON entrano qui: gli agenti che PRODUCONO testo pubblico non devono riecheggiarli
 * (`briefPromptContext` con includeSecrets=false, il default).
 *
 * CACHE PER-PROCESSO: una generazione ha MOLTI nodi (explore/synthesize) che girano nello
 * stesso processo worker; il brief non cambia durante la generazione. Lo carichiamo UNA
 * volta per generationId e lo teniamo in memoria (il valore è `string | null`: null = brief
 * assente, così una generazione senza brief non ri-interroga il DB a ogni nodo). La cache è
 * best-effort e non ha bisogno di invalidazione: vive quanto il processo e una generazione
 * finalizzata non torna più (nuovi trigger = nuovi id).
 */

/** `briefPromptContext(brief)` (senza segreti) oppure null se la generazione non ha brief. */
const cache = new Map<string, string | null>();

/**
 * Carica il contesto del brief per la generazione, cache per-processo. Ritorna la stringa
 * da passare a `buildExplorePrompt`/`buildSynthesizePrompt` come `briefContext`, oppure
 * `undefined` se la generazione non ha brief (→ prompt byte-identici a prima). Best-effort:
 * un errore DB ritorna `undefined` (la generazione non si rompe mai per il brief).
 */
export async function loadBriefContext(
  db: Db,
  generationId: string,
): Promise<string | undefined> {
  if (cache.has(generationId)) {
    return cache.get(generationId) ?? undefined;
  }
  let context: string | null = null;
  try {
    const [row] = await db
      .select({ brief: docGenerations.brief })
      .from(docGenerations)
      .where(eq(docGenerations.id, generationId));
    const brief = (row?.brief ?? null) as ProjectBrief | null;
    // includeSecrets NON passato (default false): i fatti riservati NON finiscono in un
    // prompt che genera testo pubblico.
    context = brief !== null ? briefPromptContext(brief) : null;
  } catch {
    context = null;
  }
  cache.set(generationId, context);
  return context ?? undefined;
}

/** Svuota la cache (per i test: isola i casi con/senza brief sulla stessa generazione). */
export function clearBriefContextCache(): void {
  cache.clear();
}
