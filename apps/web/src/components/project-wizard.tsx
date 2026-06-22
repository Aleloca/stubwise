import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  getAccountBranches,
  getAccountRepositories,
  getValidateAccountRepo,
  type ProjectDraft,
  type RepoSummary,
} from "../lib/api";
import { gitAccountsQueryOptions } from "../lib/queries";
import { ProviderBadge } from "./badges";
import { BranchSelect } from "./branch-select";
import { CredentialChecks } from "./credential-fields";
import { FormError, SelectField, SubmitButton, TextField } from "./field";

interface ProjectWizardProps {
  onSubmit: (draft: ProjectDraft) => Promise<void>;
}

/**
 * Repository scelto nel wizard: o uno selezionato dal picker (con cloneUrl e
 * defaultBranch dal provider) o l'inserimento manuale di fallback (quando il
 * provider non espone l'elenco). In entrambi i casi alla fine si ha un repoUrl.
 */

/**
 * Wizard di creazione progetto: rivelazioni sequenziali — Nome, Account git,
 * Repository (picker filtrabile dai repo dell'account), Branch di default
 * (preselezionato). Se l'elenco repo/branch del provider non è disponibile
 * (scope mancante, credenziali finte) si degrada a inserimento manuale di
 * repoUrl e branch, così l'utente non resta bloccato.
 */
