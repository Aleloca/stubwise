import type { InstancePermission, ProjectPermission } from "@stubwise/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { defaultViewerContext, PrototypeViewerProvider } from "@backend/viewer";
import { INSTANCE_SET } from "./access/catalog";
import { isAppBuild } from "./build";
import { CLAUDE_ID } from "./ids";
import { NO_SESSION_PERSON_ID } from "./session";
import { onSessionLost } from "./sessionEvents";
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
 */
export function can(viewer: Viewer, perm: Permission, projectId?: string): boolean {
  // R-L9: Claude PRIMA di tutto, e senza leggere il suo `Viewer`: nessuna
  // concessione, ruolo di progetto o full admin gli dà ciò che è vietato.
  if (viewer.personId === CLAUDE_ID) return claudeCan(perm);
  if (isFullAdmin(viewer)) return true;
  if (INSTANCE_SET.has(perm))
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
export interface ViewerProviderProps {
  children: ReactNode;
  initialPersonId?: string;
  /**
   * Build app: cosa mostrare quando Stubwise non risponde (rete, 5xx), che non
   * è «fuori»: niente ingresso, una frase e «Retry». Senza, non si mostra nulla.
   */
  unreachable?: (retry: () => void) => ReactNode;
}

export function ViewerProvider(props: ViewerProviderProps) {
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

/** Fuori (nessuna sessione): un `Viewer` senza permessi, come «nessuno» del prototipo. */
const NOBODY: Viewer = {
  personId: NO_SESSION_PERSON_ID,
  instancePermissions: [],
  projectPermissions: {},
  departmentPermissions: {},
};

/**
 * La build app: persona e permessi vengono dal server (`/api/auth/me`).
 * Finché la sessione non è letta non si monta nulla; fuori si monta con
 * «nessuno», così il cancello delle rotte porta al login. Entrare, uscire o
 * perdere la sessione a metà (un 401) azzera TUTTA la cache prima di
 * rileggere chi è dentro: nessun dato della persona di prima resta a schermo.
 */
function AppViewerProvider({ children, unreachable }: ViewerProviderProps) {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ["session-person"],
    queryFn: async () => (await backend()).getSessionPerson(),
    staleTime: Infinity,
    retry: false,
  });
  const personId = session.data ?? null;
  const viewer = useQuery({
    queryKey: ["viewer", personId],
    queryFn: async () => (await backend()).getViewer(),
    enabled: personId !== null,
    staleTime: Infinity,
  });
  // Persona cambiata (login, logout): `useLogin`/`useLogout` chiamano
  // `setPersona`; qui vuol dire «rileggi la sessione». Uscendo (o perdendo la
  // sessione) si azzera tutto e si smonta; entrando si toglie la cache di
  // «nessuno» ma l'albero resta montato finché il viewer nuovo non c'è, così
  // la pagina d'ingresso può ancora mostrare il suo ultimo passo (i codici
  // di riserva appena creati, «ne restano pochi»).
  const restart = useCallback(
    (next?: string) => {
      if (next === undefined || next === NO_SESSION_PERSON_ID) {
        void client.resetQueries();
        return;
      }
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== "session-person" });
      void client.invalidateQueries({ queryKey: ["session-person"] });
    },
    [client],
  );
  useEffect(() => onSessionLost(() => restart()), [restart]);
  const last = useRef<ViewerContextValue | null>(null);
  const value = useMemo<ViewerContextValue | null>(() => {
    if (session.isPending) return null;
    if (personId === null) return { viewer: NOBODY, setPersona: restart };
    if (viewer.data) return { viewer: viewer.data, setPersona: restart };
    // Appena entrati: «nessuno» resta finché i permessi veri non arrivano.
    return last.current?.viewer.personId === NO_SESSION_PERSON_ID ? last.current : null;
  }, [session.isPending, personId, viewer.data, restart]);
  last.current = value;
  // Non raggiungibile (rete, 5xx su `/me`, o i permessi che non arrivano dopo
  // un `/me` riuscito): non è «fuori», e non è una schermata bianca.
  if (session.isError || (personId !== null && viewer.isError)) {
    return unreachable ? createElement(Fragment, null, unreachable(() => restart())) : null;
  }
  if (!value) return null;
  return createElement(ViewerContext.Provider, { value }, children);
}

export function useViewer(): ViewerContextValue {
  return useContext(ViewerContext) ?? defaultViewerContext();
}
