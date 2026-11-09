import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { AutomationDecision } from "../../../data/types";
import { relativeTime } from "../../../notifications/time";
import { ApprovalBox, ChooseProject, str } from "../../automations/RunDecisions";
import { useNames } from "../../automations/shared";

const linkClass =
  "rounded-sm text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink";

/**
 * Un passo di un'automazione che aspetta me in «Da decidere» (shape
 * automations.md §6): la riga d'origine (automazione ed esecuzione, coi
 * link; senza nome né link all'automazione se non la vedo), la domanda in
 * una frase, l'anteprima condivisa (l'email chiusa alle prime righe) e
 * Reject · Edit · Approve — oppure, per il proprietario, «scegli il
 * progetto». Ogni risposta segue la finestra dell'«Undo».
 */
export function AutomationDecisionItem({ decision }: { decision: AutomationDecision }) {
  const { t, i18n } = useTranslation();
  const names = useNames();
  const d = decision;
  const project = d.projectId ? names.project(d.projectId) : null;
  const projectWords = project?.code ?? t("automations.test.preview.hiddenProject");
  const question =
    d.kind === "project"
      ? d.clientName
        ? t("automations.now.whichProject", { client: d.clientName })
        : t("automations.decide.whichProjectNoClient")
      : t(`automations.decide.ask.${d.stepKind}`, {
          defaultValue: t("automations.decide.ask.other"),
          to: str(d.preview.to),
          project: projectWords,
          name: d.preview.persona ? names.person(str(d.preview.persona)) : "",
        });
  const run = { code: d.automationCode, n: String(d.n) };
  return (
    <div
      data-automation-decision={d.runId}
      className="flex flex-col gap-2 border-b border-rule py-3 pr-3 pl-4"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-ink-muted">
        <span>{t("automations.decide.from")}</span>
        {d.automationVisible ? (
          <Link to="/automations/$code" params={{ code: d.automationCode }} className={linkClass}>
            <span className="num font-semibold text-ink">{d.automationCode}</span>{" "}
            {d.automationName}
          </Link>
        ) : (
          <span className="num font-semibold text-ink">{d.automationCode}</span>
        )}
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <Link to="/automations/$code/runs/$n" params={run} className={linkClass}>
          {t("automations.decide.run", { n: d.n })}
        </Link>
        {project && (
          <>
            <span aria-hidden="true" className="text-ink-faint">
              ·
            </span>
            <span className="num text-xs font-semibold tracking-[0.02em] text-ink">
              {project.code}
            </span>
          </>
        )}
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <span className="num text-ink-faint">{relativeTime(d.since, t, i18n.language)}</span>
      </div>
      <p className="max-w-[72ch] text-lg font-medium text-ink [overflow-wrap:anywhere]">
        {question}
      </p>
      <div className="flex max-w-[72ch] flex-col gap-2.5">
        {d.kind === "project" ? (
          <ChooseProject
            key={`${d.runId}:${d.cursor}`}
            runId={d.runId}
            cursor={d.cursor}
            code={d.code}
            client={d.clientName}
            label={t("automations.decide.project")}
          />
        ) : (
          <ApprovalBox
            key={`${d.runId}:${d.cursor}`}
            runId={d.runId}
            cursor={d.cursor}
            code={d.code}
            stepKind={d.stepKind}
            preview={d.preview}
            effect={d.effect}
            names={names}
            projectId={d.projectId}
            from={null}
            canDecide
            compact
          />
        )}
      </div>
    </div>
  );
}
