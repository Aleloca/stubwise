import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { FormError, SubmitButton, TextField } from "../../components/field";
import { createPat, deletePat, type PatView, type PatWithToken } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { patsQueryOptions } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";
import { useCopyWithFallback } from "../../lib/use-copy-with-fallback";

/**
 * Sotto-pagina "Token di accesso" (per-utente, visibile a tutti): elenco dei
 * Personal Access Token dell'utente e creazione di nuovi. Il token in chiaro
 * (`stw_pat_…`) è mostrato UNA volta nel pannello di rivelazione a creazione,
 * mai persistito né rifetchabile — serve poi come STUBWISE_TOKEN del server MCP.
 */
export function SettingsAccessTokensPage() {
  const { t } = useTranslation();
  const { data: pats } = useSuspenseQuery(patsQueryOptions);
  // Token appena creato: vive solo nello stato del componente finché l'utente
  // non chiude il pannello. Alla chiusura sparisce e non è più recuperabile.
  const [revealed, setRevealed] = useState<PatWithToken | null>(null);

  return (
    <div className="space-y-6">
      <section className="rounded-sm border border-line bg-ink-900">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:accessTokens.title")}
          </h2>
        </header>
        <div className="space-y-4 px-4 py-4">
          <p className="text-sm leading-relaxed text-fg-muted">
            {t("settings:accessTokens.description")}
          </p>
          <TokenList pats={pats} />
        </div>
      </section>

      <section className="rounded-sm border border-line bg-ink-900">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:accessTokens.createTitle")}
          </h2>
        </header>
        <div className="px-4 py-4">
          {revealed ? (
            <RevealPanel pat={revealed} onDone={() => setRevealed(null)} />
          ) : (
            <CreateTokenForm onCreated={setRevealed} />
          )}
        </div>
      </section>
    </div>
  );
}

/** Elenco dei token esistenti; stato vuoto compatto in stile "terminal". */
function TokenList({ pats }: { pats: PatView[] }) {
  const { t } = useTranslation();

  if (pats.length === 0) {
    return (
      <p className="font-mono text-[13px] text-fg-faint">{t("settings:accessTokens.empty")}</p>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {pats.map((pat) => (
        <TokenRow key={pat.id} pat={pat} />
      ))}
    </ul>
  );
}

/** Riga di un token: metadati + revoca con conferma inline. */
function TokenRow({ pat }: { pat: PatView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const expired = pat.expiresAt !== null && new Date(pat.expiresAt).getTime() <= Date.now();

  const deletion = useMutation({
    mutationFn: () => deletePat(pat.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: patsQueryOptions.queryKey }),
  });

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] text-fg">{pat.name}</span>
          {expired && (
            <span className="inline-flex rounded-sm border border-danger/30 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] text-danger uppercase">
              {t("settings:accessTokens.expired")}
            </span>
          )}
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-fg-faint">
          <div className="flex gap-1.5">
            <dt>{t("settings:accessTokens.colCreated")}</dt>
            <dd className="text-fg-muted">{formatDate(pat.createdAt)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>{t("settings:accessTokens.colLastUsed")}</dt>
            <dd className="text-fg-muted">
              {pat.lastUsedAt ? formatDate(pat.lastUsedAt) : t("settings:accessTokens.neverUsed")}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>{t("settings:accessTokens.colExpires")}</dt>
            <dd className="text-fg-muted">
              {pat.expiresAt ? formatDate(pat.expiresAt) : t("settings:accessTokens.noExpiry")}
            </dd>
          </div>
        </dl>
        <FormError message={deletion.error ? translateApiError(deletion.error, t) : null} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => deletion.mutate()}
              disabled={deletion.isPending}
              aria-label={t("settings:accessTokens.deleteConfirmAria", { name: pat.name })}
              className="rounded-sm border border-danger/30 bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-danger uppercase transition-colors hover:border-danger/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("settings:accessTokens.deleteConfirm")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              aria-label={t("settings:accessTokens.cancelDeleteAria", { name: pat.name })}
              className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("common:cancel")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={t("settings:accessTokens.deleteAria", { name: pat.name })}
            className="rounded-sm border border-danger/30 bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-danger uppercase transition-colors hover:border-danger/60"
          >
            {t("settings:accessTokens.delete")}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * Ora corrente in formato `YYYY-MM-DDTHH:mm` (ora locale) per l'attributo `min`
 * dell'input datetime-local: il picker nativo scoraggia le date passate. Solo
 * cosmetico — la validazione JS in `handleSubmit` resta la sorgente di verità.
 */
function minDateTimeLocal(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 16);
}

