import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectSubscriptions, SubscriptionRow as Row } from "../../data/alerts";
import { useCopyAlertSubscriptions } from "../../data/queries";
import { Dialog } from "../../tasks-ui/Dialog";
import { Menu, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MoreGlyph } from "./glyphs";
import { useMuteProject, useUndoAction } from "./useAlertActions";

// Il menu «⋯» di un gruppo delle Preferenze → Notifiche e il dialogo «Same
// as another project…» (shape alerts.md, «Azioni in blocco»).

/** Un progetto corrisponde alla ricerca per codice o nome. */
export const matchesProject = (p: ProjectSubscriptions, q: string) => {
  const needle = q.trim().toLowerCase();
  return !needle || p.code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle);
};

/** Il menu «⋯» del gruppo: «Same as another project…», «Turn everything off», «Open». */
export function GroupMenu({
  project: p,
  all,
}: {
  project: ProjectSubscriptions;
  all: ProjectSubscriptions[];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const muteProject = useMuteProject();
  const [step, setStep] = useState<"closed" | "main" | "pick">("closed");
  const [filter, setFilter] = useState("");
  const [copyFrom, setCopyFrom] = useState<ProjectSubscriptions | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const close = useCallback((restore: boolean) => {
    setStep("closed");
    setFilter("");
    if (restore) buttonRef.current?.focus();
  }, []);
  useEffect(() => {
    if (step === "pick") filterRef.current?.focus();
  }, [step]);

  const candidates = all.filter((o) => o.projectId !== p.projectId && matchesProject(o, filter));
  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={step !== "closed"}
        aria-label={t("alerts.menu.label", { code: p.code })}
        onClick={() => (step === "closed" ? setStep("main") : close(false))}
        className="grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
      >
        <MoreGlyph />
      </button>
      {step === "main" && (
        <Menu label={t("alerts.menu.label", { code: p.code })} onClose={close} align="right">
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => setStep("pick")}
          >
            {t("alerts.menu.same")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              close(true);
              void muteProject(p);
            }}
          >
            {t("alerts.menu.off", { code: p.code })}
          </button>
          <div role="separator" className="my-1 border-t border-rule" />
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              close(false);
              void navigate({
                to: "/p/$code/$section",
                params: { code: p.code, section: "overview" },
              });
            }}
          >
            {t("alerts.menu.open", { code: p.code })}
          </button>
        </Menu>
      )}
      {step === "pick" && (
        <Menu label={t("alerts.menu.pick")} onClose={close} align="right">
          <input
            ref={filterRef}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t("alerts.menu.pick")}
            placeholder={t("alerts.findPlaceholder")}
            className="mb-1 h-8 w-full min-w-0 shrink-0 rounded-md border border-rule-strong bg-transparent px-2 text-sm text-ink placeholder:text-ink-faint"
          />
          {candidates.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-ink-muted">{t("alerts.menu.none")}</p>
          )}
          {candidates.map((o) => (
            <button
              key={o.projectId}
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                close(false);
                setCopyFrom(o);
              }}
            >
              <span className="num w-9 shrink-0 text-xs font-semibold text-ink">{o.code}</span>
              <span className="min-w-0 truncate">{o.name}</span>
            </button>
          ))}
        </Menu>
      )}
      {copyFrom && (
        <CopyDialog
          from={copyFrom}
          to={p}
          onClose={() => {
            setCopyFrom(null);
            buttonRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

type Channel = "off" | "app" | "both";
const channelOf = (r: Row): Channel => (!r.app ? "off" : r.phone ? "both" : "app");
const writable = (r: Row | undefined): r is Row => r?.state === "on" || r?.state === "off";

/** Quante righe di `to` cambierebbero prendendo lo stato di `from` (solo quelle scrivibili da entrambe le parti). */
export function copyDiff(from: ProjectSubscriptions, to: ProjectSubscriptions) {
  const source = new Map(from.rows.map((r) => [r.type, r]));
  return to.rows.flatMap((r) => {
    const s = source.get(r.type);
    if (!writable(r) || !writable(s) || channelOf(r) === channelOf(s)) return [];
    return [{ row: r, from: channelOf(r), to: channelOf(s) }];
  });
}

const DIFF_LINES = 6;

/** «Use ACQ's alert settings in AUD? 14 alerts change.» con le differenze (shape [A 12]). */
function CopyDialog({
  from,
  to,
  onClose,
}: {
  from: ProjectSubscriptions;
  to: ProjectSubscriptions;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const copy = useCopyAlertSubscriptions();
  const toast = useToast();
  const undoAction = useUndoAction();
  const diff = copyDiff(from, to);
  const ch = (c: Channel) => t(`alerts.copy.channels.${c}`);
  async function confirm() {
    try {
      const done = await copy.mutateAsync({ from: from.projectId, to: to.projectId });
      onClose();
      toast.show(t("alerts.copy.done", { from: from.code, to: to.code }), {
        action: undoAction(done, to.code),
      });
    } catch {
      toast.error(t("alerts.bulkError", { code: to.code }));
    }
  }
  return (
    <Dialog
      title={t("alerts.copy.title", { from: from.code, to: to.code })}
      description={
        diff.length > 0 ? t("alerts.copy.count", { count: diff.length }) : t("alerts.copy.none")
      }
      width={400}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink hover:bg-ink/6"
          >
            {t("alerts.copy.cancel")}
          </button>
          <button
            type="button"
            data-autofocus
            disabled={diff.length === 0 || copy.isPending}
            onClick={() => void confirm()}
            className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-sm font-semibold text-ground hover:opacity-90 disabled:opacity-40"
          >
            {t("alerts.copy.confirm")}
          </button>
        </>
      }
    >
      {diff.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-ink">
          {diff.slice(0, DIFF_LINES).map((d) => (
            <li key={d.row.type}>
              {t("alerts.copy.line", { label: t(d.row.labelKey), from: ch(d.from), to: ch(d.to) })}
            </li>
          ))}
          {diff.length > DIFF_LINES && (
            <li className="text-ink-muted">
              {t("alerts.copy.more", { count: diff.length - DIFF_LINES })}
            </li>
          )}
        </ul>
      )}
      <p className="text-sm text-ink-muted">{t("alerts.copy.stays")}</p>
    </Dialog>
  );
}
