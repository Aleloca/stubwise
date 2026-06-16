import { gitProviderKindSchema, type GitProviderKind } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  deleteGitAccount,
  patchGitAccount,
  postGitAccount,
  postValidateGitAccount,
  type CredentialCheck,
  type GitAccount,
} from "../lib/api";
import { gitAccountsQueryOptions } from "../lib/queries";
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
            <AccountRow key={account.id} account={account} />
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

/** Riga di un account: badge, data, e azioni Valida / Modifica / Elimina. */
function AccountRow({ account }: { account: GitAccount }) {
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
      await queryClient.invalidateQueries({ queryKey: gitAccountsQueryOptions.queryKey });
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
      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
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
