import { ApiError } from "@stubwise/api-client";
import type {
  ChangeDiff,
  ChangeEntryView,
  ChangeFilter,
  ChangeFilterChoices,
  ChangeObjectLink,
} from "../../changelog/types";
import { CLAUDE_ID } from "../../ids";
import type { Viewer } from "../../types";
import { can } from "../../viewing";
import { appClient } from "./client";

// Il registro delle modifiche nella build app (area 9, F2) sulla lettura del
// server (72: `GET /api/change-log`, `…/projects/:id/change-log`,
// `…/change-log/filters`). Il server decide chi legge cosa (G-3) e toglie le
// persone che chi guarda non vede; qui si compone la voce come la legge la
// pagina: la frase dal tipo, il link all'oggetto (solo se c'è ancora e chi
// guarda lo apre, coi permessi calcolati dal server), il prima/dopo.
//
// Limiti dichiarati (registro dei rimandi):
// - `via: "claude"` e `undoOf` sono di F7: «By Claude» e «Undid…» restano
//   spenti (nessuna voce, `claude: false`, `undoOf: null`);
// - un invito non ha link: il server cancella gli inviti usati e revocati;
// - le pagine (50 voci) si leggono tutte, fino a `MAX_PAGES`: la pagina del
//   prototipo non ha «Load more».

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Fin dove si legge, in pagine da 50 (2.000 voci). */
const MAX_PAGES = 40;

export interface ChangelogQuery {
  person?: string;
  project?: string;
  type?: string;
  group?: string;
  from?: string;
  to?: string;
  withinDays?: number;
  cursor?: string;
}

/** Le rotte (sul client vero: `client.changeLog`), più chi guarda. */
export interface ChangelogApi {
  list(query: ChangelogQuery): Promise<{ entries: Any[]; nextCursor: string | null }>;
  listProject(
    projectId: string,
    query: Omit<ChangelogQuery, "project">,
  ): Promise<{ entries: Any[]; nextCursor: string | null }>;
  filters(projectId?: string): Promise<Any>;
  viewer(): Promise<Viewer>;
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(",") : [];

/** I `params` del server (stringhe o liste) nella forma del prototipo (liste con la virgola). */
function paramsOf(params: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
  );
}

/** Il prima e dopo, per i tipi del server (area 9); gli altri non ne hanno. */
function diffOf(e: Any): ChangeDiff | null {
  const { before, after } = e.data;
  const p = e.data.params ?? {};
  switch (e.type) {
    case "person.instance_role_changed":
    case "member.role_changed":
    case "person.git_identity_linked":
    case "person.git_identity_unlinked":
    case "person.bitbucket_username_set":
    case "person.email_changed":
      return before === null && after === null ? null : { kind: "values", before, after };
    case "department.updated": {
      const name = (v: string | null) => (v === null ? null : v.replace(/\s+--[\w-]+$/, ""));
      return name(before) === name(after)
        ? null
        : { kind: "values", before: name(before), after: name(after) };
    }
    case "role.updated":
    case "department.permissions_changed": {
      const added = list(p.added);
      const removed = list(p.removed);
      if (added.length === 0 && removed.length === 0)
        return before !== after ? { kind: "values", before, after } : null;
      const full = p.before !== undefined && p.after !== undefined;
      return {
        kind: "permissions",
        added,
        removed,
        role: null,
        before: full ? list(p.before) : null,
        after: full ? list(p.after) : null,
      };
    }
    case "member.permission_granted":
    case "member.permission_revoked": {
      const granted = e.type === "member.permission_granted";
      const permission = String(p.permission ?? (granted ? after : before) ?? "");
      return {
        kind: "permissions",
        added: granted ? [permission] : [],
        removed: granted ? [] : [permission],
        role: typeof p.role === "string" ? p.role : null,
        before: null,
        after: null,
      };
    }
    case "department.members_changed":
    case "department.home_managers_changed":
      // I nomi di allora, già senza le persone che chi guarda non vede (server).
      return { kind: "people", added: list(p.addedNames), removed: list(p.removedNames) };
    default:
      return null;
  }
}

