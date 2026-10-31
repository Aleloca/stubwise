import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SecretInput } from "../../../components/SecretField";
import { WhoCanLink } from "../../../components/WhoCanLink";
import {
  useCreateEnvFile,
  useDeleteEnvFile,
  useEnvFiles,
  useRemoveEnvVar,
  useSetEnvVar,
  type EnvFileView,
  type RepositoryView,
} from "../../../data/queries";
import type { Project } from "../../../data/types";
import { useReauth } from "../../../layout/useReauth";
import { formatDate } from "../../../notifications/time";
import { Dialog, DialogField, inputClass } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { ErrorLine } from "../../entry/parts";
import { CheckGlyph, OpenCircleGlyph } from "../../preferences/glyphs";
import { RowMenu, RowMenuItem, rowButton } from "../../preferences/parts";
import { smallSecondary } from "../../task/parts";
import { dangerSolidButton, primaryButton, secondaryButton } from "../../tasks/controls";
import { useSettingsWrite } from "../SettingsFrame";
import { ImportEnvDialog } from "./ImportEnvDialog";

// I file d'ambiente di un repository (shape project-repositories.md, «I file
// d'ambiente»), nella pagina del repository, solo con `repos.manage`: senza,
// la riga ○ con «Who?» al loro posto. Un gruppo per ambiente del progetto
// (Test · Staging · Production) col segno del perimetro in parole, letto da
// `reachesClaude` della vista: solo `test` arriva a Claude, e la pagina non lo
// deduce. Di una variabile si vede il nome e quando è stata scritta, mai il
// valore né le sue ultime cifre (RF 2): il valore si scrive in un dialogo e
// si svuota all'invio. Importare, impostare, rimuovere ed eliminare chiedono
// la riconferma; creare un file vuoto no. Dopo ogni dialogo il fuoco torna al
// bottone o al «⋯» che l'ha aperto; se la riga se n'è andata (variabile
// rimossa, file eliminato), al «New file» del suo ambiente.

type Environment = {
  id: string;
  name: string;
  kind: "test" | "staging" | "production";
  reachesClaude: boolean;
  files: EnvFileView[];
};

/** Il file e il suo ambiente, come li nominano i dialoghi («.env (Production)»). */
export interface FileTarget {
  file: EnvFileView;
  environment: Environment;
}

type OpenDialog =
  | { kind: "new"; environment: Environment }
  | ({ kind: "import" } & FileTarget)
  | ({ kind: "set"; key: string | null } & FileTarget)
  | ({ kind: "remove"; key: string } & FileTarget)
  | ({ kind: "delete" } & FileTarget);

/** Oltre 20 variabili il file si apre chiuso (shape §5, «Intervalli»). */
const COLLAPSE_OVER = 20;

const glyphLine = "flex max-w-[72ch] items-start gap-1.5 text-sm text-pretty text-ink-muted";

export function EnvFilesSection({
  project,
  repository,
  canManage,
  onReload,
}: {
  project: Project;
  repository: RepositoryView;
  canManage: boolean;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="@container mt-10">
      <h2 id={headingId} className="heading-group border-b border-rule pb-2">
        {t("settings.envFiles.title")}
      </h2>
      {!canManage ? (
        <p className={`${glyphLine} pt-4`}>
          <span className="mt-[3px] shrink-0">
            <OpenCircleGlyph size={12} />
          </span>
          <span className="min-w-0">
            {t("settings.envFiles.hidden", { code: project.code })}{" "}
            <WhoCanLink action="manageRepos" projectId={project.id} projectCode={project.code} />
          </span>
        </p>
      ) : !project.modules.includes("releases") ? (
        // Il modulo si legge dai moduli del progetto, non dagli ambienti vuoti (Task 4).
        <p className="pt-4 text-sm text-pretty text-ink-muted">{t("settings.envFiles.noModule")}</p>
      ) : (
        <EnvFilesBody project={project} repository={repository} onReload={onReload} />
      )}
    </section>
  );
}

