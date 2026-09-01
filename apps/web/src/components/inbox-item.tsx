import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  handledByFromError,
  INBOX_DECISION_ACTIONS,
  postInboxAction,
  postInboxHandled,
  postInboxSnooze,
  type HandledBy,
  type InboxActionBody,
  type InboxDecisionAction,
  type InboxFilters,
  type InboxItem,
  type InboxPage,
  type SnoozeUntil,
} from "../lib/api";
import { formatDateTime, formatRelativeTime } from "../lib/format";
import { inboxKeys } from "../lib/queries";
import { answerErrorMessage, QuestionPanel } from "./question-panel";

/**
 * Etichetta i18n per ciascun kind di notifica, nello stesso stile delle mappe
 * `*_LABEL_KEYS` di `badges.tsx`: i valori del dominio restano in inglese e
 * puntinati (`job.plan_review`), le chiavi i18n sono camelCase perché i18next
 * usa il punto come separatore di livello e non potrebbe risolverle altrimenti.
 *
 * `Record` completo sull'unione dei kind: aggiungerne uno in
 * `notificationKindSchema` non compila finché non gli si dà un'etichetta.
 */
export const INBOX_KIND_LABEL_KEYS: Record<InboxItem["kind"], string> = {
  "ticket.created": "inbox:kinds.ticketCreated",
  "job.pr_opened": "inbox:kinds.prOpened",
  "job.pr_closed": "inbox:kinds.prClosed",
  "job.held": "inbox:kinds.jobHeld",
  "job.plan_review": "inbox:kinds.planReview",
  "job.budget_held": "inbox:kinds.budgetHeld",
  "review.completed": "inbox:kinds.reviewCompleted",
  "job.failed": "inbox:kinds.jobFailed",
  "docs.limit_paused": "inbox:kinds.docsLimitPaused",
  "monitor.alert": "inbox:kinds.monitorAlert",
  "monitor.recovered": "inbox:kinds.monitorRecovered",
  "job.awaiting_input": "inbox:kinds.awaitingInput",
  "project.pulse": "inbox:kinds.pulse",
};

/**
 * True se la riga chiede una DECISIONE (sezione "Da decidere"), non solo una
 * lettura. `answer` è fra le decisionali: una domanda dell'agente tiene FERMO
 * il job finché qualcuno non risponde, ed è esattamente ciò che la sezione
 * raccoglie.
 */
export function isDecisionItem(item: InboxItem): boolean {
  return item.actions.some((action) =>
    (INBOX_DECISION_ACTIONS as readonly string[]).includes(action),
  );
}

/**
 * COM'È NATO il run del "Procedi", e sono due frasi diverse: `approval` = il
 * piano ereditato dalla voce ha già fermato il run sul gate; `planning` = senza
 * piano il run è partito e si fermerà DOPO — promettere il gate qui manderebbe
 * l'utente a cercare un'approvazione che ancora non esiste.
 */
type PulseOutcomeVariant = "approval" | "planning";

/** Chiave i18n della coda della frase, dopo il riferimento al ticket. */
const PULSE_OUTCOME_TAIL: Record<PulseOutcomeVariant, string> = {
  approval: "inbox:pulse.outcomeApproval",
  planning: "inbox:pulse.outcomePlanning",
};

/**
 * L'esito FRESCO del "Procedi": quello che sa solo chi ha appena premuto, cioè
 * il numero del ticket e come è nato il run.
 *
 * Il LINK al ticket non dipende da questo: dalla decisione in poi la riga porta
 * `ticketId` (lo valorizza `proceedWithProposal`), e la card lo legge dai dati —
 * anche in "Gestite", dopo un reload, o per un collega. Questo esito aggiunge
 * soltanto il numero e la frase, e vale finché la riga è a schermo.
 *
 * Vive nella PAGINA e non nella card: appena la decisione passa, `actions` si
 * svuota, la riga smette di essere una decisione e la lista la sposta da "Da
 * decidere" a "Da sapere" — cioè sotto un altro genitore, il che RIMONTA la
 * card, e uno stato locale sparirebbe.
 */
export interface PulseOutcome {
  variant: PulseOutcomeVariant;
  ticketId: string;
  ticketNumber: number;
}

const buttonBase =
  "inline-flex min-h-11 items-center justify-center rounded-sm px-3 font-mono text-[11px] tracking-[0.12em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9";
