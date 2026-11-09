import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { triggerFields, visitSteps } from "../../domain/automations/fields";
import { now } from "../../data/dates";
import {
  useActivateAutomation,
  useAutomation,
  useAutomationSources,
  useDeleteAutomationDraft,
  useDuplicateAutomation,
  useFetchAutomationRuns,
  useMailboxes,
  usePauseAutomation,
  usePublishAutomation,
  useStartAutomation,
} from "../../data/queries";
import type { AutomationFlow, DataField } from "../../data/types";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
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

type CreateKind = "createTask" | "createMilestone" | "createRequest";

/**
 * I progetti fissi in cui il flusso crea qualcosa, per tipo di passo (task,
 * traguardo, richiesta: permessi diversi), col primo passo che ci crea.
 */
function fixedProjects(flow: AutomationFlow, own: string | null) {
  const out = new Map<string, { projectId: string; kind: CreateKind; step: string }>();
  let fromClient = false;
  visitSteps(flow.steps, (s, path) => {
    if (s.kind !== "createTask" && s.kind !== "createMilestone" && s.kind !== "createRequest")
      return;
    const p = s.project;
    const id = p.mode === "fixed" ? p.projectId : p.mode === "own" ? own : null;
    if (p.mode === "from_client") fromClient = true;
    const key = `${id}:${s.kind}`;
    if (id && !out.has(key))
      out.set(key, { projectId: id, kind: s.kind, step: displayNumber(flow.steps, path) });
  });
  return { fixed: [...out.values()], fromClient };
}

/** I codici d'errore di `activate`/`publish` in parole. */
const ON_ERRORS: Record<string, string> = {
  "invalid: permission": "automations.toast.onPermission",
  "invalid: mailbox_missing": "automations.toast.onMailboxMissing",
  "invalid: mailbox_expired": "automations.toast.onMailboxExpired",
  "invalid: config": "automations.toast.onConfig",
};

