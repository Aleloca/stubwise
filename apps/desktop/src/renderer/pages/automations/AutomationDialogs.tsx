import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { visitSteps } from "../../domain/automations/fields";
import {
  useActivateAutomation,
  useAutomation,
  useDeleteAutomationDraft,
  useMailboxes,
  usePauseAutomation,
  usePublishAutomation,
} from "../../data/queries";
import type { AutomationFlow } from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { RadioDot } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { displayNumber, sendsEmail } from "./format";
import { CriticalGlyph, WarningGlyph } from "./glyphs";
import { useAutomationPerms, useMe, useNames } from "./shared";

// I dialoghi di un'automazione (shape automations.md §«Dialoghi»): accendere
// e pubblicare dicono SEMPRE il cambio di proprietario, anche quando non
// cambia; mettere in pausa dice cosa succede agli eventi e alle esecuzioni;
// eliminare una bozza mai accesa chiede conferma. I controlli (casella,
// permessi nei progetti fissi) sono di chi accende: il dialogo li mostra
// prima, e `activate`/`publish` li rifanno (codici `mailbox_missing`,
// `mailbox_expired`, `permission`). La casella scelta resta sull'automazione.

/** I progetti fissi in cui il flusso crea qualcosa, col primo passo che ci crea. */
function fixedProjects(flow: AutomationFlow, own: string | null) {
  const out = new Map<string, string>();
  let fromClient = false;
  visitSteps(flow.steps, (s, path) => {
    if (s.kind !== "createTask" && s.kind !== "createMilestone" && s.kind !== "createRequest")
      return;
    const p = s.project;
    const id = p.mode === "fixed" ? p.projectId : p.mode === "own" ? own : null;
    if (p.mode === "from_client") fromClient = true;
    if (id && !out.has(id)) out.set(id, displayNumber(path));
  });
  return { fixed: out, fromClient };
}

