import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { sendAgentMessage } from "../../lib/api";
import { agentSessionKeys } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";

/** Il tetto del server (`sendAgentMessageInputSchema`): oltre, 400. */
const MAX_TEXT = 4000;

const button =
  "inline-flex min-h-9 items-center justify-center rounded-sm px-3 font-mono text-[11px] tracking-[0.12em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Il campo per scrivere all'agente (piano B, Task 7). Chi lo monta lo fa SOLO
 * con `detail.canWrite` del server: qui non c'è nessuna regola di ruolo.
 *
 * «Scrivi» manda `interrupt: false`; «Ferma e scrivi» (solo con `canInterrupt`)
 * `interrupt: true`, sempre con un testo non vuoto. Dopo il 202 il campo si
 * svuota e si rilegge il dettaglio: la bolla compare da `detail.inputs` come
 * `pending` e passa a consegnata/non consegnata coi frame `session` dello
 * stream — il client non inventa lo stato. Un errore (409 `session_ended`,
 * `not_interactive`, `interrupt_unsupported`, 403, 404) si mostra tradotto e
 * il testo RESTA nel campo: non si perde quello che si è scritto.
 */
export function Composer({
  sessionId,
  canInterrupt,
  onSent,
}: {
  sessionId: string;
  canInterrupt: boolean;
  onSent?: () => void;
}) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (interrupt: boolean) => sendAgentMessage(sessionId, { text: text.trim(), interrupt }),
    onMutate: () => setError(null),
    onSuccess: () => {
      setText("");
      void queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(sessionId) });
      onSent?.();
    },
    onError: (cause) => {
      setError(translateApiError(cause, t));
      // Un 409 dice che la sessione è cambiata (finita, passo diverso): il
      // dettaglio riletto toglie il campo se non si può più scrivere.
      void queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(sessionId) });
    },
  });

  const disabled = text.trim().length === 0 || send.isPending;

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
        value={text}
        onChange={(event) => setText(event.target.value)}
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
            onClick={() => send.mutate(true)}
            className={`${button} border border-line text-fg-muted hover:bg-ink-850`}
          >
            {t("composer.interruptAndSend")}
          </button>
        )}
        <p className="text-[12px] text-fg-faint">{t("composer.hint")}</p>
      </div>
      {error !== null && (
        <p role="alert" className="font-mono text-[12px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
