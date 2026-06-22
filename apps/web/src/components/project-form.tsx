import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectPatch } from "../lib/api";
import { deriveFullName } from "../lib/format";
import { gitAccountsQueryOptions } from "../lib/queries";
import { BranchSelect } from "./branch-select";
import { FormError, SelectField, SubmitButton, TextField } from "./field";

interface ProjectInitialValues {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  /** Account git attualmente collegato (per preselezionare il select). */
  gitAccountId: string;
  /** Comando di test custom; null = auto-detect (script test del package.json). */
  testCommand: string | null;
  /** Comando di installazione custom; null = auto-detect (dal lockfile). */
  installCommand: string | null;
}

interface ProjectFormProps {
  initial: ProjectInitialValues;
  onSubmit: (values: ProjectPatch) => Promise<void>;
}

/**
 * Form di modifica progetto: nome, URL repository, branch di default e account
 * git collegato (selezionabile fra quelli esistenti). Le credenziali NON
 * vivono più sul progetto — stanno sull'account git, si gestiscono in Settings
 * → Account Git — quindi questo form non le tocca. Cambiare account aggiorna
 * anche il provider del progetto lato server.
 *
 * La creazione di un progetto NON usa questo form: passa dal wizard
 * (account → repository → branch), vedi {@link ProjectWizard}.
 */
export function ProjectForm({ initial, onSubmit }: ProjectFormProps) {
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
        id="project-name"
        label={t("projects:form.name")}
        required
        placeholder={t("projects:form.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      <TextField
        id="project-repo-url"
        label={t("projects:form.repoUrl")}
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
        id="project-default-branch"
        accountId={gitAccountId}
        repoFullName={deriveFullName(repoUrl) ?? undefined}
        value={defaultBranch}
        onChange={setDefaultBranch}
      />

      <SelectField
        id="project-git-account"
        label={t("projects:form.gitAccount")}
        value={gitAccountId}
        onChange={(event) => setGitAccountId(event.target.value)}
        options={accounts.map((account) => ({
          value: account.id,
          label: `${account.name} (${account.provider})`,
        }))}
      />
      <p className="-mt-1 font-mono text-[11px] text-fg-faint">
        {t("projects:form.credentialsHint")}
      </p>

      <TextField
        id="project-test-command"
        label={t("projects:form.testCommand")}
        type="text"
        placeholder="npm test"
        value={testCommand}
        onChange={(event) => setTestCommand(event.target.value)}
      />
      <p className="-mt-1 font-mono text-[11px] text-fg-faint">
        {t("projects:form.testCommandHint")}
      </p>

      <TextField
        id="project-install-command"
        label={t("projects:form.installCommand")}
        type="text"
        placeholder="pnpm install"
        value={installCommand}
        onChange={(event) => setInstallCommand(event.target.value)}
      />
      <p className="-mt-1 font-mono text-[11px] text-fg-faint">
        {t("projects:form.installCommandHint")}
      </p>

      <FormError message={error} />
      <SubmitButton pending={pending}>
        {pending ? t("projects:form.saving") : t("projects:form.save")}
      </SubmitButton>
    </form>
  );
}