const primaryButton = `${buttonBase} bg-signal text-ink-950 hover:bg-signal-bright active:bg-signal-dim`;
const secondaryButton = `${buttonBase} border border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg`;

export interface InboxItemCardProps {
  item: InboxItem;
  /** Nome del progetto, risolto dalla pagina (che ha già la lista progetti). */
  projectName?: string;
  /**
   * Filtri della lista in cui questa card vive: identificano la voce di cache
   * (`inboxKeys.list(filters)`) su cui applicare gli aggiornamenti ottimistici.
   */
  filters: InboxFilters;
  /** Utente corrente: chi risulta aver gestito, negli update ottimistici. */
  currentUser: HandledBy;
  /**
   * Esito del "Procedi" già registrato per questa riga (vedi
   * {@link PulseOutcome}); `null` finché non se n'è presa nessuna.
   */
  pulseOutcome?: PulseOutcome | null;
  /** Registra l'esito del "Procedi" sulla pagina, che lo tiene per questa riga. */
  onPulseOutcome?: (outcome: PulseOutcome) => void;
}

/**
 * Card di una riga d'inbox: testo dell'evento, metadati mono e i bottoni delle
 * sole azioni che il SERVER ha dichiarato in `actions` (il client non deduce
 * mai quali siano disponibili: dipendono da kind, stato del job e ruolo).
 *
 * Le mutazioni vivono qui, una istanza per card: così pending ed errore sono
 * naturalmente per-riga, senza tracciare quale id sta girando in una mutation
 * condivisa dalla pagina.
 *
 * Ottimismo: `snooze` e `handled` sono igiene personale e non possono fallire
 * per colpa di altri, quindi si applicano subito alla cache della lista con
 * rollback su errore. Le azioni DECISIONALI no: chiudono le notifiche di tutti
 * e possono legittimamente perdere la corsa (409 `already_handled`), quindi si
 * aggiornano solo a risposta arrivata, usando `changedNotificationIds`.
 */
