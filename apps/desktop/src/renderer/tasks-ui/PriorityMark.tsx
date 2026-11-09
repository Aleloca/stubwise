import { useTranslation } from "react-i18next";
import type { TaskPriority, TaskType } from "../data/types";

// Tipo e priorità di una task: gli elenchi nell'ordine in cui si offrono e il
// segno della priorità. Stavano nella testata del pannello; ne sono usciti
// quando li ha voluti anche la barra dei filtri.

export const TASK_TYPES: TaskType[] = ["feature", "bug", "activity"];
export const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];

/** La priorità: barre crescenti (forma) e il nome; «urgent» in rosso, col nome che lo dice. */
export function PriorityValue({ priority }: { priority: TaskPriority }) {
  const { t } = useTranslation();
  const level = PRIORITIES.indexOf(priority) + 1;
  const urgent = priority === "urgent";
  return (
    <span className={`flex items-center gap-1.5 ${urgent ? "font-semibold text-critical" : ""}`}>
      <svg
        viewBox="0 0 14 14"
        width={14}
        height={14}
        aria-hidden="true"
        focusable="false"
        className="shrink-0"
      >
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={1 + i * 3.25}
            y={10 - i * 2.5}
            width={2.25}
            height={3 + i * 2.5}
            rx={0.5}
            fill="currentColor"
            opacity={i < level ? 1 : 0.2}
          />
        ))}
      </svg>
      {t(`taskDetail.priorities.${priority}`)}
    </span>
  );
}
