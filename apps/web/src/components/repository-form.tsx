import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { RepositoryPatch } from "../lib/api";
import { deriveFullName } from "../lib/format";
import { gitAccountsQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";
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
  /**
   * Account revisore attuale (ciclo di correzione); null/assente = nessuno.
   * Opzionale apposta: chi monta il form lo legge da una risposta che il web
   * NON parsa (cast), quindi da un server più vecchio arriva `undefined`.
   */
  reviewGitAccountId?: string | null;
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
  // Account revisore: "" = nessuno. `?? ""` difende anche un `undefined` da un
  // server più vecchio (il campo è opzionale proprio per questo).
  const [reviewGitAccountId, setReviewGitAccountId] = useState(initial.reviewGitAccountId ?? "");
  // Le opzioni seguono le regole del server (stesso provider, stesso
  // workspace Bitbucket, mai il principale): proporre un account che il PATCH
  // rifiuterebbe sarebbe un'opzione che fallisce sempre. Il server resta
  // l'autorità: questo filtro è una comodità, non un controllo.
  const mainAccount = accounts.find((account) => account.id === gitAccountId);
  const reviewCandidates = accounts.filter(
    (account) =>
      account.id !== gitAccountId &&
      account.provider === mainAccount?.provider &&
      (account.provider !== "bitbucket" || account.workspace === mainAccount.workspace),
  );
  // Il revisore DECADE (si mostra e si salva «nessuno») solo se è stato
  // cambiato il principale IN QUESTO FORM e il revisore non è più fra le
  // opzioni. Un revisore SALVATO che il filtro esclude per altri motivi (es.
  // qualcuno ha corretto il workspace dell'account) resta com'è: il server,
  // su un PATCH che non tocca il campo, lo lascerebbe invariato, e non deve
  // essere il client a cancellarlo in silenzio. Si mostra marcato non valido,
  // così l'admin lo vede e decide.
  const mainChanged = gitAccountId !== initial.gitAccountId;
  const storedReview = initial.reviewGitAccountId ?? "";
  const reviewIsCandidate = reviewCandidates.some((account) => account.id === reviewGitAccountId);
  const keepsInvalidStored =
    !reviewIsCandidate && !mainChanged && reviewGitAccountId !== "" && reviewGitAccountId === storedReview;
  const effectiveReview = reviewIsCandidate || keepsInvalidStored ? reviewGitAccountId : "";
  const invalidStoredAccount = accounts.find((account) => account.id === storedReview);
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
      const nextReview = effectiveReview === "" ? null : effectiveReview;
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
        // Revisore incluso solo se cambiato (null↔id): il server tratta
        // l'assenza come "invariato", e un PATCH che lo rimandasse uguale
        // rifarebbe le verifiche sul provider (permessi, identità) per niente.
        ...(nextReview !== (initial.reviewGitAccountId ?? null) && {
          reviewGitAccountId: nextReview,
        }),
      });
    } catch (cause) {
      // I `code` del revisore (e gli altri del PATCH) hanno una chiave
      // `errors:*`; per un errore senza chiave si ricade sul `message`.
      setError(translateApiError(cause, t));
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

      <SelectField
        id="repository-review-account"
        label={t("repositories:form.reviewAccount")}
        value={effectiveReview}
        onChange={(event) => setReviewGitAccountId(event.target.value)}
        aria-describedby="repository-review-account-hint"
        options={[
          { value: "", label: t("repositories:form.reviewAccountNone") },
          ...reviewCandidates.map((account) => ({
            value: account.id,
            label: `${account.name} (${account.provider})`,
          })),
          // Il revisore salvato che il filtro esclude: resta selezionabile
          // (è il valore attuale) ma dice perché non va più bene.
          ...(!mainChanged && storedReview !== "" && !reviewCandidates.some((a) => a.id === storedReview)
            ? [
                {
                  value: storedReview,
                  label: t("repositories:form.reviewAccountInvalid", {
                    name: invalidStoredAccount?.name ?? storedReview,
                  }),
                },
              ]
            : []),
        ]}
      />
      <p id="repository-review-account-hint" className="-mt-1 font-mono text-[11px] text-fg-faint">
        {t("repositories:form.reviewAccountHint")}
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
