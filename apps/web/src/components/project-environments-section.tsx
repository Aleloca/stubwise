import type { EnvironmentKind, ProjectEnvironment } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createEnvironment, deleteEnvironment, patchEnvironment } from "../lib/api";
import { projectEnvironmentsQueryOptions, serversQueryOptions } from "../lib/queries";
import { FormError, SubmitButton, TextField } from "./field";

const KINDS: EnvironmentKind[] = ["test", "staging", "production"];

/**
 * Sezione "Ambienti" del dettaglio progetto (fase 8, solo admin): l'anagrafica
 * test|staging|production, con URL facoltativo e collegamento facoltativo a un
 * server già monitorato. Sezione SECONDARIA come {@link ProjectServersSection}
 * (`useQuery`, non suspense): un suo fallimento non abbatte il resto della
 * pagina progetto.
 *
 * **Stubwise non esegue né rilascia** — questa sezione è pura anagrafica. Il
 * copy lo dice esplicitamente, e l'ambiente `test` (creato dalla migrazione
 * per ogni progetto) non è cancellabile: è l'unico che la pipeline di fix può
 * leggere.
 */
export function ProjectEnvironmentsSection({
  projectId,
  isAdmin,
}: {
  projectId: string;
  /** Lettura per ogni utente autenticato; le azioni di scrittura sono admin-only lato server. */
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const { data: environments, isPending, isError } = useQuery(
    projectEnvironmentsQueryOptions(projectId),
  );
  const [creating, setCreating] = useState(false);

  if (isPending) {
    return (
      <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
        {t("projects:detail.environmentsLoading")}
      </p>
    );
  }

  if (isError) {
    return (
      <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3">
        <p className="font-mono text-[12px] text-danger">{t("projects:detail.environmentsError")}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 max-w-2xl text-sm text-fg-muted">{t("projects:detail.environmentsHint")}</p>

      {environments.length === 0 ? (
        <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
          {t("projects:detail.noEnvironments")}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-sm border border-line bg-ink-900">
          {environments.map((env) => (
            <EnvironmentRow key={env.id} projectId={projectId} environment={env} isAdmin={isAdmin} />
          ))}
        </ul>
      )}

      {isAdmin && (
        <div className="mt-3">
          {creating ? (
            <div className="rounded-sm border border-line bg-ink-900 px-4 py-4">
              <NewEnvironmentForm projectId={projectId} onDone={() => setCreating(false)} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
            >
              {t("projects:detail.addEnvironment")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewEnvironmentForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: servers } = useQuery(serversQueryOptions(projectId));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<EnvironmentKind>("staging");
  const [url, setUrl] = useState("");
  const [serverId, setServerId] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      createEnvironment(projectId, {
        name: name.trim(),
        kind,
        url: url.trim() === "" ? null : url.trim(),
        serverId: serverId === "" ? null : serverId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: projectEnvironmentsQueryOptions(projectId).queryKey,
      });
      onDone();
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
        id="new-environment-name"
        label={t("projects:detail.environmentName")}
        placeholder={t("projects:detail.environmentNamePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div>
        <label
          htmlFor="new-environment-kind"
          className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("projects:detail.environmentKind")}
        </label>
        <select
          id="new-environment-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as EnvironmentKind)}
          className="mt-1 block w-full rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[13px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`projects:detail.environmentKindOptions.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <TextField
        id="new-environment-url"
        label={t("projects:detail.environmentUrl")}
        placeholder="https://staging.example.com"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <div>
        <label
          htmlFor="new-environment-server"
          className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("projects:detail.environmentServer")}
        </label>
        <select
          id="new-environment-server"
          value={serverId}
          onChange={(event) => setServerId(event.target.value)}
          className="mt-1 block w-full rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[13px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        >
          <option value="">{t("projects:detail.environmentServerNone")}</option>
          {(servers ?? []).map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </select>
      </div>
      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending} disabled={name.trim() === ""}>
          {mutation.isPending
            ? t("projects:detail.creatingEnvironment")
            : t("projects:detail.createEnvironment")}
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

function EnvironmentRow({
  projectId,
  environment,
  isAdmin,
}: {
  projectId: string;
  environment: ProjectEnvironment;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: servers } = useQuery(serversQueryOptions(projectId));
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(environment.name);
  const [url, setUrl] = useState(environment.url ?? "");
  const [serverId, setServerId] = useState(environment.serverId ?? "");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: projectEnvironmentsQueryOptions(projectId).queryKey });

  const patchMutation = useMutation({
    mutationFn: () =>
      patchEnvironment(projectId, environment.id, {
        name: name.trim(),
        url: url.trim() === "" ? null : url.trim(),
        serverId: serverId === "" ? null : serverId,
      }),
    onSuccess: async () => {
      await invalidate();
      setEditing(false);
    },
  });

  const deletion = useMutation({
    mutationFn: () => deleteEnvironment(projectId, environment.id),
    onSuccess: () => invalidate(),
  });

  const isTest = environment.kind === "test";
  const serverName = servers?.find((s) => s.id === environment.serverId)?.name;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-[14px] font-medium text-fg">{environment.name}</span>
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] text-fg-muted uppercase">
          {t(`projects:detail.environmentKindOptions.${environment.kind}`)}
        </span>
        {environment.url && (
          <a
            href={environment.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[12px] text-signal underline-offset-2 hover:underline"
          >
            {environment.url}
          </a>
        )}
        {serverName && (
          <span className="font-mono text-[11px] text-fg-faint">
            {t("projects:detail.environmentRunningOn", { server: serverName })}
          </span>
        )}
        {isAdmin && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {!editing && !confirmingDelete && (
              <RowButton onClick={() => setEditing(true)} label={t("common:edit")} />
            )}
            {!editing &&
              (isTest ? (
                <span
                  className="font-mono text-[11px] text-fg-faint"
                  title={t("projects:detail.testEnvironmentProtected")}
                >
                  {t("projects:detail.testEnvironmentProtected")}
                </span>
              ) : confirmingDelete ? (
                <>
                  <RowButton
                    onClick={() => deletion.mutate()}
                    disabled={deletion.isPending}
                    label={t("envFiles:confirm")}
                    danger
                  />
                  <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
                </>
              ) : (
                <RowButton
                  onClick={() => setConfirmingDelete(true)}
                  disabled={deletion.isPending}
                  label={t("projects:detail.deleteEnvironment")}
                  danger
                />
              ))}
          </div>
        )}
      </div>

      {deletion.error instanceof Error && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {deletion.error.message}
        </p>
      )}

      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === "") return;
            patchMutation.mutate();
          }}
          className="mt-3 flex flex-col gap-3 border-t border-line pt-3"
        >
          <TextField
            id={`env-${environment.id}-name`}
            label={t("projects:detail.environmentName")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            id={`env-${environment.id}-url`}
            label={t("projects:detail.environmentUrl")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <div>
            <label
              htmlFor={`env-${environment.id}-server`}
              className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
            >
              {t("projects:detail.environmentServer")}
            </label>
            <select
              id={`env-${environment.id}-server`}
              value={serverId}
              onChange={(event) => setServerId(event.target.value)}
              className="mt-1 block w-full rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[13px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
            >
              <option value="">{t("projects:detail.environmentServerNone")}</option>
              {(servers ?? []).map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </div>
          <FormError message={patchMutation.error instanceof Error ? patchMutation.error.message : null} />
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pending={patchMutation.isPending} disabled={name.trim() === ""}>
              {t("common:save")}
            </SubmitButton>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(environment.name);
                setUrl(environment.url ?? "");
                setServerId(environment.serverId ?? "");
              }}
              className="rounded-sm px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
            >
              {t("common:cancel")}
            </button>
          </div>
        </form>
      )}
    </li>
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