export function InboxItemCard({
  item,
  projectName,
  filters,
  currentUser,
  pulseOutcome = null,
  onPulseOutcome,
}: InboxItemCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  /**
   * Errore dell'ultima azione, con la superficie che deve mostrarlo: quello di
   * una RISPOSTA appartiene al pannello della domanda (dove sta il bottone che
   * l'ha causato, in fondo alla card), tutti gli altri alla riga d'alert sopra
   * i bottoni. Un unico stato, così due errori non possono convivere.
   */
  const [error, setError] = useState<{ message: string; onPanel: boolean } | null>(null);
  const listKey = inboxKeys.list(filters);
  // Il PULSE è l'altro kind con opzioni, ma non è una domanda: si sceglie una
  // proposta e parte un lavoro. Cambiano le parole, non il pannello.
  const isPulse = item.kind === "project.pulse";
  // Nome del progetto: quello risolto dalla pagina, o — se la lista dei progetti
  // non lo conosce — quello che il pulse si porta nel payload.
  const displayProjectName = projectName ?? item.pulse?.projectName;
  // Il ticket nato dalla proposta: dai dati della riga, con l'esito fresco come
  // sorgente equivalente nella finestra fra la risposta e il refetch.
  const startedTicketId = isPulse ? (item.ticketId ?? pulseOutcome?.ticketId ?? null) : null;

  /**
   * Messaggio d'errore dal solo `code` (mai da `error.message`): i messaggi del
   * server sono in inglese e non sono contratto, il code sì.
   */
  function messageForError(cause: unknown): string {
    if (!(cause instanceof ApiError)) return t("inbox:errors.generic");
    switch (cause.code) {
      case "already_handled": {
        const by = handledByFromError(cause);
        return by
          ? t("inbox:errors.alreadyHandled", { email: by.email })
          : t("inbox:errors.alreadyHandledUnknown");
      }
      case "job_in_flight":
        return t("inbox:errors.jobInFlight");
      case "plan_not_pending":
        return t("inbox:errors.planNotPending");
      case "forbidden":
        return t("inbox:errors.forbidden");
      case "invalid_action":
        return t("inbox:errors.invalidAction");
      default:
        return t("inbox:errors.generic");
    }
  }

  /**
   * Messaggio d'errore del "PROCEDI" del pulse. Non riusa
   * {@link answerErrorMessage}: là si parla di una risposta che non è passata,
   * qui di una proposta che non si può più prendere. Stessi codici, altre parole
   * — più i due che esistono solo sul pulse (`proposal_stale`,
   * `run_not_started`), che quella mappa manderebbe sul generico.
   */
  function pulseErrorMessage(cause: unknown): string {
    if (!(cause instanceof ApiError)) return t("inbox:pulse.errors.generic");
    switch (cause.code) {
      case "proposal_stale":
        return t("inbox:pulse.errors.stale");
      case "already_handled": {
        const by = handledByFromError(cause);
        return by
          ? t("inbox:pulse.errors.alreadyTaken", { email: by.email })
          : t("inbox:pulse.errors.alreadyTakenUnknown");
      }
      case "run_not_started":
        // L'azione è riuscita A METÀ: il ticket c'è (lo si ritrova sulla riga
        // gestita, che ora lo porta), il run no e va lanciato a mano. Dire
        // "non riuscito" nasconderebbe il ticket appena creato.
        return t("inbox:pulse.errors.runNotStarted");
      case "invalid_answer":
        return t("inbox:pulse.errors.invalidChoice");
      case "forbidden":
        return t("inbox:errors.forbidden");
      default:
        return t("inbox:pulse.errors.generic");
    }
  }

  /** Applica un patch alle righe indicate dentro la pagina in cache. */
  function patchCached(ids: Set<string>, patch: Partial<InboxItem>): void {
    queryClient.setQueryData<InboxPage>(listKey, (page) =>
      page
        ? {
            ...page,
            items: page.items.map((row) => (ids.has(row.id) ? { ...row, ...patch } : row)),
          }
        : page,
    );
  }

  const decide = useMutation({
    // Un solo `body` opaco: la rotta è una per tutte le azioni decisionali, e
    // ognuna ci mette i campi suoi (`instructions` il rifiuto, `optionIndex`/
    // `text` la risposta).
    mutationFn: (input: { action: InboxDecisionAction; body?: InboxActionBody }) =>
      postInboxAction(item.id, input.action, input.body),
    onMutate: () => setError(null),
    onSuccess: (result) => {
      // La decisione chiude TUTTE le copie della notifica: le righe elencate
      // passano a "gestita" subito, senza aspettare il refetch.
      patchCached(new Set(result.changedNotificationIds), {
        status: "handled",
        // Il "Procedi" del pulse ANCORA il ticket alle copie chiuse (lo fa
        // `proceedWithProposal`): la cache rispecchia la stessa verità, così la
        // riga porta già il link prima ancora del refetch.
        ...(result.ticketId === undefined ? {} : { ticketId: result.ticketId }),
        // `actions` AZZERATO insieme allo stato: una riga chiusa non offre più
        // nulla. Senza questo, nella finestra fra la risposta e il refetch la
        // card resterebbe attenuata ma coi bottoni attivi, e un secondo click
        // (facile su rete lenta) andrebbe a sbattere in un 409.
        actions: [],
        handledAt: new Date().toISOString(),
        handledBy: currentUser,
      });
      // Il "Procedi" del pulse è l'unica azione che CREA un ticket: il numero e
      // la frase su come è nato il run li sa solo chi ha appena premuto.
      const startedTicket =
        result.kind === "project.pulse" &&
        result.ticketId !== undefined &&
        result.ticketNumber !== undefined
          ? { id: result.ticketId, number: result.ticketNumber }
          : null;
      if (startedTicket) {
        onPulseOutcome?.({
          // `runStatus` assente (server precedente) ricade su `planning`: è la
          // frase che non promette un gate — se poi il gate c'è già, l'utente lo
          // trova; il contrario lo manderebbe a cercarlo per niente.
          variant: result.runStatus === "awaiting_plan_approval" ? "approval" : "planning",
          ticketId: startedTicket.id,
          ticketNumber: startedTicket.number,
        });
      }
      setRejecting(false);
      setInstructions("");
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    },
    onError: (cause, variables) => {
      // La risposta a una domanda ha parole sue sugli stessi codici ("ha già
      // risposto X", non "l'ha già gestita X"), condivise con la pagina ticket;
      // il pulse ne ha altre ancora (vedi `pulseErrorMessage`).
      const isAnswer = variables.action === "answer";
      setError({
        message: isAnswer
          ? isPulse
            ? pulseErrorMessage(cause)
            : answerErrorMessage(cause, t)
          : messageForError(cause),
        onPanel: isAnswer,
      });
      // Anche (anzi: soprattutto) dopo un 409 la lista va ricaricata — la
      // notifica è già chiusa da qualcun altro e quello che vediamo è stantio.
      if (cause instanceof ApiError && cause.status === 409) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
      }
    },
  });

  const snooze = useMutation({
    mutationFn: (until: SnoozeUntil) => postInboxSnooze(item.id, until),
    onMutate: async () => {
      setError(null);
      setSnoozeOpen(false);
      // Cancella i refetch in volo: uno che atterrasse dopo il patch
      // ottimistico rimetterebbe la riga al suo posto.
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<InboxPage>(listKey);
      queryClient.setQueryData<InboxPage>(listKey, (page) =>
        page ? { ...page, items: page.items.filter((row) => row.id !== item.id) } : page,
      );
      return { previous };
    },
    onError: (cause, _until, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
      setError({ message: messageForError(cause), onPanel: false });
    },
    // `onSettled` e non `onSuccess`: dopo un rollback la lista va comunque
    // riallineata al server.
    onSettled: () => queryClient.invalidateQueries({ queryKey: inboxKeys.all }),
  });

  const handled = useMutation({
    mutationFn: () => postInboxHandled(item.id),
    onMutate: async () => {
      setError(null);
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<InboxPage>(listKey);
      // `actions: []` come nella decisione: chiusa la riga, spariscono anche i
      // suoi bottoni, subito e non al refetch.
      patchCached(new Set([item.id]), {
        status: "handled",
        actions: [],
        handledAt: new Date().toISOString(),
        handledBy: currentUser,
      });
      return { previous };
    },
    onError: (cause, _v, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
      setError({ message: messageForError(cause), onPanel: false });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: inboxKeys.all }),
  });

  const busy = decide.isPending || snooze.isPending || handled.isPending;
  const can = (action: InboxItem["actions"][number]) => item.actions.includes(action);
  const isHandled = item.status === "handled";

  return (
    <article
      // La card gestita è ancora leggibile ma smette di chiedere attenzione.
      className={`border-b border-line px-4 py-4 last:border-b-0 ${isHandled ? "opacity-60" : ""}`}
      aria-label={item.text}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-faint">
        <span className="rounded-sm border border-line bg-ink-850 px-1.5 py-0.5 text-fg-muted">
          {t(INBOX_KIND_LABEL_KEYS[item.kind])}
        </span>
        {displayProjectName !== undefined && (
          <span className="text-fg-muted">{displayProjectName}</span>
        )}
        {/*
          Da quanto il progetto è fermo: è il MOTIVO per cui questa card esiste,
          e sta nel titolino insieme al progetto invece che nella prosa.
        */}
        {item.pulse !== undefined && (
          <span className="text-fg-muted">
            {t("inbox:pulse.idle", { count: item.pulse.idleDays })}
          </span>
        )}
        <time dateTime={item.createdAt} title={item.createdAt}>
          {formatRelativeTime(item.createdAt)}
        </time>
      </div>

      <p className="mt-2 text-sm text-fg">{item.text}</p>

      {isHandled && (
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {item.handledBy
            ? t("inbox:status.handledBy", { email: item.handledBy.email })
            : t("inbox:status.handled")}
        </p>
      )}

      {startedTicketId !== null && (
        // IL TICKET NATO DALLA PROPOSTA. Il link viene dai DATI (`item.ticketId`,
        // che la decisione ancora alla riga): resta quindi anche in "Gestite",
        // dopo un reload e per un collega che non ha premuto lui. `pulseOutcome`
        // — quello che sa solo chi ha appena premuto — aggiunge il numero al
        // posto dell'etichetta generica e la frase su come è nato il run.
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {pulseOutcome
            ? t("inbox:pulse.startedBy", { email: currentUser.email })
            : t("inbox:pulse.ticketCreated")}{" "}
          <Link
            to="/tickets/$id"
            params={{ id: startedTicketId }}
            className="text-fg-muted underline transition-colors hover:text-fg"
          >
            {pulseOutcome ? `#${pulseOutcome.ticketNumber}` : t("inbox:pulse.openTicket")}
          </Link>
          {pulseOutcome && ` — ${t(PULSE_OUTCOME_TAIL[pulseOutcome.variant])}`}
        </p>
      )}

      {item.status === "snoozed" && item.snoozedUntil !== null && (
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {t("inbox:status.snoozedUntil", { date: formatDateTime(item.snoozedUntil) })}
        </p>
      )}

      {error !== null && !error.onPanel && (
        <p role="alert" className="mt-2 font-mono text-[11px] text-danger">
          {error.message}
        </p>
      )}

      {can("answer") && item.question !== undefined && (
        // La domanda si risponde QUI, sopra le azioni di contorno (apri,
        // rinvia): è la ragione per cui la riga esiste.
        //
        // `question` è OPZIONALE nel contratto: su un payload che il server non
        // ha saputo rileggere la card resta intera e senza pannello, e alla
        // domanda si risponde dalla pagina ticket (dove porta "Apri").
        //
        // Niente ottimismo: il pannello non tocca la cache, e la card cambia
        // solo quando il server ha davvero registrato la risposta (in
        // `onSuccess`, su `changedNotificationIds`) — una risposta può perdere
        // la corsa con quella di un collega.
        <QuestionPanel
          question={item.question}
          // Il `text` della notifica include già la domanda: ripeterla sarebbe
          // un'eco. Sulla pagina ticket (che non ha quel testo) il pannello la
          // mostra, ed è il suo default.
          showQuestionText={false}
          // Sul pulse confermare non manda una risposta a nessuno: fa partire
          // un lavoro. La conferma a due passi resta (è la differenza voluta
          // rispetto a Slack, dove il click esegue subito).
          {...(isPulse ? { submitLabel: t("inbox:pulse.start") } : {})}
          pending={busy}
          error={error !== null && error.onPanel ? error.message : null}
          onSubmit={(answer) => decide.mutate({ action: "answer", body: answer })}
        />
      )}

      {item.actions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {can("approve_plan") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => decide.mutate({ action: "approve_plan" })}
              className={primaryButton}
            >
              {t("inbox:actions.approvePlan")}
            </button>
          )}
          {can("reject_plan") && (
            <button
              type="button"
              disabled={busy}
              aria-expanded={rejecting}
              onClick={() => setRejecting((open) => !open)}
              className={secondaryButton}
            >
              {t("inbox:actions.rejectPlan")}
            </button>
          )}
          {can("relaunch") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => decide.mutate({ action: "relaunch" })}
              className={secondaryButton}
            >
              {t("inbox:actions.relaunch")}
            </button>
          )}
          {can("open") && item.url !== undefined && (
            // Link esterno-al-router: `url` arriva dal server (può puntare a
            // Bitbucket/GitHub tanto quanto a una rotta della SPA), quindi è un
            // `<a>` e non un `<Link>` tipato.
            <a href={item.url} className={secondaryButton}>
              {/*
                Il pulse non è ancorato a un ticket: "Apri" porta dove si vedono
                TUTTE le proposte, cioè il backlog del progetto, e lo dice.
              */}
              {t(isPulse ? "inbox:pulse.openBacklog" : "inbox:actions.open")}
            </a>
          )}
          {can("snooze") && (
            <button
              type="button"
              disabled={busy}
              aria-expanded={snoozeOpen}
              onClick={() => setSnoozeOpen((open) => !open)}
              className={secondaryButton}
            >
              {t("inbox:actions.snooze")}
            </button>
          )}
          {can("handled") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => handled.mutate()}
              className={secondaryButton}
            >
              {t("inbox:actions.handled")}
            </button>
          )}
        </div>
      )}

      {snoozeOpen && (
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["1h", "inbox:actions.snooze1h"],
              ["tomorrow", "inbox:actions.snoozeTomorrow"],
              ["3d", "inbox:actions.snooze3d"],
            ] as const
          ).map(([until, labelKey]) => (
            <button
              key={until}
              type="button"
              disabled={busy}
              onClick={() => snooze.mutate(until)}
              className={secondaryButton}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}

      {rejecting && (
        <div className="mt-3">
          <label
            htmlFor={`inbox-reject-${item.id}`}
            className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
          >
            {t("inbox:reject.label")}
          </label>
          <textarea
            id={`inbox-reject-${item.id}`}
            rows={3}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t("inbox:reject.placeholder")}
            className="mt-1 w-full rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 text-sm text-fg transition-colors focus-visible:border-signal-dim"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                decide.mutate({
                  action: "reject_plan",
                  // Campo facoltativo: vuoto (o soli spazi) = nessuna istruzione,
                  // e il body parte senza la chiave.
                  ...(instructions.trim() ? { body: { instructions: instructions.trim() } } : {}),
                })
              }
              className={primaryButton}
            >
              {t("inbox:reject.submit")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRejecting(false)}
              className={secondaryButton}
            >
              {t("inbox:reject.cancel")}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
