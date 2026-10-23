import type { Task, TaskStatus } from "../types";
import { daysFromToday, isoWeek } from "./dates";
import { DEPARTMENTS } from "./departments";
import { PEOPLE } from "./people";
import { PROJECTS } from "./projects";

// Titoli per reparto (chiave = id reparto). Generati in modo deterministico
// ciclando su queste liste: nessuna casualità.
const TITLES: Record<string, string[]> = {
  "dep-marketing": [
    "Draft the spring campaign brief",
    "Refresh landing page hero copy",
    "Schedule newsletter for the autumn launch",
    "Review social media calendar",
    "Collect testimonials for the case study",
    "Update brand guidelines PDF",
  ],
  "dep-sales": [
    "Prepare the renewal proposal",
    "Follow up on the quote sent last week",
    "Update pricing sheet for resellers",
    "Qualify inbound leads from the trade fair",
    "Plan the demo call with the buyer",
    "Negotiate payment terms",
  ],
  "dep-support": [
    "Reply to the delivery delay complaint",
    "Write the FAQ for the new checkout",
    "Triage the backlog of open tickets",
    "Call back the customer about the invoice",
    "Document the password reset procedure",
    "Collect feedback after the onboarding call",
  ],
  "dep-development": [
    "Fix the pagination bug in the order list",
    "Add CSV export to the reports page",
    "Upgrade the payment gateway SDK",
    "Improve the loading time of the catalog",
    "Write integration tests for the booking flow",
    "Migrate the media uploads to object storage",
  ],
  "dep-administration": [
    "Issue the quarterly invoices",
    "Reconcile the supplier statements",
    "Renew the hosting contract",
    "Collect signed privacy agreements",
    "Prepare the budget summary for the board",
    "Archive the closed project folders",
  ],
};

const STATUSES: TaskStatus[] = ["open", "triaged", "in_progress", "in_review", "done", "closed"];
const TASKS_PER_PROJECT = 5;

export const TASKS: Task[] = PROJECTS.flatMap((project, pi) =>
  Array.from({ length: TASKS_PER_PROJECT }, (_, n) => {
    const seq = pi * TASKS_PER_PROJECT + n;
    const department = DEPARTMENTS[(pi + n) % DEPARTMENTS.length]!;
    const titles = TITLES[department.id]!;
    const status = STATUSES[(seq * 5 + pi) % STATUSES.length]!;
    // Assegnata a un membro del progetto del reparto giusto, se c'è;
    // ogni quarta task resta senza assegnatario.
    const assignee =
      seq % 4 === 3
        ? undefined
        : PEOPLE.find(
            (p) =>
              !p.isClaude &&
              p.departmentIds.includes(department.id) &&
              project.memberIds.includes(p.id),
          );
    const due = status === "done" || status === "closed" ? null : daysFromToday((seq % 21) - 5);
    return {
      id: `t-${project.code.toLowerCase()}-${n + 1}`,
      code: `${project.code}-${n + 1}`,
      projectId: project.id,
      title: titles[(seq + n) % titles.length]!,
      departmentId: department.id,
      assigneeId: assignee?.id ?? null,
      status,
      dueDate: due,
      plannedWeek: due && seq % 3 !== 0 ? isoWeek(due) : null,
    } satisfies Task;
  }),
);
