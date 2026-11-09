import { useNavigate } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  useArchiveProject,
  useArchivePreview,
  useProjectSettingsAccess,
  type BusyReason,
} from "../../data/queries";
import type { Project } from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { routeOfCode } from "../claude/conversation/ProposalCard";
import { OpenCircleGlyph } from "../preferences/glyphs";
import { ReadError, refusalOf } from "../preferences/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { SettingsFrame, useSettingsWrite } from "./SettingsFrame";
import { ViewOnlyLine } from "./ViewOnly";

// Progetto → Settings → Archive (area 9c, Task 11, shape project-archive.md
// «Archive»): «il lavoro è finito». Archiviare è il gesto che si torna
// indietro: un bottone secondario, le conseguenze in righe, nessuna
// riconferma [AR 1]. Eliminare non sta qui: un progetto attivo non si
// elimina, e la riga in fondo dice dove e da chi si fa [AR 2]. Chi scrive lo
// dice `access.archive` del livello dati; il `busy` arriva dalla risposta
// alla conferma, e il dialogo dice cosa aspettare senza fermare niente [AR 4].

/** Le righe di «What happens», nell'ordine dello shape. */
const WHAT_HAPPENS = ["leaves", "readable", "automations", "nothingDeleted"] as const;

export function ArchiveSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const access = useProjectSettingsAccess(project.id).archive;
  const [open, setOpen] = useState(false);
  const lineId = useId();
  const listId = useId();
  const code = project.code;

  return (
    <SettingsFrame
      title={t("settings.sections.archive")}
      intro={t("settings.archive.intro", { code })}
    >
      {!access.canEdit && (
        <ViewOnlyLine
          id={lineId}
          action={access.editAction ?? "manageProjectSettings"}
          projectId={project.id}
          code={code}
        />
      )}
      <section aria-labelledby={listId} className="border-t border-rule pt-5">
        <h2 id={listId} className="heading-group pb-3">
          {t("settings.archive.whatHappens")}
        </h2>
        <ul aria-labelledby={listId} className="flex max-w-[72ch] flex-col gap-2.5">
          {WHAT_HAPPENS.map((line) => (
            <li key={line} className="flex items-start gap-2 text-md text-pretty text-ink">
              <span aria-hidden="true" className="mt-[4px] shrink-0 text-ink-muted">
                <OpenCircleGlyph size={12} />
              </span>
              <span className="min-w-0">{t(`settings.archive.${line}`, { code })}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-col items-start gap-3">
          <button
            type="button"
            aria-disabled={!access.canEdit || undefined}
            aria-describedby={access.canEdit ? undefined : lineId}
            onClick={() => access.canEdit && setOpen(true)}
            className={`${secondaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
          >
            {t("settings.archive.button", { code })}
          </button>
          <p className="max-w-[72ch] text-sm text-pretty text-ink-muted">
            {t("settings.archive.deleteNote")}
          </p>
        </div>
      </section>
      {open && <ArchiveDialog project={project} onClose={() => setOpen(false)} />}
    </SettingsFrame>
  );
}

/**
 * «Archive ACQ?» (480 px): le quattro righe in breve, più le esecuzioni
 * d'automazione che si annulleranno ([AR 3], dall'anteprima). Con `busy` il
 * dialogo resta aperto e dice cosa aspettare; riuscito, si va ad All projects
 * col fuoco all'h1 e il toast con «Open Archived».
 */
function ArchiveDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const preview = useArchivePreview(project.id);
  const archive = useArchiveProject();
  const [busyReasons, setBusyReasons] = useState<BusyReason[] | null>(null);
  const [sending, setSending] = useState(false);
  const code = project.code;

  const toProjects = () => void navigate({ to: "/projects", state: { focus: "h1" } as never });
  const write = useSettingsWrite(code, () => void preview.refetch());

  async function submit() {
    if (sending) return;
    setSending(true);
    await write.run(
      // `busy` non è un errore da riprovare: è la risposta che il dialogo dice.
      async () => {
        const result = await archive.mutateAsync(project.id);
        if (!result.ok && result.error === "busy")
          return { ok: true as const, busy: result.reasons };
        return result;
      },
      (reason) => {
        if (reason !== "already_archived") return;
        toast.show(t("settings.archive.already", { code }));
        onClose();
        toProjects();
      },
      (result) => {
        if ("busy" in result && Array.isArray(result.busy)) return setBusyReasons(result.busy);
        onClose();
        toProjects();
        toast.show(t("settings.archive.done", { code }), {
          action: {
            label: t("settings.archive.openArchived"),
            run: () => void navigate({ to: "/projects", search: { view: "archived" } as never }),
          },
        });
      },
    );
    setSending(false);
  }

  const submitButton = (label: string) => (
    <button
      type="button"
      aria-disabled={sending || undefined}
      onClick={() => void submit()}
      className={primaryButton}
    >
      {sending ? t("settings.archive.dialog.archiving") : label}
    </button>
  );

  if (busyReasons)
    return (
      <Dialog
        title={t("settings.archive.busy.title", { code })}
        onClose={onClose}
        width={480}
        footer={
          <>
            <button type="button" data-autofocus className={secondaryButton} onClick={onClose}>
              {t("settings.archive.busy.close")}
            </button>
            {submitButton(t("settings.archive.busy.again"))}
          </>
        }
      >
        {/* Ogni riga ha il suo glifo: un triangolo accanto alla lista farebbe due icone sulla prima. */}
        <div className="flex min-w-0 flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {busyReasons.map((reason, i) => (
              <BusyLine key={i} reason={reason} code={code} />
            ))}
          </ul>
          <p className="text-md text-pretty text-ink">
            {t("settings.archive.busy.wait", { count: busyReasons.length })}
          </p>
        </div>
        {write.message}
      </Dialog>
    );

  const runs = preview.data && preview.data.ok ? preview.data.openAutomationRuns : 0;
  return (
    <Dialog
      title={t("settings.archive.dialog.title", { code })}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button type="button" data-autofocus className={secondaryButton} onClick={onClose}>
            {t("settings.archive.dialog.cancel")}
          </button>
          {submitButton(t("settings.archive.dialog.archive"))}
        </>
      }
    >
      <ul className="flex flex-col gap-2 text-md text-pretty text-ink">
        {WHAT_HAPPENS.map((line) => (
          <Consequence key={line}>{t(`settings.archive.dialog.${line}`, { code })}</Consequence>
        ))}
        {runs > 0 && (
          <Consequence>{t("settings.archive.dialog.openRuns", { count: runs })}</Consequence>
        )}
      </ul>
      {preview.isError || (preview.data && refusalOf(preview.data)) ? (
        <ReadError
          message={t("settings.common.loadError", { code })}
          onRetry={() => void preview.refetch()}
        />
      ) : null}
      {write.message}
    </Dialog>
  );
}

function Consequence({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden="true" className="mt-[8px] size-1 shrink-0 rounded-full bg-ink-muted" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** Il segno di ciò che lavora (▸) e di ciò che aspetta la coda (◷). */
function ReasonGlyph({ waiting }: { waiting: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {waiting ? (
        <>
          <circle cx="8" cy="8" r="5.75" />
          <path d="M8 5v3.25l2 1.25" />
        </>
      ) : (
        <path d="M5.5 3.75v8.5L12 8 5.5 3.75Z" />
      )}
    </svg>
  );
}

/**
 * Una ragione di `busy`, in parole: la sessione col codice (link alla task o
 * alla richiesta) e il titolo, il solo titolo, o niente dei due se chi guarda
 * non vede la conversazione (P23); il rilascio col suo codice.
 */
function BusyLine({ reason, code }: { reason: BusyReason; code: string }) {
  const codeLink = (href: string) => (
    <a
      href={href}
      className="num font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
    />
  );
  let line: ReactNode;
  if (reason.kind === "release") {
    line = (
      <Trans
        i18nKey="settings.archive.busy.release"
        values={{ code: reason.code }}
        components={{ code: codeLink(`#/p/${code}/releases/${reason.code}`) }}
      />
    );
  } else {
    const base = reason.waiting ? "waiting" : "session";
    const key =
      reason.code !== null ? base : reason.title !== null ? `${base}Title` : `${base}Hidden`;
    line = (
      <Trans
        i18nKey={`settings.archive.busy.${key}`}
        values={{ code: reason.code ?? "", title: reason.title ?? "" }}
        components={{ code: reason.code ? codeLink(routeOfCode(reason.code)) : <span /> }}
      />
    );
  }
  return (
    <li className="flex items-start gap-2 text-md text-pretty text-ink">
      <span className="mt-[4px] shrink-0 text-ink-muted">
        <ReasonGlyph waiting={reason.kind === "claude_session" && reason.waiting} />
      </span>
      <span className="min-w-0">{line}</span>
    </li>
  );
}
