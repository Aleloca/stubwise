import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAdvancePrWork,
  useRequestPrCorrection,
  useSetPrAnalysisOnly,
  useSimulateAuthorPush,
} from "../../data/queries";
import type { OpenPrView } from "../../data/releases";
import { can, useViewer } from "../../data/viewer";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { PrototypeBox } from "../automations/shared";
import { Section, smallPrimary, smallSecondary } from "../task/parts";
import { shortRepo } from "./format";

// Le azioni del pannello di una PR (shape releases.md §6, ordine fisso):
// «Analysis only» (solo PR dei colleghi, [R 14]), «Request changes» (entro il
// tetto; oltre, solo chi approva i piani), e i «Simula» del prototipo in un
// riquadro tratteggiato ([R 15]) che dicono di non avviare niente. I
// permessi li ha già calcolati il livello dati (`actions`).

function AnalysisOnly({ pr }: { pr: OpenPrView }) {
  const { t } = useTranslation();
  const set = useSetPrAnalysisOnly();
  const toast = useToast();
  const id = useId();
  const on = pr.analysisOnly !== null;
  const off = pr.prState.state === "analysis_off";
  const inFlight = pr.corrections.some((c) => c.state === "running");
  const disabled = !pr.actions.analysisOnly || off || set.isPending;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          disabled={disabled}
          onClick={() =>
            set.mutate(
              { prId: pr.id, on: !on },
              { onError: () => toast.error(t("releases.panel.analysisOnlyError")) },
            )
          }
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-[var(--duration-fast)] ease-out disabled:opacity-40 ${on ? "border-ink bg-ink" : "border-rule-strong bg-transparent"}`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 left-0 size-3.5 rounded-full transition-transform duration-[var(--duration-fast)] ease-out ${on ? "translate-x-4 bg-ground" : "translate-x-0.5 bg-ink-muted"}`}
          />
        </button>
        <label htmlFor={id} className="text-md font-medium text-ink">
          {t("releases.panel.analysisOnly")}
        </label>
      </div>
      <p className="text-sm text-ink-muted">
        {off
          ? t("releases.prLine.analysisOff", { repo: shortRepo(pr.repo) })
          : t("releases.panel.analysisOnlyBody")}
      </p>
      {!on && inFlight && !off && (
        <p className="text-sm text-ink-muted">{t("releases.panel.willStop")}</p>
      )}
    </div>
  );
}

function RequestChanges({
  pr,
  projectCode,
}: {
  pr: OpenPrView;
  projectCode: string;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const request = useRequestPrCorrection();
  const toast = useToast();
  const navigate = useNavigate();
  const id = useId();
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const { cap } = pr;
  const atCap = pr.prState.autoRound >= cap;
  // Oltre il tetto solo chi approva i piani (R-K2): agli altri il bottone c'è, spento, col perché.
  const over = atCap && can(viewer, "plans.approve", pr.projectId);
  const blocked = atCap && !over;
  const send = () =>
    request.mutate(
      { prId: pr.id, text },
      {
        onSuccess: (r) => {
          if (!r.ok) return setResult(r.error);
          setText("");
          setResult(null);
          const sessionId = r.sessionId;
          // Una PR di Stubwise: la correzione è una sessione della task, e il
          // toast porta lì (come «Merged… Open»).
          if (sessionId && pr.taskCode) {
            toast.show(t("releases.panel.requestStarted", { task: pr.taskCode }), {
              action: {
                label: t("releases.panel.openSession"),
                run: () => void navigate({ to: "/claude/$id", params: { id: sessionId } }),
              },
            });
          } else toast.show(t("releases.panel.requestSent"));
        },
        onError: () => toast.error(t("releases.panel.requestError")),
      },
    );
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-md font-medium text-ink">
        {t("releases.panel.whatShouldChange")}
      </label>
      <textarea
        id={id}
        rows={3}
        value={text}
        disabled={blocked}
        onChange={(e) => setText(e.target.value)}
        className={`${inputClass} resize-y disabled:opacity-50`}
      />
      {over && (
        <p className="text-sm text-ink-muted">
          {t("releases.panel.overCap", { code: projectCode, cap })}
        </p>
      )}
      {blocked && (
        <p className="text-sm text-ink-muted">
          {t("releases.panel.capReached", { code: projectCode, cap })}
        </p>
      )}
      {result && (
        <p role="alert" className="text-sm text-critical">
          {t(`releases.panel.requestErrors.${result}`, { code: projectCode, cap })}
        </p>
      )}
      <button
        type="button"
        disabled={blocked || !text.trim() || request.isPending}
        onClick={send}
        className={`${smallPrimary} self-start`}
      >
        {t("releases.panel.sendToClaude")}
      </button>
    </div>
  );
}

export function PrActions({
  pr,
  projectCode,
}: {
  pr: OpenPrView;
  projectCode: string;
}) {
  const { t } = useTranslation();
  const colleague = pr.origin === "colleague";
  const fixable = pr.prState.state !== "not_fixable";
  return (
    <Section title={t("releases.panel.actions")}>
      <div className="flex flex-col gap-5 pb-1">
        {colleague && <AnalysisOnly pr={pr} />}
        {/* Sulle PR di Stubwise è la correzione della task (area 3), sotto lo stesso tetto. */}
        {pr.actions.requestCorrection && fixable && (
          <RequestChanges pr={pr} projectCode={projectCode} />
        )}
        {!colleague && pr.taskCode && pr.actions.requestCorrection && (
          <p className="text-sm text-ink-muted">
            {t("releases.panel.stubwiseCorrections", { task: pr.taskCode })}
          </p>
        )}
      </div>
    </Section>
  );
}

export function PrSimulate({ pr }: { pr: OpenPrView }) {
  const { t } = useTranslation();
  const advance = useAdvancePrWork();
  const push = useSimulateAuthorPush();
  const toast = useToast();
  const fail = () => toast.error(t("releases.simulate.error"));
  return (
    <div className="px-4 pb-6">
      <PrototypeBox label={t("releases.simulate.label")}>
        <p className="text-sm text-ink-muted">{t("releases.simulate.prIntro")}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={smallSecondary}
            onClick={() => advance.mutate(pr.id, { onError: fail })}
          >
            {t("releases.simulate.advance")}
          </button>
          <button
            type="button"
            className={smallSecondary}
            onClick={() => push.mutate(pr.id, { onError: fail })}
          >
            {t("releases.simulate.authorPush")}
          </button>
        </div>
      </PrototypeBox>
    </div>
  );
}
