import { googleOauthScopes, GOOGLE_OAUTH_CALLBACK_PATH } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  deleteGoogleWorkspace,
  patchGoogleWorkspace,
  postGoogleWorkspace,
  type GoogleWorkspace,
  type GoogleWorkspacePatch,
} from "../lib/api";
import { formatDateTime } from "../lib/format";
import { googleWorkspacesQueryOptions } from "../lib/queries";
import { FormError, SubmitButton, TextField } from "./field";

/**
 * Sezione "Google Workspace" delle impostazioni (solo admin): il registro delle
 * app OAuth **interne** su cui gli operatori collegano le loro caselle.
 *
 * Il `clientSecret` è write-only, con la stessa UX dei segreti Slack: il campo
 * lasciato vuoto significa «non modificare» (il segreto salvato resta), e per
 * RIMUOVERE un segreto si spunta la casella dedicata — che è l'unico modo di
 * mandare la stringa vuota che il server interpreta come azzeramento.
 */
export function GoogleWorkspacesSection() {
  const { t } = useTranslation();
  const { data: workspaces } = useSuspenseQuery(googleWorkspacesQueryOptions);
  const [creating, setCreating] = useState(false);

  // Il redirect URI autorevole lo compone il SERVER (conosce `PUBLIC_URL`) e
  // arriva su ogni riga. Con il registro ancora vuoto — cioè proprio quando
  // l'admin sta creando l'app nella Console e ne ha più bisogno — si ripiega
  // sull'origin corrente, come già fa la sezione Slack per le sue request URL.
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://stubwise.example.com";
  const redirectUri = workspaces[0]?.redirectUri ?? `${origin}${GOOGLE_OAUTH_CALLBACK_PATH}`;

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:google.title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t("settings:google.subtitle")}
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("settings:google.newWorkspace")}
          </button>
        )}
      </header>

      <ConsoleBox redirectUri={redirectUri} />

      {creating && (
        <div className="border-b border-line px-4 py-4">
          <NewWorkspaceForm onDone={() => setCreating(false)} />
        </div>
      )}

      {workspaces.length === 0 && !creating ? (
        <p className="px-4 py-8 text-center font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
          {t("settings:google.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {workspaces.map((workspace) => (
            <WorkspaceRow key={workspace.id} workspace={workspace} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * I valori da incollare nella Google Cloud Console. Sono in cima e fuori dai
 * form di proposito: servono PRIMA di poter compilare qualunque campo, perché
 * il client id e il secret nascono di là.
 */
function ConsoleBox({ redirectUri }: { redirectUri: string }) {
  const { t } = useTranslation();
  return (
    <div className="border-b border-line bg-ink-950/40 px-4 py-4">
      <h3 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
        {t("settings:google.consoleTitle")}
      </h3>
      <dl className="mt-3 grid gap-3">
        <div>
          <dt className="font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase">
            {t("settings:google.redirectUri")}
          </dt>
          <dd className="mt-1 font-mono text-[12px] break-all text-fg">{redirectUri}</dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase">
            {t("settings:google.scopes")}
          </dt>
          <dd className="mt-1 font-mono text-[12px] break-all text-fg">
            {googleOauthScopes.join(" ")}
          </dd>
        </div>
      </dl>
      <p className="mt-3 font-mono text-[11px] leading-relaxed text-fg-faint">
        {t("settings:google.internalHint")}
      </p>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-fg-faint">
        {t("settings:google.apisHint")}
      </p>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-fg-faint">
        {t("settings:google.guideHint")}
      </p>
    </div>
  );
}

/**
 * I domini si scrivono in un campo solo, separati da virgola o spazio: è la
 * forma in cui si copiano dalla Console. La normalizzazione (lowercase, dedup)
 * la fa il server — qui si spezza soltanto.
 */
function parseDomains(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);
}

/** Form di creazione: nome, domini e le due metà delle credenziali OAuth. */
function NewWorkspaceForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const mutation = useMutation({
    mutationFn: postGoogleWorkspace,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: googleWorkspacesQueryOptions.queryKey });
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({
      name: name.trim(),
      domains: parseDomains(domains),
      clientId: clientId.trim(),
      clientSecret,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id="new-google-workspace-name"
        label={t("settings:google.name")}
        required
        placeholder={t("settings:google.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id="new-google-workspace-domains"
          label={t("settings:google.domains")}
          required
          placeholder={t("settings:google.domainsPlaceholder")}
          value={domains}
          onChange={(event) => setDomains(event.target.value)}
        />
        <p className="font-mono text-[11px] text-fg-faint">{t("settings:google.domainsHint")}</p>
      </div>
      <TextField
        id="new-google-workspace-client-id"
        label={t("settings:google.clientId")}
        required
        placeholder={t("settings:google.clientIdPlaceholder")}
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id="new-google-workspace-client-secret"
          type="password"
          label={t("settings:google.clientSecret")}
          required
          placeholder={t("settings:google.secretPlaceholder")}
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
        />
        <p className="font-mono text-[11px] text-fg-faint">{t("settings:google.secretHint")}</p>
      </div>

      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending ? t("settings:google.creating") : t("settings:google.create")}
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

/** Riga di un Workspace: identità, stato del segreto, caselle, azioni. */
function WorkspaceRow({ workspace }: { workspace: GoogleWorkspace }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deletion = useMutation({
    mutationFn: () => deleteGoogleWorkspace(workspace.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: googleWorkspacesQueryOptions.queryKey });
    },
  });

  // Il 409 ha una causa sola e la sappiamo già: caselle ancora collegate. Vale
  // la pena tradurla, invece di mostrare il messaggio tecnico del server.
  const deleteMessage =
    deletion.error instanceof ApiError && deletion.error.status === 409
      ? t("settings:google.inUse")
      : deletion.error instanceof Error
        ? deletion.error.message
        : null;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[14px] font-medium text-fg">{workspace.name}</span>
        <span className="font-mono text-[11px] text-fg-muted">{workspace.domains.join(", ")}</span>
        <span
          className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
            workspace.clientSecretSet
              ? "border-ok/40 text-ok"
              : "border-danger/40 text-danger"
          }`}
        >
          {workspace.clientSecretSet
            ? t("settings:google.secretSetBadge")
            : t("settings:google.secretMissingBadge")}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RowButton
            onClick={() => setEditing((value) => !value)}
            label={t("settings:google.edit")}
          />
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => deletion.mutate()}
                disabled={deletion.isPending}
                label={t("settings:google.confirm")}
                danger
              />
              <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingDelete(true)}
              label={t("settings:google.delete")}
              danger
            />
          )}
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-fg-faint">
        <span className="break-all">{workspace.clientId}</span>
        <span>{t("settings:google.accounts", { count: workspace.accountCount })}</span>
        <span>{t("settings:google.createdAt", { date: formatDateTime(workspace.createdAt) })}</span>
      </div>

      {deleteMessage && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {deleteMessage}
        </p>
      )}

      {editing && (
        <div className="mt-3 rounded-sm border border-line bg-ink-950/40 p-4">
          <EditWorkspaceForm workspace={workspace} onDone={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}

/** Form di modifica: il segreto vuoto resta quello salvato, la casella lo azzera. */
function EditWorkspaceForm({
  workspace,
  onDone,
}: {
  workspace: GoogleWorkspace;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const [domains, setDomains] = useState(workspace.domains.join(", "));
  const [clientId, setClientId] = useState(workspace.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [removeClientSecret, setRemoveClientSecret] = useState(false);

  const mutation = useMutation({
    mutationFn: (patch: GoogleWorkspacePatch) => patchGoogleWorkspace(workspace.id, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: googleWorkspacesQueryOptions.queryKey });
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const patch: GoogleWorkspacePatch = {
      name: name.trim(),
      domains: parseDomains(domains),
      clientId: clientId.trim(),
    };
    // "rimuovi" esplicito → ""; valore digitato → sostituisce; campo vuoto senza
    // rimozione → chiave OMESSA, così il segreto salvato non viene toccato.
    if (removeClientSecret) {
      patch.clientSecret = "";
    } else if (clientSecret !== "") {
      patch.clientSecret = clientSecret;
    }
    mutation.mutate(patch);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id={`edit-google-workspace-name-${workspace.id}`}
        label={t("settings:google.name")}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id={`edit-google-workspace-domains-${workspace.id}`}
          label={t("settings:google.domains")}
          required
          value={domains}
          onChange={(event) => setDomains(event.target.value)}
        />
        <p className="font-mono text-[11px] text-fg-faint">{t("settings:google.domainsHint")}</p>
      </div>
      <TextField
        id={`edit-google-workspace-client-id-${workspace.id}`}
        label={t("settings:google.clientId")}
        required
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id={`edit-google-workspace-client-secret-${workspace.id}`}
          type="password"
          label={t("settings:google.clientSecret")}
          placeholder={
            workspace.clientSecretSet
              ? t("settings:google.secretSetPlaceholder")
              : t("settings:google.secretPlaceholder")
          }
          value={clientSecret}
          disabled={mutation.isPending || removeClientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
        />
        {workspace.clientSecretSet && (
          <label className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
            <input
              type="checkbox"
              checked={removeClientSecret}
              disabled={mutation.isPending}
              onChange={(event) => setRemoveClientSecret(event.target.checked)}
              className="size-4 accent-signal"
            />
            {t("settings:google.removeClientSecret")}
          </label>
        )}
        <p className="font-mono text-[11px] text-fg-faint">{t("settings:google.secretHint")}</p>
      </div>

      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending ? t("settings:google.saving") : t("settings:google.save")}
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
