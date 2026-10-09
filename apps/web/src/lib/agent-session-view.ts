import type { AgentSessionEvent, Reader } from "@stubwise/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { openAgentSessionStream, type StreamStatus } from "./agent-session-stream";
import { applyPartial, clearPartialsFor, mergeEvents } from "./agent-transcript";
import { getAgentSessionEvents } from "./api";
import {
  agentSessionEventsQueryOptions,
  agentSessionKeys,
  agentSessionQueryOptions,
} from "./queries";

type SessionEvent = Reader<AgentSessionEvent>;

/**
 * Lo stato di una sessione per la sua vista (piano B, Task 6; il Task 7 ci
 * aggiunge scrittura e risposte).
 *
 * 1. Dettaglio (query) e PRIMA pagina di eventi (gli ultimi 200, senza cursori):
 *    una sessione enorme non si carica mai per intero.
 * 2. Lo stream si apre solo DOPO la prima pagina, con `after` = l'ultimo id
 *    caricato: arrivano esattamente gli eventi successivi, senza ripartire
 *    dalla coda. Si apre solo se la sessione non è `ended` (il replay di una
 *    conclusa non ha niente da ascoltare); se un refetch del dettaglio la
 *    riporta viva, si apre allora. Si chiude allo smontaggio.
 * 3. `events` → `mergeEvents` e poi `clearPartialsFor`; `partial` →
 *    `applyPartial` (i parziali sono DELTA: si accodano); `session` → il
 *    dettaglio in cache, che ha la stessa forma (`Reader<…>`) del REST perché
 *    lo stream lo parsa con lo stesso schema.
 * 4. `loadOlder()` chiede `before` = il cursore dell'ultima pagina più vecchia
 *    e antepone; `hasOlder` è `before !== null` (con una pagina piena il server
 *    lo dà anche se non c'è altro: un click a vuoto, innocuo).
 */
export function useAgentSession(id: string) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery(agentSessionQueryOptions(id));
  const pageQuery = useQuery(agentSessionEventsQueryOptions(id));

  const [events, setEvents] = useState<SessionEvent[]>([]);
  // Lo stream legge l'ultimo id al momento in cui si apre: un ref, perché
  // l'effetto che lo apre non deve ripartire a ogni evento.
  const eventsRef = useRef<SessionEvent[]>([]);
  const updateEvents = useCallback((fn: (prev: SessionEvent[]) => SessionEvent[]) => {
    const next = fn(eventsRef.current);
    if (next === eventsRef.current) return;
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const [partials, setPartials] = useState<Record<string, string>>({});
  const [before, setBefore] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<Error | null>(null);
  const [status, setStatus] = useState<StreamStatus | "idle">("idle");
  const olderLoaded = useRef(false);

  const firstPage = pageQuery.data;
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!firstPage) return;
    updateEvents((prev) => mergeEvents(prev, firstPage.events));
    // Il cursore viene dalla prima pagina finché non se ne carica una più vecchia.
    if (!olderLoaded.current) setBefore(firstPage.before);
    setSeeded(true);
  }, [firstPage, updateEvents]);

  const detail = detailQuery.data;
  // Uno stato ignoto (segnaposto del reader) non è "ended": si ascolta.
  const live = detail !== undefined && detail.state !== "ended";

  useEffect(() => {
    if (!seeded || !live) return;
    const current = eventsRef.current;
    const stream = openAgentSessionStream({
      sessionId: id,
      after: current.length > 0 ? current[current.length - 1]!.id : null,
      onStatus: setStatus,
      onMessage: (message) => {
        switch (message.type) {
          case "events":
            updateEvents((prev) => mergeEvents(prev, message.events));
            setPartials((prev) => clearPartialsFor(prev, message.events));
            break;
          case "partial":
            setPartials((prev) => applyPartial(prev, message.segmentId, message.text));
            break;
          case "session":
            queryClient.setQueryData(agentSessionKeys.detail(id), message.detail);
            break;
        }
      },
    });
    return () => stream.close();
  }, [id, seeded, live, queryClient, updateEvents]);

  const loadOlder = useCallback(async () => {
    if (before === null || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await getAgentSessionEvents(id, { before });
      olderLoaded.current = true;
      updateEvents((prev) => mergeEvents(prev, page.events));
      setBefore(page.before);
    } catch (error) {
      setOlderError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setLoadingOlder(false);
    }
  }, [id, before, loadingOlder, updateEvents]);

  return {
    detail,
    detailError: detailQuery.error,
    eventsError: pageQuery.error,
    eventsLoaded: seeded,
    events,
    partials,
    status,
    loadOlder,
    hasOlder: before !== null,
    loadingOlder,
    olderError,
  };
}
