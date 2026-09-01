import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ANSWER_TEXT_MAX_CHARS,
  ApiError,
  handledByFromError,
  type AgentQuestionOption,
  type AnswerBody,
  type InboxQuestion,
} from "../lib/api";

/**
 * Stile dei bottoni, ricopiato dalla card d'inbox invece di importarlo da lei:
 * questo pannello è CONDIVISO (card e pagina ticket) e non deve dipendere da
 * una delle due superfici che lo ospitano.
 */
const primaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-sm bg-signal px-3 font-mono text-[11px] tracking-[0.12em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9";

/** Un'opzione senza etichetta non è cliccabile: non c'è nulla da leggere. */
function isUsable(option: AgentQuestionOption): boolean {
  return option.label.trim().length > 0;
}

/**
 * Le opzioni da mostrare, oppure `null` quando l'elenco NON è utilizzabile.
 *
 * INVARIANTE — gli indici non si compattano MAI. L'indice dell'opzione viaggia
 * da solo fino ad `answerQuestion`, che lo valida SOLO per range contro le
 * opzioni davvero persistite in `agent_questions`. Se qui saltassimo una voce
 * inutilizzabile, chi clicca la terza etichetta registrerebbe in silenzio la
 * seconda opzione persistita: una scelta diversa da quella letta, che è il
 * fallimento peggiore per un recinto difensivo.
 *
 * Perciò una sola voce inutilizzabile azzera l'intero elenco (bail-out, come
 * `readOptions` dei blocchi Slack): meglio nessuna opzione — resta il testo
 * libero, o si risponde dalla pagina ticket — che un'opzione che mente.
 */
function usableOptions(question: InboxQuestion): AgentQuestionOption[] | null {
  if (question.options.length === 0) return null;
  return question.options.every(isUsable) ? question.options : null;
}

/**
 * Messaggio d'errore di una RISPOSTA, dal solo `code` (mai da `error.message`:
 * i messaggi del server sono in inglese e non sono contratto, il code sì).
 *
 * Esportata perché la mappatura appartiene al pannello, non alla superficie:
 * card d'inbox e pagina ticket chiamano lo stesso `answerQuestion` e devono
 * dire le stesse parole sugli stessi conflitti.
 */
export function answerErrorMessage(cause: unknown, t: TFunction): string {
  if (!(cause instanceof ApiError)) return t("question:errors.generic");
  switch (cause.code) {
    case "already_handled": {
      // Il 409 della corsa porta CHI ha risposto: è l'informazione che spiega
      // perché la propria risposta non è passata.
      const by = handledByFromError(cause);
      return by
        ? t("question:errors.alreadyAnswered", { email: by.email })
        : t("question:errors.alreadyAnsweredUnknown");
    }
    case "question_not_pending":
      return t("question:errors.notPending");
    case "invalid_answer":
      return t("question:errors.invalidAnswer");
    case "forbidden":
      return t("question:errors.forbidden");
    default:
      return t("question:errors.generic");
  }
}

export interface QuestionPanelProps {
  /** La domanda posta dall'agente, nella forma canonica condivisa. */
  question: InboxQuestion;
  /**
   * Invio della risposta. Il pannello non conosce la rotta: la card d'inbox
   * chiama `POST /api/inbox/:id/actions/answer`, la pagina ticket la sua.
   */
  onSubmit: (answer: AnswerBody) => void;
  /** Risposta in volo: blocca i controlli (niente doppio invio). */
  pending?: boolean;
  /** Errore GIÀ localizzato (vedi {@link answerErrorMessage}); `null` = nessuno. */
  error?: string | null;
  /**
   * Se rendere il testo della domanda. Default `true` (uso autonomo: pagina
   * ticket); la card d'inbox lo mette a `false` perché il `text` localizzato
   * della notifica include già la domanda, e ripeterla sarebbe un'eco.
   */
  showQuestionText?: boolean;
  /**
   * Etichetta del bottone di conferma. Default `question:submit` ("Invia
   * risposta"), che è giusto per la domanda dell'agente; il pulse la sostituisce
   * con "Avvia", perché lì confermare non manda una risposta a nessuno — fa
   * partire un lavoro.
   */
  submitLabel?: string;
}

/**
 * Pannello di risposta a una domanda dell'agente: le alternative come scelta
 * singola (con la conseguenza sotto ciascuna), la consigliata MARCATA ma mai
 * preselezionata, e "Altro…" col testo libero quando l'agente lo ammette.
 *
 * CONFERMA A DUE PASSI (selezione → "Invia risposta"), deliberatamente diversa
 * da Slack, dove il click esegue subito: qui la card si legge dal telefono e un
 * tocco accidentale non deve decidere per la persona. Niente ottimismo: la
 * risposta è una decisione, e l'esito si mostra quando è reale.
 *
 * DEGRADO: se non resta niente di azionabile (elenco non utilizzabile e nessun
 * testo libero) il pannello non rende NULLA. La superficie che lo ospita resta
 * intera — sulla card i bottoni `actions` continuano a funzionare, e alla
 * domanda si risponde dalla pagina ticket.
 *
 * Reso da {@link QuestionPanel}, che lo rimonta a ogni domanda nuova: qui
 * dentro si può assumere che lo stato appartenga SEMPRE a `question`.
 */
function QuestionPanelInner({
  question,
  onSubmit,
  pending = false,
  error = null,
  showQuestionText = true,
  submitLabel,
}: QuestionPanelProps) {
  const { t } = useTranslation();
  // `null` = niente scelto: è lo stato iniziale ANCHE quando c'è una
  // consigliata. Marcarla e sceglierla per conto d'altri sono due cose diverse.
  const [choice, setChoice] = useState<number | "free" | null>(null);
  const [text, setText] = useState("");

  const options = usableOptions(question);
  const allowFreeText = question.allowFreeText;
  if (options === null && !allowFreeText) return null;

  // Senza opzioni da scegliere il testo libero è l'unica strada: si mostra
  // aperto, senza un radio che sceglierebbe l'ovvio.
  const freeSelected = options === null || choice === "free";
  const trimmed = text.trim();
  const canSubmit = !pending && (freeSelected ? trimmed.length > 0 : typeof choice === "number");

  // La consigliata si marca solo se l'indice cade DENTRO le opzioni mostrate:
  // un indice fuori range (payload divergente) non deve marcare nulla.
  const recommended =
    options !== null &&
    question.recommendedIndex !== undefined &&
    question.recommendedIndex >= 0 &&
    question.recommendedIndex < options.length
      ? question.recommendedIndex
      : null;

  // Gli id derivano dal questionId: unico per domanda, quindi due pannelli
  // nella stessa pagina (due card d'inbox) non si rubano label e gruppo radio.
  const groupName = `question-${question.questionId}`;
  const textId = `${groupName}-text`;

  function submit(): void {
    if (pending) return;
    // Due rami espliciti invece di un cast: il body ha esattamente uno dei due
    // campi, e chi legge vede da dove esce ciascuno.
    if (freeSelected) {
      if (trimmed) onSubmit({ text: trimmed });
      return;
    }
    if (typeof choice === "number") onSubmit({ optionIndex: choice });
  }

  return (
    <div className="mt-3">
      {showQuestionText && <p className="text-sm text-fg">{question.question}</p>}

      {options !== null && (
        // `fieldset` + `legend`: il gruppo ha un nome per chi naviga a
        // tastiera, e `disabled` sul fieldset spegne in un colpo tutti i radio.
        <fieldset className="mt-2 flex flex-col gap-2" disabled={pending}>
          <legend className="mb-1 font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("question:legend")}
          </legend>
          {options.map((option, index) => {
            const consequenceId = `${groupName}-consequence-${index}`;
            return (
              <div key={index} className="flex flex-col gap-1">
                <label
                  className={`flex items-start gap-2 rounded-sm border px-2 py-1.5 text-sm transition-colors ${
                    index === recommended
                      ? "border-signal-dim"
                      : "border-line hover:border-line-strong"
                  }`}
                >
                  <input
                    type="radio"
                    name={groupName}
                    checked={choice === index}
                    onChange={() => setChoice(index)}
                    // La conseguenza è DESCRIZIONE, non nome: così il nome
                    // accessibile del radio resta l'etichetta dell'opzione.
                    {...(option.consequence ? { "aria-describedby": consequenceId } : {})}
                    className="mt-0.5 size-4 accent-signal"
                  />
                  <span className="text-fg">{option.label}</span>
                  {index === recommended && (
                    // Dentro la label: la marcatura entra nel nome accessibile
                    // del radio, non solo nel colore del bordo.
                    <span className="font-mono text-[10px] tracking-[0.12em] text-signal uppercase">
                      {t("question:recommended")}
                    </span>
                  )}
                </label>
                {option.consequence && (
                  <p id={consequenceId} className="pl-8 text-[12px] text-fg-muted">
                    {option.consequence}
                  </p>
                )}
              </div>
            );
          })}
          {allowFreeText && (
            <label className="flex items-center gap-2 rounded-sm border border-line px-2 py-1.5 text-sm transition-colors hover:border-line-strong">
              <input
                type="radio"
                name={groupName}
                checked={choice === "free"}
                onChange={() => setChoice("free")}
                className="size-4 accent-signal"
              />
              <span className="text-fg">{t("question:other")}</span>
            </label>
          )}
        </fieldset>
      )}

      {freeSelected && (
        <div className="mt-2">
          <label
            htmlFor={textId}
            className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
          >
            {t("question:freeLabel")}
          </label>
          <textarea
            id={textId}
            rows={3}
            value={text}
            disabled={pending}
            // Tetto del contratto: oltre, il server risponderebbe 400.
            maxLength={ANSWER_TEXT_MAX_CHARS}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("question:freePlaceholder")}
            className="mt-1 w-full rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 text-sm text-fg transition-colors focus-visible:border-signal-dim disabled:opacity-50"
          />
        </div>
      )}

      {error !== null && (
        <p role="alert" className="mt-2 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={!canSubmit} onClick={submit} className={primaryButton}>
          {submitLabel ?? t("question:submit")}
        </button>
      </div>
    </div>
  );
}

/**
 * Il pannello, rimontato a ogni domanda DIVERSA.
 *
 * La `key` sul figlio non è un dettaglio di resa: è ciò che impedisce a una
 * scelta di sopravvivere alla domanda per cui è stata fatta. Sulla pagina
 * ticket un round nuovo arriva col pannello montato (polling): senza rimonta,
 * `choice = 2` scelto sul round 1 resterebbe lì mentre il round 2 mostra due
 * opzioni — nessun radio apparirebbe selezionato, ma il bottone d'invio sarebbe
 * comunque attivo e manderebbe l'indice 2 contro la domanda nuova. È la stessa
 * classe di fallimento del bail-out sugli indici: una scelta diversa da quella
 * letta, in silenzio.
 *
 * Difesa DENTRO il componente e non nel contratto d'uso: un `key` chiesto ai
 * chiamanti è una regola che ogni consumatore futuro deve conoscere, e che si
 * dimentica senza rumore.
 */
export function QuestionPanel(props: QuestionPanelProps) {
  return <QuestionPanelInner key={props.question.questionId} {...props} />;
}