function EnvFilesBody({
  project,
  repository,
  onReload,
}: {
  project: Project;
  repository: RepositoryView;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const files = useEnvFiles(repository.id);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  // Il «New file» di ogni ambiente: dove va il fuoco quando la riga è sparita.
  const newFileButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusNewFile, setFocusNewFile] = useState<string | null>(null);

  useEffect(() => {
    if (focusNewFile === null) return;
    newFileButtons.current.get(focusNewFile)?.focus();
    setFocusNewFile(null);
  }, [focusNewFile, files.data]);

  if (files.isPending)
    return (
      <div aria-busy="true" className="skeleton-breathe pt-4">
        <span role="status" className="sr-only">
          {t("taskUi.states.loading")}
        </span>
        {[0, 1].map((g) => (
          <div key={g} className="mt-6 first:mt-0">
            <span className="block h-3 w-40 rounded-sm bg-ink/8" />
            <div className="mt-3 flex h-11 items-center gap-3 border-y border-rule">
              <span className="h-2.5 w-24 rounded-sm bg-ink/8" />
              <span className="ml-auto h-2.5 w-32 rounded-sm bg-ink/8" />
            </div>
          </div>
        ))}
      </div>
    );
  if (files.isError)
    return (
      <div role="alert" className="flex items-center gap-3 pt-4">
        <p className="text-md text-ink">{t("settings.envFiles.loadError")}</p>
        <button type="button" className={smallSecondary} onClick={() => void files.refetch()}>
          {t("taskUi.states.retry")}
        </button>
      </div>
    );

  const environments = files.data.environments;
  if (environments.length === 0)
    return (
      <p className="pt-4 text-sm text-pretty text-ink-muted">
        {t("settings.envFiles.noEnvironments", { code: project.code })}{" "}
        <Link
          to="/p/$code/$section"
          params={{ code: project.code, section: "releases" }}
          search={{ view: "environments" } as never}
          className="text-ink underline underline-offset-4"
        >
          {t("settings.envFiles.environmentsLink")}
        </Link>
        .
      </p>
    );

  const close = (gone?: string) => {
    setDialog(null);
    if (gone) setFocusNewFile(gone);
  };

  return (
    <>
      <p className={`${glyphLine} pt-4`}>
        <span className="mt-[3px] shrink-0">
          <OpenCircleGlyph size={12} />
        </span>
        <span className="min-w-0">{t("settings.envFiles.intro")}</span>
      </p>
      {environments.map((environment) => (
        <EnvironmentGroup
          key={environment.id}
          environment={environment}
          newFileRef={(el) => {
            if (el) newFileButtons.current.set(environment.id, el);
            else newFileButtons.current.delete(environment.id);
          }}
          onOpen={setDialog}
        />
      ))}
      {dialog?.kind === "new" && (
        <NewFileDialog
          code={project.code}
          repositoryId={repository.id}
          environment={dialog.environment}
          onReload={onReload}
          onClose={() => close()}
        />
      )}
      {dialog?.kind === "import" && (
        <ImportEnvDialog
          code={project.code}
          target={dialog}
          onReload={onReload}
          onClose={() => close()}
        />
      )}
      {dialog?.kind === "set" && (
        <SetVariableDialog
          code={project.code}
          target={dialog}
          fixedKey={dialog.key}
          onReload={onReload}
          onClose={() => close()}
        />
      )}
      {dialog?.kind === "remove" && (
        <RemoveVariableDialog
          code={project.code}
          target={dialog}
          variable={dialog.key}
          onReload={onReload}
          onClose={(gone) => close(gone ? dialog.environment.id : undefined)}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteFileDialog
          code={project.code}
          target={dialog}
          onReload={onReload}
          onClose={(gone) => close(gone ? dialog.environment.id : undefined)}
        />
      )}
    </>
  );
}

