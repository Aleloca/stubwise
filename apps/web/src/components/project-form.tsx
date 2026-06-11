import { gitProviderKindSchema, type GitProviderKind } from "@stubwise/shared";
import { useState, type FormEvent } from "react";
import {
  postValidateCredentials,
  type CredentialCheck,
  type GitCredentials,
  type ProjectDraft,
  type ProjectPatch,
} from "../lib/api";
import { FormError, SelectField, SubmitButton, TextField } from "./field";
import { PROVIDER_LABELS } from "./badges";

interface ProjectInitialValues {
  name: string;
  provider: GitProviderKind;
  repoUrl: string;
  defaultBranch: string;
}

/**
 * Unione discriminata sul mode: in creazione `onSubmit` riceve un
 * {@link ProjectDraft} completo; in modifica un {@link ProjectPatch} senza
 * provider (immutabile) e con `credentials` solo se c'è un token nuovo.
 */
type ProjectFormProps =
  | { mode: "create"; initial?: undefined; onSubmit: (values: ProjectDraft) => Promise<void> }
  | {
      mode: "edit";
      initial: ProjectInitialValues;
      /**
       * Vero quando il progetto ha già delle credenziali salvate: il fieldset
       * credenziali parte collassato in uno stato "configurato", riapribile via
       * bottone. Solo in modifica (in creazione non c'è nulla da collassare).
       */
      credentialsConfigured?: boolean;
      onSubmit: (values: ProjectPatch) => Promise<void>;
    };

/**
 * Form progetto puro: API e navigazione iniettate via `onSubmit`.
 *
 * Le credenziali git sono write-only per contratto col server: qui i campi
 * partono SEMPRE vuoti (niente prefill nemmeno in modifica) e in modifica
 * un token vuoto significa "lascia quelle salvate".
 */
