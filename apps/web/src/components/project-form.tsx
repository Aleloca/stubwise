import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
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
  const { data: accounts } = useSuspenseQuery(gitAccountsQueryOptions);

  const [name, setName] = useState(initial.name);
  const [repoUrl, setRepoUrl] = useState(initial.repoUrl);
  const [defaultBranch, setDefaultBranch] = useState(initial.defaultBranch);
  const [gitAccountId, setGitAccountId] = useState(initial.gitAccountId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await onSubmit({
        name,
        repoUrl,
        defaultBranch,
        // Includo gitAccountId solo se cambiato: un PATCH minimo evita di
        // ri-denormalizzare il provider quando non serve.
        ...(gitAccountId !== initial.gitAccountId && { gitAccountId }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Errore imprevisto");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
      <TextField
        id="project-name"
        label="Nome"
        required
        placeholder="Es. Demo Shop"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      <TextField
        id="project-repo-url"
        label="URL repository"
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
        label="Account git"
        value={gitAccountId}
        onChange={(event) => setGitAccountId(event.target.value)}
        options={accounts.map((account) => ({
          value: account.id,
          label: `${account.name} (${account.provider})`,
        }))}
      />
      <p className="-mt-1 font-mono text-[11px] text-fg-faint">
        // le credenziali vivono sull&apos;account: gestiscile in Settings → Account Git.
      </p>

      <FormError message={error} />
      <SubmitButton pending={pending}>
        {pending ? "Salvataggio…" : "Salva modifiche"}
      </SubmitButton>
    </form>
  );
}
