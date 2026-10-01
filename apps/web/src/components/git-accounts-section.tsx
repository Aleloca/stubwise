import { gitProviderKindSchema, reviewScopeKey, type GitProviderKind } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  deleteDefaultReviewer,
  deleteGitAccount,
  patchGitAccount,
  postGitAccount,
  postValidateGitAccount,
  putDefaultReviewer,
  type CredentialCheck,
  type DefaultReviewerResult,
  type DefaultReviewerWarning,
  type GitAccount,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { gitAccountsQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";
import { ProviderBadge, PROVIDER_LABELS } from "./badges";
import {
  buildCredentials,
  CredentialChecks,
  CredentialFields,
  type CredentialFieldsValue,
} from "./credential-fields";
import { FormError, SelectField, SubmitButton, TextField } from "./field";
import { formatDateTime } from "../lib/format";

/**
 * Sezione "Account Git" delle impostazioni (solo admin): elenco degli account
 * riutilizzabili con, per ciascuno, validazione delle credenziali, modifica e
 * eliminazione, più un form per crearne di nuovi. Le credenziali sono
 * write-only: non vengono mai mostrate, in modifica si possono solo sostituire.
 */
export function GitAccountsSection() {
  const { t } = useTranslation();
  const { data: accounts } = useSuspenseQuery(gitAccountsQueryOptions);
  // La pagina è già solo admin (guardia della rotta), ma il toggle del
  // revisore predefinito si nasconde anche qui: chi non è admin riceverebbe un
  // 403. Senza la risposta di /me (in caricamento o fallita) non si mostra.
  const { data: me } = useQuery(meQueryOptions);
  const isAdmin = me?.user.role === "admin";
  const [creating, setCreating] = useState(false);

  return (
    <section className="rounded-sm border border-line bg-ink-900 lg:col-span-2">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:gitAccounts.title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t("settings:gitAccounts.subtitle")}
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("settings:gitAccounts.newAccount")}
          </button>
        )}
      </header>

      {creating && (
        <div className="border-b border-line px-4 py-4">
          <NewAccountForm onDone={() => setCreating(false)} />
        </div>
      )}

      {accounts.length === 0 && !creating ? (
        <p className="px-4 py-8 text-center font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
          {t("settings:gitAccounts.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} accounts={accounts} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </section>
  );
}

const emptyCredentials: CredentialFieldsValue = { username: "", email: "", token: "" };

/**
 * Form di creazione di un account git: nome, provider e credenziali. Offre la
 * validazione prima di salvare; sul successo invalida la lista e si chiude.
 */
function NewAccountForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<GitProviderKind>("bitbucket");
  const [credentials, setCredentials] = useState<CredentialFieldsValue>(emptyCredentials);
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: postGitAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gitAccountsQueryOptions.queryKey });
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const creds = buildCredentials(credentials);
    if (!creds) {
      setError(t("settings:gitAccounts.tokenRequired"));
      return;
    }
    const trimmedWorkspace = workspace.trim();
    mutation.mutate({
      name,
      provider,
      credentials: creds,
      ...(provider === "bitbucket" && trimmedWorkspace ? { workspace: trimmedWorkspace } : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id="new-account-name"
        label={t("settings:gitAccounts.name")}
        required
        placeholder={t("settings:gitAccounts.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <SelectField
        id="new-account-provider"
        label={t("settings:gitAccounts.provider")}
        value={provider}
        onChange={(event) => setProvider(event.target.value as GitProviderKind)}
        options={gitProviderKindSchema.options.map((kind) => ({
          value: kind,
          label: PROVIDER_LABELS[kind],
        }))}
      />

      {provider === "bitbucket" && (
        <div className="flex flex-col gap-1.5">
          <TextField
            id="new-account-workspace"
            label={t("settings:gitAccounts.workspace")}
            placeholder={t("settings:gitAccounts.workspacePlaceholder")}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
          />
          <p className="font-mono text-[11px] text-fg-faint">
            {t("settings:gitAccounts.workspaceHint")}
          </p>
        </div>
      )}

      <fieldset className="rounded-sm border border-line bg-ink-950/40 p-4">
        <legend className="px-1.5 font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t("settings:gitAccounts.gitCredentials")}
        </legend>
        <CredentialFields
          idPrefix="new-account"
          value={credentials}
          onChange={setCredentials}
          tokenRequired
        />
        <p className="mt-4 font-mono text-[11px] text-fg-faint">
          {t("settings:gitAccounts.createHint")}
        </p>
      </fieldset>

      <FormError message={error ?? (mutation.error instanceof Error ? mutation.error.message : null)} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending ? t("settings:gitAccounts.creatingAccount") : t("settings:gitAccounts.createAccount")}
        </SubmitButton>
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
        >
          {t("common:cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * Le cache che mostrano un revisore DERIVATO dal server (D8): lista e dettaglio
 * dei repository (`repositoriesQueryOptions` = `["repositories", projectId]`,
 * `repositoryQueryOptions` = `["repositories", "detail", slug]`, entrambe sotto
 * la radice `["repositories"]`). Cambiare il predefinito, o l'account che lo è,
 * cambia `effectiveReviewAccount` di N repository: con lo `staleTime` di 60 s
 * un admin che torna su una repository leggerebbe ancora il revisore vecchio.
 */
const REPOSITORIES_ROOT_KEY = ["repositories"] as const;

/** Riga di un account: badge, data, e azioni Valida / Modifica / Elimina. */
function AccountRow({
  account,
  accounts,
  isAdmin,
}: {
  account: GitAccount;
  accounts: readonly GitAccount[];
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const validation = useMutation({
    mutationFn: () => postValidateGitAccount(account.id),
  });

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deletion = useMutation({
    mutationFn: () => deleteGitAccount(account.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gitAccountsQueryOptions.queryKey });
    },
  });

  const deleteMessage =
    deletion.error instanceof ApiError && deletion.error.status === 409
      ? t("settings:gitAccounts.inUse")
      : deletion.error instanceof Error
        ? deletion.error.message
        : null;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[14px] font-medium text-fg">{account.name}</span>
        <ProviderBadge provider={account.provider} />
        <span className="font-mono text-[11px] whitespace-nowrap text-fg-faint">
          {t("settings:gitAccounts.createdAt", { date: formatDateTime(account.createdAt) })}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RowButton
            onClick={() => validation.mutate()}
            disabled={validation.isPending}
            label={validation.isPending ? t("settings:gitAccounts.validating") : t("settings:gitAccounts.validate")}
          />
          <RowButton onClick={() => setEditing((value) => !value)} label={t("settings:gitAccounts.edit")} />
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => deletion.mutate()}
                disabled={deletion.isPending}
                label={t("settings:gitAccounts.confirm")}
                danger
              />
              <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton onClick={() => setConfirmingDelete(true)} label={t("settings:gitAccounts.delete")} danger />
          )}
        </div>
      </div>

      {validation.isError && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {validation.error instanceof Error ? validation.error.message : t("settings:gitAccounts.validationError")}
        </p>
      )}
      {validation.data && (
        <div className="mt-3">
          <CredentialChecks result={validation.data as { ok: boolean; checks: CredentialCheck[] }} />
        </div>
      )}

      {deleteMessage && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {deleteMessage}
        </p>
      )}

      {isAdmin && <DefaultReviewerToggle account={account} accounts={accounts} />}

      {editing && (
        <div className="mt-3 rounded-sm border border-line bg-ink-950/40 p-4">
          <EditAccountForm account={account} onDone={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}

/** Form di modifica: nome e/o credenziali (vuote = invariate). */
function EditAccountForm({ account, onDone }: { account: GitAccount; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(account.name);
  const [credentials, setCredentials] = useState<CredentialFieldsValue>(emptyCredentials);
  const [workspace, setWorkspace] = useState(account.workspace ?? "");

  const mutation = useMutation({
    mutationFn: (patch: {
      name?: string;
      credentials?: ReturnType<typeof buildCredentials>;
      workspace?: string;
    }) => patchGitAccount(account.id, patch as never),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: gitAccountsQueryOptions.queryKey }),
        // Nome e credenziali entrano nel revisore derivato delle repository.
        queryClient.invalidateQueries({ queryKey: REPOSITORIES_ROOT_KEY }),
      ]);
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const creds = buildCredentials(credentials);
    const trimmedWorkspace = workspace.trim();
    mutation.mutate({
      name,
      ...(creds && { credentials: creds }),
      ...(account.provider === "bitbucket" && trimmedWorkspace
        ? { workspace: trimmedWorkspace }
        : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id={`edit-account-name-${account.id}`}
        label={t("settings:gitAccounts.name")}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {account.provider === "bitbucket" && (
        <div className="flex flex-col gap-1.5">
          <TextField
            id={`edit-account-workspace-${account.id}`}
            label={t("settings:gitAccounts.workspace")}
            placeholder={t("settings:gitAccounts.workspacePlaceholder")}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
          />
          <p className="font-mono text-[11px] text-fg-faint">
            {t("settings:gitAccounts.workspaceHint")}
          </p>
        </div>
      )}
      <fieldset className="rounded-sm border border-line bg-ink-950/40 p-4">
        <legend className="px-1.5 font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t("settings:gitAccounts.gitCredentials")}
        </legend>
        <CredentialFields
          idPrefix={`edit-account-${account.id}`}
          value={credentials}
          onChange={setCredentials}
          showKeepHint
        />
        <p className="mt-4 font-mono text-[11px] text-fg-faint">
          {t("settings:gitAccounts.editHint")}
        </p>
      </fieldset>
      {/* `translateApiError`: il 409 `default_reviewer_workspace_locked` (D7) ha un testo suo. */}
      <FormError message={mutation.error ? translateApiError(mutation.error, t) : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending ? t("settings:gitAccounts.savingAccount") : t("settings:gitAccounts.saveAccount")}
        </SubmitButton>
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
        >
          {t("common:cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * Toggle «Revisore predefinito» di un account (solo admin, D4): acceso = PUT,
 * spento = DELETE. Se nello stesso ambito c'è già un altro predefinito, prima
 * di sostituirlo chiede conferma. Dopo il PUT mostra l'esito del SERVER: chi è
 * stato sostituito (`replaced`) e gli avvisi per repository (`warnings`), che
 * non bloccano — il predefinito è già impostato quando si leggono.
 */
function DefaultReviewerToggle({ account, accounts }: { account: GitAccount; accounts: readonly GitAccount[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // `?? false`: il web fa un cast, e un server più vecchio non manda il campo.
  // Senza, il checkbox sarebbe NON controllato e resterebbe acceso dopo un PUT
  // fallito, dicendo il falso.
  const isDefault = account.isDefaultReviewer ?? false;
  // Stesso AMBITO (D1) con la regola condivisa di `@stubwise/shared`: serve
  // SOLO a chiedere conferma prima di una sostituzione, chi è stato sostituito
  // davvero lo dice il server (`replaced`).
  const scope = reviewScopeKey(account);
  const current = accounts.find(
    (other) => other.id !== account.id && (other.isDefaultReviewer ?? false) && reviewScopeKey(other) === scope,
  );
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<
    { kind: "set"; result: DefaultReviewerResult } | { kind: "removed" } | null
  >(null);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: gitAccountsQueryOptions.queryKey }),
      queryClient.invalidateQueries({ queryKey: REPOSITORIES_ROOT_KEY }),
    ]);
  const setDefault = useMutation({
    mutationFn: () => putDefaultReviewer(account.id),
    onMutate: () => setOutcome(null),
    onSuccess: async (result) => {
      setOutcome({ kind: "set", result });
      await invalidate();
    },
  });
  const unsetDefault = useMutation({
    mutationFn: () => deleteDefaultReviewer(account.id),
    onMutate: () => setOutcome(null),
    onSuccess: async () => {
      setOutcome({ kind: "removed" });
      await invalidate();
    },
  });
  const pending = setDefault.isPending || unsetDefault.isPending;
  // La conferma ha senso solo finché il predefinito da sostituire c'è: se un
  // refetch lo toglie (un altro admin l'ha spento), la richiesta di conferma
  // sparisce e il toggle NON deve restare bloccato.
  const awaitingConfirm = confirming && current !== undefined;
  const error = setDefault.error ?? unsetDefault.error;

  function handleToggle() {
    setDefault.reset();
    unsetDefault.reset();
    setConfirming(false);
    if (isDefault) unsetDefault.mutate();
    else if (current) setConfirming(true);
    else setDefault.mutate();
  }

  const id = `default-reviewer-${account.id}`;
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={isDefault}
          disabled={pending || awaitingConfirm}
          onChange={handleToggle}
          aria-describedby={`${id}-hint`}
          className="h-4 w-4 shrink-0 accent-signal"
        />
        <label htmlFor={id} className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t("settings:gitAccounts.defaultReviewer")}
        </label>
        {pending && (
          <span className="font-mono text-[11px] text-fg-faint">{t("settings:gitAccounts.defaultReviewerSaving")}</span>
        )}
      </div>
      <p id={`${id}-hint`} className="font-mono text-[11px] text-fg-faint">
        {t("settings:gitAccounts.defaultReviewerHint")}
      </p>

      {awaitingConfirm && current && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-signal">
            {t("settings:gitAccounts.defaultReviewerReplaceConfirm", { name: current.name })}
          </span>
          <RowButton
            onClick={() => {
              setConfirming(false);
              setDefault.mutate();
            }}
            label={t("settings:gitAccounts.defaultReviewerConfirm")}
          />
          <RowButton onClick={() => setConfirming(false)} label={t("common:cancel")} />
        </div>
      )}

      {error && (
        <p role="alert" className="font-mono text-[12px] wrap-anywhere text-danger">
          {translateApiError(error, t)}
        </p>
      )}

      {outcome?.kind === "removed" && (
        <p role="status" className="font-mono text-[12px] text-ok">
          {t("settings:gitAccounts.defaultReviewerRemoved")}
        </p>
      )}
      {outcome?.kind === "set" && <DefaultReviewerOutcome result={outcome.result} />}
    </div>
  );
}

/**
 * Esito del PUT: chi è stato sostituito e dove il predefinito non farà la
 * review. `replaced ?? null` e `warnings ?? []`: il web fa un cast, e la
 * risposta di un server diverso può non avere i campi.
 */
function DefaultReviewerOutcome({ result }: { result: DefaultReviewerResult }) {
  const { t } = useTranslation();
  const replaced = result.replaced ?? null;
  const warnings = result.warnings ?? [];
  const titleId = `default-reviewer-warnings-${result.account.id}`;
  return (
    <>
      <p role="status" className="font-mono text-[12px] text-ok">
        {replaced
          ? t("settings:gitAccounts.defaultReviewerReplaced", { name: replaced.name })
          : t("settings:gitAccounts.defaultReviewerSet")}
      </p>
      {warnings.length > 0 && (
        <div className="font-mono text-[12px] text-signal">
          <p id={titleId}>{t("settings:gitAccounts.defaultReviewerWarningsTitle")}</p>
          <ul aria-labelledby={titleId} className="mt-1 list-disc pl-5">
            {warnings.map((warning) => (
              <li key={warning.repositoryId} className="wrap-anywhere">
                {warning.repositoryName}: {defaultReviewerWarningText(warning, t)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// Sentinella come in `translateApiError`: distingue «chiave mancante» da una
// traduzione vuota.
const MISSING = "\u0000__missing__";

/**
 * Testo di un avviso per repository: prima una chiave propria
 * (`defaultReviewerWarning.<code>`, per i codici che altrove hanno un testo da
 * errore inadatto qui), poi quella dell'errore omonimo (`errors:<code>`: i
 * codici della verifica del revisore dicono la stessa cosa), infine il codice
 * grezzo — un server più nuovo può mandarne uno che questo bundle non conosce.
 */
function defaultReviewerWarningText(warning: DefaultReviewerWarning, t: ReturnType<typeof useTranslation>["t"]): string {
  const own = t(`settings:gitAccounts.defaultReviewerWarning.${warning.code}`, { defaultValue: MISSING });
  if (own !== MISSING) return own;
  const shared = t(`errors:${warning.code}`, { defaultValue: MISSING, detail: "" });
  if (shared !== MISSING) return shared;
  return t("settings:gitAccounts.defaultReviewerWarningUnknown", { code: warning.code });
}

function RowButton({
  onClick,
  label,
  disabled,
  danger,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-sm border bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? "border-danger/30 text-danger hover:border-danger/60"
          : "border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
