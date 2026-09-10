import type { ProjectEnvironment } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  createEnvFile,
  deleteEnvFile,
  deleteEnvVar,
  importEnvFile,
  setEnvVar,
  type ProjectEnvFile,
  type ProjectEnvVar,
} from "../lib/api";
import { projectEnvFilesQueryOptions, projectEnvironmentsQueryOptions } from "../lib/queries";
import { FormError, SubmitButton, TextField } from "./field";

/**
 * Sezione "File d'ambiente" del dettaglio REPOSITORY (solo admin): per ogni
 * file (es. `.env.local`) elenca le sole CHIAVI delle variabili — il valore è
 * write-only e cifrato at-rest, l'API non lo manda mai, quindi qui è sempre
 * mascherato. Azioni: aggiungi file, importa (incolla o carica un file .env),
 * sostituisci/elimina una variabile, elimina il file. Niente valore è MAI
 * mostrato né letto: si scrive soltanto (import / sostituisci).
 *
 * **Fase 8**: i file si organizzano per AMBIENTE del progetto (test|staging|
 * production, {@link ProjectEnvironmentsSection} li gestisce nel dettaglio
 * progetto) — ogni gruppo ha il proprio "aggiungi file", scoperto sul suo
 * `environmentId`. Solo il gruppo `test` porta la nota che la pipeline di fix
 * legge quei valori; gli altri dicono esplicitamente che sono conservati per
 * essere letti da una persona, mai usati automaticamente.
 */
