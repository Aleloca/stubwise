import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateCheck, useDeleteCheck, useUpdateCheck } from "../../data/queries";
import type { CheckInput } from "../../data/servers";
import type { ServerCheck } from "../../data/types";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { dangerButton, ghostButton, smallSecondary } from "../task/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { CheckGlyph } from "./glyphs";
import { Part, shortInput } from "./Part";

// I controlli (shape servers.md §3, «Checks», [S 7]): una riga da 40px —
// stato in parola, nome, tipo, bersaglio, intervallo, latenza, ultimo
// errore. Clic (o Invio) sulla riga la seleziona per i grafici (`?check=`);
// di nuovo la deseleziona. Con `monitor.manage`: «Add check» in un dialogo
// e, al passaggio sulla riga, Edit · Pause/Resume · Delete (conferma a due
// tempi, in posto).

const TYPES: readonly ServerCheck["type"][] = ["http", "tcp", "process", "postgres", "mysql"];

function CheckDialog({
  serverCode,
  check,
  onClose,
}: {
  serverCode: string;
  check: ServerCheck | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateCheck();
  const update = useUpdateCheck();
  const ids = { name: useId(), type: useId(), target: useId(), interval: useId(), active: useId() };
  const [draft, setDraft] = useState({
    name: check?.name ?? "",
    type: check?.type ?? ("http" as ServerCheck["type"]),
    target: check?.target ?? "",
    interval: String(check?.intervalSeconds ?? 60),
    enabled: check?.enabled ?? true,
  });
  const [error, setError] = useState<{ field: string; text: string } | null>(null);
  const pending = create.isPending || update.isPending;

  const save = async () => {
    setError(null);
    const input: CheckInput = {
      name: draft.name,
      type: draft.type,
      target: draft.target,
      intervalSeconds: Number(draft.interval),
      enabled: draft.enabled,
    };
    try {
      if (check) await update.mutateAsync({ checkId: check.id, patch: input });
      else await create.mutateAsync({ code: serverCode, input });
      onClose();
    } catch (e) {
      const field = e instanceof Error ? e.message.replace(/^invalid: /, "") : "";
      setError({
        field,
        text: t(`servers.checks.errors.${field}`, {
          defaultValue: t("servers.checks.errors.generic"),
        }),
      });
    }
  };
  const fieldError = (field: string) =>
    error?.field === field ? (
      <span role="alert" className="text-sm text-critical">
        {error.text}
      </span>
    ) : null;

  return (
    <Dialog
      title={
        check ? t("servers.checks.editTitle", { name: check.name }) : t("servers.checks.addTitle")
      }
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("servers.cancel")}
          </button>
          <button
            type="button"
            disabled={pending || !draft.name.trim() || !draft.target.trim()}
            onClick={() => void save()}
            className={`${primaryButton} disabled:opacity-40`}
          >
            {check ? t("servers.save") : t("servers.checks.add")}
          </button>
        </>
      }
    >
      <DialogField label={t("servers.checks.fields.name")} htmlFor={ids.name}>
        <input
          id={ids.name}
          data-autofocus
          maxLength={200}
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className={inputClass}
        />
        {fieldError("name")}
      </DialogField>
      <DialogField label={t("servers.checks.fields.type")} htmlFor={ids.type}>
        <select
          id={ids.type}
          value={draft.type}
          onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as ServerCheck["type"] }))}
          className={`${inputClass} h-8`}
        >
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`servers.checks.types.${type}`)}
            </option>
          ))}
        </select>
        {fieldError("type")}
      </DialogField>
      <DialogField
        label={t("servers.checks.fields.target")}
        htmlFor={ids.target}
        hint={t("servers.checks.example", { example: t(`servers.checks.examples.${draft.type}`) })}
      >
        <input
          id={ids.target}
          value={draft.target}
          placeholder={t(`servers.checks.examples.${draft.type}`)}
          onChange={(e) => setDraft((d) => ({ ...d, target: e.target.value }))}
          className={`${inputClass} num`}
        />
        {fieldError("target")}
      </DialogField>
      <DialogField
        label={t("servers.checks.fields.interval")}
        htmlFor={ids.interval}
        hint={t("servers.checks.intervalHint")}
      >
        <input
          id={ids.interval}
          type="number"
          min={10}
          max={3600}
          value={draft.interval}
          onChange={(e) => setDraft((d) => ({ ...d, interval: e.target.value }))}
          className={`${shortInput} num h-8 w-32`}
        />
        {fieldError("intervalSeconds")}
      </DialogField>
      <label htmlFor={ids.active} className="flex items-center gap-2 text-md text-ink">
        <input
          id={ids.active}
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
          className="accent-ink"
        />
        {t("servers.checks.fields.active")}
      </label>
      {error && !["name", "type", "target", "intervalSeconds"].includes(error.field) && (
        <p role="alert" className="text-sm text-critical">
          {error.text}
        </p>
      )}
    </Dialog>
  );
}

