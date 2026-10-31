import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useDeleteProject, useDeletionPreview, useSeesAdminSection } from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { ErrorLine } from "../entry/parts";
import { refusalOf, WriteError } from "../preferences/parts";
import { useSettingsWrite } from "../settings/SettingsFrame";
import { dangerSolidButton, secondaryButton } from "../tasks/controls";
import { COUNT_KEYS } from "./ArchivedProjectPage";

// «Delete RNC for good?» (area 9c, Task 11, shape project-archive.md «Delete
// for good»): il gesto `critical`, solo del full admin e solo su un
// archiviato, dalla pagina o dal «⋯» della riga di Archived. Mostra
// l'inventario dall'anteprima del livello dati — cosa sparisce (i soli
// conteggi non zero) e cosa resta senza progetto (repository e server) —,
// chiede il codice scritto esatto [AR 6] e poi la riconferma (+R). Il codice
// scritto è una bozza: Cancel ed Esc passano da «Discard?».

export function DeleteProjectDialog({
  projectId,
  code,
  onClose,
  onReload,
  onDeleted,
}: {
  projectId: string;
  code: string;
  onClose: () => void;
  /** Un rifiuto che cambia ciò che si vede (`forbidden`): chi ha aperto rilegge. */
  onReload: () => void;
  /** Riuscito, dopo il toast: chi ha aperto decide dove va il fuoco. */
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const reauth = useReauth();
  const remove = useDeleteProject();
  const preview = useDeletionPreview(projectId);
  const seesRepositories = useSeesAdminSection("repositories");
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const hintId = useId();
  const listId = useId();
  const staysId = useId();
  const write = useSettingsWrite(code, onReload, {
    forbidden: t("projects.archived.deleteDialog.forbidden"),
    onNotFound: () => {
      toast.error(t("projects.archived.deleteDialog.gone", { code }));
      onClose();
      void navigate({ to: "/projects", search: { view: "archived" } as never });
    },
  });

  const data = preview.data && preview.data.ok ? preview.data : null;
  const ready = data !== null;
  // Caricata l'anteprima, il fuoco va al campo del codice (shape §6).
  useEffect(() => {
    if (ready) field.current?.focus();
  }, [ready]);

  const exact = typed === code;
  // Lunghezza giusta ma testo diverso (anche solo le minuscole): lo dice [AR 6].
  const almost = !exact && typed.length === code.length;

  async function submit() {
    if (!exact || sending || !data) return;
    setSending(true);
    setMismatch(false);
    const detached = data.detachedRepositories.length;
    await write.run(
      () =>
        reauth(() => remove.mutateAsync({ projectId, confirmCode: typed }), {
          action: t("projects.archived.deleteDialog.reauthAction", { code }),
          cancelMessage: t("projects.archived.deleteDialog.nothingDeleted"),
        }),
      (reason) => {
        if (reason === "code_mismatch") return setMismatch(true);
        if (reason !== "not_archived") return;
        toast.show(t("projects.archived.deleteDialog.notArchived", { code }));
        onClose();
        void navigate({ to: "/p/$code/$section", params: { code, section: "overview" } });
      },
      () => {
        toast.show(
          detached > 0
            ? t("projects.archived.deleteDialog.doneDetached", { code, count: detached })
            : t("projects.archived.deleteDialog.done", { code }),
          detached > 0 && seesRepositories
            ? {
                action: {
                  label: t("projects.archived.deleteDialog.openRepositories"),
                  run: () =>
                    void navigate({ to: "/admin/$section", params: { section: "repositories" } }),
                },
              }
            : {},
        );
        onClose();
        onDeleted();
      },
    );
    setSending(false);
  }

  return (
    <Dialog
      title={t("projects.archived.deleteDialog.title", { code })}
      onClose={onClose}
      width={560}
      confirmDiscard={
        typed
          ? {
              message: t("projects.archived.deleteDialog.discard"),
              keep: t("projects.archived.deleteDialog.keep"),
              discard: t("projects.archived.deleteDialog.discardYes"),
            }
          : undefined
      }
      footer={(dismiss) => (
        <>
          <button type="button" data-autofocus className={secondaryButton} onClick={dismiss}>
            {t("projects.archived.deleteDialog.cancel")}
          </button>
          <button
            type="button"
            disabled={!exact || !ready}
            aria-busy={sending || undefined}
            onClick={() => void submit()}
            className={`${dangerSolidButton} disabled:cursor-not-allowed`}
          >
            {sending
              ? t("projects.archived.deleteDialog.deleting")
              : t("projects.archived.deleteDialog.submit")}
          </button>
        </>
      )}
    >
      <p className="flex items-start gap-1.5 text-md font-semibold text-critical">
        <CrossCircle />
        <span>{t("projects.archived.deleteDialog.undone")}</span>
      </p>
      {preview.isError || (preview.data && refusalOf(preview.data)) ? (
        <WriteError
          message={t("projects.archived.deleteDialog.loadError")}
          onRetry={() => void preview.refetch()}
        />
      ) : !data ? (
        <PreviewSkeleton />
      ) : (
        <>
          <section aria-labelledby={listId} className="flex flex-col gap-2">
            <h3 id={listId} className="heading-group">
              {t("projects.archived.deleteDialog.deleted")}
            </h3>
            <ul aria-labelledby={listId} className="grid grid-cols-2 gap-x-6 gap-y-1">
              {COUNT_KEYS.filter((key) => data.counts[key] > 0).map((key) => (
                <li key={key} className="num text-md text-ink">
                  {t(`projects.archived.deleteDialog.counts.${key}`, { count: data.counts[key] })}
                </li>
              ))}
            </ul>
            <p className="text-sm text-ink-muted">{t("projects.archived.deleteDialog.andMore")}</p>
          </section>
          {(data.detachedRepositories.length > 0 || data.orphanServers.length > 0) && (
            <section aria-labelledby={staysId} className="flex flex-col gap-2">
              <h3 id={staysId} className="heading-group">
                {t("projects.archived.deleteDialog.stays")}
              </h3>
              {data.detachedRepositories.length > 0 && (
                <Stays
                  i18nKey="projects.archived.deleteDialog.repositories"
                  names={data.detachedRepositories}
                />
              )}
              {data.orphanServers.length > 0 && (
                <Stays
                  i18nKey="projects.archived.deleteDialog.servers"
                  names={data.orphanServers}
                />
              )}
            </section>
          )}
          <p className="text-sm text-pretty text-ink-muted">
            {t("projects.archived.deleteDialog.log", { code })}
          </p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={fieldId} className="text-sm font-medium text-ink">
              {t("projects.archived.deleteDialog.type", { code })}
            </label>
            <input
              ref={field}
              id={fieldId}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={almost || undefined}
              aria-describedby={almost ? hintId : undefined}
              onChange={(e) => {
                setTyped(e.target.value);
                setMismatch(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              className={`${inputClass} num h-8 max-w-40 py-0`}
            />
            {almost && (
              <p id={hintId} className="text-xs text-ink-muted">
                {t("projects.archived.deleteDialog.exactly", { code })}
              </p>
            )}
            {mismatch && <ErrorLine>{t("projects.archived.deleteDialog.mismatch")}</ErrorLine>}
          </div>
        </>
      )}
      {write.message}
    </Dialog>
  );
}

/** Una riga di ciò che resta senza progetto: il numero, i nomi in grassetto e cosa succede. */
function Stays({ i18nKey, names }: { i18nKey: string; names: string[] }) {
  return (
    <p className="text-md text-pretty text-ink">
      <Trans
        i18nKey={i18nKey}
        values={{ count: names.length, names: names.join(", ") }}
        components={{ b: <strong className="font-semibold" /> }}
      />
    </p>
  );
}

function CrossCircle() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="mt-[3px] shrink-0"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.75 5.75 4.5 4.5M10.25 5.75l-4.5 4.5" />
    </svg>
  );
}

/** Sei righe finte, nella forma dell'inventario. */
function PreviewSkeleton(): ReactNode {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-2.5 py-1">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {[0.42, 0.3, 0.36, 0.5, 0.28, 0.4].map((w, i) => (
        <span key={i} className="block h-3 rounded-sm bg-ink/8" style={{ width: `${w * 100}%` }} />
      ))}
    </div>
  );
}
