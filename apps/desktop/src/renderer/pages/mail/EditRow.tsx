import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Person, ProposedAction, Task } from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { quietButton, secondaryButton } from "../claude/conversation/parts";
import type { Args } from "./proposalText";

/** La riga aperta in un piccolo modulo dentro la scheda (A13). */
export function EditRow({
  action,
  args,
  code,
  members,
  people,
  tasks,
  projectId,
  focus,
  onDone,
  onReset,
  onCancel,
}: {
  action: ProposedAction;
  args: Args;
  code: string;
  members: ReadonlySet<string>;
  people: readonly Person[];
  tasks: readonly Task[];
  projectId: string;
  focus?: "assignee" | undefined;
  onDone: (edit: Args) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Args>(() =>
    action.fn === "updateTask" ? { ...((args.patch as Args) ?? {}) } : { ...args },
  );
  const first = useRef<HTMLElement | null>(null);
  const assignee = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    (focus === "assignee" ? assignee.current : first.current)?.focus();
  }, [focus]);
  const set = (key: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const id = useId();
  const field = (key: string, label: string, control: ReactNode) => (
    <label key={key} htmlFor={`${id}-${key}`} className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
      {label}
      {control}
    </label>
  );
  const text = (key: string, label: string, multiline = false) =>
    field(
      key,
      label,
      multiline ? (
        <textarea
          id={`${id}-${key}`}
          ref={(el) => {
            if (!first.current) first.current = el;
          }}
          rows={3}
          value={(values[key] as string | undefined) ?? ""}
          onChange={set(key)}
          className={`${inputClass} h-auto py-1.5`}
        />
      ) : (
        <input
          id={`${id}-${key}`}
          ref={(el) => {
            if (!first.current) first.current = el;
          }}
          value={(values[key] as string | undefined) ?? ""}
          onChange={set(key)}
          className={inputClass}
        />
      ),
    );
  const date = (key: string, label: string) =>
    field(
      key,
      label,
      <input
        id={`${id}-${key}`}
        type="date"
        value={((values[key] as string | null | undefined) ?? "").slice(0, 10)}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value || null }))}
        className={inputClass}
      />,
    );
  const inProject = people.filter((x) => members.has(x.id) && !x.isClaude);
  const outside = people.filter((x) => !members.has(x.id) && !x.isClaude);
  const assigneeField = () =>
    field(
      "assigneeId",
      t("mail.proposal.fields.assignee"),
      <select
        id={`${id}-assigneeId`}
        ref={assignee}
        value={(values.assigneeId as string | null | undefined) ?? ""}
        onChange={(e) => setValues((v) => ({ ...v, assigneeId: e.target.value || null }))}
        className={inputClass}
      >
        <option value="">{t("mail.proposal.unassigned")}</option>
        <optgroup label={t("mail.proposal.fields.inProject", { code })}>
          {inProject.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("mail.proposal.fields.outsideProject", { code })}>
          {outside.map((x) => (
            <option key={x.id} value={x.id}>
              {`${x.name} · ${t("mail.proposal.notIn", { code })}`}
            </option>
          ))}
        </optgroup>
      </select>,
    );

  let fields: ReactNode[] = [];
  switch (action.fn) {
    case "createTask":
      fields = [
        text("title", t("mail.proposal.fields.title")),
        text("description", t("mail.proposal.fields.description"), true),
        assigneeField(),
        date("dueDate", t("mail.proposal.fields.dueDate")),
      ];
      break;
    case "createRequest":
      fields = [text("title", t("mail.proposal.fields.title")), text("description", t("mail.proposal.fields.description"), true)];
      break;
    case "updateTask":
      fields = [
        field(
          "task",
          t("mail.proposal.fields.task"),
          <select id={`${id}-task`} disabled value={args.id as string} className={inputClass}>
            {tasks
              .filter((x) => x.projectId === projectId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {`${x.code} ${x.title}`}
                </option>
              ))}
          </select>,
        ),
        ...("dueDate" in values ? [date("dueDate", t("mail.proposal.fields.dueDate"))] : []),
        ...("assigneeId" in values ? [assigneeField()] : []),
      ];
      break;
    case "addComment":
      fields = [text("body", t("mail.proposal.fields.comment"), true)];
      break;
    case "createMilestone":
      fields = [text("name", t("mail.proposal.fields.name")), date("dueDate", t("mail.proposal.fields.date"))];
      break;
  }

  const done = () => {
    const keys = Object.keys(values).filter((k) => !["projectId", "id", "taskId", "source"].includes(k));
    if (action.fn === "updateTask") onDone({ patch: values });
    else onDone(Object.fromEntries(keys.map((k) => [k, values[k]])));
  };

  return (
    <div
      className="flex flex-col gap-2.5 rounded-md bg-ink/4 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {fields}
      <div className="flex items-center justify-end gap-2">
        <button type="button" className={quietButton} onClick={onReset}>
          {t("mail.proposal.reset")}
        </button>
        <button type="button" className={secondaryButton} onClick={done}>
          {t("mail.proposal.done")}
        </button>
      </div>
    </div>
  );
}
