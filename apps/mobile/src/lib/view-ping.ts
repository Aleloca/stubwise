import type { StubwiseClient } from "@stubwise/api-client";
import { useEffect } from "react";

/**
 * IL CONTEGGIO DELLE VISITE di una pagina di documentazione («la
 * documentazione nell'app, come sul web», 25 set 2026): un ping
 * fire-and-forget all'apertura, con anti-rimbalzo — gemello di `useViewPing`
 * del web (`apps/web/src/lib/use-view-ping.ts`).
 *
 * La memoria vive a livello di MODULO, non del componente: la pagina si
 * rimonta a ogni navigazione, e un ref locale ricontrebbe la stessa pagina
 * tornandoci. Chiave = repository+slug: la stessa pagina non si riconta per
 * 10 minuti, pagine diverse contano subito.
 */
export const VIEW_PING_TTL_MS = 10 * 60_000;

/** Ultimo ping per chiave `repositoryId:slug` (epoch ms). */
const lastPingAt = new Map<string, number>();

/** Azzera la memoria dei ping. Solo per i test. */
export function resetViewPings(): void {
  lastPingAt.clear();
}

/** Va contata questa visita? Se sì, la registra. */
export function shouldPingView(repositoryId: string, slug: string, now: number = Date.now()): boolean {
  const key = `${repositoryId}:${slug}`;
  const previous = lastPingAt.get(key);
  if (previous !== undefined && now - previous < VIEW_PING_TTL_MS) return false;
  lastPingAt.set(key, now);
  return true;
}

/**
 * Conta la visita all'apertura della pagina. ⚠️ Un ping che fallisce non deve
 * MAI toccare la pagina che si sta leggendo: l'errore si ingoia qui.
 */
export function usePageViewPing(client: StubwiseClient | null, repositoryId: string, slug: string): void {
  useEffect(() => {
    if (!client || !shouldPingView(repositoryId, slug)) return;
    client.docs.viewPage(repositoryId, slug).catch(() => {
      // Una visita non contata, non un errore da mostrare.
    });
  }, [client, repositoryId, slug]);
}
