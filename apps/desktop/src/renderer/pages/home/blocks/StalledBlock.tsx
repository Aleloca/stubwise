import { useTranslation } from "react-i18next";
import { useProjects, useSessionPersonId, useStalled } from "../../../data/queries";
import { TaskRow } from "../../../tasks-ui/TaskRow";
import {
  BlockSection,
  Capped,
  queryState,
  useOpenTask,
  useReportDepartments,
} from "./BlockSection";

/**
 * «Stalled in my projects»: le task ferme dei progetti di cui sono membro
 * (un full admin li vede tutti, ma qui contano i suoi), dalla più
 * vecchia, con giorni e motivo (il segno «ferma» della riga, che il motivo
 * lo dice al passaggio e ai lettori di schermo).
 */
export function StalledBlock() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const stalled = useStalled();
  const projects = useProjects();
  const openTask = useOpenTask();
  const mine = new Set(
    (projects.data ?? []).filter((p) => p.memberIds.includes(me)).map((p) => p.id),
  );
  const rows = (stalled.data ?? []).filter((r) => mine.has(r.task.projectId));
  useReportDepartments(
    "stalled",
    rows.map((r) => r.task),
  );
  const state = queryState([stalled, projects], {
    when: rows.length === 0,
    text: t("home.stalled.empty"),
  });
  return (
    <BlockSection title={t("home.blocks.stalledInMyProjects")} count={rows.length} state={state}>
      <Capped
        items={rows}
        render={({ task, stall }) => (
          <li key={task.id}>
            <TaskRow task={task} density="regular" stall={stall} onOpen={(x) => openTask(x.code)} />
          </li>
        )}
      />
    </BlockSection>
  );
}
