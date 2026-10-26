import { Link } from "@tanstack/react-router";
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ancestorsAt, availableFields, scopeAt } from "../../../domain/automations/fields";
import { AUTOMATION_LIMITS } from "../../../domain/automations/fields";
import { useDepartments, usePeople, useProjects } from "../../../data/queries";
import type { Approval, ProjectTarget, Step } from "../../../data/types";
import { MenuGroup, itemClass } from "../../../tasks-ui/Menu";
import { MenuButton } from "../../tasks/controls";
import { CriticalGlyph, MoreGlyph, StepGlyph } from "../glyphs";
import { useAutomationPerms } from "../shared";
import { ClaudeForm } from "./ClaudeForm";
import { ConditionEditor } from "./ConditionEditor";
import { useBuilder } from "./context";
import { DataText, FieldError, tokenLabel } from "./DataText";
import { laneLabel } from "./FlowTree";
import { stepProblems, type FieldProblem } from "./issues";
import { templateRefs } from "../../../domain/automations/validate";
import { Field, Note, RadioRow, Section, Segmented, selectClass, smallInput } from "./controls";
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

/** Il problema di un campo, se c'è: id per `aria-describedby` e il paragrafo. */
export function useFieldProblem(problems: FieldProblem[], field: string) {
  const id = useId();
  const p = problems.find((x) => x.field === field);
  return {
    describedBy: p ? id : undefined,
    invalid: !!p,
    error: p ? <FieldError id={id}>{p.text}</FieldError> : null,
  };
}

interface FormProps {
  step: Step;
  path: string;
  set: (next: Partial<Step>) => void;
  problems: FieldProblem[];
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

type Of<K extends Step["kind"]> = Extract<Step, { kind: K }>;
type KindProps<K extends Step["kind"]> = Omit<FormProps, "step"> & { step: Of<K> };

/** Un campo con dati e il suo problema. */
function TextField({
  label,
  field,
  value,
  onChange,
  path,
  problems,
  required,
  multiline,
  rows,
  types,
}: {
  label: string;
  field: string;
  value: string;
  onChange: (v: string) => void;
  path: string;
  problems: FieldProblem[];
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  types?: Parameters<typeof DataText>[0]["types"];
}) {
  const id = useId();
  // Il problema del campo, e i dati che il campo cita e che qui non ci sono.
  const refs = templateRefs(value);
  const list = problems.filter(
    (x) => x.field === field || (x.ref !== undefined && refs.includes(x.ref)),
  );
  return (
    <Field label={label} required={required}>
      <DataText
        label={label}
        value={value}
        onChange={onChange}
        path={path}
        multiline={multiline}
        rows={rows}
        describedBy={list.length > 0 ? id : undefined}
        invalid={list.length > 0}
        types={types}
      />
      {list.length > 0 && (
        <div id={id}>
          {list.map((x, i) => (
            <FieldError key={i} id={`${id}-${i}`}>
              {x.text}
            </FieldError>
          ))}
        </div>
      )}
    </Field>
  );
}

function DueField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <Field label={t("automations.builder.panel.due")}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={t("automations.builder.panel.due")}
          value={value === null ? "none" : "days"}
          options={[
            { value: "none", label: t("automations.builder.panel.noDue") },
            { value: "days", label: t("automations.builder.panel.dueAfter") },
          ]}
          onChange={(v) => onChange(v === "none" ? null : 2)}
        />
        {value !== null && (
          <span className="flex items-center gap-1.5 text-sm text-ink-muted">
            <input
              id={id}
              type="number"
              min={0}
              aria-label={t("automations.builder.panel.dueDays")}
              className={`${smallInput} w-16`}
              value={value}
              onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
            />
            {t("automations.builder.panel.daysAfterCreated", { count: value })}
          </span>
        )}
      </div>
    </Field>
  );
}

