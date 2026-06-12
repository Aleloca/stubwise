import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  getAccountBranches,
  getAccountRepositories,
  type ProjectDraft,
  type RepoSummary,
} from "../lib/api";
import { gitAccountsQueryOptions } from "../lib/queries";
import { ProviderBadge } from "./badges";
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
  const { data: accounts } = useSuspenseQuery(gitAccountsQueryOptions);

  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [selectedRepo, setSelectedRepo] = useState<RepoSummary | null>(null);
  const [search, setSearch] = useState("");
  const [branch, setBranch] = useState("");
  // Fallback manuale: repoUrl/branch a mano quando il picker non è disponibile
  // o l'utente sceglie di inserirli manualmente.
  const [manualRepoUrl, setManualRepoUrl] = useState("");
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

  // Cambiando account si azzera la scelta repo/branch: non avrebbero più senso.
  useEffect(() => {
    setSelectedRepo(null);
    setSearch("");
    setBranch("");
    setManualRepoUrl("");
  }, [accountId]);

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
  const branches = branchesQuery.data?.branches ?? [];
  // Il branch scelto potrebbe non essere nell'elenco (preselezione del repo):
  // lo si include comunque come opzione per non perderlo.
  const branchOptions = useMemo(() => {
    const set = new Set(branches);
    if (branch) set.add(branch);
    return [...set];
  }, [branches, branch]);

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
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Errore imprevisto");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-6" noValidate>
      <TextField
        id="wizard-name"
        label="Nome"
        required
        placeholder="Es. Demo Shop"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      {accounts.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line-strong px-4 py-6">
          <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
            // nessun account git
          </p>
          <p className="mt-2 text-sm text-fg-muted">
            Crea prima un account git in{" "}
            <Link to="/settings" className="text-signal underline hover:text-signal-bright">
              Settings → Account Git
            </Link>
            , poi torna qui per collegarlo a un repository.
          </p>
        </div>
      ) : (
        <Step label="Account git">
          <SelectField
            id="wizard-account"
            label="Account git"
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
        <Step label="Repository">
          {reposQuery.isLoading ? (
            <p className="font-mono text-[12px] text-fg-faint">// caricamento repository…</p>
          ) : (
            <>
              <TextField
                id="wizard-repo-search"
                label="Cerca repository"
                type="text"
                placeholder="Filtra per nome…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <ul className="mt-3 max-h-64 overflow-y-auto rounded-sm border border-line bg-ink-950/40">
                {filteredRepos.length === 0 ? (
                  <li className="px-3 py-3 font-mono text-[12px] text-fg-faint">
                    // nessun repository corrisponde
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
                              default: {repo.defaultBranch}
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
        <Step label="Repository">
          <p
            role="alert"
            className="mb-3 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[12px] text-danger"
          >
            {reposQuery.error instanceof Error
              ? reposQuery.error.message
              : "Impossibile elencare i repository dell'account"}
          </p>
          <p className="mb-3 font-mono text-[11px] text-fg-faint">
            // elenco non disponibile: inserisci URL e branch manualmente.
          </p>
          <TextField
            id="wizard-manual-repo-url"
            label="URL repository"
            type="url"
            required
            placeholder="https://github.com/acme/demo"
            value={manualRepoUrl}
            onChange={(event) => setManualRepoUrl(event.target.value)}
          />
          <div className="mt-4">
            <TextField
              id="wizard-manual-branch"
              label="Branch di default"
              required
              placeholder="main"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>
        </Step>
      )}

      {!manualMode && selectedRepo && (
        <Step label="Branch di default">
          {branchesQuery.isLoading ? (
            <p className="font-mono text-[12px] text-fg-faint">// caricamento branch…</p>
          ) : branchesQuery.isError ? (
            <>
              <p
                role="alert"
                className="mb-3 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[12px] text-danger"
              >
                {branchesQuery.error instanceof Error
                  ? branchesQuery.error.message
                  : "Impossibile elencare i branch"}
              </p>
              <TextField
                id="wizard-branch-manual"
                label="Branch di default"
                required
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
              />
            </>
          ) : (
            <SelectField
              id="wizard-branch"
              label="Branch di default"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              options={branchOptions.map((b) => ({ value: b, label: b }))}
            />
          )}
        </Step>
      )}

      <FormError message={error} />
      <SubmitButton pending={pending} disabled={!canSubmit}>
        {pending ? "Creazione…" : "Crea progetto"}
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
