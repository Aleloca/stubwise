import { getRouteApi, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SessionHeader } from "../../components/agent-session/session-header";
import { Transcript } from "../../components/agent-session/transcript";
import { RouteError } from "../../components/route-error";
import { useAgentSession } from "../../lib/agent-session-view";
import { buildTranscript } from "../../lib/agent-transcript";
import { ApiError, isAgentSessionsUnavailable } from "../../lib/api";
import { useNow } from "../../lib/elapsed";

const route = getRouteApi("/authed/agents/$id");

/**
 * `/agents/$id`: una sessione dell'agente, dal vivo o in replay, in sola
 * lettura (piano B, Task 6; il Task 7 aggiunge il campo per scrivere e le
 * risposte alle domande, tramite `renderQuestion` della trascrizione).
 *
 * `useQuery`, non la suspense: un server senza le rotte risponde 404 SENZA
 * `code` e la pagina deve dire «non disponibile su questa istanza»; un 404
 * `not_found` è una sessione che non c'è (o non è visibile a chi guarda).
 */
export function AgentSessionPage() {
  const { id } = route.useParams();
  // La chiave azzera lo stato (eventi, parziali, stream) cambiando sessione.
  return <AgentSessionView key={id} id={id} />;
}

function AgentSessionView({ id }: { id: string }) {
  const { t } = useTranslation("agents");
  const now = useNow();
  const session = useAgentSession(id);
  const { detail, detailError } = session;

  const items = useMemo(
    () =>
      buildTranscript({
        events: session.events,
        partials: session.partials,
        inputs: detail?.inputs ?? [],
        questions: detail?.questions ?? [],
      }),
    [session.events, session.partials, detail?.inputs, detail?.questions],
  );

  let body: React.ReactNode;
  if (isAgentSessionsUnavailable(detailError)) {
    body = <p className="mt-6 text-sm text-fg-muted">{t("unavailable")}</p>;
  } else if (isNotFound(detailError)) {
    body = <p className="mt-6 text-sm text-fg-muted">{t("notFound")}</p>;
  } else if (detail === undefined && detailError !== null) {
    body = <RouteError error={detailError} />;
  } else if (detail === undefined) {
    body = null;
  } else {
    body = (
      <>
        <div className="mt-4">
          <SessionHeader detail={detail} now={now} />
        </div>
        {session.status === "reconnecting" && (
          <p role="status" className="mt-3 font-mono text-[12px] text-fg-faint">
            {t("reconnecting")}
          </p>
        )}
        <section className="mt-6">
          {session.hasOlder && (
            <button
              type="button"
              onClick={() => void session.loadOlder()}
              disabled={session.loadingOlder}
              className="mb-4 rounded-sm border border-line px-3 py-1 font-mono text-[12px] text-fg-muted hover:bg-ink-850 disabled:opacity-60"
            >
              {session.loadingOlder ? t("loadingOlder") : t("loadOlder")}
            </button>
          )}
          {session.olderError !== null && (
            <div className="mb-4">
              <RouteError error={session.olderError} />
            </div>
          )}
          {session.eventsError !== null ? (
            <RouteError error={session.eventsError} />
          ) : session.eventsLoaded && items.length === 0 ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("noEvents")}</p>
          ) : (
            <Transcript items={items} live={detail.state !== "ended"} />
          )}
        </section>
      </>
    );
  }

  return (
    <div className="page mx-auto w-full max-w-5xl">
      <Link to="/agents" className="font-mono text-[12px] text-fg-muted hover:text-fg">
        {t("back")}
      </Link>
      {body}
    </div>
  );
}

/** Un 404 CON `code` (`not_found`): la sessione non c'è o non è visibile a chi guarda. */
function isNotFound(error: Error | null): boolean {
  return error instanceof ApiError && error.status === 404;
}
