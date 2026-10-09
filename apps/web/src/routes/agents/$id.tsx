import { INTERACTIVE_SEGMENTS } from "@stubwise/shared";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Composer } from "../../components/agent-session/composer";
import { SessionHeader } from "../../components/agent-session/session-header";
import { SessionQuestion } from "../../components/agent-session/session-question";
import { Transcript } from "../../components/agent-session/transcript";
import { RouteError } from "../../components/route-error";
import { useAgentSession } from "../../lib/agent-session-view";
import { buildTranscript } from "../../lib/agent-transcript";
import { ApiError, isAgentSessionsUnavailable } from "../../lib/api";
import { useNow } from "../../lib/elapsed";

const route = getRouteApi("/authed/agents/$id");

/**
 * `/agents/$id`: una sessione dell'agente, dal vivo o in replay (piano B,
 * Task 6), col campo per scrivere all'agente e le risposte alle sue domande
 * (Task 7, tramite `renderQuestion` della trascrizione).
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

  // La prima domanda aperta è il bersaglio di `#question` (Task 8 ci linka).
  const firstOpenQuestionId = useMemo(() => {
    for (const item of items) {
      if (item.kind === "question" && !item.question.answered) return item.question.id;
    }
    return null;
  }, [items]);
  useScrollToQuestion(firstOpenQuestionId);

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
            <Transcript
              items={items}
              live={detail.state !== "ended"}
              renderQuestion={(item) => (
                <SessionQuestion
                  sessionId={id}
                  question={item.question}
                  anchor={item.question.id === firstOpenQuestionId}
                />
              )}
            />
          )}
        </section>
        <section className="mt-6">
          {(detail.canWrite ?? false) ? (
            <Composer sessionId={id} canInterrupt={detail.canInterrupt ?? false} />
          ) : isWatchOnlyStep(detail.activeSegment ?? null) ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("composer.readOnly")}</p>
          ) : null}
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

/**
 * R1: la riga «si può solo guardare» c'è solo con un segmento VIVO (il server
 * valorizza `activeSegment` solo a segmento vivo e aperto) che non è fra
 * quelli interattivi — la costante condivisa, mai una copia. Un segmento ignoto
 * (segnaposto del reader) non è interattivo.
 */
function isWatchOnlyStep(activeSegment: string | null): boolean {
  if (activeSegment === null) return false;
  return !(INTERACTIVE_SEGMENTS as ReadonlySet<string>).has(activeSegment);
}

/**
 * Con `#question` nell'URL la vista scorre alla prima domanda aperta, una
 * volta sola: appena compare (dettaglio ed eventi arrivano dopo il montaggio).
 */
function useScrollToQuestion(firstOpenQuestionId: string | null) {
  const hash = useRouterState({ select: (state) => state.location.hash });
  const done = useRef(false);
  useEffect(() => {
    if (done.current || hash.replace(/^#/, "") !== "question" || firstOpenQuestionId === null) return;
    const element = document.getElementById("question");
    if (element === null) return;
    done.current = true;
    element.scrollIntoView({ block: "start" });
  }, [hash, firstOpenQuestionId]);
}

/** Un 404 CON `code` (`not_found`): la sessione non c'è o non è visibile a chi guarda. */
function isNotFound(error: Error | null): boolean {
  return error instanceof ApiError && error.status === 404;
}