export function ProjectWizard({ onSubmit }: ProjectWizardProps) {
  const { t } = useTranslation();
  const { data: accounts } = useSuspenseQuery(gitAccountsQueryOptions);

  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [selectedRepo, setSelectedRepo] = useState<RepoSummary | null>(null);
  const [search, setSearch] = useState("");
  const [branch, setBranch] = useState("");
  // Fallback manuale: repoUrl/branch a mano quando il picker non è disponibile
  // o l'utente sceglie di inserirli manualmente.
  const [manualRepoUrl, setManualRepoUrl] = useState("");
  // Comando di test opzionale: vuoto = auto-detect (script test del package.json).
  const [testCommand, setTestCommand] = useState("");
  // Comando di installazione opzionale: vuoto = auto-rilevato dal lockfile.
  const [installCommand, setInstallCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Repository dell'account scelto: si carica solo con un account selezionato.
  const reposQuery = useQuery({
    queryKey: ["git-accounts", "detail", accountId, "repositories"],
    queryFn: () => getAccountRepositories(accountId),
    enabled: accountId !== "",
    retry: false,
    staleTime: 30_000,
  });

  // Branch del repository scelto dal picker: il defaultBranch del repo
  // preseleziona il select una volta caricati.
  const branchesQuery = useQuery({
    queryKey: ["git-accounts", "detail", accountId, "branches", selectedRepo?.fullName],
    queryFn: () => getAccountBranches(accountId, selectedRepo!.fullName),
    enabled: accountId !== "" && selectedRepo !== null,
    retry: false,
    staleTime: 30_000,
  });

  // Preseleziona il branch: defaultBranch del repo, o quello dichiarato
  // dall'API branches come fallback, appena disponibili.
  useEffect(() => {
    if (!selectedRepo) return;
    const fromBranches = branchesQuery.data?.defaultBranch ?? undefined;
    setBranch(selectedRepo.defaultBranch ?? fromBranches ?? "main");
  }, [selectedRepo, branchesQuery.data]);

  const filteredRepos = useMemo(() => {
    const repos = reposQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (q === "") return repos;
    return repos.filter(
      (repo) =>
        repo.fullName.toLowerCase().includes(q) || repo.name.toLowerCase().includes(q),
    );
  }, [reposQuery.data, search]);

  // Il fetch dei repo è fallito (scope mancante, credenziali finte): si abilita
  // l'inserimento manuale di repoUrl + branch.
  const manualMode = reposQuery.isError;

  const repoUrl = manualMode ? manualRepoUrl.trim() : (selectedRepo?.cloneUrl ?? "");

  // Nome completo del repo da verificare: dal picker (fullName) o, in fallback
  // manuale, ricavato dall'URL (gli ultimi due segmenti, senza .git).
  const repoFullName = useMemo(() => {
    if (selectedRepo) return selectedRepo.fullName;
    if (!manualMode || repoUrl === "") return null;
    try {
      const segments = new URL(repoUrl).pathname.split("/").filter((s) => s.length > 0);
      if (segments.length < 2) return null;
      const owner = segments[segments.length - 2]!;
      const repo = segments[segments.length - 1]!.replace(/\.git$/, "");
      return `${owner}/${repo}`;
    } catch {
      return null;
    }
  }, [selectedRepo, manualMode, repoUrl]);

  // Verifica advisory dell'accesso al repo: i 3 check repo-specifici (push git /
  // REST PR / webhook). NON blocca la creazione del progetto.
  const repoCheck = useMutation({
    mutationFn: (fullName: string) => getValidateAccountRepo(accountId, fullName),
  });

  // Cambiando account si azzera la scelta repo/branch e l'esito della verifica:
  // non avrebbero più senso. (Definito dopo repoCheck per usarne reset.)
  useEffect(() => {
    setSelectedRepo(null);
    setSearch("");
    setBranch("");
    setManualRepoUrl("");
    // repoCheck.reset è stabile fra i render: azzera l'esito stantio.
    repoCheck.reset();
  }, [accountId]);

  // L'esito della verifica è legato a un repo preciso: cambiando repo lo si
  // azzera per non mostrare check di un altro repository.
  useEffect(() => {
    repoCheck.reset();
  }, [repoFullName]);

  const canSubmit =
    name.trim() !== "" && accountId !== "" && repoUrl !== "" && branch.trim() !== "";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!canSubmit) return;
    setPending(true);
    try {
      await onSubmit({
        name: name.trim(),
        gitAccountId: accountId,
        repoUrl,
        defaultBranch: branch.trim(),
        // Vuoto → null (auto-detect); altrimenti il comando senza spazi di contorno.
        testCommand: testCommand.trim() === "" ? null : testCommand.trim(),
        // Vuoto → null (auto-rilevato dal lockfile); altrimenti senza spazi di contorno.
        installCommand: installCommand.trim() === "" ? null : installCommand.trim(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-6" noValidate>
      <TextField
        id="wizard-name"
        label={t("projects:wizard.name")}
        required
        placeholder={t("projects:wizard.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      {accounts.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line-strong px-4 py-6">
          <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
            {t("projects:wizard.noGitAccount")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">
            {t("projects:wizard.createAccountFirstPrefix")}
            <Link to="/settings" className="text-signal underline hover:text-signal-bright">
              {t("projects:wizard.createAccountFirstLink")}
            </Link>
            {t("projects:wizard.createAccountFirstSuffix")}
          </p>
        </div>
      ) : (
        <Step label={t("projects:wizard.gitAccount")}>
          <SelectField
            id="wizard-account"
            label={t("projects:wizard.gitAccount")}
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            options={accounts.map((account) => ({
              value: account.id,
              label: `${account.name} (${account.provider})`,
            }))}
          />
          {accounts
            .filter((account) => account.id === accountId)
            .map((account) => (
              <div key={account.id} className="mt-2">
                <ProviderBadge provider={account.provider} />
              </div>
            ))}
        </Step>
      )}

      {accountId !== "" && !manualMode && (
        <Step label={t("projects:wizard.repository")}>
          {reposQuery.isLoading ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("projects:wizard.loadingRepos")}</p>
          ) : (
            <>
              <TextField
                id="wizard-repo-search"
                label={t("projects:wizard.searchRepo")}
                type="text"
                placeholder={t("projects:wizard.searchRepoPlaceholder")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <ul className="mt-3 max-h-64 overflow-y-auto rounded-sm border border-line bg-ink-950/40">
                {filteredRepos.length === 0 ? (
                  <li className="px-3 py-3 font-mono text-[12px] text-fg-faint">
                    {t("projects:wizard.noRepoMatch")}
                  </li>
                ) : (
                  filteredRepos.map((repo) => {
                    const active = selectedRepo?.fullName === repo.fullName;
                    return (
                      <li key={repo.fullName} className="border-b border-line last:border-b-0">
                        <button
                          type="button"
                          onClick={() => setSelectedRepo(repo)}
                          className={`flex w-full flex-wrap items-baseline gap-x-3 px-3 py-2.5 text-left transition-colors ${
                            active ? "bg-signal/10" : "hover:bg-ink-850"
                          }`}
                        >
                          <span className={`font-mono text-[13px] ${active ? "text-signal" : "text-fg"}`}>
                            {repo.fullName}
                          </span>
                          {repo.defaultBranch && (
                            <span className="font-mono text-[11px] text-fg-faint">
                              {t("projects:wizard.default")}: {repo.defaultBranch}
                            </span>
                          )}
                          {active && <span className="ml-auto font-mono text-[12px] text-signal">✓</span>}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          )}
        </Step>
      )}

      {manualMode && (
        <Step label={t("projects:wizard.repository")}>
          <p
            role="alert"
            className="mb-3 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[12px] text-danger"
          >
            {reposQuery.error instanceof Error
              ? reposQuery.error.message
              : t("projects:wizard.listReposFailed")}
          </p>
          <p className="mb-3 font-mono text-[11px] text-fg-faint">
            {t("projects:wizard.manualHint")}
          </p>
          <TextField
            id="wizard-manual-repo-url"
            label={t("projects:wizard.repoUrl")}
            type="url"
            required
            placeholder="https://github.com/acme/demo"
            value={manualRepoUrl}
            onChange={(event) => setManualRepoUrl(event.target.value)}
          />
          <div className="mt-4">
            <TextField
              id="wizard-manual-branch"
              label={t("projects:wizard.defaultBranch")}
              required
              placeholder="main"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>
        </Step>
      )}

      {!manualMode && selectedRepo && (
        <Step label={t("projects:wizard.defaultBranch")}>
          {/*
            Stesso componente del form di modifica: select dei branch via API,
            con fallback a input testuale su errore. Il branch è già
            preselezionato dal defaultBranch del repo scelto (vedi l'effetto
            sopra), quindi BranchSelect non lo sovrascrive.
          */}
          <BranchSelect
            id="wizard-branch"
            accountId={accountId}
            repoFullName={selectedRepo.fullName}
            value={branch}
            onChange={setBranch}
          />
        </Step>
      )}

      {repoFullName && (
        <Step label={t("projects:wizard.verifyAccess")}>
          <p className="mb-3 font-mono text-[11px] text-fg-faint">
            {t("projects:wizard.verifyHint1")}
            <br />
            {t("projects:wizard.verifyHint2")}
          </p>
          <button
            type="button"
            onClick={() => repoCheck.mutate(repoFullName)}
            disabled={repoCheck.isPending}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {repoCheck.isPending ? t("projects:wizard.verifying") : t("projects:wizard.verifyAccess")}
          </button>
          {repoCheck.isError && (
            <p role="alert" className="mt-3 font-mono text-[12px] text-danger">
              {repoCheck.error instanceof Error
                ? repoCheck.error.message
                : t("projects:wizard.verifyError")}
            </p>
          )}
          {repoCheck.data && (
            <div className="mt-3">
              <CredentialChecks result={repoCheck.data} />
            </div>
          )}
        </Step>
      )}

      {repoUrl !== "" && (
        <Step label={t("projects:wizard.testCommand")}>
          <TextField
            id="wizard-test-command"
            label={t("projects:wizard.testCommand")}
            type="text"
            placeholder="npm test"
            value={testCommand}
            onChange={(event) => setTestCommand(event.target.value)}
          />
          <p className="mt-2 font-mono text-[11px] text-fg-faint">
            {t("projects:wizard.testCommandHint")}
          </p>
          <div className="mt-4">
            <TextField
              id="wizard-install-command"
              label={t("projects:wizard.installCommand")}
              type="text"
              placeholder="pnpm install"
              value={installCommand}
              onChange={(event) => setInstallCommand(event.target.value)}
            />
            <p className="mt-2 font-mono text-[11px] text-fg-faint">
              {t("projects:wizard.installCommandHint")}
            </p>
          </div>
        </Step>
      )}

      <FormError message={error} />
      <SubmitButton pending={pending} disabled={!canSubmit}>
        {pending ? t("projects:wizard.submitting") : t("projects:wizard.submit")}
      </SubmitButton>
    </form>
  );
}

/** Riquadro di uno step del wizard: legenda mono + contenuto. */
function Step({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-sm border border-line bg-ink-950/40 p-4">
      <legend className="px-1.5 font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
        {label}
      </legend>
      {children}
    </fieldset>
  );
}
