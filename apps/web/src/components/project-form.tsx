import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectPatch } from "../lib/api";
import { deriveFullName } from "../lib/format";
import { aiProvidersQueryOptions, gitAccountsQueryOptions } from "../lib/queries";
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
  /** Se true, ogni push sul branch di default rigenera la documentazione. */
  docAutoUpdate: boolean;
  /** Provider AI fissato per l'auto-aggiornamento; null = automatico (primo abilitato). */
  docAutoUpdateProviderId: string | null;
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
  // Provider AI configurati: alimentano il select del provider per l'auto-update.
  // Il form è admin-only (montato solo per gli admin nel dettaglio progetto),
  // quindi possiamo leggere l'endpoint admin senza ulteriore gating. Ordinati
  // per position (failover), mostriamo tutti i provider con label + tipo.
  const { data: providers } = useSuspenseQuery(aiProvidersQueryOptions);
  const sortedProviders = [...providers].sort((a, b) => a.position - b.position);

  const [name, setName] = useState(initial.name);
  const [repoUrl, setRepoUrl] = useState(initial.repoUrl);
  const [defaultBranch, setDefaultBranch] = useState(initial.defaultBranch);
  const [gitAccountId, setGitAccountId] = useState(initial.gitAccountId);
  // Comando di test come stringa controllata: vuoto = nessun comando (auto-detect).
  const [testCommand, setTestCommand] = useState(initial.testCommand ?? "");
  // Comando di installazione come stringa controllata: vuoto = auto-detect (dal lockfile).
  const [installCommand, setInstallCommand] = useState(initial.installCommand ?? "");
  // Auto-aggiornamento Docs ai push (default off) e provider fissato: "" =
  // automatico (primo abilitato), id = provider scelto.
  const [docAutoUpdate, setDocAutoUpdate] = useState(initial.docAutoUpdate);
  const [docAutoUpdateProviderId, setDocAutoUpdateProviderId] = useState(
    initial.docAutoUpdateProviderId ?? "",
  );
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
      // "" = automatico (primo abilitato) → null lato server; altrimenti l'id scelto.
      const nextProviderId = docAutoUpdateProviderId === "" ? null : docAutoUpdateProviderId;
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
        // docAutoUpdate incluso solo se cambiato (toggle), per un PATCH minimo.
        ...(docAutoUpdate !== initial.docAutoUpdate && { docAutoUpdate }),
        // Provider incluso solo se cambiato (null↔id) per un PATCH minimo.
        ...(nextProviderId !== (initial.docAutoUpdateProviderId ?? null) && {
          docAutoUpdateProviderId: nextProviderId,
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

      {/*
        Auto-aggiornamento Docs: toggle (default off) + select opzionale del
        provider, mostrato solo a toggle attivo. "" = automatico (primo provider
        abilitato in ordine di failover).
      */}
      <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-ink-900 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <input
            id="project-doc-auto-update"
            type="checkbox"
            checked={docAutoUpdate}
            onChange={(event) => setDocAutoUpdate(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-signal"
          />
          <label
            htmlFor="project-doc-auto-update"
            className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
          >
            {t("projects:form.docAutoUpdate")}
          </label>
        </div>
        <p className="font-mono text-[11px] text-fg-faint">
          {t("projects:form.docAutoUpdateHint")}
        </p>

        {docAutoUpdate && (
          <div className="mt-1">
            <SelectField
              id="project-doc-auto-update-provider"
              label={t("projects:form.docAutoUpdateProvider")}
              value={docAutoUpdateProviderId}
              onChange={(event) => setDocAutoUpdateProviderId(event.target.value)}
              options={[
                { value: "", label: t("projects:form.docAutoUpdateProviderAuto") },
                ...sortedProviders.map((provider) => ({
                  value: provider.id,
                  label: `${provider.label} (${provider.kind})`,
                })),
              ]}
            />
            <p className="mt-1.5 font-mono text-[11px] text-fg-faint">
              {t("projects:form.docAutoUpdateProviderHint")}
            </p>
          </div>
        )}
      </div>

      <FormError message={error} />
      <SubmitButton pending={pending}>
        {pending ? t("projects:form.saving") : t("projects:form.save")}
      </SubmitButton>
    </form>
  );
}