/** Il segno del perimetro, in glifo e parola: viene da `reachesClaude`, mai dal tipo. */
function ReachMark({ reaches }: { reaches: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 text-sm ${reaches ? "text-ink" : "text-ink-muted"}`}
    >
      {reaches ? (
        <span className="text-positive">
          <CheckGlyph size={14} />
        </span>
      ) : (
        <OpenCircleGlyph size={12} />
      )}
      {reaches ? t("settings.envFiles.reaches") : t("settings.envFiles.never")}
    </span>
  );
}

function EnvironmentGroup({
  environment,
  newFileRef,
  onOpen,
}: {
  environment: Environment;
  newFileRef: (el: HTMLButtonElement | null) => void;
  onOpen: (dialog: OpenDialog) => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="mt-7">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule pb-2">
        <h3 id={headingId} className="min-w-0 flex-1 text-sm text-ink">
          <span className="heading-group text-ink">
            {t(`settings.envFiles.kinds.${environment.kind}`)}
          </span>
          <span className="text-ink-muted"> · {environment.name}</span>
        </h3>
        <ReachMark reaches={environment.reachesClaude} />
        <button
          ref={newFileRef}
          type="button"
          className={smallSecondary}
          onClick={() => onOpen({ kind: "new", environment })}
        >
          {t("settings.envFiles.newFile")}
        </button>
      </div>
      {environment.files.length === 0 ? (
        <p className="py-3 text-sm text-ink-muted">
          {t("settings.envFiles.noFiles", { env: environment.name })}
        </p>
      ) : (
        <ul aria-label={t("settings.envFiles.filesOf", { env: environment.name })}>
          {environment.files.map((file) => (
            <FileRow key={file.id} file={file} environment={environment} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Un file: percorso · quante variabili · Import… · Add variable… · «⋯». Da
 * stretta (1024) Import e Add scendono sotto il percorso, il «⋯» resta su.
 */
function FileRow({
  file,
  environment,
  onOpen,
}: {
  file: EnvFileView;
  environment: Environment;
  onOpen: (dialog: OpenDialog) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(file.keys.length <= COLLAPSE_OVER);
  const target = { file, environment };
  return (
    <li aria-label={file.path} className="border-b border-rule">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-2 @min-[720px]:min-h-11 @min-[720px]:grid-cols-[minmax(0,1fr)_auto_auto]">
        <p className="flex min-w-0 items-baseline gap-3">
          <code className="font-code text-md text-ink [overflow-wrap:anywhere]">{file.path}</code>
          <span className="num shrink-0 text-sm text-ink-muted">
            {t("settings.envFiles.variables", { count: file.keys.length })}
          </span>
        </p>
        <span className="col-span-2 row-start-2 flex flex-wrap gap-2 @min-[720px]:col-span-1 @min-[720px]:col-start-2 @min-[720px]:row-start-1">
          <button
            type="button"
            className={smallSecondary}
            onClick={() => onOpen({ kind: "import", ...target })}
          >
            {t("settings.envFiles.import")}
          </button>
          <button
            type="button"
            className={smallSecondary}
            onClick={() => onOpen({ kind: "set", key: null, ...target })}
          >
            {t("settings.envFiles.addVariable")}
          </button>
        </span>
        <span className="col-start-2 row-start-1 @min-[720px]:col-start-3">
          <RowMenu label={t("settings.envFiles.more", { path: file.path })}>
            {(close) => (
              // Il «⋯» riprende il fuoco prima che il dialogo si apra: è lì che torna.
              <RowMenuItem onSelect={() => (close(true), onOpen({ kind: "delete", ...target }))}>
                {t("settings.envFiles.deleteFile")}
              </RowMenuItem>
            )}
          </RowMenu>
        </span>
      </div>
      {file.keys.length > 0 &&
        (expanded ? (
          <ul aria-label={t("settings.envFiles.variablesOf", { path: file.path })} className="pb-2">
            {file.keys.map((v) => (
              <VariableRow
                key={v.key}
                variable={v}
                onReplace={() => onOpen({ kind: "set", key: v.key, ...target })}
                onRemove={() => onOpen({ kind: "remove", key: v.key, ...target })}
              />
            ))}
          </ul>
        ) : (
          <button
            type="button"
            className={`${rowButton} mb-2 ml-4`}
            onClick={() => setExpanded(true)}
          >
            {t("settings.envFiles.showAll", { count: file.keys.length })}
          </button>
        ))}
    </li>
  );
}

/**
 * Una variabile, rientrata: nome · «set Oct 29» · Replace… Remove…. Nessun
 * valore, nessuna ultima cifra, nessun «Show». Da stretta su due righe: nome
 * e data sopra, le azioni sotto a destra.
 */
function VariableRow({
  variable,
  onReplace,
  onRemove,
}: {
  variable: { key: string; setAt: string };
  onReplace: () => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <li
      aria-label={variable.key}
      className="flex flex-col gap-0.5 py-1.5 pl-4 @min-[720px]:min-h-9 @min-[720px]:flex-row @min-[720px]:items-center @min-[720px]:gap-4 @min-[720px]:py-0"
    >
      <span className="flex min-w-0 flex-1 items-baseline gap-4">
        <code title={variable.key} className="min-w-0 truncate font-code text-sm text-ink">
          {variable.key}
        </code>
        <span className="num ml-auto shrink-0 text-xs text-ink-muted @min-[720px]:ml-0">
          {t("settings.envFiles.setAt", { date: formatDate(variable.setAt, i18n.language) })}
        </span>
      </span>
      <span className="flex justify-end gap-1">
        <button type="button" className={rowButton} onClick={onReplace}>
          {t("settings.envFiles.replace")}
        </button>
        <button type="button" className={rowButton} onClick={onRemove}>
          {t("settings.envFiles.remove")}
        </button>
      </span>
    </li>
  );
}

/** «.env (Production)»: come i dialoghi nominano un file. */
const fileWords = (target: FileTarget) => ({
  path: target.file.path,
  env: target.environment.name,
});

function NewFileDialog({
  code,
  repositoryId,
  environment,
  onReload,
  onClose,
}: {
  code: string;
  repositoryId: string;
  environment: Environment;
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateEnvFile();
  const write = useSettingsWrite(code, onReload);
  const [path, setPath] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function submit() {
    if (busy) return;
    setBusy(true);
    setInvalid(null);
    const ok = await write.run(
      () => create.mutateAsync({ repositoryId, environmentId: environment.id, path }),
      (reason) => setInvalid(reason),
    );
    setBusy(false);
    if (ok) onClose();
  }

  const error =
    invalid === "path_taken"
      ? t("settings.envFiles.newFileDialog.pathTaken", { env: environment.name, path: path.trim() })
      : invalid
        ? t("settings.envFiles.newFileDialog.pathError")
        : null;
  return (
    <Dialog
      title={t("settings.envFiles.newFileDialog.title", { env: environment.name })}
      onClose={onClose}
      width={440}
      confirmDiscard={
        path.trim() !== ""
          ? {
              message: t("settings.common.leave"),
              keep: t("settings.common.keepEditing"),
              discard: t("settings.common.discard"),
            }
          : undefined
      }
      footer={(dismiss) => (
        <>
          <button type="button" className={secondaryButton} onClick={dismiss}>
            {t("settings.envFiles.cancel")}
          </button>
          <button
            type="submit"
            form={`${id}-form`}
            aria-disabled={busy || undefined}
            className={`${primaryButton} aria-disabled:opacity-40`}
          >
            {busy
              ? t("settings.envFiles.newFileDialog.creating")
              : t("settings.envFiles.newFileDialog.create")}
          </button>
        </>
      )}
    >
      <form
        id={`${id}-form`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        <DialogField
          label={t("settings.envFiles.newFileDialog.path")}
          htmlFor={`${id}-path`}
          hint={t("settings.envFiles.newFileDialog.hint")}
        >
          <input
            id={`${id}-path`}
            data-autofocus
            value={path}
            spellCheck={false}
            autoComplete="off"
            placeholder=".env.local"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => {
              setPath(e.target.value);
              setInvalid(null);
            }}
            className={`${inputClass} font-code`}
          />
        </DialogField>
        {error && <ErrorLine id={`${id}-error`}>{error}</ErrorLine>}
        {write.message}
      </form>
    </Dialog>
  );
}

/**
 * «Add variable…» e «Replace…»: il nome (fisso con Replace) e il valore in un
 * campo password con Show/Hide, senza stato salvato. All'invio il campo si
 * svuota prima della risposta; se il nome è rifiutato il valore torna, dalla
 * variabile locale, con l'errore sotto il nome.
 */
function SetVariableDialog({
  code,
  target,
  fixedKey,
  onReload,
  onClose,
}: {
  code: string;
  target: FileTarget;
  fixedKey: string | null;
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const setVar = useSetEnvVar();
  const write = useSettingsWrite(code, onReload);
  const [key, setKey] = useState(fixedKey ?? "");
  const [value, setValue] = useState("");
  const [keyError, setKeyError] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const words = fileWords(target);

  async function submit() {
    if (busy) return;
    const sent = value;
    const name = key.trim();
    setValue("");
    setKeyError(false);
    setBusy(true);
    const ok = await write.run(
      () =>
        reauth(() => setVar.mutateAsync({ fileId: target.file.id, key: name, value: sent }), {
          action: t("settings.envFiles.setDialog.reauthAction", { key: name, ...words }),
        }),
      (reason) => {
        if (reason === "key") {
          setKeyError(true);
          setValue(sent);
        }
      },
    );
    setBusy(false);
    if (!ok) return;
    toast.show(t("settings.envFiles.setDialog.done", { key: name, ...words }));
    onClose();
  }

  const dirty = value !== "" || (fixedKey === null && key.trim() !== "");
  return (
    <Dialog
      title={t("settings.envFiles.setDialog.title", words)}
      onClose={onClose}
      width={440}
      confirmDiscard={
        dirty
          ? {
              message: t("settings.envFiles.setDialog.discard"),
              keep: t("settings.envFiles.setDialog.keep"),
              discard: t("settings.envFiles.setDialog.discardButton"),
            }
          : undefined
      }
      footer={(dismiss) => (
        <>
          <button type="button" className={secondaryButton} onClick={dismiss}>
            {t("settings.envFiles.cancel")}
          </button>
          <button
            type="submit"
            form={`${id}-form`}
            aria-disabled={busy || undefined}
            className={`${primaryButton} aria-disabled:opacity-40`}
          >
            {busy ? t("settings.envFiles.setDialog.saving") : t("settings.envFiles.setDialog.save")}
          </button>
        </>
      )}
    >
      <form
        id={`${id}-form`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
      >
        <DialogField label={t("settings.envFiles.setDialog.name")} htmlFor={`${id}-key`}>
          <input
            id={`${id}-key`}
            value={key}
            readOnly={fixedKey !== null}
            data-autofocus={fixedKey === null || undefined}
            spellCheck={false}
            autoComplete="off"
            placeholder="DATABASE_URL"
            aria-invalid={keyError || undefined}
            aria-describedby={keyError ? `${id}-key-error` : undefined}
            onChange={(e) => {
              setKey(e.target.value);
              setKeyError(false);
            }}
            className={`${inputClass} font-code read-only:border-transparent read-only:px-0`}
          />
          {keyError && (
            <ErrorLine id={`${id}-key-error`}>
              {t("settings.envFiles.setDialog.keyError")}
            </ErrorLine>
          )}
        </DialogField>
        <SecretInput
          label={t("settings.envFiles.setDialog.value")}
          value={value}
          onChange={setValue}
          autoFocus={fixedKey !== null}
          hint={t("settings.envFiles.setDialog.hint")}
        />
        {write.message}
      </form>
    </Dialog>
  );
}

function RemoveVariableDialog({
  code,
  target,
  variable,
  onReload,
  onClose,
}: {
  code: string;
  target: FileTarget;
  variable: string;
  onReload: () => void;
  /** `gone`: la riga non c'è più, il fuoco va al «New file» dell'ambiente. */
  onClose: (gone?: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const remove = useRemoveEnvVar();
  const write = useSettingsWrite(code, onReload);
  const [busy, setBusy] = useState(false);
  const words = { key: variable, ...fileWords(target) };

  async function submit() {
    if (busy) return;
    setBusy(true);
    const ok = await write.run(
      () =>
        reauth(() => remove.mutateAsync({ fileId: target.file.id, key: variable }), {
          action: t("settings.envFiles.removeDialog.reauthAction", words),
        }),
      () => undefined,
    );
    setBusy(false);
    if (!ok) return;
    toast.show(t("settings.envFiles.removeDialog.done", words));
    onClose(true);
  }

  return (
    <Dialog
      title={t("settings.envFiles.removeDialog.title", words)}
      description={
        target.environment.reachesClaude ? t("settings.envFiles.removeDialog.claude") : undefined
      }
      onClose={() => onClose()}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={() => onClose()}>
            {t("settings.envFiles.cancel")}
          </button>
          <button
            type="button"
            aria-disabled={busy || undefined}
            className={dangerSolidButton}
            onClick={() => void submit()}
          >
            {busy
              ? t("settings.envFiles.removeDialog.removing")
              : t("settings.envFiles.removeDialog.remove")}
          </button>
        </>
      }
    >
      {write.message}
    </Dialog>
  );
}

function DeleteFileDialog({
  code,
  target,
  onReload,
  onClose,
}: {
  code: string;
  target: FileTarget;
  onReload: () => void;
  onClose: (gone?: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const remove = useDeleteEnvFile();
  const write = useSettingsWrite(code, onReload);
  const [busy, setBusy] = useState(false);
  const words = fileWords(target);
  const count = target.file.keys.length;

  async function submit() {
    if (busy) return;
    setBusy(true);
    const ok = await write.run(
      () =>
        reauth(() => remove.mutateAsync(target.file.id), {
          action: t("settings.envFiles.deleteDialog.reauthAction", words),
        }),
      () => undefined,
    );
    setBusy(false);
    if (!ok) return;
    toast.show(t("settings.envFiles.deleteDialog.done", words));
    onClose(true);
  }

  return (
    <Dialog
      title={
        count === 0
          ? t("settings.envFiles.deleteDialog.titleEmpty", words)
          : t("settings.envFiles.deleteDialog.title", { ...words, count })
      }
      onClose={() => onClose()}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={() => onClose()}>
            {t("settings.envFiles.cancel")}
          </button>
          <button
            type="button"
            aria-disabled={busy || undefined}
            className={dangerSolidButton}
            onClick={() => void submit()}
          >
            {busy
              ? t("settings.envFiles.deleteDialog.deleting")
              : t("settings.envFiles.deleteDialog.delete")}
          </button>
        </>
      }
    >
      {write.message}
    </Dialog>
  );
}