function TaskForm({ step, path, set, problems }: KindProps<"createTask">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const people = usePeople().data ?? [];
  const departments = useDepartments().data ?? [];
  const who = useFieldProblem(problems, "assignee");
  const a = step.assignee;
  const mode =
    a === null || "personId" in a ? "person" : "departmentId" in a ? "department" : "role";
  const milestones = scopeAt(b.flow, path, b.sources).preceding.filter(
    (s) => s.kind === "createMilestone",
  );
  return (
    <Section title={t("automations.builder.panel.what")}>
      <TextField
        label={t("automations.builder.panel.title")}
        field="title"
        required
        value={step.title}
        onChange={(title) => set({ title })}
        path={path}
        problems={problems}
      />
      <TextField
        label={t("automations.builder.panel.description")}
        field="description"
        multiline
        rows={3}
        value={step.description}
        onChange={(description) => set({ description })}
        path={path}
        problems={problems}
      />
      <Field label={t("automations.builder.panel.whoDoesIt")} required>
        <Segmented
          label={t("automations.builder.panel.whoDoesIt")}
          value={mode}
          options={[
            { value: "person", label: t("automations.builder.panel.aPerson") },
            { value: "department", label: t("automations.builder.panel.aDepartment") },
            { value: "role", label: t("automations.builder.panel.aRole") },
          ]}
          onChange={(m) =>
            set({
              assignee:
                m === "person"
                  ? { personId: "" }
                  : m === "department"
                    ? { departmentId: "" }
                    : { projectRole: "project_lead" },
            })
          }
        />
        {mode === "person" && (
          <select
            aria-label={t("automations.builder.panel.aPerson")}
            aria-describedby={who.describedBy}
            aria-invalid={who.invalid || undefined}
            className={selectClass}
            value={a && "personId" in a ? a.personId : ""}
            onChange={(e) => set({ assignee: { personId: e.target.value } })}
          >
            <option value="" disabled>
              {t("automations.builder.panel.choosePerson")}
            </option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {mode === "department" && (
          <>
            <div
              role="radiogroup"
              aria-label={t("automations.builder.panel.aDepartment")}
              aria-describedby={who.describedBy}
              className="flex flex-col"
            >
              {departments.map((d) => {
                const on = a !== null && "departmentId" in a && a.departmentId === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ assignee: { departmentId: d.id } })}
                    className={`relative flex h-8 items-center rounded-md pl-4 text-left text-md ${on ? "bg-ink/10 font-medium text-ink" : "text-ink-muted hover:bg-ink/6 hover:text-ink"}`}
                  >
                    <span
                      aria-hidden="true"
                      className="absolute top-2 bottom-2 left-1 w-[3px] rounded-[1px]"
                      style={{ background: `var(${d.colorToken})` }}
                    />
                    {d.name}
                  </button>
                );
              })}
            </div>
            <Note>
              {t("automations.builder.panel.departmentNote", {
                name:
                  a && "departmentId" in a && a.departmentId
                    ? b.names.department(a.departmentId)
                    : "…",
              })}
            </Note>
          </>
        )}
        {mode === "role" && (
          <>
            <select
              aria-label={t("automations.builder.panel.aRole")}
              className={selectClass}
              value={a && "projectRole" in a ? a.projectRole : ""}
              onChange={(e) => set({ assignee: { projectRole: e.target.value } })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`automations.roles.${r}`)}
                </option>
              ))}
            </select>
            <Note>{t("automations.builder.panel.roleNote")}</Note>
          </>
        )}
        {who.error}
      </Field>
      <DueField value={step.dueInDays} onChange={(dueInDays) => set({ dueInDays })} />
      <Field label={t("automations.builder.panel.milestone")}>
        <select
          aria-label={t("automations.builder.panel.milestone")}
          className={selectClass}
          value={step.milestoneRef ?? ""}
          onChange={(e) => set({ milestoneRef: e.target.value || null })}
        >
          <option value="">{t("automations.builder.panel.noMilestone")}</option>
          {step.milestoneRef && !milestones.some((m) => m.id === step.milestoneRef) && (
            <option value={step.milestoneRef}>
              {t("automations.builder.panel.milestoneGone")}
            </option>
          )}
          {milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {t("automations.builder.panel.milestoneFrom", {
                n: b.numbers.get(b.paths.get(m.id) ?? ""),
              })}
            </option>
          ))}
        </select>
      </Field>
    </Section>
  );
}

