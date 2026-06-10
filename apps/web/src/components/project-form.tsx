import { gitProviderKindSchema, type GitProviderKind } from "@stubwise/shared";
import { useState, type FormEvent } from "react";
import type { GitCredentials, ProjectDraft, ProjectPatch } from "../lib/api";
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
  | { mode: "edit"; initial: ProjectInitialValues; onSubmit: (values: ProjectPatch) => Promise<void> };

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
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const trimmedToken = token.trim();
      const trimmedUsername = username.trim();
      const credentials: GitCredentials | undefined =
        trimmedToken === ""
          ? undefined
          : trimmedUsername === ""
            ? { token: trimmedToken }
            : { username: trimmedUsername, token: trimmedToken };
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
        <p className="mb-4 font-mono text-[11px] leading-relaxed text-fg-faint">
          // write-only: vengono cifrate e non verranno mai mostrate di nuovo.
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
            label="Username (opzionale)"
            type="text"
            autoComplete="off"
            placeholder="Solo per Bitbucket"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <TextField
            id="project-token"
            label="Token di accesso"
            type="password"
            autoComplete="new-password"
            required={mode === "create"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
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
