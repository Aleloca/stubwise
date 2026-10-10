import { buildTranscript, INTERACTIVE_SEGMENTS } from "@stubwise/shared";
import { useIsMutating } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Composer, UnsentMessage } from "../../components/agent-session/composer";
import { SessionHeader } from "../../components/agent-session/session-header";
import { SessionQuestion } from "../../components/agent-session/session-question";
import { Transcript } from "../../components/agent-session/transcript";
import { RouteError } from "../../components/route-error";
import { useAgentSession } from "../../lib/agent-session-view";
import { ApiError, isAgentSessionsUnavailable } from "../../lib/api";
import { useNow } from "../../lib/elapsed";
import { agentSessionKeys } from "../../lib/queries";
import { useSessionScroll, type TranscriptTail } from "../../lib/session-scroll";

const route = getRouteApi("/authed/agents/$id");

type SessionDetail = NonNullable<ReturnType<typeof useAgentSession>["detail"]>;

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
  // Testo e ultimo errore del campo vivono QUI, non nel Composer: un 409 toglie
  // `canWrite` al dettaglio riletto e smonta il campo, e quello che si era
  // scritto non deve sparire con lui.
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // «Rimanda» (Task A2): rimette il testo di un non consegnato nel campo e ci
  // mette il focus — non invia.
  // Non cancella ciò che si stava scrivendo: lo AGGIUNGE dopo una riga vuota,
  // e focus e cursore vanno in fondo DOPO che il valore nuovo è nel campo (il
  // contatore fa scattare l'effetto anche a testo invariato). Spento durante
  // un invio: al suo successo il campo si svuota e il testo sparirebbe.
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const sending = useIsMutating({ mutationKey: agentSessionKeys.send(id) }) > 0;
  const [resendTick, setResendTick] = useState(0);
  const resend = useCallback((text: string) => {
    setDraft((previous) => (previous.trim().length > 0 ? `${previous}\n\n${text}` : text));
    setResendTick((n) => n + 1);
  }, []);
  useEffect(() => {
    if (resendTick === 0) return;
    const field = fieldRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [resendTick]);

  const items = useMemo(
    () =>
      buildTranscript({
        events: session.events,
        partials: session.partials,
        inputs: detail?.inputs ?? [],
        questions: detail?.questions ?? [],
        // «In coda» solo a sessione non conclusa (regola 8 di buildTranscript).
        live: detail !== undefined && detail.state !== "ended",
      }),
    [session.events, session.partials, detail?.inputs, detail?.questions, detail?.state],
  );

  // La prima domanda aperta è il bersaglio di `#question` (Task 8 ci linka).
  const firstOpenQuestionId = useMemo(() => {
    for (const item of items) {
      if (item.kind === "question" && !item.question.answered) return item.question.id;
    }
    return null;
  }, [items]);
  const hash = useRouterState({ select: (state) => state.location.hash });
  const wantsQuestion = hash.replace(/^#/, "") === "question";

  // Apertura in fondo e «segui il testo nuovo»: PRIMA dello scroll alla
  // domanda, così nello stesso commit vince la domanda.
  const rootRef = useRef<HTMLDivElement>(null);
  const scroll = useSessionScroll(rootRef, {
    ready: session.eventsLoaded && detail !== undefined,
    skipOpen: wantsQuestion && firstOpenQuestionId !== null,
    tail: transcriptTail(session.events, session.partials, detail),
  });
  useScrollToQuestion(firstOpenQuestionId, session.eventsLoaded, wantsQuestion);

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
              onResend={composerMounted(detail) ? resend : undefined}
              resendDisabled={sending}
              renderQuestion={(item) => (
                <SessionQuestion
                  sessionId={id}
                  question={item.question}
                  anchor={item.question.id === firstOpenQuestionId}
                />
              )}
            />
          )}
          {scroll.hasNew && (
            // `h-0` + sticky: resta attaccato al fondo della vista senza
            // occupare spazio nel flusso.
            <div className="sticky bottom-4 z-10 flex h-0 justify-center">
              <button
                type="button"
                onClick={scroll.scrollToBottom}
                className="-translate-y-full rounded-sm border border-line bg-ink-900 px-3 py-1 font-mono text-[12px] text-fg shadow-lg hover:bg-ink-850"
              >
                <span aria-hidden="true">↓ </span>
                {t("newMessages")}
              </button>
            </div>
          )}
        </section>
        <section className="mt-6">
          <ComposerArea
            sessionId={id}
            detail={detail}
            draft={draft}
            onDraftChange={setDraft}
            sendError={sendError}
            onSendErrorChange={setSendError}
            onSent={scroll.pinToBottom}
            fieldRef={fieldRef}
          />
        </section>
      </>
    );
  }

  return (
    <div ref={rootRef} className="page mx-auto w-full max-w-5xl">
      <Link to="/agents" className="font-mono text-[12px] text-fg-muted hover:text-fg">
        {t("back")}
      </Link>
      {body}
    </div>
  );
}

