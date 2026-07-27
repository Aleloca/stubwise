import { useEffect } from "react";
import { pingPageView } from "./docs-api";

/**
 * Conteggio viste di una pagina di documentazione: un ping fire-and-forget
 * all'apertura, con anti-rimbalzo.
 *
 * Il debounce vive a livello di MODULO (non del componente) perché il
 * componente pagina si rimonta a ogni navigazione: un ref locale conterebbe di
 * nuovo lo stesso slug tornando indietro col browser o rientrando dalla
 * ricerca. Chiave = repository+slug, così la stessa pagina non è ricontata per
 * ~10 minuti nella stessa sessione, mentre pagine diverse contano subito.
 */

const PING_TTL_MS = 10 * 60_000;

/** Ultimo ping per chiave `repositoryId:slug` (timestamp epoch). */
const lastPingAt = new Map<string, number>();

/** Azzera la memoria dei ping. Solo per i test. */
export function resetViewPings(): void {
  lastPingAt.clear();
}

export function useViewPing(repositoryId: string, slug: string | undefined): void {
  useEffect(() => {
    if (!slug) return;
    const key = `${repositoryId}:${slug}`;
    const now = Date.now();
    const previous = lastPingAt.get(key);
    if (previous !== undefined && now - previous < PING_TTL_MS) return;
    lastPingAt.set(key, now);
    pingPageView(repositoryId, slug);
  }, [repositoryId, slug]);
}
