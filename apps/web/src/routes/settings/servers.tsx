import { checkTypeSchema, type CheckType } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  createServer,
  createServerCheck,
  deleteServer,
  deleteServerCheck,
  regenerateServerKey,
  updateServer,
  updateServerCheck,
  type CreateCheckInput,
  type ProjectListItem,
  type ServerCheck,
  type ServerView,
  type ServerWithKey,
} from "../../lib/api";
import {
  projectsQueryOptions,
  serverChecksQueryOptions,
  serverKeys,
  serversQueryOptions,
} from "../../lib/queries";
import { FormError, SelectField, SubmitButton, TextField } from "../../components/field";

/** I tipi di check DB: per questi il `target` è una connection string cifrata. */
const DB_CHECK_TYPES: ReadonlySet<CheckType> = new Set<CheckType>(["postgres", "mysql"]);

/**
 * Comando `docker run` completo per installare l'agente su un host monitorato.
 * `STUBWISE_URL` è preso dall'origin del browser (l'istanza corrente), la chiave
 * è interpolata così com'è. Mostrato SOLO nel dialog a creazione/rigenerazione:
 * la chiave in chiaro non è mai persistita né rifetchabile dal client.
 */
function dockerRunCommand(key: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return [
    "docker run -d --name stubwise-agent --restart unless-stopped \\",
    '  --group-add "$(stat -c %g /var/run/docker.sock)" \\',
    "  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock:ro \\",
    `  -e STUBWISE_URL=${origin} -e STUBWISE_SERVER_KEY=${key} \\`,
    "  stubwise/agent",
  ].join("\n");
}

/**
 * Sotto-pagina Impostazioni → Server (solo admin): registrazione dei server
 * monitorati, comando d'installazione dell'agente (chiave one-shot),
 * associazione progetti ed editor dei check di servizio.
 *
 * SICUREZZA: la chiave dell'agente vive solo nello stato del dialog (rivelata
 * una volta da create/regenerate), mai in cache né rifetchabile; i DSN dei check
 * DB non escono mai dall'API (flag `hasDsn`), quindi non vengono mai mostrati.
 */
export function SettingsServersPage() {
  const { t } = useTranslation();
  const { data: servers } = useSuspenseQuery(serversQueryOptions());
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const [creating, setCreating] = useState(false);
  // Chiave rivelata (create/regenerate): mostrata nel dialog, mai persistita.
  const [revealed, setRevealed] = useState<ServerWithKey | null>(null);

  return (
    <section className="rounded-sm border border-line bg-ink-900 lg:col-span-2">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:servers.title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t("settings:servers.subtitle")}
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("settings:servers.newServer")}
          </button>
        )}
      </header>

      {creating && (
        <div className="border-b border-line px-4 py-4">
          <NewServerForm
            onDone={() => setCreating(false)}
            onCreated={(server) => {
              setCreating(false);
              setRevealed(server);
            }}
          />
        </div>
      )}

      {servers.length === 0 && !creating ? (
        <p className="px-4 py-8 text-center font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
          {t("settings:servers.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              projects={projects}
              onRevealKey={setRevealed}
            />
          ))}
        </ul>
      )}

      {revealed && <KeyDialog server={revealed} onClose={() => setRevealed(null)} />}
    </section>
  );
}

