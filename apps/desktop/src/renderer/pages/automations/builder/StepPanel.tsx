import { useTranslation } from "react-i18next";
import { ancestorsAt } from "../../../domain/automations/fields";
import { templateRefs } from "../../../domain/automations/validate";
import type { Step } from "../../../data/types";
import { MenuGroup, itemClass } from "../../../tasks-ui/Menu";
import { MenuButton } from "../../tasks/controls";
import { CriticalGlyph, MoreGlyph, StepGlyph } from "../glyphs";
import {
  EmailForm,
  MilestoneForm,
  NotifyForm,
  RequestForm,
  StartForm,
  TaskForm,
} from "./ActionForms";
import { ClaudeForm } from "./ClaudeForm";
import { useBuilder } from "./context";
import { laneLabel } from "./flowWords";
import { ConditionForm, ForEachForm, RepeatForm, WaitForm } from "./FlowForms";
import { stepProblems } from "./issues";
import { type FormProps } from "./stepFields";
import { ApprovalSection, WhereSection } from "./StepSections";
import { laneDepth, placeOf, replaceAt } from "./tree";

// Il pannello del passo selezionato (shape builder §6): testata «Step 7 ·
// Send an email», il percorso oltre il terzo livello ([A 7]), «⋯»
// (Duplicate · Move to… · Delete); poi, dall'alto, cosa fa → dove → prima
// di partire (approvazione). Ogni modifica si vede subito nella frase della
// riga. Ogni problema sta sotto il suo campo (`aria-describedby`).

export type Patch<S extends Step> = (next: Partial<S>) => void;

export function StepPanel({ step, path }: { step: Step; path: string }) {
  const { t } = useTranslation();
  const b = useBuilder();
  const n = b.numbers.get(path) ?? 0;
  const depth = laneDepth(placeOf(path).lane);
  const general = b.automation.projectId === null;
  const problems = stepProblems(
    b.issues.byStep.get(step.id) ?? [],
    b.flow,
    path,
    step,
    {
      general,
      names: b.names,
      ownerId: b.automation.ownerId,
      projectCode: b.names.project(b.automation.projectId)?.code ?? null,
      sources: b.sources,
      labels: b.labels,
    },
    t,
  );
  const set = (next: Partial<Step>) =>
    b.update((f) => ({ ...f, steps: replaceAt(f.steps, path, { ...step, ...next } as Step) }));
  const ancestors = ancestorsAt(b.flow.steps, path);
  const segs = path.split("/");
  const trail = ancestors.map((a, i) => laneLabel(a, segs[i * 2 + 1]!, b, t));
  // In testa i problemi che non stanno sotto un campo: un dato citato in un
  // testo del passo sta sotto quel testo.
  const inText = new Set(
    Object.values(step).flatMap((v) => (typeof v === "string" ? templateRefs(v) : [])),
  );
  const general_ = problems.filter(
    (p) =>
      (p.field === "data" && !(p.ref !== undefined && inText.has(p.ref))) ||
      p.field === "step" ||
      p.field === "stepRef",
  );

  return (
    <div data-step-panel={step.id} className="flex flex-col pb-10">
      <header className="flex flex-col gap-1 px-5 pt-5 pb-4">
        {depth > 3 && (
          <p data-step-trail className="text-xs text-ink-muted">
            {t("automations.builder.panel.inside", { trail: trail.join(" › ") })}
          </p>
        )}
        <div className="flex items-center gap-2">
          <StepGlyph kind={step.kind} />
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-ink">
            <span className="num">{t("automations.builder.stepN", { n })}</span>
            <span className="font-normal text-ink-muted">
              {" "}
              · {t(`automations.builder.kind.${step.kind}`)}
            </span>
          </h2>
          {!b.readOnly && (
            <MenuButton
              ariaLabel={t("automations.builder.rowMenu", { n })}
              menuLabel={t("automations.builder.rowMenu", { n })}
              align="right"
              label={<MoreGlyph />}
              className="grid size-8 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
            >
              {(close) => (
                <MenuGroup>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => (close(), b.duplicate(step.id))}
                  >
                    {t("automations.builder.menu.duplicate")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => (close(), b.requestMoveTo(step.id))}
                  >
                    {t("automations.builder.menu.moveTo")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={`${itemClass} text-critical`}
                    onClick={() => (close(), b.requestDelete(step.id))}
                  >
                    {t("automations.builder.menu.delete")}
                  </button>
                </MenuGroup>
              )}
            </MenuButton>
          )}
        </div>
        {general_.length > 0 && (
          <ul
            aria-label={t("automations.builder.panel.problems")}
            className="flex flex-col gap-1 pt-2"
          >
            {general_.map((p, i) => (
              <li key={i} className="flex items-start gap-1.5 text-sm text-critical">
                <CriticalGlyph />
                {p.text}
              </li>
            ))}
          </ul>
        )}
      </header>
      <fieldset disabled={b.readOnly} className="contents">
        <Form step={step} path={path} set={set} problems={problems} />
        {"project" in step && (
          <WhereSection step={step} path={path} set={set} problems={problems} />
        )}
        {"approval" in step && <ApprovalSection step={step} set={set} problems={problems} />}
      </fieldset>
    </div>
  );
}

function Form(props: FormProps) {
  const { step } = props;
  switch (step.kind) {
    case "createTask":
      return <TaskForm {...props} step={step} />;
    case "createMilestone":
      return <MilestoneForm {...props} step={step} />;
    case "createRequest":
      return <RequestForm {...props} step={step} />;
    case "sendEmail":
      return <EmailForm {...props} step={step} />;
    case "notify":
      return <NotifyForm {...props} step={step} />;
    case "startAutomation":
      return <StartForm {...props} step={step} />;
    case "wait":
      return <WaitForm {...props} step={step} />;
    case "claude":
      return <ClaudeForm {...props} step={step} />;
    case "condition":
      return <ConditionForm {...props} step={step} />;
    case "forEach":
      return <ForEachForm {...props} step={step} />;
    case "repeatUntil":
      return <RepeatForm {...props} step={step} />;
  }
}
