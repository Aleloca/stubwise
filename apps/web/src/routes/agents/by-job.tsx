import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { agentSessionsLookupQueryOptions } from "../../lib/queries";

const route = getRouteApi("/authed/agents/job/$jobId");

/**
 * `/agents/job/$jobId?ticketId=`: dal job (una notifica, un link) alla sua
 * sessione (piano B, Task 8). Cerca la sessione per `aiJobId` e, se c'è, ci
 * va con `#question` (la vista scorre alla prima domanda aperta).
 *
 * Se non c'è (nessuna sessione registrata, server senza le rotte, errore) va
 * al ticket di `?ticketId=` — il link dell'inbox lo passa sempre; il web non
 * ha una lettura del job per id — e, senza nemmeno quello, a `/agents`. In
 * tutti i casi `replace`: questa pagina non deve restare nello storico.
 *
 * `useQuery` senza polling né retry (`agentSessionsLookupQueryOptions`): un
 * errore è già una risposta, e non va riprovato prima di cambiare pagina.
 */
export function AgentSessionByJobPage() {
  const { t } = useTranslation("agents");
  const { jobId } = route.useParams();
  const { ticketId } = route.useSearch();
  const navigate = useNavigate();
  const { data, error, isPending } = useQuery(agentSessionsLookupQueryOptions({ aiJobId: jobId }));

  useEffect(() => {
    if (isPending) return;
    const session = data === undefined ? undefined : (data.live[0] ?? data.recent[0]);
    if (session !== undefined) {
      void navigate({
        to: "/agents/$id",
        params: { id: session.id },
        hash: "question",
        replace: true,
      });
    } else if (ticketId !== undefined) {
      void navigate({ to: "/tickets/$id", params: { id: ticketId }, replace: true });
    } else {
      void navigate({ to: "/agents", replace: true });
    }
  }, [isPending, data, error, ticketId, navigate]);

  // Il testo compare solo se si sta davvero cadendo sul ticket.
  const fallingBack =
    !isPending && (data === undefined || (data.live.length === 0 && data.recent.length === 0));
  return (
    <div className="page mx-auto w-full max-w-5xl">
      {fallingBack && <p className="mt-6 text-sm text-fg-muted">{t("byJobFallback")}</p>}
    </div>
  );
}
