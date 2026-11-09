import type { InstancePermission, ProjectPermission } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from "react";
import { defaultViewerContext, PrototypeViewerProvider } from "@backend/viewer";
import { BOTH_LEVELS, INSTANCE_SET } from "./access/catalog";
import { isAppBuild } from "./build";
import { CLAUDE_ID } from "./ids";
import type {
  DepartmentPermission,
  LocalInstancePermission,
  LocalProjectPermission,
  Viewer,
} from "./types";

// Chi guarda e cosa può fare (integrazione area 2, fetta 1): le domande sui
// permessi (`can`, `canInDepartment`) e il contesto del `Viewer`, senza stato
// né seme, così li ha anche la build app. Il `Viewer` del prototipo, il «vedi
// come» e le concessioni stanno in `viewer.ts` (il finto), raggiunto da
// `@backend/viewer`; nella build app quell'alias è `backend/real/viewer.ts`.

export type Permission =
  | InstancePermission
  | LocalInstancePermission
  | ProjectPermission
  | LocalProjectPermission
  | DepartmentPermission;
export type AnyProjectPermission = ProjectPermission | LocalProjectPermission;

/**
 * Quello che Claude non ha MAI (R-L9, R-L11): le decisioni — approvare un
 * piano, fare merge, operare sui server, registrare una decisione (il
 * registro non lo scrive mai l'AI), adottare una PR — e la gestione, di
 * progetto (impostazioni, membri, repository, ambienti, widget, moderazione)
 * e d'istanza (full admin, inviti, ogni `*.manage`: accessi SSH, monitor,
 * automazioni, canali generali, reparti…), più lo stato dell'istanza e il
 * registro delle modifiche (area 9a). Vince su ogni concessione, ruolo e
 * full admin: `claudeCan` non legge né il `Viewer` né lo stato.
 */
const CLAUDE_NEVER: ReadonlySet<string> = new Set([
  "plans.approve",
  "release.merge",
  "servers.operate",
  "decisions.record",
  "prs.adopt",
  "tickets.moderate",
  "instance.full_admin",
  "users.invite",
  "departments.manage",
  "instance.status.view",
  "changelog.view",
]);

const claudeForbidden = (perm: string): boolean =>
  CLAUDE_NEVER.has(perm) || perm.endsWith(".manage");

/**
 * I permessi di Claude in ogni progetto, membro o no (R-L9, maintainer:
 * «Claude ha sempre accesso a TUTTI i progetti»): quelli di lavoro —
 * vedere, aprire task, avviare i run, leggere i repository — senza nessuno
 * dei vietati. Un insieme FISSO (area 9a): fino all'8b derivava dal preset
 * Developer, ma i preset ora si modificano, e cambiare Developer avrebbe
 * cambiato Claude in silenzio. Il contenuto è quello di allora: un test lo
 * confronta col fixture di parità. Gli avvisi non gli arrivano comunque (R-K5).
 */
export const CLAUDE_PROJECT_PERMISSIONS: ReadonlySet<string> = new Set([
  "tickets.view_all",
  "tickets.create",
  "tickets.edit",
  "tickets.comment",
  "runs.start",
  "corrections.request",
  "backlog.view_all",
  "backlog.create",
  "backlog.edit",
  "docs.view",
  "docs.edit",
  "repos.view",
  "agent_sessions.intervene",
  "project.usage.view",
  "docs.generate",
  "chat.channels.create",
  "drive.upload",
  "support.reply",
]);

/** D'istanza: quelli del preset User di allora, senza i vietati (nessuna concessione si aggiunge). */
export const CLAUDE_INSTANCE_PERMISSIONS: ReadonlySet<string> = new Set([
  "monitor.view",
  "users.view_all",
  "git_accounts.view",
  "mail_admission.view",
  "claude.public.view",
  "chat.general.create",
]);

/**
 * Se Claude ha `perm`, in qualunque progetto: dai due insiemi qui sopra e
 * basta. Un permesso a due livelli (`automations.manage`) è vietato a
 * entrambi; i permessi di reparto non li ha.
 */
function claudeCan(perm: Permission): boolean {
  if (claudeForbidden(perm)) return false;
  if (INSTANCE_SET.has(perm)) return CLAUDE_INSTANCE_PERMISSIONS.has(perm);
  return CLAUDE_PROJECT_PERMISSIONS.has(perm);
}