const ROLES = ["project_lead", "developer", "contributor"];

function MilestoneForm({ step, path, set, problems }: KindProps<"createMilestone">) {
  const { t } = useTranslation();
  return (
    <Section title={t("automations.builder.panel.what")}>
      <TextField
        label={t("automations.builder.panel.name")}
        field="name"
        required
        value={step.name}
        onChange={(name) => set({ name })}
        path={path}
        problems={problems}
      />
      <DueField value={step.dueInDays} onChange={(dueInDays) => set({ dueInDays })} />
    </Section>
  );
}

function RequestForm({ step, path, set, problems }: KindProps<"createRequest">) {
  const { t } = useTranslation();
  return (
    <Section title={t("automations.builder.panel.what")}>
      <TextField
        label={t("automations.builder.panel.title")}
        field="title"
        required
        value={step.title}
        onChange={(title) => set({ title })}
        path={path}
        problems={problems}
      />
      <TextField
        label={t("automations.builder.panel.description")}
        field="description"
        multiline
        rows={3}
        value={step.description}
        onChange={(description) => set({ description })}
        path={path}
        problems={problems}
      />
    </Section>
  );
}

function EmailForm({ step, path, set, problems }: KindProps<"sendEmail">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const files = availableFields(b.flow, path, b.sources).filter((f) => f.type === "file");
  return (
    <Section title={t("automations.builder.panel.what")}>
      <TextField
        label={t("automations.builder.panel.to")}
        field="to"
        required
        value={step.to}
        onChange={(to) => set({ to })}
        path={path}
        problems={problems}
        types={["email", "person", "text"]}
      />
      <TextField
        label={t("automations.builder.panel.subject")}
        field="subject"
        required
        value={step.subject}
        onChange={(subject) => set({ subject })}
        path={path}
        problems={problems}
      />
      <TextField
        label={t("automations.builder.panel.body")}
        field="body"
        required
        multiline
        rows={8}
        value={step.body}
        onChange={(body) => set({ body })}
        path={path}
        problems={problems}
      />
      <Field label={t("automations.builder.panel.attachments")}>
        {files.length === 0 && step.attachRefs.length === 0 ? (
          <Note>{t("automations.builder.panel.noFiles")}</Note>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {[...new Set([...files.map((f) => f.key), ...step.attachRefs])].map((key) => {
              const on = step.attachRefs.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set({
                      attachRefs: on
                        ? step.attachRefs.filter((k) => k !== key)
                        : [...step.attachRefs, key],
                    })
                  }
                  className={`h-7 rounded-[4px] px-2 text-sm ${on ? "bg-ink/10 text-ink" : "border border-rule text-ink-muted hover:text-ink"}`}
                >
                  {tokenLabel(b.flow, key, b.labels)}
                </button>
              );
            })}
          </div>
        )}
      </Field>
      <Note>{t("automations.builder.panel.sentFromOwner")}</Note>
    </Section>
  );
}

function NotifyForm({ step, path, set, problems }: KindProps<"notify">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const who = useFieldProblem(problems, "who");
  const persons = availableFields(b.flow, path, b.sources).filter((f) => f.type === "person");
  const current = step.personRef.replace(/^\{\{\s*|\s*\}\}$/g, "");
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Field label={t("automations.builder.panel.notifyWho")} required>
        <select
          aria-label={t("automations.builder.panel.notifyWho")}
          aria-describedby={who.describedBy}
          aria-invalid={who.invalid || undefined}
          className={selectClass}
          value={current}
          onChange={(e) => set({ personRef: e.target.value })}
        >
          <option value="" disabled>
            {t("automations.builder.panel.choosePersonData")}
          </option>
          {current && !persons.some((p) => p.key === current) && (
            <option value={current}>{tokenLabel(b.flow, current, b.labels)}</option>
          )}
          {persons.map((p) => (
            <option key={p.key} value={p.key}>
              {tokenLabel(b.flow, p.key, b.labels)}
            </option>
          ))}
        </select>
        {persons.length === 0 && <Note>{t("automations.builder.panel.noPersonData")}</Note>}
        {who.error}
      </Field>
      <TextField
        label={t("automations.builder.panel.message")}
        field="message"
        required
        multiline
        rows={3}
        value={step.text}
        onChange={(text) => set({ text })}
        path={path}
        problems={problems}
      />
    </Section>
  );
}