export function TurnOnDialog({
  automationId,
  onClose,
}: {
  automationId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const me = useMe();
  const names = useNames();
  const perms = useAutomationPerms();
  const toast = useToast();
  const detail = useAutomation(automationId).data;
  const mailboxes = useMailboxes().data;
  const activate = useActivateAutomation();
  const publish = usePublishAutomation();
  const [from, setFrom] = useState<string | null>(null);
  const groupId = useId();
  if (!detail) return null;
  const a = detail.automation;
  const latest = a.versions.at(-1)!;
  const live = a.versions.filter((v) => v.publishedAt !== null).at(-1);
  const publishing = a.status === "active" && a.hasDraft;
  const flow = a.status === "paused" && live ? live.flow : latest.flow;
  const errors = a.status === "paused" ? detail.liveErrors : detail.configErrors;
  const { fixed, fromClient } = fixedProjects(flow, a.projectId);
  const blocked = [...fixed.entries()].filter(([id]) => !perms.createTasks(id));
  const needsMailbox = sendsEmail(flow);
  // Solo le caselle collegate: una scaduta non spedisce.
  const boxes = (mailboxes ?? []).filter((b) => !b.expired);
  const chosen = from ?? boxes[0]?.email ?? null;
  const suspended = detail.runs.filter((r) => r.status === "suspended").length;
  const ok = errors.length === 0 && blocked.length === 0 && (!needsMailbox || boxes.length > 0);
  const title = publishing
    ? t("automations.dialogs.publishTitle", { n: latest.n, code: a.code })
    : t("automations.dialogs.turnOnTitle", { code: a.code });

  const submit = () => {
    const done = {
      onSuccess: () => {
        onClose();
        toast.show(t("automations.toast.on", { code: a.code }));
      },
      onError: () => toast.error(t("automations.toast.onError", { code: a.code })),
    };
    const vars = { id: a.id, mailbox: needsMailbox ? (chosen ?? undefined) : undefined };
    if (publishing) publish.mutate(vars, done);
    else activate.mutate(vars, done);
  };

  return (
    <Dialog
      title={title}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!ok || activate.isPending || publish.isPending}
            onClick={submit}
          >
            {publishing ? t("automations.actions.publish") : t("automations.actions.turnOn")}
          </button>
        </>
      }
    >
      <p data-owner-change className="text-md text-ink">
        <Trans
          i18nKey="automations.dialogs.acts"
          components={{ b: <strong className="font-semibold" /> }}
        />
      </p>
      <p className="text-sm text-ink-muted">
        {a.ownerId === me || a.ownerId === null
          ? a.ownerId === me
            ? t("automations.dialogs.ownerSame")
            : t("automations.dialogs.ownerNew")
          : t("automations.dialogs.ownerChange", { from: names.person(a.ownerId) })}
      </p>
      {errors.length > 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-critical">
          <CriticalGlyph />
          {t("automations.dialogs.hasProblems", { count: errors.length })}
        </p>
      )}
      {needsMailbox && (
        <div role="radiogroup" aria-labelledby={groupId} className="flex flex-col gap-1.5">
          <span id={groupId} className="text-sm font-medium text-ink">
            {t("automations.dialogs.sentFrom")}
          </span>
          {boxes.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {t("automations.dialogs.noMailbox")}{" "}
              <Link to="/mail" className="text-ink underline underline-offset-4">
                {t("automations.dialogs.openMail")}
              </Link>
            </p>
          ) : (
            boxes.map((b) => (
              <button
                key={b.email}
                type="button"
                role="radio"
                aria-checked={chosen === b.email}
                onClick={() => setFrom(b.email)}
                className="flex h-8 items-center gap-2 rounded-md px-1 text-left text-sm text-ink hover:bg-ink/6"
              >
                <RadioDot checked={chosen === b.email} />
                {b.email}
              </button>
            ))
          )}
        </div>
      )}
      {blocked.map(([id, step]) => (
        <p key={id} data-blocked className="flex items-start gap-2 text-sm text-critical">
          <CriticalGlyph />
          {t("automations.dialogs.cantCreate", {
            code: names.project(id)?.code ?? t("automations.dialogs.thatProject"),
            step,
          })}
        </p>
      ))}
      {fromClient && (
        <p className="flex items-start gap-2 text-sm text-ink-muted">
          <WarningGlyph />
          {t("automations.dialogs.clientWarning")}
        </p>
      )}
      {publishing && a.openRuns > 0 && (
        <p className="text-sm text-ink-muted">
          {t("automations.dialogs.keepVersion", { count: a.openRuns, n: live?.n ?? 1 })}
        </p>
      )}
      {a.status === "paused" && (
        <p className="text-sm text-ink-muted">
          {suspended > 0 && `${t("automations.dialogs.resumes", { count: suspended })} `}
          {t("automations.dialogs.notRecovered")}
        </p>
      )}
    </Dialog>
  );
}

export function PauseDialog({
  automationId,
  onClose,
}: {
  automationId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const detail = useAutomation(automationId).data;
  const pause = usePauseAutomation();
  if (!detail) return null;
  const a = detail.automation;
  return (
    <Dialog
      title={t("automations.dialogs.pauseTitle", { code: a.code })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={pause.isPending}
            onClick={() =>
              pause.mutate(a.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.paused", { code: a.code }));
                },
                onError: () => toast.error(t("automations.toast.pauseError", { code: a.code })),
              })
            }
          >
            {t("automations.actions.pause")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">{t("automations.dialogs.pauseIgnored")}</p>
      {a.openRuns > 0 && (
        <p className="text-sm text-ink-muted">
          {t("automations.dialogs.pauseRuns", { count: a.openRuns })}
        </p>
      )}
    </Dialog>
  );
}

export function DeleteDraftDialog({
  automationId,
  onClose,
}: {
  automationId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const detail = useAutomation(automationId).data;
  const remove = useDeleteAutomationDraft();
  if (!detail) return null;
  const a = detail.automation;
  return (
    <Dialog
      title={t("automations.dialogs.deleteTitle", { code: a.code })}
      width={400}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(a.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.deleted", { code: a.code }));
                  void navigate({ to: "/automations" });
                },
                onError: () => toast.error(t("automations.toast.deleteError", { code: a.code })),
              })
            }
          >
            {t("automations.actions.delete")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">{t("automations.dialogs.deleteBody")}</p>
    </Dialog>
  );
}
