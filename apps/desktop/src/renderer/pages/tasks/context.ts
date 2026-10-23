import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  useDepartments,
  useMilestones,
  usePeople,
  useProjects,
  useStalled,
  useStatusesOf,
} from "../../data/queries";
import type { FilterCriteria, Task } from "../../data/types";
import type { Stall } from "../../domain/stalled";
import { weekLabel } from "../../domain/weeks";
import type { GroupContext } from "./grouping";
import { shortWeek } from "./pickers";

const NO_IDS: string[] = [];

/**
 * I dati che danno nome e ordine ai gruppi di un insieme di task: stati dei
 * progetti presenti (più quello della pagina, anche senza task), persone,
 * reparti, traguardi, e i testi tradotti dei «senza». `undefined` finché
 * qualcosa carica.
 */
export function useGroupContext(
  tasks: Task[] | undefined,
  projectId?: string,
): GroupContext | undefined {
  return useGroupContextState(tasks, projectId).ctx;
}

/**
 * Come `useGroupContext`, più lo stato delle letture di contorno: se una
 * fallisce la pagina mostra l'errore (non uno scheletro per sempre), e
 * `refetch` le riprova tutte.
 */
export function useGroupContextState(
  tasks: Task[] | undefined,
  projectId?: string,
): { ctx: GroupContext | undefined; isError: boolean; refetch: () => Promise<unknown> } {
  const { t, i18n } = useTranslation();
  const projectIds = useMemo(() => {
    const ids = new Set(tasks?.map((task) => task.projectId) ?? NO_IDS);
    if (projectId) ids.add(projectId);
    return [...ids].sort();
  }, [tasks, projectId]);
  const statusesQuery = useStatusesOf(projectIds);
  const peopleQuery = usePeople();
  const departmentsQuery = useDepartments();
  const projectsQuery = useProjects();
  // Un progetto: i suoi traguardi; più progetti: tutti quelli visibili.
  const milestonesQuery = useMilestones(projectIds.length === 1 ? projectIds[0] : undefined);
  const statuses = statusesQuery.data;
  const people = peopleQuery.data;
  const departments = departmentsQuery.data;
  const milestones = milestonesQuery.data;
  const projects = projectsQuery.data;

  const ctx = useMemo((): GroupContext | undefined => {
    if (!statuses || !people || !departments || !milestones || !projects) return undefined;
    const wanted = new Set(projectIds);
    return {
      statuses,
      people,
      departments,
      milestones: milestones.filter((m) => wanted.has(m.projectId)),
      projects: projects.filter((p) => wanted.has(p.id)),
      labels: {
        all: t("tasks.groups.all"),
        noAssignee: t("tasks.groups.noAssignee"),
        noMilestone: t("tasks.groups.noMilestone"),
        noWeek: t("tasks.groups.noWeek"),
        other: t("tasks.groups.other"),
        family: (f) => t(`taskUi.families.${f}`),
        week: (w) =>
          t("tasks.groups.week", { week: shortWeek(w), range: weekLabel(w, i18n.language) }),
      },
    };
  }, [statuses, people, departments, milestones, projects, projectIds, t, i18n.language]);

  const queries = [peopleQuery, departmentsQuery, milestonesQuery, projectsQuery];
  return {
    ctx,
    isError: statusesQuery.isError || queries.some((q) => q.isError),
    refetch: () => Promise.all([statusesQuery.refetch(), ...queries.map((q) => q.refetch())]),
  };
}

const NO_STALLS = new Map<string, Stall>();

/** Le ferme dell'insieme, per id di task (il segno «ferma» di righe, carte e barre). */
export function useStallMap(criteria: FilterCriteria, enabled = true): Map<string, Stall> {
  const { data } = useStalled(criteria, { enabled });
  return useMemo(
    () => (data ? new Map(data.map((row) => [row.task.id, row.stall])) : NO_STALLS),
    [data],
  );
}
