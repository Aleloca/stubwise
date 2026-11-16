import { ApiError } from "@stubwise/api-client";
import { actionById, groupsFor, type AccessScope } from "../../../domain/access/actions";
import type { WhatCanView, WhoCanChoices, WhoCanReason, WhoCanView } from "../../access/whoCanApi";
import { appClient } from "./client";
import { listPeople } from "./people";
import { listProjects } from "./projects";

// «Chi può farlo?» nella build app (area 9, F1, R9) sulle rotte del server
// (`GET /api/access/who-can` e `what-can`, D-11 = a), con le firme del
// prototipo. Il calcolo è del server, con le stesse funzioni di `can()`: qui
// solo la mappa azione → permesso (catalogo e testo, `domain/access/actions`)
// e i nomi (persone, reparti) per i motivi in parole. Claude non ha permessi
// suoi (decisione (a)): una risposta fissa.

type ServerReason = {
  kind: string;
  roleId?: string | null;
  roleName?: string | null;
  byUserId?: string | null;
  at?: string | null;
  departmentId?: string | null;
};

type ServerWho = {
  permission: string;
  projectId: string | null;
  people: { userId: string; email: string; displayName: string | null; reasons: ServerReason[] }[];
};

type ServerWhat = {
  userId: string;
  instance: { permission: string; reasons: ServerReason[] }[];
  projects: {
    projectId: string;
    projectName: string;
    permissions: { permission: string; reasons: ServerReason[] }[];
  }[];
};

/** Le rotte e le letture che servono ai nomi (sul client vero). */
export interface WhoCanApi {
  whoCan(q: { permission: string; projectId?: string }): Promise<ServerWho>;
  whatCan(q: { userId: string; projectId?: string }): Promise<ServerWhat>;
  people(): Promise<{ id: string; name: string; initials: string; isClaude: boolean }[]>;
  projects(): Promise<{ id: string; code: string; name: string }[]>;
  departments(): Promise<{ id: string; name: string }[]>;
}

const invisible = { visible: false } as const;

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function createRealWhoCan(api: WhoCanApi) {
  /** I motivi del server in parole del prototipo; un tipo ignoto (server più nuovo) si salta. */
  async function reasonsOf(reasons: ServerReason[]): Promise<WhoCanReason[]> {
    const needNames = reasons.some((r) => r.kind === "grant" || r.kind === "department");
    const [people, departments] = needNames
      ? await Promise.all([api.people(), api.departments()])
      : [[], []];
    return reasons.flatMap((r): WhoCanReason[] => {
      if (r.kind === "full_admin") return [{ kind: "full_admin" }];
      if (r.kind === "role") return [{ kind: "role", roleName: r.roleName ?? "" }];
      if (r.kind === "grant") {
        const by = people.find((p) => p.id === r.byUserId)?.name ?? null;
        return [{ kind: "grant", byName: by, at: r.at ?? "" }];
      }
      if (r.kind === "department") {
        const name = departments.find((d) => d.id === r.departmentId)?.name ?? "";
        return [{ kind: "department", departmentName: name }];
      }
      return [];
    });
  }

  const codeOf = async (projectId: string | null): Promise<string | null> =>
    projectId ? ((await api.projects()).find((p) => p.id === projectId)?.code ?? null) : null;

  const notFound = (error: unknown) => error instanceof ApiError && error.status === 404;

  return {
    async whoCan(actionId: string, projectId: string | null): Promise<WhoCanView> {
      const action = actionById(actionId);
      if (!action) return invisible;
      const scoped = action.scope === "project" ? projectId : null;
      if (action.scope === "project" && !scoped) return invisible;
      let r: ServerWho;
      try {
        r = await api.whoCan({
          permission: action.permission,
          ...(scoped ? { projectId: scoped } : {}),
        });
      } catch (error) {
        if (notFound(error)) return invisible;
        throw error;
      }
      // I nomi come li dice `/api/people` (come altrove nell'app); senza, il
      // nome visualizzato o l'email del server.
      const known = await api.people();
      const people = await Promise.all(
        r.people.map(async (p) => {
          const person = known.find((k) => k.id === p.userId);
          const name = person?.name ?? (p.displayName?.trim() || p.email);
          return {
            personId: p.userId,
            name,
            initials: person?.initials ?? initialsOf(name),
            reasons: await reasonsOf(p.reasons),
          };
        }),
      );
      return {
        visible: true,
        actionId,
        permission: action.permission,
        scope: action.scope,
        projectCode: await codeOf(scoped),
        people,
        agent: { actsFor: "confirmer" },
      };
    },

    async whatCan(personId: string, projectId: string | null): Promise<WhatCanView> {
      let r: ServerWhat;
      try {
        r = await api.whatCan({ userId: personId, ...(projectId ? { projectId } : {}) });
      } catch (error) {
        if (notFound(error)) return invisible;
        throw error;
      }
      const scope: AccessScope = projectId === null ? "instance" : "project";
      const project = projectId ? r.projects.find((p) => p.projectId === projectId) : undefined;
      const held = new Map(
        (projectId === null ? r.instance : (project?.permissions ?? [])).map((p) => [
          p.permission,
          p,
        ]),
      );
      const groups = await Promise.all(
        groupsFor(scope).map(async (g) => ({
          groupKey: g.key,
          permissions: await Promise.all(
            g.permissions.map(async (permission) => {
              const h = held.get(permission);
              return { permission, held: !!h, reasons: h ? await reasonsOf(h.reasons) : [] };
            }),
          ),
        })),
      );
      const person = (await api.people()).find((p) => p.id === personId);
      return {
        visible: true,
        personId,
        name: person?.name ?? personId,
        projectCode: await codeOf(projectId),
        member: projectId === null ? null : !!project,
        groups: groups.filter((g) => g.permissions.length > 0),
      };
    },

    async whoCanChoices(): Promise<WhoCanChoices> {
      const [projects, people] = await Promise.all([api.projects(), api.people()]);
      return {
        projects: projects
          .map((p) => ({ projectId: p.id, code: p.code, name: p.name }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        people: people
          .filter((p) => !p.isClaude)
          .map((p) => ({ personId: p.id, name: p.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: WhoCanApi = {
  whoCan: (q) => appClient().access.whoCan(q) as Promise<ServerWho>,
  whatCan: (q) => appClient().access.whatCan(q) as Promise<ServerWhat>,
  people: () => listPeople(),
  projects: () => listProjects(),
  departments: async () =>
    (await appClient().departments.list()).map((d) => ({ id: d.id, name: d.name })),
};

/** SOLO TEST: le rotte vere. */
export const liveWhoCanApiForTest = liveApi;

export const liveWhoCan = createRealWhoCan(liveApi);