function StartForm({ step, set, problems }: KindProps<"startAutomation">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const p = useFieldProblem(problems, "automation");
  const choices = b.otherAutomations.filter(
    (a) => a.status === "active" && a.id !== b.automation.id,
  );
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Field label={t("automations.builder.panel.whichAutomation")} required>
        <select
          aria-label={t("automations.builder.panel.whichAutomation")}
          aria-describedby={p.describedBy}
          aria-invalid={p.invalid || undefined}
          className={selectClass}
          value={step.automationId}
          onChange={(e) => set({ automationId: e.target.value })}
        >
          <option value="" disabled>
            {t("automations.builder.panel.chooseAutomation")}
          </option>
          {step.automationId && !choices.some((a) => a.id === step.automationId) && (
            <option value={step.automationId}>
              {b.otherAutomations.find((a) => a.id === step.automationId)?.code ??
                t("automations.steps.anAutomation")}
            </option>
          )}
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </select>
        {p.error}
      </Field>
      <Note>{t("automations.builder.panel.startNote")}</Note>
    </Section>
  );
}

function WaitForm({ step, path, set, problems }: KindProps<"wait">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const w = step.for;
  const mode = "days" in w ? "days" : "replyTo" in w ? "reply" : "task";
  const before = scopeAt(b.flow, path, b.sources).preceding;
  const emails = before.filter((s) => s.kind === "sendEmail");
  const tasks = before.filter((s) => s.kind === "createTask");
  const ref = useFieldProblem(problems, mode === "reply" ? "replyTo" : "taskClosed");
  const days = useFieldProblem(problems, mode === "days" ? "days" : "maxDays");
  const refId = "replyTo" in w ? w.replyTo : "taskClosed" in w ? w.taskClosed : "";
  const options = mode === "reply" ? emails : tasks;
  const num = (id: string) => b.numbers.get(b.paths.get(id) ?? "");
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Segmented
        label={t("automations.builder.panel.waitFor")}
        value={mode}
        options={[
          { value: "days", label: t("automations.builder.panel.someTime") },
          { value: "reply", label: t("automations.builder.panel.aReply") },
          { value: "task", label: t("automations.builder.panel.aTask") },
        ]}
        onChange={(m) =>
          set({
            for:
              m === "days"
                ? { days: 3 }
                : m === "reply"
                  ? { replyTo: emails.at(-1)?.id ?? "", maxDays: 5 }
                  : { taskClosed: tasks.at(-1)?.id ?? "", maxDays: 5 },
          })
        }
      />
      {mode !== "days" && (
        <Field
          label={
            mode === "reply"
              ? t("automations.builder.panel.replyTo")
              : t("automations.builder.panel.taskToClose")
          }
          required
        >
          <select
            aria-label={
              mode === "reply"
                ? t("automations.builder.panel.replyTo")
                : t("automations.builder.panel.taskToClose")
            }
            aria-describedby={ref.describedBy}
            aria-invalid={ref.invalid || undefined}
            className={selectClass}
            value={refId}
            onChange={(e) =>
              set({
                for:
                  mode === "reply"
                    ? { replyTo: e.target.value, maxDays: (w as { maxDays: number }).maxDays }
                    : { taskClosed: e.target.value, maxDays: (w as { maxDays: number }).maxDays },
              })
            }
          >
            <option value="" disabled>
              {t("automations.builder.panel.chooseStep")}
            </option>
            {refId && !options.some((s) => s.id === refId) && (
              <option value={refId}>
                {t("automations.builder.panel.stepNotBefore", { n: num(refId) ?? "" })}
              </option>
            )}
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {mode === "reply"
                  ? t("automations.builder.panel.emailFrom", { n: num(s.id) })
                  : t("automations.builder.panel.taskFrom", { n: num(s.id) })}
              </option>
            ))}
          </select>
          {options.length === 0 && (
            <Note>
              {mode === "reply"
                ? t("automations.builder.panel.noEmailBefore")
                : t("automations.builder.panel.noTaskBefore")}
            </Note>
          )}
          {ref.error}
        </Field>
      )}
      <Field
        label={
          mode === "days"
            ? t("automations.builder.panel.howLong")
            : t("automations.builder.panel.stopAfter")
        }
        required
      >
        <span className="flex items-center gap-1.5 text-sm text-ink-muted">
          <input
            type="number"
            min={1}
            aria-label={
              mode === "days"
                ? t("automations.builder.panel.howLong")
                : t("automations.builder.panel.stopAfter")
            }
            aria-describedby={days.describedBy}
            aria-invalid={days.invalid || undefined}
            className={`${smallInput} w-16`}
            value={"days" in w ? w.days : w.maxDays}
            onChange={(e) => {
              const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
              set({ for: "days" in w ? { days: v } : { ...w, maxDays: v } });
            }}
          />
          {t("automations.builder.panel.daysWord", { count: "days" in w ? w.days : w.maxDays })}
        </span>
        {days.error}
      </Field>
      {mode === "reply" && <Note>{t("automations.builder.panel.replyData")}</Note>}
    </Section>
  );
}