export function ProjectEnvFilesSection({
  repositoryId,
  projectId,
}: {
  repositoryId: string;
  projectId: string;
}) {
  const { t } = useTranslation();
  const { data: files } = useSuspenseQuery(projectEnvFilesQueryOptions(repositoryId));
  const { data: environments } = useSuspenseQuery(projectEnvironmentsQueryOptions(projectId));

  const filesByEnvironment = new Map<string, ProjectEnvFile[]>();
  for (const file of files) {
    const group = filesByEnvironment.get(file.environmentId) ?? [];
    group.push(file);
    filesByEnvironment.set(file.environmentId, group);
  }
  // `test` sempre per primo (è l'unico che conta per la pipeline), poi
  // l'ordine con cui l'API già restituisce gli ambienti (per nome).
  const orderedEnvironments = [...environments].sort((a, b) =>
    a.kind === "test" ? -1 : b.kind === "test" ? 1 : 0,
  );

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("envFiles:title")}
        </h2>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("envFiles:subtitle")}</p>
      </header>

      <ul className="divide-y divide-line">
        {orderedEnvironments.map((environment) => (
          <EnvironmentFilesGroup
            key={environment.id}
            repositoryId={repositoryId}
            environment={environment}
            files={filesByEnvironment.get(environment.id) ?? []}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Un ambiente e i suoi file. Copy esplicita (design fase 8 §3): SOLO `test`
 * dice che la pipeline di fix legge quei valori; gli altri dicono il
 * contrario, chiaro e prima di ogni file — non un dettaglio da dedurre.
 */
function EnvironmentFilesGroup({
  repositoryId,
  environment,
  files,
}: {
  repositoryId: string;
  environment: ProjectEnvironment;
  files: ProjectEnvFile[];
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-[12px] font-semibold tracking-[0.1em] text-fg uppercase">
              {environment.name}
            </h3>
            <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] text-fg-muted uppercase">
              {t(`projects:detail.environmentKindOptions.${environment.kind}`)}
            </span>
          </div>
          <p className="mt-1 max-w-xl font-mono text-[11px] text-fg-faint">
            {environment.kind === "test" ? t("envFiles:usedByPipeline") : t("envFiles:notUsedByPipeline")}
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
          >
            {t("envFiles:addFile")}
          </button>
        )}
      </div>

      {creating && (
        <div className="mt-3 rounded-sm border border-line px-4 py-4">
          <NewFileForm
            repositoryId={repositoryId}
            environmentId={environment.id}
            onDone={() => setCreating(false)}
          />
        </div>
      )}

      {files.length === 0 && !creating ? (
        <p className="mt-3 font-mono text-[11px] text-fg-faint">{t("envFiles:empty")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-l-2 border-line pl-3">
          {files.map((file) => (
            <FileRow key={file.id} repositoryId={repositoryId} file={file} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Form di creazione di un file in UN ambiente: solo il path. Validazione client: non vuoto. */
function NewFileForm({
  repositoryId,
  environmentId,
  onDone,
}: {
  repositoryId: string;
  environmentId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");

  const mutation = useMutation({
    mutationFn: () => createEnvFile(repositoryId, environmentId, path.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: projectEnvFilesQueryOptions(repositoryId).queryKey,
      });
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // Validazione basilare: un path vuoto non parte (coerente con ai-providers).
    if (path.trim() === "") return;
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id={`new-env-file-path-${environmentId}`}
        label={t("envFiles:path")}
        placeholder={t("envFiles:pathPlaceholder")}
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending} disabled={path.trim() === ""}>
          {mutation.isPending ? t("envFiles:creatingFile") : t("envFiles:createFile")}
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
 * Riga di un file d'ambiente: path, azione di import (incolla + upload),
 * elenco delle variabili (chiave + valore mascherato) ed eliminazione del file
 * con conferma.
 */
function FileRow({ repositoryId, file }: { repositoryId: string; file: ProjectEnvFile }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: projectEnvFilesQueryOptions(repositoryId).queryKey });

  const importMutation = useMutation({
    mutationFn: (content: string) => importEnvFile(repositoryId, file.id, content),
    onSuccess: async () => {
      await invalidate();
      setPasted("");
    },
  });

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deletion = useMutation({
    mutationFn: () => deleteEnvFile(repositoryId, file.id),
    onSuccess: () => invalidate(),
  });

  const [pasted, setPasted] = useState("");

  function handleImportPaste(event: FormEvent) {
    event.preventDefault();
    if (pasted.trim() === "") return;
    importMutation.mutate(pasted);
  }

  // Upload: legge il contenuto del file scelto (file.text()) e lo passa allo
  // STESSO flusso di import dell'incolla. Il binario non transita mai.
  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const uploaded = event.target.files?.[0];
    event.target.value = "";
    if (!uploaded) return;
    const content = await uploaded.text();
    if (content.trim() === "") return;
    importMutation.mutate(content);
  }

  const importError =
    importMutation.error instanceof Error ? importMutation.error.message : null;
  const deleteError = deletion.error instanceof Error ? deletion.error.message : null;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-[14px] font-medium text-fg">{file.path}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => deletion.mutate()}
                disabled={deletion.isPending}
                label={t("envFiles:confirm")}
                danger
              />
              <RowButton
                onClick={() => setConfirmingDelete(false)}
                label={t("common:cancel")}
              />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingDelete(true)}
              disabled={deletion.isPending}
              label={t("envFiles:deleteFile")}
              danger
            />
          )}
        </div>
      </div>

      {deleteError && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {deleteError}
        </p>
      )}

      {/* Import: incolla in textarea o carica un file .env. */}
      <form onSubmit={handleImportPaste} className="mt-3 flex flex-col gap-2">
        <label
          htmlFor={`env-paste-${file.id}`}
          className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("envFiles:pasteLabel")}
        </label>
        <textarea
          id={`env-paste-${file.id}`}
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          rows={3}
          placeholder={t("envFiles:pastePlaceholder")}
          className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[13px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
        <p className="font-mono text-[11px] text-fg-faint">{t("envFiles:importHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={importMutation.isPending || pasted.trim() === ""}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importMutation.isPending ? t("envFiles:importing") : t("envFiles:import")}
          </button>
          <label className="cursor-pointer rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg">
            {t("envFiles:upload")}
            <input
              type="file"
              data-testid="env-file-upload"
              accept=".env,text/plain"
              onChange={handleUpload}
              className="sr-only"
            />
          </label>
        </div>
        {importError && (
          <p role="alert" className="font-mono text-[12px] text-danger">
            {importError}
          </p>
        )}
      </form>

      {file.vars.length === 0 ? (
        <p className="mt-3 font-mono text-[11px] text-fg-faint">{t("envFiles:noVars")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-l-2 border-line pl-3">
          {file.vars.map((envVar) => (
            <VarRow
              key={envVar.key}
              repositoryId={repositoryId}
              fileId={file.id}
              envVar={envVar}
              onChanged={invalidate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Riga di una variabile: chiave visibile + valore mascherato (mai il valore
 * reale). Azioni: sostituisci il valore (write-only, PUT) ed elimina (DELETE).
 */
function VarRow({
  repositoryId,
  fileId,
  envVar,
  onChanged,
}: {
  repositoryId: string;
  fileId: string;
  envVar: ProjectEnvVar;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");

  const setMutation = useMutation({
    mutationFn: () => setEnvVar(repositoryId, fileId, envVar.key, value),
    onSuccess: async () => {
      await onChanged();
      setReplacing(false);
      setValue("");
    },
  });

  const deletion = useMutation({
    mutationFn: () => deleteEnvVar(repositoryId, fileId, envVar.key),
    onSuccess: () => onChanged(),
  });

  const error = [setMutation.error, deletion.error].find((e) => e instanceof Error) as
    | Error
    | undefined;

  function handleReplace(event: FormEvent) {
    event.preventDefault();
    if (value === "") return;
    setMutation.mutate();
  }

  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-[13px] text-fg">{envVar.key}</span>
        {/* Valore mascherato: l'API non lo manda mai. */}
        <span className="font-mono text-[13px] tracking-[0.2em] text-fg-faint" aria-hidden>
          ••••••••
        </span>
        <span className="sr-only">{t("envFiles:valueSet")}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!replacing && (
            <RowButton
              onClick={() => setReplacing(true)}
              disabled={deletion.isPending}
              label={t("envFiles:replace")}
            />
          )}
          <RowButton
            onClick={() => deletion.mutate()}
            disabled={deletion.isPending || setMutation.isPending}
            label={t("envFiles:remove")}
            danger
          />
        </div>
      </div>

      {replacing && (
        <form onSubmit={handleReplace} className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 grow">
            <TextField
              id={`env-var-value-${fileId}-${envVar.key}`}
              type="password"
              label={t("envFiles:value")}
              placeholder={t("envFiles:valuePlaceholder")}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={setMutation.isPending || value === ""}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[11px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {setMutation.isPending ? t("envFiles:saving") : t("common:save")}
          </button>
          <button
            type="button"
            onClick={() => {
              setReplacing(false);
              setValue("");
            }}
            className="rounded-sm px-3 py-2 font-mono text-[11px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
          >
            {t("common:cancel")}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-1 font-mono text-[12px] text-danger">
          {error.message}
        </p>
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
