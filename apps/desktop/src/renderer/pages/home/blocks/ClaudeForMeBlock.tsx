import { useTranslation } from "react-i18next";
import { useSessionPersonId, useTasks } from "../../../data/queries";
import type { ClaudeWorkState, FilterCriteria, Task } from "../../../data/types";
import { TaskRow } from "../../../tasks-ui/TaskRow";
import {
  BlockSection,
  Capped,
  queryState,
  useOpenTask,
  useReportDepartments,
} from "./BlockSection";
import { useStallsByCode } from "./MyTasksBlock";

const OPEN: FilterCriteria = { families: ["todo", "active"] };

/** Gli stati in cui Claude ha in mano la task (prima quelli che aspettano qualcuno). */
const ORDER: ClaudeWorkState[] = ["awaiting_answer", "awaiting_approval", "stopped", "working"];

/** Una task che ho affidato a Claude: è mia (assegnata o creata da me) e Claude ci lavora. */
const forMe = (task: Task, me: string) =>
  ORDER.includes(task.claude) && (task.assigneeId === me || task.createdById === me);

/**
 * «Claude's work for me»: le task che ho affidato a Claude e il suo stato —
 * prima quelle che aspettano me (una risposta, un'approvazione), poi le
 * ferme, poi quelle in corso. Lo stato si dice a parole, accanto alla riga;
 * l'area 3 aggiunge la sessione dal vivo.
 */
export function ClaudeForMeBlock() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const tasks = useTasks(OPEN);
  const stalls = useStallsByCode();
  const openTask = useOpenTask();
  const mine = (tasks.data ?? [])
    .filter((task) => forMe(task, me))
    .sort(
      (a, b) => ORDER.indexOf(a.claude) - ORDER.indexOf(b.claude) || a.code.localeCompare(b.code),
    );
  useReportDepartments("claudeForMe", mine);
  const state = queryState([tasks], { when: mine.length === 0, text: t("home.claude.empty") });
  return (
    <BlockSection title={t("home.blocks.claudeForMe")} count={mine.length} state={state}>
      <Capped
        items={mine}
        render={(task) => (
          <li key={task.id} className="flex flex-col">
            <TaskRow
              task={task}
              density="regular"
              stall={stalls.get(task.code) ?? null}
              onOpen={(x) => openTask(x.code)}
            />
            <ClaudeState state={task.claude} />
          </li>
        )}
      />
    </BlockSection>
  );
}

/**
 * Lo stato di Claude sotto la riga: l'anello tratteggiato (la forma di
 * Claude, pulsante se lavora) e la frase. Inchiostro, mai una tinta nuova.
 */
function ClaudeState({ state }: { state: ClaudeWorkState }) {
  const { t } = useTranslation();
  const waiting = state === "awaiting_answer" || state === "awaiting_approval";
  return (
    <p
      data-claude-state={state}
      className="-mt-px flex items-center gap-2 border-b border-rule pb-2 pl-[92px] text-sm"
    >
      <span
        aria-hidden="true"
        className={`size-2.5 shrink-0 rounded-full border-[1.5px] border-dashed border-claude ${state === "working" ? "rail-pulse" : ""}`}
      />
      <span className={waiting ? "font-medium text-ink" : "text-ink-muted"}>
        {t(`home.claude.states.${state}`)}
      </span>
    </p>
  );
}