function CheckRow({
  check,
  selected,
  onSelect,
  canManage,
  onEdit,
}: {
  check: ServerCheck;
  selected: boolean;
  onSelect: () => void;
  canManage: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateCheck();
  const remove = useDeleteCheck();
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  const status = check.enabled ? check.status : "paused";

  return (
    <li
      data-check={check.name}
      className="group flex min-h-10 items-center gap-2 border-b border-rule"
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={t("servers.checks.select", {
          name: check.name,
          status: t(`servers.checks.status.${status}`),
        })}
        onClick={onSelect}
        className="grid min-w-0 flex-1 grid-cols-[6.5rem_minmax(0,1.2fr)_6rem_minmax(0,1.6fr)_6rem_4.5rem] items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-pressed:bg-ink/10"
      >
        <span className="flex items-center gap-1.5">
          <CheckGlyph status={check.enabled ? check.status : "unknown"} />
          <span className="font-semibold text-ink">{t(`servers.checks.status.${status}`)}</span>
        </span>
        <span className="truncate font-medium text-ink" title={check.name}>
          {check.name}
        </span>
        <span className="text-ink-muted">{t(`servers.checks.types.${check.type}`)}</span>
        {/* Bersaglio e ultimo errore insieme (shape §7); il bersaglio resta
            leggibile, l'errore prende l'ellissi. */}
        <span
          data-check-target
          className="num flex min-w-0 items-baseline gap-1 text-ink-muted"
          title={check.lastError ? `${check.target} — ${check.lastError}` : check.target}
        >
          <span className="max-w-full shrink-0 truncate">{check.target}</span>
          {check.lastError && (
            <span className="min-w-0 truncate text-ink">— {check.lastError}</span>
          )}
        </span>
        <span className="num text-ink-muted">
          {t("servers.checks.every", { n: check.intervalSeconds })}
        </span>
        <span className="num text-right text-ink-muted">
          {check.latencyMs === null ? "—" : t("servers.checks.latency", { n: check.latencyMs })}
        </span>
      </button>
      {canManage &&
        (confirming ? (
          <span
            role="group"
            aria-label={t("servers.checks.deleteQuestion", { name: check.name })}
            className="flex shrink-0 items-center gap-1.5 pr-2"
          >
            <span className="text-sm text-ink">
              {t("servers.checks.deleteQuestion", { name: check.name })}
            </span>
            <button
              type="button"
              className={smallSecondary}
              onClick={() => setConfirming(false)}
              onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}
            >
              {t("servers.cancel")}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={dangerButton}
              disabled={remove.isPending}
              onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}
              onClick={() =>
                remove.mutate(check.id, {
                  onError: () =>
                    toast.error(t("servers.checks.errors.delete", { name: check.name })),
                })
              }
            >
              {t("servers.checks.confirmDelete")}
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-0.5 pr-2 opacity-0 transition-opacity duration-[var(--duration-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              className={ghostButton}
              aria-label={t("servers.checks.editOf", { name: check.name })}
              onClick={onEdit}
            >
              {t("servers.checks.edit")}
            </button>
            <button
              type="button"
              className={ghostButton}
              aria-label={t(check.enabled ? "servers.checks.pauseOf" : "servers.checks.resumeOf", {
                name: check.name,
              })}
              onClick={() =>
                update.mutate(
                  { checkId: check.id, patch: { enabled: !check.enabled } },
                  { onError: () => toast.error(t("servers.checks.errors.generic")) },
                )
              }
            >
              {t(check.enabled ? "servers.checks.pause" : "servers.checks.resume")}
            </button>
            <button
              type="button"
              className={ghostButton}
              aria-label={t("servers.checks.deleteOf", { name: check.name })}
              onClick={() => setConfirming(true)}
            >
              {t("servers.checks.delete")}
            </button>
          </span>
        ))}
    </li>
  );
}

export function ChecksPanel({
  serverCode,
  checks,
  canManage,
  selectedId,
  onSelect,
}: {
  serverCode: string;
  checks: ServerCheck[];
  canManage: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<ServerCheck | "new" | null>(null);
  return (
    <Part
      id="checks"
      title={t("servers.index.checks")}
      action={
        canManage ? (
          <button
            type="button"
            data-add-check
            className={smallSecondary}
            onClick={() => setEditing("new")}
          >
            {t("servers.checks.add")}
          </button>
        ) : undefined
      }
    >
      {checks.length === 0 ? (
        <p className="border-t border-rule py-3 pl-3 text-md text-ink-muted">
          {t("servers.checks.empty")}
        </p>
      ) : (
        <ul aria-label={t("servers.index.checks")} className="flex flex-col border-t border-rule">
          {checks.map((c) => (
            <CheckRow
              key={c.id}
              check={c}
              selected={c.id === selectedId}
              onSelect={() => onSelect(c.id === selectedId ? null : c.id)}
              canManage={canManage}
              onEdit={() => setEditing(c)}
            />
          ))}
        </ul>
      )}
      {editing && (
        <CheckDialog
          serverCode={serverCode}
          check={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Part>
  );
}
