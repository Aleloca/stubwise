import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PulseProposalView, PulseStartResult } from "../../../data/pulse/types";
import { usePulseDecide } from "../../../data/queries";
import { relativeTime } from "../../../notifications/time";
import { useToast } from "../../../tasks-ui/Toast";
import { ghostButton, smallPrimary } from "../../task/parts";

/**
 * Una proposta del polso in «Da decidere» (shape `pulse-proposals.md`,
 * PQ-1b: si decide solo qui). Il progetto fermo, le voci da cui ripartire
 * (la suggerita già scelta), la conseguenza scritta prima di «Start», e
 * «Not now» che archiva per chi lo preme. Dopo Start la riga sparisce con
 * la rilettura, e il toast apre la task nata.
 */
export function PulseDecisionItem({
  proposal: p,
  onOpenTask,
}: {
  proposal: PulseProposalView;
  onOpenTask: (code: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const decide = usePulseDecide();
  const name = useId();
  const [choice, setChoice] = useState(() => Math.max(0, p.options.findIndex((o) => o.suggested)));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<PulseStartResult, { ok: false }> | null>(null);

  const start = async () => {
    setBusy(true);
    setFailure(null);
    let r: PulseStartResult;
    try {
      r = await decide.start(p.id, choice);
    } catch {
      r = { ok: false, reason: "failed" };
    }
    setBusy(false);
    if (r.ok) {
      toast.show(
        t(r.awaitingApproval ? "home.decide.pulse.startedApproval" : "home.decide.pulse.started", {
          code: r.taskCode,
        }),
        { action: { label: t("home.decide.pulse.open"), run: () => onOpenTask(r.taskCode) } },
      );
      return;
    }
    setFailure(r);
  };

  return (
    <div data-pulse-proposal={p.id} className="flex flex-col gap-2 border-b border-rule py-3 pr-3 pl-4">
      <div className="flex min-w-0 items-baseline gap-2 text-sm text-ink-muted">
        <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">{p.projectCode}</span>
        <span className="min-w-0 truncate">{p.projectName}</span>
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <span className="num shrink-0 text-ink-faint">{relativeTime(p.createdAt, t, i18n.language)}</span>
      </div>
      <p className="max-w-[72ch] text-lg font-medium text-ink [overflow-wrap:anywhere]">
        {t("home.decide.pulse.question", { code: p.projectCode, count: p.idleDays })}
      </p>
      <fieldset className="flex max-w-[72ch] flex-col gap-1" disabled={busy}>
        <legend className="sr-only">{t("home.decide.pulse.legend", { code: p.projectCode })}</legend>
        {p.options.map((o, i) => (
          <label key={i} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-ink/4">
            <input
              type="radio"
              name={name}
              className="mt-1"
              checked={choice === i}
              onChange={() => setChoice(i)}
            />
            <span className="flex min-w-0 flex-col">
              <span className="flex items-baseline gap-2 text-md text-ink [overflow-wrap:anywhere]">
                {o.title}
                {o.suggested && (
                  <span data-suggested className="shrink-0 text-xs font-medium text-ink-muted">
                    {t("home.decide.pulse.suggested")}
                  </span>
                )}
              </span>
              {(o.urgency || o.effort !== null) && (
                <span className="text-xs text-ink-muted">
                  {[
                    o.urgency ? t(`home.decide.pulse.urgency.${o.urgency}`) : null,
                    o.effort !== null ? t("home.decide.pulse.effort", { value: o.effort }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      <p className="max-w-[72ch] text-sm text-ink-muted">{t("home.decide.pulse.consequence")}</p>
      {failure && (
        <p role="alert" data-pulse-failure={failure.reason} className="max-w-[72ch] text-sm text-ink">
          {t(`home.decide.pulse.errors.${failure.reason}`, { code: failure.taskCode ?? "" })}
          {failure.reason === "run_not_started" && failure.taskCode && (
            <>
              {" "}
              <button
                type="button"
                className="rounded-sm underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
                onClick={() => onOpenTask(failure.taskCode!)}
              >
                {t("home.decide.pulse.open")}
              </button>
            </>
          )}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={smallPrimary}
          aria-busy={busy || undefined}
          disabled={busy || failure?.reason === "stale" || failure?.reason === "run_not_started"}
          onClick={() => void start()}
        >
          {t("home.decide.pulse.start")}
        </button>
        <button type="button" className={ghostButton} disabled={busy} onClick={() => void decide.dismiss(p.id)}>
          {t("home.decide.pulse.notNow")}
        </button>
      </div>
    </div>
  );
}
