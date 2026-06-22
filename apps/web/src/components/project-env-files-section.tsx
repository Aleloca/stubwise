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
import { projectEnvFilesQueryOptions } from "../lib/queries";
import { FormError, SubmitButton, TextField } from "./field";

/**
 * Sezione "File d'ambiente" del dettaglio progetto (solo admin): per ogni file
 * (es. `.env.local`) elenca le sole CHIAVI delle variabili — il valore è
 * write-only e cifrato at-rest, l'API non lo manda mai, quindi qui è sempre
 * mascherato. Azioni: aggiungi file, importa (incolla o carica un file .env),
 * sostituisci/elimina una variabile, elimina il file. Niente valore è MAI
 * mostrato né letto: si scrive soltanto (import / sostituisci).
 */
export function ProjectEnvFilesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: files } = useSuspenseQuery(projectEnvFilesQueryOptions(projectId));
  const [creating, setCreating] = useState(false);

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("envFiles:title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("envFiles:subtitle")}</p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("envFiles:addFile")}
          </button>
        )}
      </header>

      {creating && (
        <div className="border-b border-line px-4 py-4">
          <NewFileForm projectId={projectId} onDone={() => setCreating(false)} />
        </div>
      )}

      {files.length === 0 && !creating ? (
        <p className="px-4 py-8 text-center font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
          {t("envFiles:empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {files.map((file) => (
            <FileRow key={file.id} projectId={projectId} file={file} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Form di creazione di un file: solo il path. Validazione client: non vuoto. */
function NewFileForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");

  const mutation = useMutation({
    mutationFn: () => createEnvFile(projectId, path.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: projectEnvFilesQueryOptions(projectId).queryKey,
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
        id="new-env-file-path"
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
function FileRow({ projectId, file }: { projectId: string; file: ProjectEnvFile }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: projectEnvFilesQueryOptions(projectId).queryKey });

  const importMutation = useMutation({
    mutationFn: (content: string) => importEnvFile(projectId, file.id, content),
    onSuccess: async () => {
      await invalidate();
      setPasted("");
    },
  });

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deletion = useMutation({
    mutationFn: () => deleteEnvFile(projectId, file.id),
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
              projectId={projectId}
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
  projectId,
  fileId,
  envVar,
  onChanged,
}: {
  projectId: string;
  fileId: string;
  envVar: ProjectEnvVar;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");

  const setMutation = useMutation({
    mutationFn: () => setEnvVar(projectId, fileId, envVar.key, value),
    onSuccess: async () => {
      await onChanged();
      setReplacing(false);
      setValue("");
    },
  });

  const deletion = useMutation({
    mutationFn: () => deleteEnvVar(projectId, fileId, envVar.key),
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
