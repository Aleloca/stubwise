import { useTranslation } from "react-i18next";
import { availableFields, scopeAt } from "../../../domain/automations/fields";
import { useDepartments } from "../../../data/queries";
import { useBuilder } from "./context";
import { Field, Note, Section, Segmented, selectClass } from "./controls";
import { tokenLabel } from "./DataText";
import {
  DueField,
  PersonPicker,
  ROLES,
  TextField,
  useFieldProblem,
  type KindProps,
} from "./stepFields";

// I moduli dei passi che fanno qualcosa (shape builder §6): task, traguardo,
// richiesta, email, avviso, avvio di un'altra automazione.

export function TaskForm({ step, path, set, problems }: KindProps<"createTask">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const departments = useDepartments().data ?? [];
  const who = useFieldProblem(problems, "assignee");
  const a = step.assignee;
  const mode =
    a === null || "personId" in a || "personRef" in a
      ? "person"
      : "departmentId" in a
        ? "department"
        : "role";
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
          <PersonPicker
            label={t("automations.builder.panel.aPerson")}
            describedBy={who.describedBy}
            invalid={who.invalid}
            path={path}
            value={a && ("personId" in a || "personRef" in a) ? a : { personId: "" }}
            onChange={(assignee) => set({ assignee })}
          />
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

export function MilestoneForm({ step, path, set, problems }: KindProps<"createMilestone">) {
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

export function RequestForm({ step, path, set, problems }: KindProps<"createRequest">) {
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

export function EmailForm({ step, path, set, problems }: KindProps<"sendEmail">) {
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

export function NotifyForm({ step, path, set, problems }: KindProps<"notify">) {
  const { t } = useTranslation();
  const who = useFieldProblem(problems, "who");
  const w = step.who;
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Field label={t("automations.builder.panel.notifyWho")} required>
        <Segmented
          label={t("automations.builder.panel.notifyWho")}
          value={"projectRole" in w ? "role" : "person"}
          options={[
            { value: "person", label: t("automations.builder.panel.aPerson") },
            { value: "role", label: t("automations.builder.panel.aRole") },
          ]}
          onChange={(m) =>
            set({ who: m === "role" ? { projectRole: "project_lead" } : { personId: "" } })
          }
        />
        {"projectRole" in w ? (
          <>
            <select
              aria-label={t("automations.builder.panel.aRole")}
              className={selectClass}
              value={w.projectRole}
              onChange={(e) => set({ who: { projectRole: e.target.value } })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`automations.roles.${r}`)}
                </option>
              ))}
            </select>
            <Note>{t("automations.builder.panel.notifyRoleNote")}</Note>
          </>
        ) : (
          <PersonPicker
            label={t("automations.builder.panel.notifyWho")}
            describedBy={who.describedBy}
            invalid={who.invalid}
            path={path}
            value={w}
            onChange={(v) => set({ who: v })}
          />
        )}
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

export function StartForm({ step, set, problems }: KindProps<"startAutomation">) {
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