/** Dove porta l'oggetto: solo se c'è ancora e chi guarda lo apre. */
function linkOf(e: Any, viewer: Viewer): ChangeObjectLink | null {
  if (e.objectDeleted) return null;
  const { type, id } = e.data.object;
  switch (type) {
    case "person":
      // Una voce di membro si apre nel pannello del membro, se ne è ancora membro.
      if (e.projectCode && String(e.type).startsWith("member.") && e.type !== "member.removed")
        return { to: "member", projectCode: e.projectCode, personId: id };
      return { to: "person", personId: id };
    case "role":
      return can(viewer, "roles.manage") ? { to: "role", roleId: id } : null;
    case "department":
      return can(viewer, "departments.manage") ? { to: "department", departmentId: id } : null;
    default:
      return null;
  }
}

function viewOf(e: Any, viewer: Viewer): ChangeEntryView {
  return {
    id: e.id,
    kind: e.type,
    at: e.at,
    actorId: e.actor.id ?? (e.actor.kind === "agent" ? CLAUDE_ID : ""),
    projectId: e.projectId ?? null,
    before: e.data.before ?? null,
    after: e.data.after ?? null,
    undoOf: null,
    object: { ...e.data.object },
    params: paramsOf(e.data.params),
    templateKey: `changelog.kinds.${e.type}`,
    scope: e.scope,
    group: e.group,
    actorName: e.actor.name,
    projectCode: e.projectCode ?? null,
    objectDeleted: !!e.objectDeleted,
    objectLink: linkOf(e, viewer),
    objectLabelKey: null,
    diff: diffOf(e),
  } as ChangeEntryView;
}

/** I filtri del prototipo nella query del server. */
function queryOf(filter: ChangeFilter): ChangelogQuery {
  const q: ChangelogQuery = {};
  if (filter.personId) q.person = filter.personId;
  if (filter.projectId !== undefined) q.project = filter.projectId ?? "instance";
  if (filter.kind) q.type = filter.kind;
  if (filter.group) q.group = filter.group;
  if (filter.withinDays !== undefined) q.withinDays = filter.withinDays;
  if (filter.from) q.from = filter.from;
  if (filter.to) q.to = filter.to;
  return q;
}

export function createRealChangelog(api: ChangelogApi) {
  /** Tutte le pagine, fino a `MAX_PAGES`. */
  async function allPages(
    read: (cursor?: string) => Promise<{ entries: Any[]; nextCursor: string | null }>,
  ): Promise<Any[]> {
    const out: Any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await read(cursor);
      out.push(...page.entries);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  const withCursor = <T extends object>(q: T, cursor?: string) => (cursor ? { ...q, cursor } : q);

  return {
    async listChanges(filter: ChangeFilter = {}): Promise<ChangeEntryView[]> {
      if (filter.via === "claude") return [];
      const q = queryOf(filter);
      const [entries, viewer] = await Promise.all([
        allPages((c) => api.list(withCursor(q, c))),
        api.viewer(),
      ]);
      return entries.map((e) => viewOf(e, viewer));
    },

    async listProjectChanges(
      projectId: string,
      filter: Omit<ChangeFilter, "projectId"> = {},
    ): Promise<ChangeEntryView[]> {
      if (filter.via === "claude") return [];
      const q = queryOf(filter);
      try {
        const [entries, viewer] = await Promise.all([
          allPages((c) => api.listProject(projectId, withCursor(q, c))),
          api.viewer(),
        ]);
        return entries.map((e) => viewOf(e, viewer));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) throw new Error("not_found");
        if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
        throw error;
      }
    },

    async listChangeFilterChoices(projectId?: string): Promise<ChangeFilterChoices> {
      let f: Any;
      try {
        f = await api.filters(projectId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) throw new Error("not_found");
        throw error;
      }
      return {
        everything: !!f.everything,
        people: f.people ?? [],
        projects: f.projects ?? [],
        groups: f.groups ?? [],
        // F7: le voci di Claude non ci sono ancora.
        claude: false,
      };
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: ChangelogApi = {
  list: (query) => appClient().changeLog.list(query) as Promise<Any>,
  listProject: (projectId, query) =>
    appClient().changeLog.listProject(projectId, query) as Promise<Any>,
  filters: (projectId) => appClient().changeLog.filters(projectId),
  viewer: async () => {
    const me = await appClient().auth.me();
    return {
      personId: me.user.id,
      instancePermissions: me.instancePermissions,
      projectPermissions: me.projectPermissions,
      departmentPermissions: me.departmentPermissions ?? {},
    } as Viewer;
  },
};

/** SOLO TEST: le rotte vere. */
export const liveChangelogApiForTest = liveApi;

export const liveChangelog = createRealChangelog(liveApi);
