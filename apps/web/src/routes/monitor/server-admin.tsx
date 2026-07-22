import { checkTypeSchema, type CheckType } from "@stubwise/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  createServer,
  createServerCheck,
  deleteServer,
  regenerateServerKey,
  updateServer,
  updateServerCheck,
  type CreateCheckInput,
  type ProjectListItem,
  type ServerCheck,
  type ServerView,
  type ServerWithKey,
} from "../../lib/api";
import { serverKeys } from "../../lib/queries";
import { useCopyWithFallback } from "../../lib/use-copy-with-fallback";
import { FormError, SelectField, SubmitButton, TextField } from "../../components/field";
import { Drawer } from "../../components/drawer";

/**
 * Componenti di gestione dei server monitorati (solo admin), spostati qui dalla
 * ex sotto-pagina Impostazioni → Server. Riusati dalla lista Monitor
 * (registrazione + guida chiave) e dal dettaglio server (editor check, editor
 * anagrafica, rigenera/elimina). La view resta accessibile a tutti; il gating
 * admin lo fanno i chiamanti (le route API sono comunque `requireAdmin`).
 *
 * SICUREZZA: la chiave dell'agente vive solo nello stato del componente
 * (rivelata una volta da create/regenerate), mai in cache né rifetchabile; i DSN
 * dei check DB non escono mai dall'API (flag `hasDsn`), quindi non sono mostrati.
 */

/** I tipi di check DB: per questi il `target` è una connection string cifrata. */
export const DB_CHECK_TYPES: ReadonlySet<CheckType> = new Set<CheckType>(["postgres", "mysql"]);

/**
 * Parsea un intervallo in secondi dall'input; null se non è un intero nel range
 * [min, max]. Niente clamp silenzioso: fuori range → errore inline nel form.
 */
export function parseIntervalSeconds(raw: string, min: number, max: number): number | null {
  const n = Math.round(Number(raw.trim()));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Comando `docker run` completo per installare l'agente su un host monitorato.
 * `STUBWISE_URL` è preso dall'origin del browser (l'istanza corrente), la chiave
 * è interpolata così com'è. Mostrato SOLO nel dialog a creazione/rigenerazione:
 * la chiave in chiaro non è mai persistita né rifetchabile dal client.
 */
export function dockerRunCommand(key: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return [
    "docker run -d --name stubwise-agent --restart unless-stopped \\",
    '  --group-add "$(stat -c %g /var/run/docker.sock)" \\',
    "  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock:ro \\",
    `  -e STUBWISE_URL=${origin} -e STUBWISE_SERVER_KEY=${key} \\`,
    "  alelocadev/stubwise-agent",
  ].join("\n");
}

