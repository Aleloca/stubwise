import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorLine } from "../pages/entry/parts";
import { quietButton, secondaryButton } from "../pages/tasks/controls";
import { inputClass } from "../tasks-ui/Dialog";

// Il campo di un segreto scritto da chi amministra (area 9b, shape
// admin-ai.md «SecretField», riusato da admin-integrations.md): una chiave
// API, un setup-token, un token git, un client secret, una chiave S3.
//
// - Da scrivere: campo password con «Show»/«Hide», in monospace (è una
//   chiave), e sotto la riga che dice che dopo resta solo la coda.
// - Salvato: niente campo, «•••• 7f3a» e «Replace», che riapre il campo
//   vuoto sul posto con Save · Cancel (Save chiede la riconferma: la fa chi
//   passa `onSave`, con `useReauth`).
// - In sola lettura: «•••• 7f3a» senza Replace.
//
// Il valore non passa MAI da una query (RF 1): vive solo nello stato locale
// mentre si scrive (o in quello del dialogo che lo usa). Dopo Save il campo
// si svuota prima che la risposta arrivi; se la scrittura è rifiutata
// torna il valore appena scritto, dalla variabile locale, con l'errore
// sotto: non viene ricaricato da nessuna parte.

/** «•••• 7f3a»: la sola forma in cui un segreto salvato si mostra. */
export const maskedSecret = (last4: string): string => `•••• ${last4}`;

/** Il campo password con Show/Hide e la riga sotto: il pezzo che scrive. */
export function SecretInput({
  id,
  label,
  value,
  onChange,
  error,
  autoFocus = false,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const own = useId();
  const inputId = id ?? own;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          ref={ref}
          id={inputId}
          type={shown ? "text" : "password"}
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${hintId}` : hintId}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} font-mono`}
        />
        <button
          type="button"
          aria-pressed={shown}
          aria-controls={inputId}
          onClick={() => setShown((s) => !s)}
          className={`${quietButton} h-8`}
        >
          {shown ? t("admin.ai.secret.hide") : t("admin.ai.secret.show")}
        </button>
      </div>
      {error && (
        <ErrorLine id={errorId}>
          {error}
        </ErrorLine>
      )}
      <p id={hintId} className="text-xs text-ink-muted">
        {t("admin.ai.secret.hint")}
      </p>
    </div>
  );
}

/**
 * Un segreto salvato, sostituibile sul posto. `onSave` fa la scrittura (con
 * la riconferma) e risponde `null` se è riuscita, una frase se è rifiutata,
 * `""` se non è cambiato niente senza nulla da dire (riconferma chiusa: lo
 * dice già il dialogo). Senza `last4` il campo è da scrivere subito.
 */
export function SecretField({
  label,
  last4 = null,
  readOnly = false,
  onSave,
}: {
  label: string;
  last4?: string | null;
  readOnly?: boolean;
  onSave?: (value: string) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(last4 === null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();

  if (!editing || readOnly || !onSave) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <span id={labelId} className="text-sm font-medium text-ink">
          {label}
        </span>
        <div className="flex min-h-8 items-center gap-3">
          <span className="num font-mono text-md text-ink">
            {last4 ? maskedSecret(last4) : "—"}
          </span>
          {!readOnly && onSave && (
            <button
              ref={replaceRef}
              type="button"
              aria-describedby={labelId}
              onClick={() => {
                setValue("");
                setError(null);
                setEditing(true);
              }}
              className={`${secondaryButton} h-7 px-2.5`}
            >
              {t("admin.ai.secret.replace")}
            </button>
          )}
        </div>
      </div>
    );
  }

  async function save() {
    if (!onSave) return;
    // Il valore resta solo in questa variabile: il campo si svuota subito.
    const written = value;
    setValue("");
    setError(null);
    setSaving(true);
    const outcome = await onSave(written).catch(() => t("admin.ai.saveFailed"));
    setSaving(false);
    if (outcome === null) {
      setEditing(false);
      requestAnimationFrame(() => replaceRef.current?.focus());
      return;
    }
    setValue(written);
    if (outcome) setError(outcome);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SecretInput label={label} value={value} onChange={setValue} error={error} autoFocus />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className={`${secondaryButton} h-7 px-2.5 disabled:opacity-40`}
        >
          {t("admin.ai.save")}
        </button>
        {last4 !== null && (
          <button
            type="button"
            onClick={() => {
              setValue("");
              setError(null);
              setEditing(false);
            }}
            className={`${quietButton} h-7`}
          >
            {t("admin.ai.cancel")}
          </button>
        )}
      </div>
    </div>
  );
}