/**
 * Form di creazione: nome + scadenza opzionale (datetime-local locale → ISO
 * UTC). Validazione client della scadenza nel passato prima dell'invio (il
 * server risponde comunque 400); sul successo consegna il token al chiamante,
 * che apre il pannello di rivelazione una-tantum.
 */
function CreateTokenForm({ onCreated }: { onCreated: (pat: PatWithToken) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (isoExpiry: string | null) => createPat(name.trim(), isoExpiry),
    onSuccess: async (pat) => {
      await queryClient.invalidateQueries({ queryKey: patsQueryOptions.queryKey });
      setName("");
      setExpiresAt("");
      onCreated(pat);
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    let iso: string | null = null;
    if (expiresAt.trim() !== "") {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        setValidationError(t("settings:accessTokens.expiresInPast"));
        return;
      }
      iso = parsed.toISOString();
    }
    setValidationError(null);
    mutation.mutate(iso);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id="new-pat-name"
        label={t("settings:accessTokens.nameLabel")}
        required
        maxLength={100}
        placeholder={t("settings:accessTokens.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id="new-pat-expires"
          label={t("settings:accessTokens.expiresLabel")}
          type="datetime-local"
          min={minDateTimeLocal()}
          value={expiresAt}
          onChange={(event) => {
            setExpiresAt(event.target.value);
            setValidationError(null);
          }}
        />
        <p className="font-mono text-[11px] text-fg-faint">
          {t("settings:accessTokens.expiresHint")}
        </p>
      </div>
      <FormError
        message={validationError ?? (mutation.error ? translateApiError(mutation.error, t) : null)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending} disabled={name.trim() === ""}>
          {mutation.isPending
            ? t("settings:accessTokens.creating")
            : t("settings:accessTokens.create")}
        </SubmitButton>
      </div>
    </form>
  );
}

/**
 * Pannello di rivelazione una-tantum: mostra il token in chiaro col pulsante
 * copia (fallback a selezione manuale nei contesti http non sicuri, come fa la
 * guida dell'agente monitoraggio) e un avviso che è visibile una sola volta.
 * "Fatto" scarta il token, che non è più recuperabile.
 */
function RevealPanel({ pat, onDone }: { pat: PatWithToken; onDone: () => void }) {
  const { t } = useTranslation();
  const { copied, manualHint, copy, targetRef } = useCopyWithFallback(pat.token);

  return (
    <div className="space-y-3">
      <h3 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg uppercase">
        {t("settings:accessTokens.createdTitle")}
      </h3>
      <pre
        ref={targetRef}
        className="overflow-x-auto rounded-sm border border-line-strong bg-ink-950/70 px-3 py-3 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap text-fg"
      >
        {pat.token}
      </pre>
      <p role="alert" className="font-mono text-[12px] text-signal">
        {t("settings:accessTokens.tokenWarning")}
      </p>
      <p className="font-mono text-[12px] text-fg-muted">{t("settings:accessTokens.mcpHint")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copy}
          className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
        >
          {copied ? t("common:copied") : t("common:copy")}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
        >
          {t("settings:accessTokens.done")}
        </button>
      </div>
      {manualHint && (
        <p role="status" className="font-mono text-[12px] text-fg-muted">
          {t("settings:accessTokens.copyManualHint")}
        </p>
      )}
    </div>
  );
}
