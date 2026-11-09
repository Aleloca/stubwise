import type { ProjectMember } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { Project } from "../../types";
import { appClient } from "./client";

// I progetti della build app (integrazione area 2, fetta 1): quelli che chi
// guarda vede (`GET /api/projects` filtra già nella WHERE), coi membri
// (`GET /api/projects/:id/members`, che ogni membro legge) per i selettori
// dell'assegnatario. Template, moduli e segnali sono quelli neutri: le
// sezioni che li leggono arrivano con le fette successive.

interface ServerProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  code?: string;
  stallThresholds?: { activeDays: number; todoDays: number };
  /** I membri effettivi (full admin impliciti compresi), derivati dal server; assenti da un server più vecchio. */
  memberIds?: string[];
}

const DEFAULT_THRESHOLDS = { activeDays: 7, todoDays: 14 };

/** Il codice di un progetto: quello del server; da un server più vecchio, lo slug in maiuscolo. */
const codeOf = (p: ServerProject): string => p.code ?? p.slug.toUpperCase();

function toProject(p: ServerProject, memberIds: string[]): Project {
  return {
    id: p.id,
    code: codeOf(p),
    name: p.name,
    kind: "internal",
    template: "software",
    modules: [],
    memberIds,
    stallThresholds: p.stallThresholds ?? DEFAULT_THRESHOLDS,
    signals: { claudeWorking: false },
    ...(p.description ? { description: p.description } : {}),
  };
}

async function membersOf(projectId: string): Promise<string[]> {
  try {
    const rows = await appClient().request<ProjectMember[]>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/members`,
    );
    return rows.map((m) => m.userId);
  } catch {
    // Un elenco dei membri che non si legge non toglie il progetto: niente assegnatari proposti.
    return [];
  }
}

export const listProjects: typeof Fake.listProjects = async () => {
  const rows = (await appClient().projects.list()) as unknown as ServerProject[];
  const members = await Promise.all(rows.map((p) => p.memberIds ?? membersOf(p.id)));
  return rows.map((p, i) => toProject(p, members[i]!));
};

/** Un progetto invisibile risponde come uno che non esiste: `null`. */
export const getProjectByCode: typeof Fake.getProjectByCode = async (code) => {
  const wanted = code.toUpperCase();
  const rows = (await appClient().projects.list()) as unknown as ServerProject[];
  const hit = rows.find((p) => codeOf(p) === wanted);
  return hit ? toProject(hit, hit.memberIds ?? (await membersOf(hit.id))) : null;
};

/** I fissati sono i progetti seguiti (`/api/me/follows`), nell'ordine del server. */
export const listPinnedProjectIds: typeof Fake.listPinnedProjectIds = async () => {
  const follows = await appClient().me.follows();
  return follows.projectIds;
};

export const setPinned: typeof Fake.setPinned = async (projectId, isPinned) => {
  const { projectIds } = await appClient().me.follows();
  const next = isPinned
    ? projectIds.includes(projectId)
      ? projectIds
      : [...projectIds, projectId]
    : projectIds.filter((id) => id !== projectId);
  await appClient().me.setFollows(next);
};

/**
 * I progetti con una richiesta di decisione aperta rivolta a me (il punto «ti
 * aspetta» delle tessere). La vista della decisione nomina la task, non il
 * progetto: il progetto lo dà il ticket (una lettura per task distinta).
 */
export const listWaitingOnMeProjectIds: typeof Fake.listWaitingOnMeProjectIds = async () => {
  const decisions = await appClient().decisions.list({ askedOfId: "me", open: true });
  // Il server dà il progetto (`projectId`, derivato a lettura); da un server
  // che non lo manda ancora, lo dà il ticket.
  const known = decisions.flatMap((d) => {
    const projectId = (d as { projectId?: string | null }).projectId;
    return projectId ? [projectId] : [];
  });
  const taskIds = [
    ...new Set(
      decisions.filter((d) => !(d as { projectId?: string | null }).projectId).map((d) => d.taskId),
    ),
  ];
  const tickets = await Promise.all(
    taskIds.map((id) => appClient().tickets.get(id).catch(() => null)),
  );
  return [...new Set([...known, ...tickets.flatMap((t) => (t ? [t.projectId] : []))])];
};
