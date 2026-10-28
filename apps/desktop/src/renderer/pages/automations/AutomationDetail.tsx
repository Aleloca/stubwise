import { useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAutomation } from "../../data/queries";
import { useToast } from "../../tasks-ui/Toast";
import { secondaryButton } from "../tasks/controls";
import {
  DeleteDraftDialog,
  DuplicateDialog,
  PauseDialog,
  RunNowDialog,
  TurnOnDialog,
} from "./AutomationDialogs";
import { Header } from "./DetailHeader";
import {
  AboutSection,
  HowItWorks,
  ProblemsSection,
  RunsSection,
  VersionsSection,
} from "./DetailSections";

// Il dettaglio di un'automazione (shape automations.md §6): una colonna di
// lettura fino a 960 px — testata con la riga di stato in prosa e le azioni,
// «Problems» (solo se ce ne sono), «Runs» (prima del riassunto, [A 8]),
// «How it works», «Versions», «About». Ogni sezione tiene i suoi stati.
//
// La testata sta in `DetailHeader.tsx`, le sezioni in `DetailSections.tsx`.

export function AutomationDetail({ automationId }: { automationId: string }) {
  const { t } = useTranslation();
  const query = useAutomation(automationId);
  const toast = useToast();
  const [dialog, setDialog] = useState<"on" | "pause" | "delete" | "run" | "duplicate" | null>(
    null,
  );
  const [duplicateVersion, setDuplicateVersion] = useState<number | undefined>(undefined);
  const [viewing, setViewing] = useState<number | null>(null);
  const problems = useRef<HTMLElement>(null);
  const detail = query.data;
  const search = useSearch({ strict: false }) as { problems?: string };
  // `?problems=1` (dall'elenco, «Turn on» con problemi): alla sezione Problems.
  const hasDetail = detail !== undefined;
  useEffect(() => {
    if (!hasDetail || search.problems !== "1") return;
    problems.current?.scrollIntoView?.({ block: "start" });
    problems.current?.focus();
  }, [hasDetail, search.problems]);
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 px-8 py-10">
        <p className="text-md text-ink">{t("automations.errors.loadOne")}</p>
        <button type="button" className={secondaryButton} onClick={() => void query.refetch()}>
          {t("automations.actions.retry")}
        </button>
      </div>
    );
  }
  if (!detail) return <DetailSkeleton />;
  const a = detail.automation;
  const turnOn = () => {
    const issues = a.status === "paused" ? detail.liveErrors : detail.configErrors;
    if (issues.length > 0) {
      problems.current?.scrollIntoView({ block: "start" });
      problems.current?.focus();
      toast.error(t("automations.toast.fixFirst", { count: issues.length }));
      return;
    }
    setDialog("on");
  };
  const duplicateOf = (n: number) => {
    setDuplicateVersion(n);
    setDialog("duplicate");
  };
  return (
    <article className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[960px] flex-col pr-8">
        <Header
          detail={detail}
          onTurnOn={turnOn}
          onPause={() => setDialog("pause")}
          onDelete={() => setDialog("delete")}
          onRunNow={() => setDialog("run")}
          onDuplicate={() => {
            setDuplicateVersion(undefined);
            setDialog("duplicate");
          }}
        />
        <ProblemsSection detail={detail} focusRef={problems} />
        {a.status === "draft" ? (
          <>
            <HowItWorks
              detail={detail}
              viewing={viewing}
              onBack={() => setViewing(null)}
              onDuplicate={duplicateOf}
            />
            <RunsSection detail={detail} />
          </>
        ) : (
          <>
            <RunsSection detail={detail} />
            <HowItWorks
              detail={detail}
              viewing={viewing}
              onBack={() => setViewing(null)}
              onDuplicate={duplicateOf}
            />
          </>
        )}
        <VersionsSection detail={detail} viewing={viewing} onView={setViewing} />
        <AboutSection detail={detail} />
      </div>
      {dialog === "on" && <TurnOnDialog automationId={a.id} onClose={() => setDialog(null)} />}
      {dialog === "pause" && <PauseDialog automationId={a.id} onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <DeleteDraftDialog automationId={a.id} onClose={() => setDialog(null)} />
      )}
      {dialog === "run" && <RunNowDialog automationId={a.id} onClose={() => setDialog(null)} />}
      {dialog === "duplicate" && (
        <DuplicateDialog
          automationId={a.id}
          version={duplicateVersion}
          onClose={() => setDialog(null)}
        />
      )}
    </article>
  );
}

/** Lo scheletro del dettaglio: intestazione e quattro righe. */
export function DetailSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div
      aria-busy="true"
      className="skeleton-breathe flex max-w-[960px] flex-col gap-3 py-8 pr-8 pl-8"
    >
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className={`h-3 w-24 ${bar}`} />
      <span className={`h-7 w-96 ${bar}`} />
      <span className={`h-3 w-72 ${bar}`} />
      <div className="mt-6 flex flex-col border-t border-rule">
        {[62, 48, 71, 40].map((w) => (
          <span key={w} className="flex h-10 items-center border-b border-rule">
            <span className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} />
          </span>
        ))}
      </div>
    </div>
  );
}
