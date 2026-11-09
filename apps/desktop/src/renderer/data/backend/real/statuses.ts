import type { ProjectStatusView } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { Milestone, ProjectStatus } from "../../types";
import { appClient } from "./client";
import { listProjects } from "./projects";

// Stati e soglie del progetto, e i traguardi in lettura, nella build app
// (integrazione area 2, fetta 1). Le regole (almeno uno stato per famiglia,
// lo spostamento delle task di uno stato tolto) le applica il server.

const toStatus = (v: ProjectStatusView): ProjectStatus => ({
  id: v.id,
  projectId: v.projectId,
  name: v.name,
  family: v.family,
  order: v.position,
});

export const listProjectStatuses: typeof Fake.listProjectStatuses = async (projectId) =>
  (await appClient().projectStatuses.list(projectId))
    .map((v) => toStatus(v as ProjectStatusView))
    .sort((a, b) => a.order - b.order);

export const setProjectStatuses: typeof Fake.setProjectStatuses = async (projectId, statuses, reassign) =>
  (
    await appClient().projectStatuses.set(projectId, {
      statuses: statuses.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name.trim(), family: s.family })),
      reassign,
    })
  )
    .map((v) => toStatus(v as ProjectStatusView))
    .sort((a, b) => a.order - b.order);

export const setStallThresholds: typeof Fake.setStallThresholds = async (projectId, thresholds) => {
  await appClient().projectStatuses.setStallThresholds(projectId, thresholds);
  const project = (await listProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error("not_found");
  return project;
};

/** I traguardi di un progetto (o di tutti quelli visibili); le scritture stanno in `milestones.ts`. */
export const listMilestones: typeof Fake.listMilestones = async (projectId) => {
  const ids = projectId ? [projectId] : (await listProjects()).map((p) => p.id);
  const lists = await Promise.all(ids.map((id) => appClient().projects.milestones(id)));
  return lists.flat().map((m) => toMilestone(m));
};

/** Un traguardo del server nella forma del prototipo: la scadenza come giorno, `closed` da `status`. */
export function toMilestone(m: {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: string | null;
  status: string;
}): Milestone {
  return {
    id: m.id,
    projectId: m.projectId,
    name: m.name,
    description: m.description ?? "",
    dueDate: m.dueDate ? m.dueDate.slice(0, 10) : null,
    closed: m.status === "closed",
  };
}