function ConditionForm({ step, path, set, problems }: KindProps<"condition">) {
  const { t } = useTranslation();
  const p = useFieldProblem(problems, "condition");
  return (
    <Section title={t("automations.builder.panel.when")}>
      <ConditionEditor
        value={step.when}
        onChange={(when) => set({ when })}
        path={path}
        label={t("automations.builder.panel.when")}
        describedBy={p.describedBy}
      />
      {p.error}
      <Note>{t("automations.builder.panel.conditionNote")}</Note>
    </Section>
  );
}

function ForEachForm({ step, path, set, problems }: KindProps<"forEach">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const listP = useFieldProblem(problems, "list");
  const asP = useFieldProblem(problems, "as");
  const lists = availableFields(b.flow, path, b.sources).filter((f) => f.type === "list");
  const asId = useId();
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Field label={t("automations.builder.panel.list")} required>
        <select
          aria-label={t("automations.builder.panel.list")}
          aria-describedby={listP.describedBy}
          aria-invalid={listP.invalid || undefined}
          className={selectClass}
          value={step.list}
          onChange={(e) => {
            const f = lists.find((x) => x.key === e.target.value);
            set({ list: e.target.value, as: step.as || singular(f?.label ?? "") });
          }}
        >
          <option value="" disabled>
            {t("automations.builder.panel.chooseList")}
          </option>
          {step.list && !lists.some((l) => l.key === step.list) && (
            <option value={step.list}>{tokenLabel(b.flow, step.list, b.labels)}</option>
          )}
          {lists.map((l) => (
            <option key={l.key} value={l.key}>
              {tokenLabel(b.flow, l.key, b.labels)}
            </option>
          ))}
        </select>
        {lists.length === 0 && <Note>{t("automations.builder.panel.noLists")}</Note>}
        {listP.error}
      </Field>
      <Field label={t("automations.builder.panel.callEach")} required htmlFor={asId}>
        <input
          id={asId}
          className={`${smallInput} w-48`}
          aria-describedby={asP.describedBy}
          aria-invalid={asP.invalid || undefined}
          value={step.as}
          onChange={(e) => set({ as: e.target.value.replace(/[./]/g, "") })}
        />
        {asP.error}
      </Field>
      <Note>
        {t("automations.builder.panel.forEachNote", { count: AUTOMATION_LIMITS.forEachRounds })}
      </Note>
    </Section>
  );
}

/** Il nome dell'elemento precompilato dall'etichetta dell'elenco («Task di attivazione» → «task»). */
function singular(label: string): string {
  const first = label.trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/[./]/g, "").replace(/s$/, "");
}