/** Form di registrazione: solo il nome. Sul successo rivela la chiave (dialog). */
export function NewServerForm({
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
        label={t("monitor:servers.name")}
        required
        placeholder={t("monitor:servers.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending} disabled={name.trim() === ""}>
          {mutation.isPending ? t("monitor:servers.creating") : t("monitor:servers.create")}
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
 * Sidepanel (a destra) con la guida essenziale d'installazione dell'agente: box
 * della chiave one-shot col comando `docker run` in cima (visibile SOLO qui, una
 * volta: un avviso lo ricorda), poi tre step guidati (Docker collassabile, avvio,
 * verifica) e un link alla guida completa. Bottone per copiare l'intero comando;
 * senza Clipboard API (contesto non sicuro, tipico self-hosted su http) NIENTE
 * falso "Copiato": si seleziona il comando e si invita a copiarlo a mano. Il
 * pannello NON si chiude cliccando il backdrop (gesto facile da sbagliare su un
 * dato irreversibile): solo Escape o Chiudi (`dismissOnBackdrop={false}`).
 */
export function KeyPanel({ server, onClose }: { server: ServerWithKey; onClose: () => void }) {
  const { t } = useTranslation();
  const command = dockerRunCommand(server.key);
  const { copied, manualHint, copy, targetRef } = useCopyWithFallback(command);
  const [dockerOpen, setDockerOpen] = useState(false);

  return (
    <Drawer
      open
      onClose={onClose}
      side="right"
      widthClassName="w-[min(92vw,34rem)]"
      dismissOnBackdrop={false}
      aria-label={t("monitor:servers.keyPanelHeading", { name: server.name })}
    >
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="border-b border-line px-4 py-3">
          <h3 className="font-mono text-[12px] font-medium tracking-[0.14em] text-fg uppercase">
            {t("monitor:servers.keyPanelHeading", { name: server.name })}
          </h3>
        </header>

        <div className="flex flex-col gap-5 px-4 py-4">
          {/* Chiave one-shot: comando completo + avviso ambra + copia. */}
          <div className="space-y-3">
            <pre
              ref={targetRef}
              className="overflow-x-auto rounded-sm border border-line-strong bg-ink-950/70 px-3 py-3 font-mono text-[12px] leading-relaxed whitespace-pre text-fg"
            >
              {command}
            </pre>
            <p role="alert" className="font-mono text-[12px] text-signal">
              {t("monitor:servers.keyWarning")}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={copy}
                className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
              >
                {copied ? t("monitor:servers.copied") : t("monitor:servers.copy")}
              </button>
            </div>
            {manualHint && (
              <p role="status" className="font-mono text-[12px] text-fg-muted">
                {t("monitor:servers.copyManualHint")}
              </p>
            )}
          </div>

          {/* Step 1 — Docker (collassabile, chiuso di default). */}
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setDockerOpen((value) => !value)}
              aria-expanded={dockerOpen}
              className="flex w-full items-center justify-between gap-2 font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase transition-colors hover:text-fg"
            >
              <span>{t("monitor:servers.keyStepDockerTitle")}</span>
              <span className="text-fg-faint normal-case">
                {t("monitor:servers.keyStepDockerToggle")} {dockerOpen ? "−" : "+"}
              </span>
            </button>
            {dockerOpen && (
              <div className="space-y-2 border-l border-line pl-3">
                <p className="font-mono text-[11px] text-fg-faint">
                  {t("monitor:servers.keyStepDockerVerify")}
                </p>
                <pre className="overflow-x-auto rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[12px] text-fg">
                  docker --version
                </pre>
                <p className="font-mono text-[11px] text-fg-faint">
                  {t("monitor:servers.keyStepDockerInstall")}
                </p>
                <pre className="overflow-x-auto rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[12px] text-fg">
                  curl -fsSL https://get.docker.com | sh
                </pre>
                <p className="font-mono text-[11px] text-fg-faint">
                  {t("monitor:servers.keyStepDockerNote")}
                </p>
              </div>
            )}
          </section>

          {/* Step 2 — Run: spiegazione (il comando è già mostrato sopra). */}
          <section className="space-y-2">
            <h4 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
              {t("monitor:servers.keyStepRunTitle")}
            </h4>
            <p className="font-mono text-[11px] leading-relaxed text-fg-faint">
              {t("monitor:servers.keyStepRunBody")}
            </p>
          </section>

          {/* Step 3 — Verify. */}
          <section className="space-y-2">
            <h4 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
              {t("monitor:servers.keyStepVerifyTitle")}
            </h4>
            <p className="font-mono text-[11px] leading-relaxed text-fg-faint">
              {t("monitor:servers.keyStepVerifyBody")}
            </p>
            <pre className="overflow-x-auto rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[12px] text-fg">
              docker logs -f stubwise-agent
            </pre>
          </section>

          {/* Footer: link alla guida completa (naviga fuori dalla SPA). */}
          <a
            href="/guide/monitoring/agent-install/"
            className="font-mono text-[12px] text-signal underline-offset-2 hover:underline"
          >
            {t("monitor:servers.keyFullGuide")}
          </a>
        </div>

        <footer className="mt-auto flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
          >
            {t("monitor:servers.close")}
          </button>
        </footer>
      </div>
    </Drawer>
  );
}

/** Form di modifica: nome, intervallo di campionamento e progetti associati. */
export function EditServerForm({
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
  // Snapshot dei valori correnti all'apertura, SENZA sync col refetch (il form
  // monta on-demand): intenzionale, il refetch periodico a 30s non deve
  // sovrascrivere ciò che l'utente sta digitando.
  const [name, setName] = useState(server.name);
  const [interval, setInterval] = useState(String(server.sampleIntervalSeconds));
  const [projectIds, setProjectIds] = useState<string[]>(server.projects.map((p) => p.id));
  const [intervalError, setIntervalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (sampleIntervalSeconds: number) =>
      updateServer(server.id, {
        name: name.trim(),
        sampleIntervalSeconds,
        projectIds,
      }),
    onSuccess: async () => {
      // Lista E dettaglio: dal Monitor l'header del dettaglio (nome/progetti)
      // deve riflettere subito la modifica, non solo la card della lista.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: serverKeys.lists() }),
        queryClient.invalidateQueries({ queryKey: serverKeys.details() }),
      ]);
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
    if (name.trim() === "") return;
    const parsed = parseIntervalSeconds(interval, 10, 300);
    if (parsed === null) {
      setIntervalError(t("monitor:servers.intervalRange", { min: 10, max: 300 }));
      return;
    }
    setIntervalError(null);
    mutation.mutate(parsed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id={`edit-server-name-${server.id}`}
        label={t("monitor:servers.name")}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        id={`edit-server-interval-${server.id}`}
        label={t("monitor:servers.interval")}
        type="number"
        min={10}
        max={300}
        value={interval}
        onChange={(event) => {
          setInterval(event.target.value);
          setIntervalError(null);
        }}
      />

      <fieldset className="rounded-sm border border-line bg-ink-950/40 p-4">
        <legend className="px-1.5 font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t("monitor:servers.projects")}
        </legend>
        {projects.length === 0 ? (
          <p className="font-mono text-[11px] text-fg-faint">{t("monitor:servers.noProjects")}</p>
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

      <FormError
        message={intervalError ?? (mutation.error instanceof Error ? mutation.error.message : null)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending} disabled={name.trim() === ""}>
          {mutation.isPending ? t("monitor:servers.saving") : t("monitor:servers.save")}
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
 * Pannello "Impostazioni server" del dettaglio (solo admin): editor anagrafica
 * (nome/intervallo/progetti), rigenerazione della chiave (riapre la guida) ed
 * eliminazione del server (conferma + avviso → redirect al Monitor).
 */
export function ServerSettingsPanel({
  server,
  projects,
}: {
  server: ServerView;
  projects: ProjectListItem[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  // Chiave rivelata (regenerate): mostrata nel dialog, mai persistita.
  const [revealed, setRevealed] = useState<ServerWithKey | null>(null);

  const deletion = useMutation({
    mutationFn: () => deleteServer(server.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serverKeys.lists() });
      // Il server non esiste più: torna alla lista Monitor.
      await navigate({ to: "/monitor" });
    },
  });

  const regeneration = useMutation({
    mutationFn: () => regenerateServerKey(server.id),
    onSuccess: async (result) => {
      setConfirmingRegen(false);
      await queryClient.invalidateQueries({ queryKey: serverKeys.lists() });
      setRevealed(result);
    },
  });

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("monitor:servers.settingsPanelTitle")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <RowButton
            onClick={() => setEditing((value) => !value)}
            label={t("monitor:servers.edit")}
          />
          {confirmingRegen ? (
            <>
              <RowButton
                onClick={() => regeneration.mutate()}
                disabled={regeneration.isPending}
                label={t("monitor:servers.regenerateConfirm")}
              />
              <RowButton onClick={() => setConfirmingRegen(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingRegen(true)}
              label={t("monitor:servers.regenerate")}
            />
          )}
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => deletion.mutate()}
                disabled={deletion.isPending}
                label={t("monitor:servers.deleteConfirm")}
                danger
              />
              <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingDelete(true)}
              label={t("monitor:servers.delete")}
              danger
            />
          )}
        </div>
      </header>

      <div className="px-4 py-4">
        {confirmingRegen && (
          <p className="mb-2 font-mono text-[12px] text-signal">
            {t("monitor:servers.regenerateWarning")}
          </p>
        )}
        {confirmingDelete && (
          <p role="alert" className="mb-2 font-mono text-[12px] text-danger">
            {t("monitor:servers.deleteWarning")}
          </p>
        )}
        <div className="empty:hidden">
          <FormError message={deletion.error instanceof Error ? deletion.error.message : null} />
          <FormError
            message={regeneration.error instanceof Error ? regeneration.error.message : null}
          />
        </div>

        {editing ? (
          <EditServerForm server={server} projects={projects} onDone={() => setEditing(false)} />
        ) : (
          <dl className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-[12px]">
            <div>
              <dt className="text-fg-faint">{t("monitor:servers.interval")}</dt>
              <dd className="text-fg">{server.sampleIntervalSeconds}s</dd>
            </div>
            <div>
              <dt className="text-fg-faint">{t("monitor:servers.projects")}</dt>
              <dd className="text-fg">
                {server.projects.length > 0
                  ? server.projects.map((project) => project.name).join(", ")
                  : "—"}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {revealed && <KeyPanel server={revealed} onClose={() => setRevealed(null)} />}
    </section>
  );
}

/**
 * Form di check condiviso creazione/modifica. In creazione `target` è
 * obbligatorio; in modifica di un check DB può restare vuoto (= DSN invariato).
 * Cambiare il tipo richiede un nuovo target: il 400
 * `target_required_for_type_change` del server viene mostrato inline.
 */
export function CheckForm({
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

  const [intervalError, setIntervalError] = useState<string | null>(null);

  const isDb = DB_CHECK_TYPES.has(type);
  const typeChanged = isEdit && check.type !== type;

  const mutation = useMutation({
    mutationFn: (intervalSeconds: number) => {
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
      // Oltre alla lista check: i conteggi checksUp/checksDown vivono su lista
      // (ServerCard) e dettaglio del server, da riconciliare dopo il CRUD.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: serverKeys.checks(serverId) }),
        queryClient.invalidateQueries({ queryKey: serverKeys.lists() }),
        queryClient.invalidateQueries({ queryKey: serverKeys.details() }),
      ]);
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseIntervalSeconds(interval, 10, 3600);
    if (parsed === null) {
      setIntervalError(t("monitor:servers.intervalRange", { min: 10, max: 3600 }));
      return;
    }
    setIntervalError(null);
    mutation.mutate(parsed);
  }

  // Messaggio d'errore: traduce il codice noto del cambio tipo senza target.
  const errorMessage =
    intervalError ??
    (mutation.error instanceof ApiError && mutation.error.code === "target_required_for_type_change"
      ? t("monitor:servers.targetRequiredForTypeChange")
      : mutation.error instanceof Error
        ? mutation.error.message
        : null);

  const targetLabelKey = isDb
    ? "monitor:servers.targetLabel.db"
    : `monitor:servers.targetLabel.${type}`;
  const targetPlaceholderKey = isDb
    ? "monitor:servers.targetPlaceholder.db"
    : `monitor:servers.targetPlaceholder.${type}`;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
      <SelectField
        id={`check-type-${serverId}-${check?.id ?? "new"}`}
        label={t("monitor:servers.checkType")}
        value={type}
        onChange={(event) => setType(event.target.value as CheckType)}
        options={checkTypeSchema.options.map((option) => ({
          value: option,
          label: t(`monitor:servers.checkTypeLabels.${option}`),
        }))}
      />
      <TextField
        id={`check-name-${serverId}-${check?.id ?? "new"}`}
        label={t("monitor:servers.checkName")}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id={`check-target-${serverId}-${check?.id ?? "new"}`}
          label={t(targetLabelKey)}
          required={!isEdit}
          value={target}
          placeholder={t(targetPlaceholderKey)}
          onChange={(event) => setTarget(event.target.value)}
        />
        {isDb && (
          <p className="font-mono text-[11px] text-fg-faint">
            {isEdit ? t("monitor:servers.dsnKeepNote") : t("monitor:servers.dsnNote")}
          </p>
        )}
        {typeChanged && (
          <p className="font-mono text-[11px] text-signal">
            {t("monitor:servers.targetRequiredForTypeChange")}
          </p>
        )}
      </div>
      <TextField
        id={`check-interval-${serverId}-${check?.id ?? "new"}`}
        label={t("monitor:servers.checkInterval")}
        type="number"
        min={10}
        max={3600}
        value={interval}
        onChange={(event) => {
          setInterval(event.target.value);
          setIntervalError(null);
        }}
      />
      <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="size-4 accent-signal"
        />
        {t("monitor:servers.checkEnabled")}
      </label>

      <FormError message={errorMessage} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending
            ? t("monitor:servers.savingCheck")
            : isEdit
              ? t("monitor:servers.saveCheck")
              : t("monitor:servers.addCheck")}
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

/** Bottone d'azione compatto (stile terminal) per righe e toolbar. */
export function RowButton({
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
