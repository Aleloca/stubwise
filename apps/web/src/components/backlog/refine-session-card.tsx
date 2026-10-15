import { startRefineSessionInputSchema } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  isAgentSessionsUnavailable,
  startRefineSession,
  type BacklogItemDetail,
} from "../../lib/api";
import { agentSessionQueryOptions, backlogKeys } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";
import { actionButtonClass, actionPrimaryClass, ModalShell } from "./modal";

/** Tetto del primo messaggio: lo stesso dello schema del body (`max(4000)`). */
const FIRST_MESSAGE_MAX = startRefineSessionInputSchema.shape.message.unwrap().maxLength ?? undefined;

/** Cadenza con cui la pagina della voce rilegge lo stato di una sessione attiva. */
const ACTIVE_SESSION_POLL_MS = 5_000;

/**
 * La sessione di refinement dalla pagina della voce (design 2026-10-14 §6.1).
 *
 * - Voce `converted`/`archived`: niente (resta montata solo la finestra già
 *   aperta, per far leggere l'errore `item_closed` di un avvio appena tentato).
 * - Nessuna sessione o sessione chiusa: «Inizia sessione» / «Riprendi
 *   sessione», che apre la finestra col primo messaggio facoltativo.
 * - Sessione attiva: «aperta», lo stato fine e il link alla vista. Lo stato
 *   («al lavoro» / «pronta») viene dal DETTAGLIO DELLA SESSIONE, mai dedotto
 *   dalla voce: la voce dice solo active/closed.
 *
 * `refineSession` si legge con `?? null`: la SPA fa un cast, e un server più
 * vecchio non manda il campo (web e server si deployano insieme: senza il
 * campo si mostra «Inizia sessione», e l'avvio dà «non disponibile»).
 */
export function RefineSessionCard({ item }: { item: BacklogItemDetail }) {
  const { t } = useTranslation();
  const isLocked = item.status === "converted" || item.status === "archived";
  const session = item.refineSession ?? null;
  const [open, setOpen] = useState(false);
  const active = session?.status === "active" && !isLocked;

  // La voce è diventata attiva con la finestra aperta (un'altra scheda, una
  // rilettura): la finestra si smonta col ramo qui sotto, e lo stato va
  // azzerato, o tornerebbe aperta da sola quando la sessione si chiude.
  useEffect(() => {
    if (active) setOpen(false);
  }, [active]);

  if (active) {
    return <ActiveRefineSession itemId={item.id} agentSessionId={session.agentSessionId} />;
  }

  return (
    <>
      {!isLocked && (
        <button type="button" onClick={() => setOpen(true)} className={actionButtonClass}>
          {session === null ? t("backlog:refine.start") : t("backlog:refine.resume")}
        </button>
      )}
      {open && (
        <StartRefineDialog itemId={item.id} locked={isLocked} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function StartRefineDialog({
  itemId,
  locked,
  onClose,
}: {
  itemId: string;
  locked: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [message, setMessage] = useState("");

  const startMutation = useMutation({
    mutationFn: (text: string | undefined) => startRefineSession(itemId, text),
    onSuccess: (result) => {
      // La voce ha ora una sessione attiva: il dettaglio in cache è vecchio.
      void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(itemId) });
      void navigate({ to: "/agents/$id", params: { id: result.agentSessionId } });
    },
    onError: (error) => {
      // Voce convertita o archiviata nel frattempo: la pagina va riletta.
      if (error instanceof ApiError && error.code === "item_closed") {
        void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(itemId) });
      }
    },
  });

  function launch() {
    // Un messaggio vuoto o di soli spazi non è un messaggio: si avvia senza
    // (lo schema del body lo rifiuterebbe con un 400).
    const text = message.trim();
    startMutation.mutate(text === "" ? undefined : text);
  }

  const error = startMutation.error;
  const errorText =
    error == null
      ? null
      : isAgentSessionsUnavailable(error)
        ? t("backlog:refine.unavailable")
        : error instanceof ApiError && error.code === "item_closed"
          ? t("backlog:refine.itemClosed")
          : t("backlog:refine.error", { reason: translateApiError(error, t) });

  return (
    <ModalShell titleId="refine-session-title" onClose={onClose}>
      <h2 id="refine-session-title" className="text-lg font-semibold">
        {t("backlog:refine.title")}
      </h2>
      <div className="mt-3 flex flex-col gap-1.5">
        <label
          htmlFor="refine-first-message"
          className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("backlog:refine.firstMessage")}
        </label>
        <textarea
          id="refine-first-message"
          rows={4}
          maxLength={FIRST_MESSAGE_MAX}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-[15px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
        <p className="font-mono text-[11px] text-fg-faint">{t("backlog:refine.firstMessageHint")}</p>
      </div>
      {errorText && (
        <p role="alert" className="mt-3 font-mono text-[12px] text-danger">
          {errorText}
        </p>
      )}
      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} className={actionButtonClass}>
          {t("backlog:actions.cancel")}
        </button>
        <button
          type="button"
          disabled={locked || startMutation.isPending}
          onClick={launch}
          className={actionPrimaryClass}
        >
          {startMutation.isPending ? t("backlog:refine.launching") : t("backlog:refine.launch")}
        </button>
      </div>
    </ModalShell>
  );
}

/** Lo stato della sessione attiva, dal suo dettaglio: `null` se non si sa. */
function stateLabelKey(state: string | undefined): string | null {
  switch (state) {
    case "working":
      return "backlog:refine.state.working";
    case "queued":
      return "backlog:refine.state.queued";
    case "idle":
      return "backlog:refine.state.ready";
    default:
      // Dettaglio non ancora letto o non leggibile, `ended` (la voce è
      // vecchia, vedi sotto) o uno stato che questo client non conosce:
      // nessuno stato inventato, resta «aperta» e il link.
      return null;
  }
}

function ActiveRefineSession({
  itemId,
  agentSessionId,
}: {
  itemId: string;
  agentSessionId: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Sulla pagina della voce non c'è lo stream della sessione: lo stato si
  // rilegge a intervalli finché la pagina è aperta (mai dopo un errore).
  const { data } = useQuery({
    ...agentSessionQueryOptions(agentSessionId),
    refetchInterval: (query) => (query.state.error == null ? ACTIVE_SESSION_POLL_MS : false),
  });
  const state = data?.state;

  // La sessione è conclusa ma la voce la dice ancora attiva (chiusa per
  // inattività o da un'altra scheda): la voce va riletta, così compare
  // «Riprendi sessione».
  useEffect(() => {
    if (state === "ended") {
      void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(itemId) });
    }
  }, [state, itemId, queryClient]);

  const labelKey = stateLabelKey(state);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span role="status" className="flex items-center gap-1.5 font-mono text-[11px] text-fg-muted">
        <span>{t("backlog:refine.active")}</span>
        {labelKey && (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-fg">{t(labelKey)}</span>
          </>
        )}
      </span>
      <Link to="/agents/$id" params={{ id: agentSessionId }} className={actionButtonClass}>
        {t("backlog:refine.open")}
      </Link>
    </span>
  );
}
