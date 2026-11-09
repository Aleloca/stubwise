import type { TicketType } from "../schemas/ticket.js";

/**
 * I tre tipi che l'app nuova mostra (decisione del maintainer, 9 nov 2026).
 * Nel DB restano i cinque di oggi: «attività» ↔ `task`; `feedback` si mostra
 * come funzionalità, `review` come attività. L'app nuova scrive solo
 * `bug|feature|task`, e solo se il tipo MOSTRATO cambia (così un `feedback`
 * che resta una funzionalità non diventa `feature` per errore).
 */
export const UI_TASK_TYPES = ["bug", "feature", "activity"] as const;
export type UiTaskType = (typeof UI_TASK_TYPES)[number];

export function uiTypeOf(type: TicketType): UiTaskType {
  switch (type) {
    case "bug":
      return "bug";
    case "feature":
    case "feedback":
      return "feature";
    case "task":
    case "review":
      return "activity";
  }
}

export function ticketTypeFor(ui: UiTaskType): "bug" | "feature" | "task" {
  return ui === "activity" ? "task" : ui;
}