export function ProjectForm(props: ProjectFormProps) {
  const { mode, initial } = props;
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState<GitProviderKind>(initial?.provider ?? "bitbucket");
  const [repoUrl, setRepoUrl] = useState(initial?.repoUrl ?? "");
  const [defaultBranch, setDefaultBranch] = useState(initial?.defaultBranch ?? "main");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Fieldset credenziali: se sono già configurate (solo in modifica) parte
  // collassato in uno stato di conferma compatto; il bottone "Modifica
  // credenziali" rivela i campi (comportamento attuale), con "Annulla" per
  // richiudere e ripartire da campi vuoti.
  const credentialsConfigured = mode === "edit" && props.credentialsConfigured === true;
  const [editingCredentials, setEditingCredentials] = useState(false);
  const credentialsCollapsed = credentialsConfigured && !editingCredentials;

  // Stato della validazione credenziali: advisory, non blocca il submit.
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; checks: CredentialCheck[] } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  /** Costruisce le credenziali dai campi correnti, omettendo username/email vuoti. */
  function currentCredentials(): GitCredentials | undefined {
    const trimmedToken = token.trim();
    if (trimmedToken === "") return undefined;
    const trimmedUsername = username.trim();
    const trimmedEmail = email.trim();
    return {
      token: trimmedToken,
      ...(trimmedUsername !== "" && { username: trimmedUsername }),
      ...(trimmedEmail !== "" && { email: trimmedEmail }),
    };
  }

  async function handleValidate() {
    const credentials = currentCredentials();
    if (!credentials) return;
    setValidating(true);
    setValidation(null);
    setValidationError(null);
    try {
      const result = await postValidateCredentials({ provider, repoUrl, credentials });
      setValidation(result);
    } catch (cause) {
      setValidationError(cause instanceof Error ? cause.message : "Errore imprevisto");
    } finally {
      setValidating(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const credentials = currentCredentials();
      if (props.mode === "create") {
        // Lo schema del server richiede il token alla creazione.
        if (!credentials) {
          setError("Il token di accesso è obbligatorio alla creazione");
          return;
        }
        await props.onSubmit({ name, provider, repoUrl, defaultBranch, credentials });
      } else {
        await props.onSubmit({ name, repoUrl, defaultBranch, ...(credentials && { credentials }) });
      }
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

      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <SelectField
          id="project-provider"
          label="Provider"
          value={provider}
          // Il provider non è aggiornabile: cambia il modo in cui la
          // pipeline apre le PR, si fissa alla creazione.
          disabled={mode === "edit"}
          onChange={(event) => setProvider(event.target.value as GitProviderKind)}
          options={gitProviderKindSchema.options.map((kind) => ({
            value: kind,
            label: PROVIDER_LABELS[kind],
          }))}
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
      </div>

      <TextField
        id="project-default-branch"
        label="Branch di default"
        required
        value={defaultBranch}
        onChange={(event) => setDefaultBranch(event.target.value)}
      />

      <fieldset className="rounded-sm border border-line bg-ink-950/40 p-4">
        <legend className="px-1.5 font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          Credenziali git
        </legend>
        {credentialsCollapsed ? (
          <div
            data-testid="credentials-configured"
            className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-ok/30 bg-ok/10 px-3 py-2.5"
          >
            <span className="font-mono text-[12px] tracking-[0.04em] text-ok">
              ✓ Credenziali git configurate
            </span>
            <button
              type="button"
              onClick={() => setEditingCredentials(true)}
              className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              Modifica credenziali
            </button>
          </div>
        ) : (
          <>
        <p className="mb-4 font-mono text-[11px] leading-relaxed text-fg-faint">
          // write-only: vengono cifrate e non verranno mai mostrate di nuovo.
          <br />
          // Bitbucket: Username = username Bitbucket (per git), Email = email
          Atlassian (per la REST API/PR), Token = API token (scope repository +
          pullrequest, read e write).
          <br />
          // GitHub: lascia Username e Email vuoti, Token = fine-grained PAT
          (Contents + Pull requests: Read and write).
          {mode === "edit" && (
            <>
              <br />
              // lascia vuoto per mantenere quelle salvate.
            </>
          )}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="project-username"
            label="Username"
            type="text"
            autoComplete="off"
            placeholder="Bitbucket: username · GitHub: vuoto"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <TextField
            id="project-email"
            label="Email"
            type="text"
            autoComplete="off"
            placeholder="Bitbucket: email Atlassian (REST API) · GitHub: vuoto"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <TextField
            id="project-token"
            label="Token di accesso"
            type="password"
            autoComplete="new-password"
            required={mode === "create"}
            placeholder="API token / PAT"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              // Serve almeno il token: senza non c'è nulla da autenticare.
              disabled={token.trim() === "" || validating}
              onClick={() => void handleValidate()}
              className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {validating ? "Verifica in corso…" : "Valida credenziali"}
            </button>
            {credentialsConfigured && (
              <button
                type="button"
                // Richiude lo stato editing e ripristina i campi vuoti: tornare
                // alla conferma compatta senza credenziali in sospeso.
                onClick={() => {
                  setEditingCredentials(false);
                  setUsername("");
                  setEmail("");
                  setToken("");
                  setValidation(null);
                  setValidationError(null);
                }}
                className="rounded-sm px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
              >
                Annulla
              </button>
            )}
          </div>

          {validationError && (
            <p
              role="alert"
              className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[12px] text-danger"
            >
              {validationError}
            </p>
          )}

          {validation && (
            <div className="flex flex-col gap-2 rounded-sm border border-line bg-ink-950/40 p-3">
              <p
                className={`font-mono text-[12px] font-semibold tracking-[0.06em] uppercase ${
                  validation.ok ? "text-ok" : "text-danger"
                }`}
              >
                {validation.ok ? "Credenziali valide" : "Problemi rilevati"}
              </p>
              <ul className="flex flex-col gap-1.5">
                {validation.checks.map((check) => (
                  <li key={check.name} className="flex gap-2 font-mono text-[12px] leading-relaxed">
                    <span className={check.ok ? "text-ok" : "text-danger"}>{check.ok ? "✓" : "✗"}</span>
                    <span className="text-fg-muted">
                      <span className="text-fg">{check.name}</span> — {check.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
          </>
        )}
      </fieldset>

      <FormError message={error} />
      <SubmitButton pending={pending}>
        {mode === "create"
          ? pending
            ? "Creazione…"
            : "Crea progetto"
          : pending
            ? "Salvataggio…"
            : "Salva modifiche"}
      </SubmitButton>
    </form>
  );
}
