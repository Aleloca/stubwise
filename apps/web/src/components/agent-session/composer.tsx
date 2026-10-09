import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { sendAgentMessage } from "../../lib/api";
import { agentSessionKeys } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";

/** Il tetto del server (`sendAgentMessageInputSchema`): oltre, 400. */
const MAX_TEXT = 4000;

const button =
  "inline-flex min-h-9 items-center justify-center rounded-sm px-3 font-mono text-[11px] tracking-[0.12em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Il campo per scrivere all'agente (piano B, Task 7). Chi lo monta lo fa con
 * `detail.canWrite` del server, o con `detail.canIntervene` fra un segmento e
 * l'altro: qui non c'è nessuna regola di ruolo. `enabled` (= `canWrite`) falso
 * lo mette in sola lettura SENZA smontarlo: `readOnly` e non `disabled`, che
 * toglierebbe il focus a chi sta scrivendo; il testo resta, i bottoni no.
 *
 * «Scrivi» manda `interrupt: false`; «Ferma e scrivi» (solo con `canInterrupt`)
 * `interrupt: true`, sempre con un testo non vuoto. Dopo il 202 si rilegge il
 * dettaglio e SOLO a rilettura finita il campo si svuota (e torna il focus):
 * la bolla compare da `detail.inputs` come `pending` e passa a
 * consegnata/non consegnata coi frame `session` dello stream — il client non
 * inventa lo stato, e il messaggio non è mai «da nessuna parte».
 *
 * Testo ed errore sono del GENITORE (`text`/`error`), non di questo
 * componente: un 409 `session_ended`/`not_interactive` rilegge il dettaglio,
 * il server lo riporta con `canWrite: false` e il campo si smonta. Se lo stato
 * stesse qui, quello che si è scritto e il perché non è partito sparirebbero
 * col campo; il genitore li mostra anche dopo (`UnsentMessage`).
 */
export function Composer({
  sessionId,
  canInterrupt,
  enabled = true,
  readOnlyNote,
  text,
  onTextChange,
  error,
  onErrorChange,
  onSent,
  fieldRef: externalFieldRef,
}: {
  sessionId: string;
  canInterrupt: boolean;
  /** `canWrite` del server: falso = campo in sola lettura, non smontato. */
  enabled?: boolean;
  /**
   * Perché il campo è in sola lettura (solo con `enabled` falso): una riga
   * sotto il campo che ne è anche la DESCRIZIONE (`aria-describedby`), così
   * chi arriva sul campo con un lettore di schermo la sente. Non è una
   * regione viva (`role="status"`): fra un segmento e l'altro cambia di
   * continuo, e riannunciarla a ogni passaggio sarebbe solo rumore.
   */
  readOnlyNote?: string;
  text: string;
  onTextChange: (text: string) => void;
  error: string | null;
  onErrorChange: (error: string | null) => void;
  onSent?: () => void;
  /** Il campo, per chi deve rimetterci testo e focus da fuori («Rimanda»). */
  fieldRef?: RefObject<HTMLTextAreaElement>;
}) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const fieldId = useId();
  const noteId = useId();
  const note = enabled ? undefined : readOnlyNote;
  const ownFieldRef = useRef<HTMLTextAreaElement>(null);
  const fieldRef = externalFieldRef ?? ownFieldRef;

  const send = useMutation({
    mutationFn: (interrupt: boolean) => sendAgentMessage(sessionId, { text: text.trim(), interrupt }),
    onMutate: () => onErrorChange(null),
    // La promessa tiene `isPending` acceso finché il dettaglio riletto (con la
    // bolla `pending`) non è arrivato: niente doppio invio in quella finestra.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(sessionId) });
      onTextChange("");
      fieldRef.current?.focus();
      onSent?.();
    },
    onError: (cause) => {
      onErrorChange(translateApiError(cause, t));
      // Un 409 dice che la sessione è cambiata (finita, passo diverso): il
      // dettaglio riletto toglie il campo se non si può più scrivere.
      void queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(sessionId) });
    },
  });

  const disabled = !enabled || text.trim().length === 0 || send.isPending;
  // «Ferma e scrivi» in corso (fino alla rilettura del dettaglio): lo dice, come l'app.
  const interrupting = send.isPending && send.variables === true;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) send.mutate(false);
      }}
    >
      <label htmlFor={fieldId} className="sr-only">
        {t("composer.placeholder")}
      </label>
      <textarea
        id={fieldId}
        ref={fieldRef}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        // Durante l'invio (fino alla rilettura del dettaglio) il campo non si
        // modifica: a rilettura finita si svuota, e ciò che si scrive ora sparirebbe.
        readOnly={!enabled || send.isPending}
        aria-describedby={note !== undefined ? noteId : undefined}
        placeholder={t("composer.placeholder")}
        maxLength={MAX_TEXT}
        rows={3}
        className="w-full resize-y rounded-sm border border-line bg-ink-900 px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-line-strong focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={disabled}
          className={`${button} bg-signal text-ink-950 hover:bg-signal-bright active:bg-signal-dim`}
        >
          {t("composer.send")}
        </button>
        {canInterrupt && (
          <button
            type="button"
            disabled={disabled}
            aria-busy={interrupting}
            onClick={() => send.mutate(true)}
            className={`${button} border border-line text-fg-muted hover:bg-ink-850`}
          >
            {interrupting ? t("composer.interrupting") : t("composer.interruptAndSend")}
          </button>
        )}
        {/* Sotto un invio spento «arriva all'agente quando…» sarebbe una promessa falsa. */}
        {enabled && (
          <p className="text-[12px] text-fg-faint">
            <span>{t("composer.hint")}</span>
            {canInterrupt && <span> {t("composer.hintInterrupt")}</span>}
          </p>
        )}
      </div>
      {note !== undefined && (
        <p id={noteId} className="font-mono text-[12px] text-fg-faint">
          {note}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="font-mono text-[12px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Un messaggio che non è partito, mostrato quando il campo non c'è più (il
 * server ha tolto `canWrite` dopo il 409): il motivo e il testo, selezionabile,
 * così non si perde quello che si era scritto.
 */
export function UnsentMessage({ text, error }: { text: string; error: string }) {
  const { t } = useTranslation("agents");
  return (
    <div role="alert" className="rounded-sm border border-danger/40 px-3 py-2">
      <p className="font-mono text-[12px] text-danger">{t("composer.notSent", { reason: error })}</p>
      <p className="mt-1 text-sm whitespace-pre-wrap text-fg select-text">{text}</p>
    </div>
  );
}
