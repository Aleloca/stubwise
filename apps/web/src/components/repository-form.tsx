import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { RepositoryPatch } from "../lib/api";
import { deriveFullName } from "../lib/format";
import { gitAccountsQueryOptions } from "../lib/queries";
import { BranchSelect } from "./branch-select";
import { FormError, SelectField, SubmitButton, TextField } from "./field";

interface RepositoryInitialValues {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  /** Account git attualmente collegato (per preselezionare il select). */
  gitAccountId: string;
  /** Comando di test custom; null = auto-detect (script test del package.json). */
  testCommand: string | null;
  /** Comando di installazione custom; null = auto-detect (dal lockfile). */
  installCommand: string | null;
  /** Toggle del knowledge graph (graphify) del repository; default false. */
  graphEnabled: boolean;
}

interface RepositoryFormProps {
  initial: RepositoryInitialValues;
  onSubmit: (values: RepositoryPatch) => Promise<void>;
}

/**
 * Form di modifica di un REPOSITORY: nome, URL repo, branch di default, account
 * git collegato e comandi di install/test della pipeline. Le credenziali NON
 * vivono sul repository (stanno sull'account git, in Settings → Account Git).
 *
 * Il provider AI e l'auto-aggiornamento Docs NON sono più qui: sono saliti al
 * PROGETTO (gruppo) e si gestiscono dal dettaglio progetto (vedi {@link
 * ProjectForm}). La creazione di un repository passa dal wizard (account →
 * repository → branch), vedi {@link RepositoryWizard}.
 */
export function RepositoryForm({ initial, onSubmit }: RepositoryFormProps) {
  const { t } = useTranslation();
  const { data: accounts } = useSuspenseQuery(gitAccountsQueryOptions);

  const [name, setName] = useState(initial.name);
  const [repoUrl, setRepoUrl] = useState(initial.repoUrl);
  const [defaultBranch, setDefaultBranch] = useState(initial.defaultBranch);
  const [gitAccountId, setGitAccountId] = useState(initial.gitAccountId);
  // Comando di test come stringa controllata: vuoto = nessun comando (auto-detect).
  const [testCommand, setTestCommand] = useState(initial.testCommand ?? "");
  // Comando di installazione come stringa controllata: vuoto = auto-detect (dal lockfile).
  const [installCommand, setInstallCommand] = useState(initial.installCommand ?? "");
  // Knowledge graph del repository: spento, nessuna build parte (né ai push né a mano).
  const [graphEnabled, setGraphEnabled] = useState(initial.graphEnabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      // Stringa vuota → null (svuota = torna all'auto-detect); altrimenti il
      // comando senza spazi di contorno.
      const trimmedTestCommand = testCommand.trim();
      const nextTestCommand = trimmedTestCommand === "" ? null : trimmedTestCommand;
      const trimmedInstallCommand = installCommand.trim();
      const nextInstallCommand = trimmedInstallCommand === "" ? null : trimmedInstallCommand;
      await onSubmit({
        name,
        repoUrl,
        defaultBranch,
        // Includo gitAccountId solo se cambiato: un PATCH minimo evita di
        // ri-denormalizzare il provider quando non serve.
        ...(gitAccountId !== initial.gitAccountId && { gitAccountId }),
        // testCommand incluso solo se cambiato (null↔stringa) per un PATCH minimo.
        ...(nextTestCommand !== (initial.testCommand ?? null) && {
          testCommand: nextTestCommand,
        }),
        // installCommand incluso solo se cambiato (null↔stringa) per un PATCH minimo.
        ...(nextInstallCommand !== (initial.installCommand ?? null) && {
          installCommand: nextInstallCommand,
        }),
        // graphEnabled incluso solo se cambiato (toggle), per un PATCH minimo.
        ...(graphEnabled !== initial.graphEnabled && { graphEnabled }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
      <TextField
        id="repository-name"
        label={t("repositories:form.name")}
        required
        placeholder={t("repositories:form.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      <TextField
        id="repository-repo-url"
        label={t("repositories:form.repoUrl")}
        type="url"
        required
        placeholder="https://github.com/acme/demo"
        value={repoUrl}
        onChange={(event) => setRepoUrl(event.target.value)}
      />

      {/*
        Branch via API dell'account collegato. Il repoUrl (anche se modificato a
        mano) viene tradotto in owner/repo; se non parsabile, BranchSelect
        degrada a input testuale così l'utente non resta bloccato.
      */}
      <BranchSelect
        id="repository-default-branch"
        accountId={gitAccountId}
        repoFullName={deriveFullName(repoUrl) ?? undefined}
        value={defaultBranch}
        onChange={setDefaultBranch}
      />

      <SelectField
        id="repository-git-account"
        label={t("repositories:form.gitAccount")}
        value={gitAccountId}
        onChange={(event) => setGitAccountId(event.target.value)}
        options={accounts.map((account) => ({
          value: account.id,
          label: `${account.name} (${account.provider})`,
        }))}
      />
      <p className="-mt-1 font-mono text-[11px] text-fg-faint">
        {t("repositories:form.credentialsHint")}
      </p>

      <TextField
        id="repository-test-command"
        label={t("repositories:form.testCommand")}
        type="text"
        placeholder="npm test"
        value={testCommand}
        onChange={(event) => setTestCommand(event.target.value)}
      />
      <p className="-mt-1 font-mono text-[11px] text-fg-faint">
        {t("repositories:form.testCommandHint")}
      </p>

      <TextField
        id="repository-install-command"
        label={t("repositories:form.installCommand")}
        type="text"
        placeholder="pnpm install"
        value={installCommand}
        onChange={(event) => setInstallCommand(event.target.value)}
      />
      <p className="-mt-1 font-mono text-[11px] text-fg-faint">
        {t("repositories:form.installCommandHint")}
      </p>

      {/*
        Knowledge graph (graphify) del repository: toggle (default off). Se
        attivo, il worker estrae il grafo del codice a ogni push sul branch di
        default e lo espone nella tab "Grafo" dello spazio Docs.
      */}
      <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-ink-900 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <input
            id="repository-graph-enabled"
            type="checkbox"
            checked={graphEnabled}
            onChange={(event) => setGraphEnabled(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-signal"
          />
          <label
            htmlFor="repository-graph-enabled"
            className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
          >
            {t("repositories:form.graph")}
          </label>
        </div>
        <p className="font-mono text-[11px] text-fg-faint">{t("repositories:form.graphHint")}</p>
      </div>

      <FormError message={error} />
      <SubmitButton pending={pending}>
        {pending ? t("repositories:form.saving") : t("repositories:form.save")}
      </SubmitButton>
    </form>
  );
}
