import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ClaudeWorkState, Task } from "../../data/types";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useInlineUpdate, useProjectMembers } from "../tasks/pickers";
import { Section, ghostButton } from "./parts";

/** Gli stati in cui c'è (o c'è stata) una sessione di Claude da aprire. */
const HAS_SESSION: ReadonlySet<ClaudeWorkState> = new Set([
  "working",
  "awaiting_answer",
  "awaiting_approval",
  "stopped",
  "done",
]);

/**
 * Claude sulla task: lo stato del suo lavoro con una frase (nessuno, sta
 * lavorando, aspetta una risposta, aspetta un'approvazione, fermo, finito) e
 * «Assign to Claude» a chi ha `tickets.edit`, se Claude è nel progetto. Il
 * resto (piano, approvazione, sessione dal vivo, PR) è dell'area 3: qui
 * c'è «Open session» verso `#/claude` e una riga che lo dice.
 */
export function ClaudeSection({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const { t } = useTranslation();
  const change = useInlineUpdate();
  const claude = useProjectMembers(task.projectId)?.find((p) => p.isClaude);
  const assigned = !!claude && task.assigneeId === claude.id;
  const canAssign = canEdit && !!claude && !assigned;
  const session = HAS_SESSION.has(task.claude);
  // Il segno di Claude è la forma (anello tratteggiato); «sta lavorando» lo fa pulsare.
  const working = task.claude === "working";

  return (
    <Section
      title={t("taskDetail.claude.title")}
      action={
        canAssign && (
          <button
            type="button"
            className={ghostButton}
            onClick={() => change(task, { assigneeId: claude.id })}
          >
            {t("taskDetail.claude.assign")}
          </button>
        )
      }
    >
      <div data-claude-state={task.claude} className="flex items-start gap-3.5 pl-0.5">
        <span className="relative mt-px grid size-[22px] shrink-0 place-items-center">
          {claude ? (
            <Avatar person={claude} />
          ) : (
            <span
              aria-hidden="true"
              className="size-[22px] rounded-full border-[1.5px] border-dashed border-rule-strong"
            />
          )}
          {working && (
            <span
              aria-hidden="true"
              className="rail-pulse absolute -inset-[4px] rounded-full border-2 border-dashed border-claude"
            />
          )}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-md text-ink">{t(`taskDetail.claude.states.${task.claude}`)}</p>
          {!claude && task.claude === "none" && (
            <p className="text-sm text-ink-muted">{t("taskDetail.claude.notMember")}</p>
          )}
          {session && (
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <Link to="/claude" className="font-medium text-ink underline underline-offset-4">
                {t("taskDetail.claude.openSession")}
              </Link>
              <span className="text-ink-muted">{t("taskDetail.claude.area3")}</span>
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
