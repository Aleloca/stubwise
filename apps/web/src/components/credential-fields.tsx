import { useTranslation } from "react-i18next";
import type { GitCredentials } from "../lib/api";
import { TextField } from "./field";

/** Valori grezzi dei tre campi credenziale (come stanno negli input). */
export interface CredentialFieldsValue {
  username: string;
  email: string;
  token: string;
}

interface CredentialFieldsProps {
  value: CredentialFieldsValue;
  onChange: (next: CredentialFieldsValue) => void;
  /** Prefisso degli id/label per evitare collisioni se più form coesistono. */
  idPrefix: string;
  /** Token obbligatorio (creazione). In modifica un token vuoto = invariate. */
  tokenRequired?: boolean;
  /** Aggiunge la riga "lascia vuoto per mantenere quelle salvate" (modifica). */
  showKeepHint?: boolean;
}

/**
 * Costruisce le credenziali git dai campi grezzi, omettendo username/email
 * vuoti e restituendo `undefined` se non c'è un token: write-only, gli spazi
 * attorno vengono rimossi. Esportata così i form la riusano in `onSubmit`.
 */
export function buildCredentials(value: CredentialFieldsValue): GitCredentials | undefined {
  const token = value.token.trim();
  if (token === "") return undefined;
  const username = value.username.trim();
  const email = value.email.trim();
  return {
    token,
    ...(username !== "" && { username }),
    ...(email !== "" && { email }),
  };
}

/**
 * Tris di campi credenziale git (Username / Email / Token) con l'avviso
 * write-only e il testo di guida per Bitbucket e GitHub. Estratto dal form
 * progetto per riusarlo nella gestione degli account git: il componente è puro
 * (stato controllato dal genitore), così la logica di submit/validazione resta
 * dove serve.
 */
export function CredentialFields({
  value,
  onChange,
  idPrefix,
  tokenRequired = false,
  showKeepHint = false,
}: CredentialFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <p className="mb-4 font-mono text-[11px] leading-relaxed text-fg-faint">
        {t("settings:credentials.writeOnlyHint")}
        <br />
        {t("settings:credentials.bitbucketHint")}
        <br />
        {t("settings:credentials.githubHint")}
        {showKeepHint && (
          <>
            <br />
            {t("settings:credentials.keepHint")}
          </>
        )}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={`${idPrefix}-username`}
          label={t("settings:credentials.username")}
          type="text"
          autoComplete="off"
          placeholder={t("settings:credentials.usernamePlaceholder")}
          value={value.username}
          onChange={(event) => onChange({ ...value, username: event.target.value })}
        />
        <TextField
          id={`${idPrefix}-email`}
          label={t("settings:credentials.email")}
          type="text"
          autoComplete="off"
          placeholder={t("settings:credentials.emailPlaceholder")}
          value={value.email}
          onChange={(event) => onChange({ ...value, email: event.target.value })}
        />
        <TextField
          id={`${idPrefix}-token`}
          label={t("settings:credentials.token")}
          type="password"
          autoComplete="new-password"
          required={tokenRequired}
          placeholder={t("settings:credentials.tokenPlaceholder")}
          value={value.token}
          onChange={(event) => onChange({ ...value, token: event.target.value })}
        />
      </div>
    </>
  );
}

/**
 * Pannello di rendering dei check di validazione credenziali (✓/✗ + dettaglio),
 * gemello di quello già usato nel form progetto. Riusato dalla gestione account.
 */
export function CredentialChecks({
  result,
}: {
  result: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-line bg-ink-950/40 p-3">
      <p
        className={`font-mono text-[12px] font-semibold tracking-[0.06em] uppercase ${
          result.ok ? "text-ok" : "text-danger"
        }`}
      >
        {result.ok ? t("settings:credentials.valid") : t("settings:credentials.issues")}
      </p>
      <ul className="flex flex-col gap-1.5">
        {result.checks.map((check) => (
          <li key={check.name} className="flex gap-2 font-mono text-[12px] leading-relaxed">
            <span className={check.ok ? "text-ok" : "text-danger"}>{check.ok ? "✓" : "✗"}</span>
            <span className="text-fg-muted">
              <span className="text-fg">{check.name}</span> — {check.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