/**
 * Il campo per scrivere e le righe che spiegano perché non si scrive. Tutti i
 * permessi vengono dal server (`canWrite`, `canIntervene`, `canInterrupt`):
 * qui nessuna regola di ruolo, solo la costante condivisa dei segmenti.
 *
 * - Il campo è MONTATO con `canWrite`, oppure con `canIntervene` a sessione
 *   `working` (un segmento vivo o il lavoro fra due segmenti): così fra la fine
 *   della ripresa del piano e l'inizio dell'esecuzione non si smonta e non
 *   perde il focus. Scrivibile SOLO con `canWrite`; altrimenti è in sola
 *   lettura (`readOnly`, non `disabled`, che toglierebbe il focus), senza il
 *   suggerimento sull'invio e con la riga del perché, che descrive il campo
 *   (`aria-describedby`): il passo si può solo guardare, o l'agente sta
 *   passando oltre.
 * - Senza campo: «si può solo guardare» su un passo vivo non interattivo
 *   (review, Docs), «solo un maintainer» su un passo vivo interattivo.
 * - In pausa (`paused` del server, Q3): una riga sopra il campo dice di
 *   scrivere all'agente cosa fare; il campo resta scrivibile (`canWrite`).
 */
function ComposerArea({
  sessionId,
  detail,
  draft,
  onDraftChange,
  sendError,
  onSendErrorChange,
  onSent,
  fieldRef,
}: {
  sessionId: string;
  detail: SessionDetail;
  draft: string;
  onDraftChange: (text: string) => void;
  sendError: string | null;
  onSendErrorChange: (error: string | null) => void;
  /** Il proprio messaggio è partito: la vista va in fondo, anche da risaliti. */
  onSent: () => void;
  fieldRef: React.RefObject<HTMLTextAreaElement>;
}) {
  const { t } = useTranslation("agents");
  const canWrite = detail.canWrite ?? false;
  // Un server più vecchio non lo manda: il campo torna a seguire `canWrite`.
  const canIntervene = detail.canIntervene ?? false;
  const activeSegment = detail.activeSegment ?? null;
  const watchOnly = isWatchOnlyStep(activeSegment);

  // Un server più vecchio non lo manda (il web fa un cast, non un parse).
  const paused = detail.paused ?? false;
  if (composerMounted(detail)) {
    return (
      <div className="flex flex-col gap-2">
        {paused && canWrite && (
          <p role="status" className="font-mono text-[12px] text-fg-muted">
            {t("composer.paused")}
          </p>
        )}
        <Composer
          sessionId={sessionId}
          canInterrupt={detail.canInterrupt ?? false}
          paused={paused}
          enabled={canWrite}
          readOnlyNote={watchOnly ? t("composer.readOnly") : t("composer.between")}
          text={draft}
          onTextChange={onDraftChange}
          error={sendError}
          onErrorChange={onSendErrorChange}
          onSent={onSent}
          fieldRef={fieldRef}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {sendError !== null && draft.trim().length > 0 && (
        <UnsentMessage text={draft} error={sendError} />
      )}
      {watchOnly && <p className="font-mono text-[12px] text-fg-faint">{t("composer.readOnly")}</p>}
      {!canIntervene && isInteractiveStep(activeSegment) && (
        <p className="font-mono text-[12px] text-fg-faint">{t("composer.maintainerOnly")}</p>
      )}
    </div>
  );
}

/**
 * Il campo è montato con `canWrite`, o con `canIntervene` a sessione `working`.
 * Una regola sola: la usano il campo e «Rimanda» (che senza campo non c'è).
 */
function composerMounted(detail: SessionDetail): boolean {
  return (detail.canWrite ?? false) || ((detail.canIntervene ?? false) && detail.state === "working");
}

/** Un segmento vivo fra quelli su cui si scrive (la costante condivisa). */
function isInteractiveStep(activeSegment: string | null): boolean {
  return activeSegment !== null && (INTERACTIVE_SEGMENTS as ReadonlySet<string>).has(activeSegment);
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
 * Aspetta la prima pagina di eventi: la domanda arriva col dettaglio e si
 * disegna anche da sola, e uno scroll fatto allora finirebbe a vuoto — gli
 * eventi che arrivano dopo la spingono in basso, e lo scroll è già «fatto».
 */
function useScrollToQuestion(
  firstOpenQuestionId: string | null,
  eventsLoaded: boolean,
  wantsQuestion: boolean,
) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !eventsLoaded || !wantsQuestion || firstOpenQuestionId === null) return;
    const element = document.getElementById("question");
    if (element === null) return;
    done.current = true;
    element.scrollIntoView({ block: "start" });
  }, [wantsQuestion, firstOpenQuestionId, eventsLoaded]);
}

/**
 * La coda della trascrizione per `useSessionScroll`: un evento più recente,
 * testo dal vivo, un intervento o una domanda. Il passato caricato con
 * «Carica i precedenti» ha id più vecchi e non la tocca.
 */
function transcriptTail(
  events: readonly { id: string }[],
  partials: Record<string, string>,
  detail: { inputs?: readonly unknown[]; questions?: readonly unknown[] } | undefined,
): TranscriptTail {
  let live = 0;
  for (const text of Object.values(partials)) live += text.length;
  return {
    lastEventId: events.length > 0 ? events[events.length - 1]!.id : "",
    live,
    inputs: detail?.inputs?.length ?? 0,
    questions: detail?.questions?.length ?? 0,
  };
}

/** Un 404 CON `code` (`not_found`): la sessione non c'è o non è visibile a chi guarda. */
function isNotFound(error: Error | null): boolean {
  return error instanceof ApiError && error.status === 404;
}