export function TurnOnDialog({
  automationId,
  onClose,
  publish: forcePublish = false,
  untested = false,
  onTestFirst,
  onDone,
}: {
  automationId: string;
  onClose: () => void;
  /**
   * Dal costruttore: pubblica la bozza anche su un'automazione in pausa, che
   * resta in pausa (shape builder [A 9]); la ripresa è del dettaglio.
   */
  publish?: boolean;
  /** La bozza non è stata provata: il dialogo lo dice e offre «Test first» (shape builder [A 11]). */
  untested?: boolean;
  onTestFirst?: () => void;
  /** Dopo l'accensione o la pubblicazione riuscita (il costruttore torna al dettaglio). */
  onDone?: () => void;
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
  const publishing = (a.status === "active" || forcePublish) && a.hasDraft;
  // In pausa, «Turn on» riaccende la versione pubblicata; «Publish» guarda la bozza.
  const resuming = a.status === "paused" && !publishing;
  const flow = resuming && live ? live.flow : latest.flow;
  const errors = resuming ? detail.liveErrors : detail.configErrors;
  const { fixed, fromClient } = fixedProjects(flow, a.projectId);
  const blocked = fixed.filter((f) => !perms.canCreate(f.kind, f.projectId));
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
        toast.show(
          a.status === "paused" && publishing
            ? t("automations.toast.publishedPaused", { code: a.code, n: latest.n })
            : t("automations.toast.on", { code: a.code }),
        );
        onDone?.();
      },
      // Pubblicando, il toast dice «pubblicare», non «accendere».
      onError: (e: unknown) =>
        toast.error(
          t(ON_ERRORS[(e as Error).message] ?? "automations.toast.onError", {
            code: a.code,
            ...(publishing ? { context: "publish" } : {}),
          }),
        ),
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
          {untested && onTestFirst && (
            <button type="button" className={secondaryButton} onClick={onTestFirst}>
              {t("automations.dialogs.testFirst")}
            </button>
          )}
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
      {blocked.map((b) => (
        <p
          key={`${b.projectId}:${b.kind}`}
          data-blocked
          className="flex items-start gap-2 text-sm text-critical"
        >
          <CriticalGlyph />
          {t(`automations.dialogs.cantCreate.${b.kind}`, {
            code: names.project(b.projectId)?.code ?? t("automations.dialogs.thatProject"),
            step: b.step,
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
      {untested && (
        <p data-untested className="text-sm text-ink-muted">
          {t("automations.dialogs.untested")}
        </p>
      )}
      {a.status === "paused" && publishing && (
        <p className="text-sm text-ink-muted">{t("automations.dialogs.staysPaused")}</p>
      )}
      {resuming && (
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

/** Un campo dell'inizio che si scrive a mano (gli elenchi e i file no). */
const typable = (f: DataField) => f.type !== "list" && f.type !== "file";

/** `{ "avvio.data": "…" }` → `{ avvio: { data: "…" } }`. */
function nest(values: Record<string, string>, fields: DataField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.key] ?? "";
    if (raw === "") continue;
    const value = f.type === "number" ? Number(raw) : f.type === "boolean" ? raw === "true" : raw;
    const keys = f.key.split(".");
    let o = out;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
    o[keys.at(-1)!] = value;
  }
  return out;
}

/**
 * «Run now» (shape §6, «⋯»): i dati dell'inizio con le loro etichette, poi
 * l'esecuzione parte con quell'evento. Per l'avvio a mano: la data, oggi.
 */
export function RunNowDialog({
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
  const sources = useAutomationSources().data ?? [];
  const start = useStartAutomation();
  const fetchRuns = useFetchAutomationRuns();
  const [values, setValues] = useState<Record<string, string>>({
    "avvio.data": now().slice(0, 10),
  });
  const baseId = useId();
  if (!detail) return null;
  const a = detail.automation;
  const live = a.versions.filter((v) => v.publishedAt !== null).at(-1);
  if (!live) return null;
  const fields = triggerFields(live.flow, sources).filter(typable);
  const inputType = (f: DataField) =>
    f.type === "number"
      ? "number"
      : f.type === "date"
        ? "date"
        : f.type === "email"
          ? "email"
          : "text";
  const submit = () =>
    start.mutate(
      { id: a.id, event: nest(values, fields) },
      {
        onSuccess: async (runId) => {
          onClose();
          const [run] = await fetchRuns([runId]);
          if (!run) return;
          toast.show(t("automations.toast.started", { code: run.code }), {
            action: {
              label: t("automations.actions.open"),
              run: () =>
                void navigate({
                  to: "/automations/$code/runs/$n",
                  params: { code: a.code, n: String(run.n) },
                }),
            },
          });
        },
        onError: () => toast.error(t("automations.toast.startError", { code: a.code })),
      },
    );
  return (
    <Dialog
      title={t("automations.dialogs.runNowTitle", { code: a.code })}
      description={t("automations.dialogs.runNowBody")}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={start.isPending}
            onClick={submit}
          >
            {t("automations.actions.runNow")}
          </button>
        </>
      }
    >
      {fields.map((f, i) => (
        <DialogField key={f.key} label={f.label} htmlFor={`${baseId}-${i}`}>
          <input
            id={`${baseId}-${i}`}
            title={f.key}
            type={inputType(f)}
            className={inputClass}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          />
        </DialogField>
      ))}
    </Dialog>
  );
}

/**
 * «Duplicate» (shape §6, [A 11]): una bozza nuova, mai accesa, dalla
 * versione scelta — è anche il modo di riprendere una versione vecchia.
 */
export function DuplicateDialog({
  automationId,
  version,
  onClose,
}: {
  automationId: string;
  version?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const detail = useAutomation(automationId).data;
  const duplicate = useDuplicateAutomation();
  const [name, setName] = useState(() =>
    t("automations.duplicate.defaultName", { name: detail?.automation.name ?? "" }),
  );
  const nameId = useId();
  if (!detail) return null;
  const a = detail.automation;
  const submit = () => {
    if (!name.trim()) return;
    duplicate.mutate(
      { id: a.id, name: name.trim(), version },
      {
        onSuccess: (copy) => {
          onClose();
          toast.show(t("automations.toast.duplicated", { code: copy.code }));
          void navigate({ to: "/automations/$code", params: { code: copy.code } });
        },
        onError: () => toast.error(t("automations.toast.duplicateError", { code: a.code })),
      },
    );
  };
  return (
    <Dialog
      title={
        version === undefined
          ? t("automations.dialogs.duplicateTitle", { code: a.code })
          : t("automations.dialogs.duplicateVersionTitle", { code: a.code, n: version })
      }
      description={t("automations.dialogs.duplicateBody")}
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
            disabled={!name.trim() || duplicate.isPending}
            onClick={submit}
          >
            {t("automations.actions.duplicate")}
          </button>
        </>
      }
    >
      <DialogField label={t("automations.create.name")} htmlFor={nameId}>
        <input
          id={nameId}
          data-autofocus
          className={inputClass}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </DialogField>
    </Dialog>
  );
}