function RepeatForm({ step, path, set, problems }: KindProps<"repeatUntil">) {
  const { t } = useTranslation();
  const until = useFieldProblem(problems, "until");
  const max = useFieldProblem(problems, "max");
  const id = useId();
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Field label={t("automations.builder.panel.until")} required>
        <ConditionEditor
          value={step.until}
          onChange={(u) => set({ until: u })}
          path={path}
          label={t("automations.builder.panel.until")}
          describedBy={until.describedBy}
        />
        {until.error}
      </Field>
      <Field label={t("automations.builder.panel.atMost")} required htmlFor={id}>
        <span className="flex items-center gap-1.5 text-sm text-ink-muted">
          <input
            id={id}
            type="number"
            min={1}
            max={AUTOMATION_LIMITS.repeatMax}
            aria-describedby={max.describedBy}
            aria-invalid={max.invalid || undefined}
            className={`${smallInput} w-16`}
            value={step.max}
            onChange={(e) => set({ max: Math.floor(Number(e.target.value) || 0) })}
          />
          {t("automations.builder.panel.timesWord", { count: step.max })}
        </span>
        {max.error}
      </Field>
      <Note>{t("automations.builder.panel.repeatNote")}</Note>
    </Section>
  );
}

function WhereSection({ step, path, set, problems }: FormProps) {
  const { t } = useTranslation();
  const b = useBuilder();
  const perms = useAutomationPerms();
  const projects = useProjects().data ?? [];
  const target = (step as { project: ProjectTarget }).project;
  const own = b.automation.projectId;
  const ownCode = b.names.project(own)?.code;
  const kind = step.kind as "createTask" | "createMilestone" | "createRequest";
  const client = useFieldProblem(problems, "client");
  const fixed = useFieldProblem(problems, "project");
  const where = useFieldProblem(problems, "where");
  const keys = availableFields(b.flow, path, b.sources).filter(
    (f) => f.type === "text" || f.type === "email",
  );
  const allowed = projects
    .filter((p) => perms.canCreate(kind, p.id))
    .sort((a, c) => a.code.localeCompare(c.code));
  const options = [
    ...(own
      ? [
          {
            value: "own" as const,
            label: t("automations.builder.where.own", { code: ownCode ?? "" }),
          },
        ]
      : []),
    { value: "from_client" as const, label: t("automations.builder.where.client") },
    { value: "fixed" as const, label: t("automations.builder.where.fixed") },
  ];
  return (
    <Section title={t("automations.builder.where.title")}>
      <Segmented
        label={t("automations.builder.where.title")}
        value={target.mode}
        options={options}
        onChange={(m) =>
          set({
            project:
              m === "own"
                ? { mode: "own" }
                : m === "fixed"
                  ? { mode: "fixed", projectId: "" }
                  : { mode: "from_client", clientRef: "" },
          } as Partial<Step>)
        }
      />
      {where.error}
      {target.mode === "from_client" && (
        <>
          <Field label={t("automations.builder.where.clientData")} required>
            <select
              aria-label={t("automations.builder.where.clientData")}
              aria-describedby={client.describedBy}
              aria-invalid={client.invalid || undefined}
              className={selectClass}
              value={target.clientRef}
              onChange={(e) =>
                set({
                  project: { mode: "from_client", clientRef: e.target.value },
                } as Partial<Step>)
              }
            >
              <option value="" disabled>
                {t("automations.builder.where.chooseClientData")}
              </option>
              {keys.map((f) => (
                <option key={f.key} value={f.key}>
                  {tokenLabel(b.flow, f.key, b.labels)}
                </option>
              ))}
            </select>
            {client.error}
          </Field>
          <Note>
            {t("automations.builder.where.clientNote")}{" "}
            <Link to="/automations/sources" className="text-ink underline underline-offset-4">
              {t("automations.builder.where.clientTable")}
            </Link>
          </Note>
        </>
      )}
      {target.mode === "fixed" && (
        <Field label={t("automations.builder.where.project")} required>
          <select
            aria-label={t("automations.builder.where.project")}
            aria-describedby={fixed.describedBy}
            aria-invalid={fixed.invalid || undefined}
            className={selectClass}
            value={target.projectId}
            onChange={(e) =>
              set({ project: { mode: "fixed", projectId: e.target.value } } as Partial<Step>)
            }
          >
            <option value="" disabled>
              {t("automations.builder.where.chooseProject")}
            </option>
            {target.projectId && !allowed.some((p) => p.id === target.projectId) && (
              <option value={target.projectId}>
                {b.names.project(target.projectId)?.code ?? t("automations.steps.inHiddenProject")}
              </option>
            )}
            {allowed.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          {fixed.error}
        </Field>
      )}
    </Section>
  );
}

function ApprovalSection({ step, set, problems }: Omit<FormProps, "path">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const people = usePeople().data ?? [];
  const approval = (step as { approval: Approval }).approval;
  const p = useFieldProblem(problems, "approver");
  const ask = approval.mode === "ask" ? approval.who : null;
  const whoMode = !ask ? "owner" : "owner" in ask ? "owner" : "personId" in ask ? "person" : "role";
  const fromClient = "project" in step && step.project.mode === "from_client";
  const whoWords = !ask
    ? ""
    : "owner" in ask
      ? t("automations.builder.asks.theOwner")
      : "personId" in ask
        ? ask.personId
          ? b.names.person(ask.personId)
          : "…"
        : t(`automations.roles.${ask.projectRole}`, { defaultValue: ask.projectRole });
  return (
    <Section title={t("automations.builder.approval.title")}>
      <div
        role="radiogroup"
        aria-label={t("automations.builder.approval.title")}
        className="flex flex-col gap-2"
      >
        <RadioRow
          checked={approval.mode === "auto"}
          label={t("automations.builder.approval.auto")}
          body={t("automations.builder.approval.autoBody")}
          onSelect={() => set({ approval: { mode: "auto" } } as Partial<Step>)}
          disabled={b.readOnly}
        />
        <RadioRow
          checked={approval.mode === "ask"}
          label={t("automations.builder.approval.ask")}
          body={t("automations.builder.approval.askBody", {
            who: whoWords || t("automations.builder.asks.someone"),
          })}
          onSelect={() =>
            approval.mode !== "ask" &&
            set({ approval: { mode: "ask", who: { owner: true } } } as Partial<Step>)
          }
          disabled={b.readOnly}
        >
          <Field label={t("automations.builder.approval.who")}>
            <Segmented
              label={t("automations.builder.approval.who")}
              value={whoMode}
              options={[
                { value: "person", label: t("automations.builder.approval.person") },
                { value: "role", label: t("automations.builder.approval.role") },
                { value: "owner", label: t("automations.builder.approval.owner") },
              ]}
              onChange={(m) =>
                set({
                  approval: {
                    mode: "ask",
                    who:
                      m === "owner"
                        ? { owner: true }
                        : m === "person"
                          ? { personId: "" }
                          : { projectRole: "project_lead" },
                  },
                } as Partial<Step>)
              }
              disabled={b.readOnly}
            />
            {whoMode === "person" && (
              <select
                aria-label={t("automations.builder.approval.person")}
                aria-describedby={p.describedBy}
                aria-invalid={p.invalid || undefined}
                className={selectClass}
                value={ask && "personId" in ask ? ask.personId : ""}
                onChange={(e) =>
                  set({
                    approval: { mode: "ask", who: { personId: e.target.value } },
                  } as Partial<Step>)
                }
              >
                <option value="" disabled>
                  {t("automations.builder.panel.choosePerson")}
                </option>
                {people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
            {whoMode === "role" && (
              <select
                aria-label={t("automations.builder.approval.role")}
                className={selectClass}
                value={ask && "projectRole" in ask ? ask.projectRole : "project_lead"}
                onChange={(e) =>
                  set({
                    approval: { mode: "ask", who: { projectRole: e.target.value } },
                  } as Partial<Step>)
                }
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`automations.roles.${r}`)}
                  </option>
                ))}
              </select>
            )}
            {p.error}
            {fromClient && <Note>{t("automations.builder.approval.clientCheck")}</Note>}
          </Field>
        </RadioRow>
      </div>
    </Section>
  );
}

export type { ReactNode };