// --- le domande ----------------------------------------------------------------

const isFullAdmin = (viewer: Viewer) => viewer.instancePermissions.includes("instance.full_admin");

/**
 * Stessa semantica di `hasPermission` in `apps/web/src/lib/permissions.ts`.
 * Per un permesso a due livelli (`BOTH_LEVELS`) il progetto sceglie quale:
 * con `projectId` quello di progetto, senza quello d'istanza.
 */
export function can(viewer: Viewer, perm: Permission, projectId?: string): boolean {
  // R-L9: Claude PRIMA di tutto, e senza leggere il suo `Viewer`: nessuna
  // concessione, ruolo di progetto o full admin gli dà ciò che è vietato.
  if (viewer.personId === CLAUDE_ID) return claudeCan(perm);
  if (isFullAdmin(viewer)) return true;
  if (INSTANCE_SET.has(perm) && !(BOTH_LEVELS.has(perm) && projectId !== undefined))
    return viewer.instancePermissions.includes(
      perm as InstancePermission | LocalInstancePermission,
    );
  if (perm === "department.home.manage") {
    return Object.values(viewer.departmentPermissions).some((perms) => perms.includes(perm));
  }
  const byProject = viewer.projectPermissions;
  const wanted = perm as AnyProjectPermission;
  if (projectId !== undefined) return (byProject[projectId] ?? []).includes(wanted);
  return Object.values(byProject).some((perms) => perms.includes(wanted));
}

/** Un permesso di reparto, su quel reparto (il full admin li ha tutti). */
export function canInDepartment(
  viewer: Viewer,
  perm: DepartmentPermission,
  departmentId: string,
): boolean {
  // R-L9: i permessi di reparto sono di gestione, a Claude mai.
  if (viewer.personId === CLAUDE_ID) return false;
  if (isFullAdmin(viewer)) return true;
  return (viewer.departmentPermissions[departmentId] ?? []).includes(perm);
}

// --- stato condiviso dell'app -----------------------------------------------

export interface ViewerContextValue {
  viewer: Viewer;
  setPersona(personId: string): void;
}

/** `null` senza provider: `useViewer` ripiega su `defaultViewerContext` del livello dati. */
export const ViewerContext = createContext<ViewerContextValue | null>(null);

/**
 * Da montare una volta nell'`App`. Nel prototipo tiene la persona «vedi come»
 * attiva e la sessione del livello dati finto; nella build app (integrazione
 * area 2, fetta 1) legge la persona e i permessi dal livello dati
 * (`api.getSessionPerson`, `api.getViewer`, query `["viewer", personId]`) e il
 * «vedi come» non esiste. Il modo si decide al montaggio (non cambia mentre
 * l'app gira), quindi i due rami non si alternano fra un render e l'altro.
 */
export function ViewerProvider(props: { children: ReactNode; initialPersonId?: string }) {
  const [app] = useState(isAppBuild);
  return createElement(app ? AppViewerProvider : PrototypeViewerProvider, props);
}

/**
 * Il livello dati, importato al primo uso e non al caricamento: `viewer.ts`
 * sta in mezzo al grafo del finto (store, accessi), e un import statico di
 * `@backend/api` ne cambierebbe l'ordine d'inizializzazione (`onStoreReset`
 * chiamato prima che lo store esista).
 */
const backend = () => import("@backend/api");

/**
 * La build app: persona e permessi vengono dal server. Finché non ci sono
 * non si monta nulla (nessuna pagina a nome di nessuno); l'ingresso (login,
 * sessione scaduta) arriva col Task 16.
 */
function AppViewerProvider({ children }: { children: ReactNode }) {
  const session = useQuery({
    queryKey: ["session-person"],
    queryFn: async () => (await backend()).getSessionPerson(),
  });
  const personId = session.data ?? null;
  const viewer = useQuery({
    queryKey: ["viewer", personId],
    queryFn: async () => (await backend()).getViewer(),
    enabled: personId !== null,
  });
  const value = useMemo<ViewerContextValue | null>(
    () => (viewer.data ? { viewer: viewer.data, setPersona: () => {} } : null),
    [viewer.data],
  );
  if (!value) return null;
  return createElement(ViewerContext.Provider, { value }, children);
}

export function useViewer(): ViewerContextValue {
  return useContext(ViewerContext) ?? defaultViewerContext();
}
