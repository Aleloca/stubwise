import { ApiError } from "@stubwise/api-client";
import type { ProjectMember } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { Project, ProjectModule, ProjectTemplate } from "../../types";
import { appClient, session } from "./client";

// I progetti della build app (integrazione area 2, fetta 1): quelli che chi
// guarda vede (`GET /api/projects` filtra già nella WHERE), coi membri
// (`GET /api/projects/:id/members`, che ogni membro legge) per i selettori
// dell'assegnatario. Dalla fetta 4 modello, moduli e cliente vengono dal
// server (le sezioni Docs, Releases, Support e Servers seguono i moduli); i
// segnali restano neutri.

interface ServerProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  code?: string;
  stallThresholds?: { activeDays: number; todoDays: number };
  /** I membri effettivi (full admin impliciti compresi), derivati dal server; assenti da un server più vecchio. */
  memberIds?: string[];
  /** Fetta 4: assenti da un server più vecchio. */
  template?: ProjectTemplate;
  modules?: ProjectModule[];
  clientName?: string | null;
  kind?: "internal" | "client";
}

/** I progetti esistenti sono Software con tutti e quattro i moduli (decisione del maintainer, fetta 4). */
const EXISTING_MODULES: ProjectModule[] = ["docs", "releases", "support", "servers"];

const DEFAULT_THRESHOLDS = { activeDays: 7, todoDays: 14 };

/** Il codice di un progetto: quello del server; da un server più vecchio, lo slug in maiuscolo. */
const codeOf = (p: ServerProject): string => p.code ?? p.slug.toUpperCase();

function toProject(p: ServerProject, memberIds: string[]): Project {
  return {
    id: p.id,
    code: codeOf(p),
    name: p.name,
    kind: p.kind ?? (p.clientName ? "client" : "internal"),
    template: p.template ?? "software",
    modules: p.modules ?? EXISTING_MODULES,
    ...(p.clientName ? { clientName: p.clientName } : {}),
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

/**
 * «Nuovo progetto» (fetta 4): codice, modello (stati iniziali e moduli),
 * cliente. Il server crea stati e appartenenza nella stessa transazione e chi
 * lo crea ne è Project Lead; un codice già usato è un 409 e non crea niente.
 * Il canale «general» del prototipo è della Chat (area 3) e qui non nasce.
 */
export const createProject: typeof Fake.createProject = async (input) => {
  try {
    const created = (await appClient().projects.create({
      name: input.name.trim(),
      code: input.code,
      template: input.template,
      ...(input.clientName ? { clientName: input.clientName } : {}),
      ...(input.modules ? { modules: input.modules } : {}),
    })) as unknown as ServerProject;
    return toProject(created, created.memberIds ?? (session.personId ? [session.personId] : []));
  } catch (error) {
    // La forma del rifiuto del prototipo: il dialogo lo dice sotto il codice.
    if (error instanceof ApiError && error.code === "code_taken") throw new Error("invalid: code_taken");
    throw error;
  }
};
