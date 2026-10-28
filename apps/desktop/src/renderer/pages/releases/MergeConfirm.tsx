import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMergePr } from "../../data/queries";
import type { MergeError as DataMergeError, OpenPrView } from "../../data/releases";
import { useToast } from "../../tasks-ui/Toast";
import { smallPrimary, smallSecondary } from "../task/parts";
import { platformOf, prCode, prUrl } from "./format";

// Il merge a due tempi (shape releases.md [R 10]): «Release» apre in posto la
// frase e «Confirm merge»; il secondo tempo non scade da sé, si richiude con
// Esc o quando il fuoco esce. Durante il merge «Merging…» disattivato. Ogni
// errore della coda in parole, con cosa fare (`role="alert"`). Il merge è
// l'unica azione: la pipeline la fa la piattaforma, Stubwise la segue.

export type MergeStep = "idle" | "confirm" | "merging";

/**
 * Gli esiti d'errore del merge: i codici del livello dati, più `generic` per
 * un'eccezione (trasporto, cancello) che non dice niente sui controlli.
 */
export type MergeError = DataMergeError | "generic";

export interface MergeFlow {
  step: MergeStep;
  error: MergeError | null;
  start(): void;
  cancel(): void;
  confirm(): Promise<void>;
}

export function useMergeFlow(
  pr: OpenPrView,
  projectCode: string,
  onError?: (error: MergeError | null) => void,
): MergeFlow {
  const { t } = useTranslation();
  const merge = useMergePr();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<MergeStep>("idle");
  const [error, setError] = useState<MergeError | null>(null);
  const report = (e: MergeError | null) => {
    setError(e);
    onError?.(e);
  };
  return {
    step,
    error,
    start: () => {
      report(null);
      setStep("confirm");
    },
    cancel: () => {
      report(null);
      setStep("idle");
    },
    confirm: async () => {
      setStep("merging");
      try {
        const result = await merge.mutateAsync(pr.id);
        if (!result.ok) {
          report(result.error);
          // Una PR chiusa o sparita esce dalla lista appena si rilegge: l'errore resta in un avviso.
          if (result.error === "already_closed" || result.error === "not_found") {
            toast.error(
              t(`releases.merge.errors.${result.error}`, {
                platform: platformOf(prUrl(pr)),
                code: projectCode,
              }),
            );
          }
          setStep("confirm");
          return;
        }
        report(null);
        setStep("idle");
        const release = result.release;
        if (release) {
          toast.show(t("releases.merge.done", { code: release.code }), {
            action: {
              label: t("releases.merge.open"),
              run: () =>
                void navigate({
                  to: "/p/$code/releases/$release",
                  params: { code: projectCode, release: release.code },
                }),
            },
          });
        } else {
          toast.show(t("releases.merge.doneNoRelease"));
        }
      } catch {
        report("generic");
        setStep("confirm");
      }
    },
  };
}

/** «Release» nella riga (o nel pannello): apre il secondo tempo. */
export function MergeButton({ pr, flow }: { pr: OpenPrView; flow: MergeFlow }) {
  const { t } = useTranslation();
  if (flow.step !== "idle") return null;
  return (
    <button
      type="button"
      data-merge-start
      aria-label={t("releases.merge.releaseLabel", { pr: prCode(pr) })}
      onClick={(e) => {
        e.stopPropagation();
        flow.start();
      }}
      className={smallSecondary}
    >
      {t("releases.merge.release")}
    </button>
  );
}

/** Il secondo tempo, in posto sotto la riga: frase, «Confirm merge», «Cancel», l'errore. */
export function MergeExpansion({
  pr,
  flow,
  projectCode,
}: {
  pr: OpenPrView;
  flow: MergeFlow;
  projectCode: string;
}) {
  const { t } = useTranslation();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const open = flow.step !== "idle";
  // Il fuoco va su «Confirm merge» quando il secondo tempo si apre.
  useEffect(() => {
    if (flow.step === "confirm" && !flow.error) confirmRef.current?.focus();
  }, [flow.step, flow.error]);
  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && flow.step === "confirm") {
      e.preventDefault();
      e.stopPropagation();
      flow.cancel();
    }
  };
  // Il fuoco che esce dalla riga richiude il secondo tempo (mai durante il merge).
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (flow.step === "confirm" && next && !e.currentTarget.contains(next)) flow.cancel();
  };
  const platform = platformOf(prUrl(pr));
  return (
    <div
      data-merge-confirm
      role="group"
      aria-label={t("releases.merge.confirmGroup", { pr: prCode(pr) })}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onClick={(e) => e.stopPropagation()}
      className="merge-expand flex flex-col gap-2 border-t border-rule py-3 pr-3 pl-3"
    >
      <p aria-live="polite" className="text-md text-ink">
        {t("releases.merge.question", { n: pr.number, branch: pr.baseBranch })}
      </p>
      {flow.error && (
        <p role="alert" className="text-sm text-critical">
          {t(`releases.merge.errors.${flow.error}`, { platform, code: projectCode })}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          ref={confirmRef}
          type="button"
          data-merge-confirm-button
          disabled={flow.step === "merging"}
          onClick={() => void flow.confirm()}
          className={smallPrimary}
        >
          {flow.step === "merging" ? t("releases.merge.merging") : t("releases.merge.confirm")}
        </button>
        <button
          type="button"
          disabled={flow.step === "merging"}
          onClick={flow.cancel}
          className={smallSecondary}
        >
          {t("releases.merge.cancel")}
        </button>
      </div>
    </div>
  );
}
