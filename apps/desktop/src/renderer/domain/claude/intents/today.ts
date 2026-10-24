import { TODAY } from "../../../data/dates";
import type { CitationRef, Task } from "../../../data/types";
import { currentWeek } from "../../weeks";
import { bulleted, labelled, named, resulted, sayDate, taskMeta, type Answer } from "../answers";
import type { IntentContext } from "../context";

/**
 * «Cosa devo fare oggi»: le decisioni che aspettano me, le mie task in
 * ritardo o in scadenza oggi, poi il resto della mia settimana. «Oggi» è
 * l'orologio fisso del prototipo.
 */
export async function today(_text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t, personId } = ctx;
  const [decisions, mine, people, visible] = await Promise.all([
    read.listDecisionRequests({ askedOfId: personId, open: true }),
    read.listTasks({ assigneeIds: [personId], families: ["todo", "active"] }),
    read.listPeople(),
    read.listTasks(),
  ]);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const tasksById = new Map(visible.map((task) => [task.id, task]));
  const refs: CitationRef[] = [];
  const cite = (task: Task) => {
    refs.push({ kind: "task", id: task.id });
    return named(task);
  };

  const decisionLines = decisions.flatMap((d) => {
    const task = tasksById.get(d.taskId);
    if (!task) return [];
    return [
      t("claude.answers.today.decisionLine", {
        task: cite(task),
        person: names.get(d.askedById) ?? "",
        question: d.question,
      }),
    ];
  });

  const due = mine
    .filter((task) => task.dueDate !== null && task.dueDate <= TODAY)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const dueLines = due.map((task) =>
    t(task.dueDate === TODAY ? "claude.answers.today.dueToday" : "claude.answers.today.overdue", {
      task: cite(task),
      date: sayDate(t, task.dueDate!),
    }),
  );

  const week = currentWeek();
  const thisWeek = mine.filter((task) => task.plannedWeek === week && !due.includes(task));
  const weekLines = thisWeek.map((task) => {
    const meta = taskMeta({ ...task, assigneeId: null, plannedWeek: null }, names);
    return meta ? `${cite(task)} · ${meta}` : cite(task);
  });

  const actions = [
    {
      tool: "list_decisions",
      ...labelled(t, "claude.answers.actions.readDecisions"),
      ...resulted(t, "claude.answers.actions.found", { count: decisionLines.length }),
    },
    {
      tool: "list_tickets",
      ...labelled(t, "claude.answers.actions.readMyWeek"),
      ...resulted(t, "claude.answers.actions.found", { count: mine.length }),
    },
  ];

  if (decisionLines.length + dueLines.length + weekLines.length === 0) {
    return { actions, text: t("claude.answers.today.nothing") };
  }
  const first = names.get(personId)?.split(" ")[0] ?? "";
  const sections = [t("claude.answers.today.intro", { name: first })];
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) sections.push("", `**${title}**`, bulleted(t, lines));
  };
  section(t("claude.answers.today.decisions", { count: decisionLines.length }), decisionLines);
  section(t("claude.answers.today.due", { count: dueLines.length }), dueLines);
  section(t("claude.answers.today.week", { count: weekLines.length }), weekLines);
  return { actions, text: sections.join("\n"), refs };
}