/** Form di registrazione: solo il nome. Sul successo rivela la chiave (dialog). */
function NewServerForm({
  onDone,
  onCreated,
}: {
  onDone: () => void;
  onCreated: (server: ServerWithKey) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const mutation = useMutation({
    mutationFn: () => createServer(name.trim()),
    onSuccess: async (server) => {
      await queryClient.invalidateQueries({ queryKey: serverKeys.lists() });
      onCreated(server);
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id="new-server-name"
        label={t("settings:servers.name")}
        required
        placeholder={t("settings:servers.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending} disabled={name.trim() === ""}>
          {mutation.isPending ? t("settings:servers.creating") : t("settings:servers.create")}
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

/**
 * Dialog con il comando `docker run` completo di chiave. La chiave è visibile
 * SOLO qui, una volta: un avviso lo ricorda. Bottone per copiare l'intero
 * comando negli appunti.
 */
function KeyDialog({ server, onClose }: { server: ServerWithKey; onClose: () => void }) {
  const { t } = useTranslation();
  const command = dockerRunCommand(server.key);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
    } catch {
      // Clipboard non disponibile (contesto non sicuro): l'utente copia a mano.
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("settings:servers.keyTitle")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-sm border border-line bg-ink-900 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b border-line px-4 py-3">
          <h3 className="font-mono text-[12px] font-medium tracking-[0.14em] text-fg uppercase">
            {t("settings:servers.keyTitle")}
          </h3>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t("settings:servers.keyIntro", { name: server.name })}
          </p>
        </header>

        <div className="space-y-3 px-4 py-4">
          <pre className="overflow-x-auto rounded-sm border border-line-strong bg-ink-950/70 px-3 py-3 font-mono text-[12px] leading-relaxed whitespace-pre text-fg">
            {command}
          </pre>
          <p role="alert" className="font-mono text-[12px] text-signal">
            {t("settings:servers.keyWarning")}
          </p>
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={copy}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {copied ? t("settings:servers.copied") : t("settings:servers.copy")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
          >
            {t("settings:servers.close")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Riga di un server: anagrafica, stato, progetti e azioni admin. */
function ServerRow({
  server,
  projects,
  onRevealKey,
}: {
  server: ServerView;
  projects: ProjectListItem[];
  onRevealKey: (server: ServerWithKey) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);

  const deletion = useMutation({
    mutationFn: () => deleteServer(server.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serverKeys.lists() });
    },
  });

  const regeneration = useMutation({
    mutationFn: () => regenerateServerKey(server.id),
    onSuccess: async (revealed) => {
      setConfirmingRegen(false);
      await queryClient.invalidateQueries({ queryKey: serverKeys.lists() });
      onRevealKey(revealed);
    },
  });

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[14px] font-medium text-fg">{server.name}</span>
        <span className="font-mono text-[11px] text-fg-muted">
          {server.hostname ?? t("settings:servers.neverConnected")}
        </span>
        <span
          className={`font-mono text-[11px] tracking-[0.08em] uppercase ${
            server.status === "online"
              ? "text-ok"
              : server.status === "offline"
                ? "text-danger"
                : "text-fg-faint"
          }`}
        >
          {t(`monitor:status.${server.status}`)}
        </span>
        {server.projects.length > 0 && (
          <span className="font-mono text-[11px] text-fg-faint">
            {server.projects.map((project) => project.name).join(", ")}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RowButton
            onClick={() => setShowChecks((value) => !value)}
            label={t("settings:servers.checks")}
          />
          <RowButton
            onClick={() => setEditing((value) => !value)}
            label={t("settings:servers.edit")}
          />
          {confirmingRegen ? (
            <>
              <RowButton
                onClick={() => regeneration.mutate()}
                disabled={regeneration.isPending}
                label={t("settings:servers.regenerateConfirm")}
              />
              <RowButton onClick={() => setConfirmingRegen(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingRegen(true)}
              label={t("settings:servers.regenerate")}
            />
          )}
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => deletion.mutate()}
                disabled={deletion.isPending}
                label={t("settings:servers.deleteConfirm")}
                danger
              />
              <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingDelete(true)}
              label={t("settings:servers.delete")}
              danger
            />
          )}
        </div>
      </div>

      {confirmingRegen && (
        <p className="mt-2 font-mono text-[12px] text-signal">
          {t("settings:servers.regenerateWarning")}
        </p>
      )}
      {confirmingDelete && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {t("settings:servers.deleteWarning")}
        </p>
      )}
      {deletion.isError && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {deletion.error instanceof Error ? deletion.error.message : ""}
        </p>
      )}
      {regeneration.isError && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {regeneration.error instanceof Error ? regeneration.error.message : ""}
        </p>
      )}

      {editing && (
        <div className="mt-3 rounded-sm border border-line bg-ink-950/40 p-4">
          <EditServerForm
            server={server}
            projects={projects}
            onDone={() => setEditing(false)}
          />
        </div>
      )}

      {showChecks && (
        <div className="mt-3 rounded-sm border border-line bg-ink-950/40 p-4">
          <ChecksEditor serverId={server.id} />
        </div>
      )}
    </li>
  );
}

/** Form di modifica: nome, intervallo di campionamento e progetti associati. */
function EditServerForm({
  server,
  projects,
  onDone,
}: {
  server: ServerView;
  projects: ProjectListItem[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(server.name);
  const [interval, setInterval] = useState(String(server.sampleIntervalSeconds));
  const [projectIds, setProjectIds] = useState<string[]>(server.projects.map((p) => p.id));

  const mutation = useMutation({
    mutationFn: () =>
      updateServer(server.id, {
        name: name.trim(),
        sampleIntervalSeconds: Math.min(300, Math.max(10, Math.round(Number(interval)) || 30)),
        projectIds,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serverKeys.lists() });
      onDone();
    },
  });

  function toggleProject(id: string, checked: boolean) {
    setProjectIds((current) =>
      checked ? [...current, id] : current.filter((value) => value !== id),
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id={`edit-server-name-${server.id}`}
        label={t("settings:servers.name")}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        id={`edit-server-interval-${server.id}`}
        label={t("settings:servers.interval")}
        type="number"
        min={10}
        max={300}
        value={interval}
        onChange={(event) => setInterval(event.target.value)}
      />

      <fieldset className="rounded-sm border border-line bg-ink-950/40 p-4">
        <legend className="px-1.5 font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t("settings:servers.projects")}
        </legend>
        {projects.length === 0 ? (
          <p className="font-mono text-[11px] text-fg-faint">{t("settings:servers.noProjects")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {projects.map((project) => (
              <label
                key={project.id}
                className="flex items-center gap-2 font-mono text-[12px] text-fg-muted"
              >
                <input
                  type="checkbox"
                  checked={projectIds.includes(project.id)}
                  onChange={(event) => toggleProject(project.id, event.target.checked)}
                  className="size-4 accent-signal"
                />
                {project.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending ? t("settings:servers.saving") : t("settings:servers.save")}
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

/** Editor dei check di un server: lista + form di creazione. */
function ChecksEditor({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { data: checks, isLoading } = useQuery(serverChecksQueryOptions(serverId));
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h4 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t("settings:servers.checks")}
        </h4>
        {!creating && (
          <RowButton onClick={() => setCreating(true)} label={t("settings:servers.newCheck")} />
        )}
      </div>

      {isLoading ? null : checks && checks.length > 0 ? (
        <ul className="divide-y divide-line rounded-sm border border-line">
          {checks.map((check) => (
            <CheckRow key={check.id} serverId={serverId} check={check} />
          ))}
        </ul>
      ) : (
        <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
          {t("settings:servers.checkEmpty")}
        </p>
      )}

      {creating && (
        <div className="rounded-sm border border-line bg-ink-900 p-3">
          <CheckForm serverId={serverId} onDone={() => setCreating(false)} />
        </div>
      )}
    </div>
  );
}

/** Riga di un check: tipo/nome/target-o-DSN/intervallo/stato + azioni. */
function CheckRow({ serverId, check }: { serverId: string; check: ServerCheck }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deletion = useMutation({
    mutationFn: () => deleteServerCheck(serverId, check.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serverKeys.checks(serverId) });
    },
  });

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]">
        <span className="text-fg">{check.name}</span>
        <span className="text-fg-faint uppercase">{t(`settings:servers.checkTypeLabels.${check.type}`)}</span>
        <span className="text-fg-muted">
          {check.hasDsn ? (
            <span className="text-fg-faint italic">{t("settings:servers.encryptedDsn")}</span>
          ) : (
            check.target || "—"
          )}
        </span>
        <span className="text-fg-faint">{check.intervalSeconds}s</span>
        {!check.enabled && (
          <span className="text-fg-faint uppercase">{t("settings:servers.disabled")}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <RowButton onClick={() => setEditing((value) => !value)} label={t("settings:servers.edit")} />
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => deletion.mutate()}
                disabled={deletion.isPending}
                label={t("settings:servers.checkConfirm")}
                danger
              />
              <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingDelete(true)}
              label={t("settings:servers.delete")}
              danger
            />
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 rounded-sm border border-line bg-ink-900 p-3">
          <CheckForm serverId={serverId} check={check} onDone={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}

/**
 * Form di check condiviso creazione/modifica. In creazione `target` è
 * obbligatorio; in modifica di un check DB può restare vuoto (= DSN invariato).
 * Cambiare il tipo richiede un nuovo target: il 400
 * `target_required_for_type_change` del server viene mostrato inline.
 */
function CheckForm({
  serverId,
  check,
  onDone,
}: {
  serverId: string;
  check?: ServerCheck;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isEdit = check !== undefined;

  const [type, setType] = useState<CheckType>(check?.type ?? "http");
  const [name, setName] = useState(check?.name ?? "");
  // In modifica i check DB non espongono il target (hasDsn): il campo parte vuoto.
  const [target, setTarget] = useState(check && !check.hasDsn ? check.target : "");
  const [interval, setInterval] = useState(String(check?.intervalSeconds ?? 60));
  const [enabled, setEnabled] = useState(check?.enabled ?? true);

  const isDb = DB_CHECK_TYPES.has(type);
  const typeChanged = isEdit && check.type !== type;

  const mutation = useMutation({
    mutationFn: () => {
      const intervalSeconds = Math.min(3600, Math.max(10, Math.round(Number(interval)) || 60));
      const trimmedTarget = target.trim();
      if (isEdit) {
        // Patch: `target` inviato solo se valorizzato (vuoto = invariato, DSN incluso).
        return updateServerCheck(serverId, check.id, {
          type,
          name: name.trim(),
          intervalSeconds,
          enabled,
          ...(trimmedTarget !== "" ? { target: trimmedTarget } : {}),
        });
      }
      const body: CreateCheckInput = {
        type,
        name: name.trim(),
        target: trimmedTarget,
        intervalSeconds,
        enabled,
      };
      return createServerCheck(serverId, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serverKeys.checks(serverId) });
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  // Messaggio d'errore: traduce il codice noto del cambio tipo senza target.
  const errorMessage =
    mutation.error instanceof ApiError && mutation.error.code === "target_required_for_type_change"
      ? t("settings:servers.targetRequiredForTypeChange")
      : mutation.error instanceof Error
        ? mutation.error.message
        : null;

  const targetLabelKey = isDb
    ? "settings:servers.targetLabel.db"
    : `settings:servers.targetLabel.${type}`;
  const targetPlaceholderKey = isDb
    ? "settings:servers.targetPlaceholder.db"
    : `settings:servers.targetPlaceholder.${type}`;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
      <SelectField
        id={`check-type-${check?.id ?? "new"}`}
        label={t("settings:servers.checkType")}
        value={type}
        onChange={(event) => setType(event.target.value as CheckType)}
        options={checkTypeSchema.options.map((option) => ({
          value: option,
          label: t(`settings:servers.checkTypeLabels.${option}`),
        }))}
      />
      <TextField
        id={`check-name-${check?.id ?? "new"}`}
        label={t("settings:servers.checkName")}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id={`check-target-${check?.id ?? "new"}`}
          label={t(targetLabelKey)}
          required={!isEdit}
          value={target}
          placeholder={t(targetPlaceholderKey)}
          onChange={(event) => setTarget(event.target.value)}
        />
        {isDb && (
          <p className="font-mono text-[11px] text-fg-faint">
            {isEdit ? t("settings:servers.dsnKeepNote") : t("settings:servers.dsnNote")}
          </p>
        )}
        {typeChanged && (
          <p className="font-mono text-[11px] text-signal">
            {t("settings:servers.targetRequiredForTypeChange")}
          </p>
        )}
      </div>
      <TextField
        id={`check-interval-${check?.id ?? "new"}`}
        label={t("settings:servers.checkInterval")}
        type="number"
        min={10}
        max={3600}
        value={interval}
        onChange={(event) => setInterval(event.target.value)}
      />
      <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="size-4 accent-signal"
        />
        {t("settings:servers.checkEnabled")}
      </label>

      <FormError message={errorMessage} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending
            ? t("settings:servers.savingCheck")
            : isEdit
              ? t("settings:servers.saveCheck")
              : t("settings:servers.addCheck")}
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
