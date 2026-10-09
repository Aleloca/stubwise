import { applyPartial, clearPartialsFor, mergeEvents, type AgentSessionEvent, type Reader } from "@stubwise/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useAuth } from "../app/auth-context";
import { openAgentSessionStream, type AgentSessionStreamOptions, type StreamStatus } from "./agent-session-stream";
import { agentSessionEventsQueryOptions, agentSessionQueryOptions } from "./agent-sessions-queries";
import { agentSessionKeys } from "./query-keys";
import { useScreenFocused } from "./use-screen-focused";

type SessionEvent = Reader<AgentSessionEvent>;

/** Dimensione di pagina del server (`GET /events`): una pagina piena può averne un'altra dietro. */
const EVENTS_PAGE_SIZE = 200;
/** Tetto del recupero finale: oltre, il resto si vede ricaricando. */
const CATCH_UP_MAX_PAGES = 20;

/**
 * Le dipendenze dello stream che un test sostituisce (l'XHR finto, la
 * sessione salvata, il backoff). Si iniettano con un PROVIDER — non con un
 * parametro di modulo — perché la schermata si monta anche dentro il
 * navigatore vero (`navigation.test.tsx`), dove un parametro non arriva: il
 * provider si mette sopra `AppProviders` e vale per tutto l'albero. In
 * produzione il valore è vuoto e lo stream usa i suoi default.
 */
export type AgentSessionStreamDeps = Partial<
  Pick<AgentSessionStreamOptions, "createXhr" | "loadSession" | "backoffMs" | "rotateAfterBytes">
>;
export const AgentSessionStreamContext = createContext<AgentSessionStreamDeps>({});

/** L'app è in primo piano? `AppState` (il mock di Jest non ha uno stato iniziale leggibile: si parte attivi). */
function useAppActive(): boolean {
  const [active, setActive] = useState(true);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status: AppStateStatus) => {
      setActive(status === "active");
    });
    return () => subscription?.remove();
  }, []);
  return active;
}

/**
 * Lo stato di una sessione per la sua schermata (piano C, Task 6; il Task 7
 * ci aggiunge scrittura e risposte, nella SCHERMATA). Gemello di
 * `apps/web/src/lib/agent-session-view.ts`, con le stesse regole e lo stesso
 * ritorno:
 *
 * 1. Dettaglio e PRIMA pagina di eventi (gli ultimi 200, senza cursori).
 * 2. Lo stream si apre dopo la prima pagina, con `after` = l'ultimo id
 *    caricato, e solo se la sessione non è `ended`.
 * 3. `events` → `mergeEvents` + `clearPartialsFor`; `partial` → `applyPartial`
 *    (DELTA, si accodano); `session` → il dettaglio in cache.
 * 4. Quando la sessione smette di essere viva (o è già conclusa al primo
 *    caricamento) UN recupero `after` = ultimo id, a pagine con tetto 20: il
 *    server manda il frame `session` prima degli ultimi eventi. I parziali si
 *    azzerano solo a recupero riuscito.
 * 5. Una sessione `ended` può tornare viva: il dettaglio si rilegge ogni 10 s
 *    finché la schermata è a fuoco (`agentSessionRefetchInterval`), e se torna
 *    viva lo stream si riapre dal cursore.
 * 6. `loadOlder()` chiede `before` e antepone.
 *
 * In più le regole dell'app (preflight M6): lo stream è aperto SOLO a
 * schermata a fuoco e app attiva — su una sessione lunga resterebbe a
 * consumare batteria e dati —, e si riapre dal cursore al ritorno. Ogni
 * connessione nuova (ritorno, riconnessione, rotazione: lo stream passa da
 * `open` a ognuna) AZZERA i parziali: i delta arrivati a stream chiuso non
 * vengono rimandati, e accodare al vecchio testo lascerebbe un buco in mezzo.
 * Il testo completo arriva comunque con l'`assistant_text`.
 */
export function useAgentSession(id: string) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const deps = useContext(AgentSessionStreamContext);
  const focused = useScreenFocused();
  const appActive = useAppActive();

  const detailOptions = agentSessionQueryOptions(client!, id);
  const detailQuery = useQuery({
    ...detailOptions,
    enabled: client !== null,
    // Fuori fuoco nessuna rilettura: la schermata non si vede.
    refetchInterval: focused ? detailOptions.refetchInterval : false,
  });
  const pageQuery = useQuery({ ...agentSessionEventsQueryOptions(client!, id), enabled: client !== null });

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
    if (!olderLoaded.current) setBefore(firstPage.before);
    setSeeded(true);
  }, [firstPage, updateEvents]);

  const detail = detailQuery.data;
  // Uno stato ignoto (segnaposto del reader) non è "ended": si ascolta.
  const hasDetail = detail !== undefined;
  const live = hasDetail && detail.state !== "ended";
  const streamAllowed = focused && appActive;

  useEffect(() => {
    if (!seeded || !live || !streamAllowed) return;
    const current = eventsRef.current;
    const stream = openAgentSessionStream({
      ...deps,
      sessionId: id,
      after: current.length > 0 ? current[current.length - 1]!.id : null,
      onStatus: (next) => {
        setStatus(next);
        // Una connessione NUOVA: i delta persi nel frattempo non tornano.
        if (next === "open") setPartials({});
      },
      // 401/403/404 a metà: si rilegge il dettaglio, che porta la vista sullo stato giusto.
      onFatal: () => {
        void queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(id) });
      },
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
  }, [id, seeded, live, streamAllowed, deps, queryClient, updateEvents]);

  // Il recupero finale (regola 4): scatta sul passaggio a non-vivo.
  useEffect(() => {
    if (!seeded || live || !hasDetail || client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        for (let page = 0; page < CATCH_UP_MAX_PAGES; page++) {
          const current = eventsRef.current;
          const after = current.length > 0 ? current[current.length - 1]!.id : undefined;
          const result = await client.agentSessions.events(id, { after, limit: EVENTS_PAGE_SIZE });
          if (cancelled) return;
          updateEvents((prev) => mergeEvents(prev, result.events));
          if (result.events.length < EVENTS_PAGE_SIZE) break;
        }
        if (!cancelled) setPartials({});
      } catch {
        // Best-effort: l'ultimo testo dal vivo resta visibile, è l'unica copia
        // del messaggio finale che lo stream non ha consegnato.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, seeded, live, hasDetail, client, updateEvents]);

  const loadOlder = useCallback(async () => {
    if (before === null || loadingOlder || client === null) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await client.agentSessions.events(id, { before });
      olderLoaded.current = true;
      updateEvents((prev) => mergeEvents(prev, page.events));
      setBefore(page.before);
    } catch (error) {
      setOlderError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setLoadingOlder(false);
    }
  }, [id, before, loadingOlder, client, updateEvents]);

  return {
    detail,
    detailError: detailQuery.error,
    refetchDetail: detailQuery.refetch,
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
