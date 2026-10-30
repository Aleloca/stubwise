import type { InstancePermission, ProjectPermission } from "@stubwise/shared";
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  BOTH_LEVELS,
  INSTANCE_SET,
  accessState,
  accessVersion,
  effectivePermissions,
  homeManagedDepartments,
  isFullAdmin as isFullAdminInState,
  isMember,
  projectRoleOf as projectRoleDefOf,
  resetAccessState,
  subscribeAccess,
  writeAccess,
} from "./access/index";
import { TODAY } from "./seed/dates";
import { CLAUDE_ID, PEOPLE } from "./seed/people";
import { clearToasts } from "../tasks-ui/Toast";
import {
  DEFAULT_SESSION_PERSON_ID,
  NO_SESSION_PERSON_ID,
  runBeforePersonaChange,
  setSessionPersonId,
} from "./session";
import type {
  DepartmentPermission,
  LocalInstancePermission,
  LocalProjectPermission,
  Viewer,
} from "./types";

export type { LocalInstancePermission, LocalProjectPermission } from "./types";
export { LOCAL_INSTANCE_PERMISSIONS, LOCAL_PROJECT_PERMISSIONS } from "./access/index";

export type Permission =
  | InstancePermission
  | LocalInstancePermission
  | ProjectPermission
  | LocalProjectPermission
  | DepartmentPermission;

type AnyProjectPermission = ProjectPermission | LocalProjectPermission;

// I permessi vivono nello stato `access` del livello dati (area 9a, vedi
// `data/access/`): ruoli, appartenenze, concessioni e reparti. Qui si
// costruisce il `Viewer` da `effectivePermissions` e si risponde a `can()`.

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

// --- il Viewer, costruito dallo stato ----------------------------------------

interface ViewerData {
  instancePermissions: (InstancePermission | LocalInstancePermission)[];
  projectPermissions: Record<string, AnyProjectPermission[]>;
  departmentPermissions: Record<string, DepartmentPermission[]>;
}

function buildViewerData(personId: string): ViewerData {
  if (personId === CLAUDE_ID) {
    // Claude non ha accessi nello stato: `can()` lo risolve in testa, qui c'è
    // solo il suo insieme d'istanza per chi legge i campi.
    return {
      instancePermissions: [...CLAUDE_INSTANCE_PERMISSIONS] as LocalInstancePermission[],
      projectPermissions: {},
      departmentPermissions: {},
    };
  }
  // Disattivata: nessun permesso (`effectivePermissions` è vuota), nemmeno
  // quello di reparto, che non passa da lì.
  if (accessState().people.find((p) => p.personId === personId)?.status !== "active")
    return { instancePermissions: [], projectPermissions: {}, departmentPermissions: {} };
  const instancePermissions = [...effectivePermissions(personId).keys()].filter((p) =>
    INSTANCE_SET.has(p),
  ) as (InstancePermission | LocalInstancePermission)[];
  const projectPermissions: Record<string, AnyProjectPermission[]> = {};
  // Un full admin non ha righe per progetto: `can` lo risolve dal permesso
  // d'istanza, come sul server.
  if (!isFullAdminInState(personId)) {
    for (const m of accessState().memberships) {
      if (m.personId !== personId) continue;
      projectPermissions[m.projectId] = [
        ...effectivePermissions(personId, m.projectId).keys(),
      ] as AnyProjectPermission[];
    }
  }
  const departmentPermissions: Record<string, DepartmentPermission[]> = {};
  for (const departmentId of homeManagedDepartments(personId)) {
    departmentPermissions[departmentId] = ["department.home.manage"];
  }
  return { instancePermissions, projectPermissions, departmentPermissions };
}

/** Il `Viewer` calcolato di una persona, con la versione degli accessi su cui è calcolato. */
const computed = new Map<string, { version: number; data: ViewerData }>();

function dataOf(personId: string): ViewerData {
  const hit = computed.get(personId);
  if (hit && hit.version === accessVersion()) return hit.data;
  const data = buildViewerData(personId);
  computed.set(personId, { version: accessVersion(), data });
  return data;
}

/**
 * Un `Viewer` per persona, sempre lo stesso oggetto: i suoi campi si leggono
 * dallo stato di adesso (ricalcolati quando la versione degli accessi
 * cambia). Così chi lo tiene — il contesto del «vedi come», un test — vede
 * subito ogni scrittura, anche su sé stesso.
 */
const viewers = new Map<string, Viewer>();

function liveViewer(personId: string): Viewer {
  let viewer = viewers.get(personId);
  if (!viewer) {
    viewer = {
      personId,
      get instancePermissions() {
        return dataOf(personId).instancePermissions;
      },
      get projectPermissions() {
        return dataOf(personId).projectPermissions;
      },
      get departmentPermissions() {
        return dataOf(personId).departmentPermissions;
      },
    };
    viewers.set(personId, viewer);
  }
  return viewer;
}

interface PersonaSpec {
  personId: string;
  /** Il nome è un dato; la descrizione (reparto e ruolo) sta nei locali: `rail.personas.<personId>`. */
  name: string;
}

// Le persone del «vedi come». I loro permessi sono quelli dello stato
// `access`: Matteo, proprietario di «Nuovo contratto» (AUT-1, R-J10), ha
// `automations.manage` d'istanza da una concessione del seme, non dal preset.
const SPECS: PersonaSpec[] = [
  { personId: "p-giulia", name: "Giulia Ferri" },
  { personId: "p-marco", name: "Marco Bellini" },
  { personId: "p-laura", name: "Laura Costa" },
  { personId: "p-sara", name: "Sara Montanari" },
  { personId: "p-matteo", name: "Matteo Conti" },
  { personId: "p-roberta", name: "Roberta Fontana" },
];

export interface ViewAsPersona {
  personId: string;
  name: string;
  /** Chiave i18n della descrizione (reparto · ruolo). */
  descriptionKey: string;
  viewer: Viewer;
}

const ALL_PERSONAS: ViewAsPersona[] = SPECS.map((spec) => ({
  personId: spec.personId,
  // Il nome si cambia in Account (area 9a): il «vedi come» legge quello di adesso.
  get name() {
    return PEOPLE.find((p) => p.id === spec.personId)?.name ?? spec.name;
  },
  descriptionKey: `rail.personas.${spec.personId}`,
  viewer: liveViewer(spec.personId),
}));

/**
 * Le persone del «vedi come» attive adesso: una persona disattivata non c'è
 * (area 9a), riattivata torna al suo posto. È sempre lo stesso array,
 * riallineato dopo ogni scrittura degli accessi.
 */
export const VIEW_AS_PERSONAS: ViewAsPersona[] = [];

function syncPersonas(): void {
  const people = accessState().people;
  const active = ALL_PERSONAS.filter((p) =>
    people.some((x) => x.personId === p.personId && x.status === "active"),
  );
  VIEW_AS_PERSONAS.splice(0, VIEW_AS_PERSONAS.length, ...active);
}
syncPersonas();
subscribeAccess(syncPersonas);

export const DEFAULT_PERSONA_ID = DEFAULT_SESSION_PERSON_ID;

/**
 * Il `Viewer` di una persona, letto dallo stato degli accessi; per un id
 * che non è né una persona né Claude, quello di default.
 */
export function viewerFor(personId: string): Viewer {
  // «Nessuno» (fuori, o dopo l'istanza vuota) resta tale: un `Viewer` senza
  // permessi, non quello della persona di default.
  const known =
    personId === CLAUDE_ID ||
    personId === NO_SESSION_PERSON_ID ||
    accessState().people.some((p) => p.personId === personId);
  return liveViewer(known ? personId : DEFAULT_PERSONA_ID);
}

// --- scritture (le firme di prima, sullo stato) -------------------------------

/** L'«adesso» delle concessioni fatte da qui: lo stesso di `now()` dello store. */
const grantedAt = (): string => `${TODAY}T12:00:00Z`;

/**
 * Il ruolo (chiave del preset o del ruolo) di una persona in un progetto;
 * `null` se non ne è membro. Lo usano le automazioni (area 7) per «chi ha il
 * ruolo X nel progetto».
 */
export function projectRoleOf(personId: string, projectId: string): string | null {
  return projectRoleDefOf(personId, projectId)?.key ?? null;
}

/**
 * Dà a una persona un ruolo su un progetto, rendendola membro se non lo era
 * (chi crea un progetto ne è il Project Lead); cambia il ruolo se c'era già.
 * Diventare Project Lead dà `people.activity.view` (R-E2, derivato). Claude
 * non ha appartenenze (R-L9): per lui non fa niente. `resetViewerGrants`
 * (parte di `resetApi`) riporta tutto al seme.
 */
export function grantProjectRole(personId: string, projectId: string, roleKey: string): void {
  if (personId === CLAUDE_ID) return;
  const role = accessState().roles.find((r) => r.key === roleKey && r.scope === "project");
  if (!role) throw new Error(`Unknown project role: ${roleKey}`);
  writeAccess((s) => {
    const m = s.memberships.find((x) => x.personId === personId && x.projectId === projectId);
    if (m) m.roleId = role.id;
    else s.memberships.push({ personId, projectId, roleId: role.id });
  });
}

const hasNow = (personId: string, perm: string, projectId: string | null): boolean =>
  effectivePermissions(personId, projectId ?? undefined).has(perm);

/** Dà un permesso: prima toglie una revoca, poi — se ancora non lo ha — una concessione personale. */
function grant(personId: string, perm: string, projectId: string | null): void {
  if (personId === CLAUDE_ID) return;
  writeAccess((s) => {
    s.revocations = s.revocations.filter(
      (r) => !(r.personId === personId && r.projectId === projectId && r.permission === perm),
    );
  });
  if (hasNow(personId, perm, projectId)) return;
  writeAccess((s) => {
    s.grants.push({ personId, projectId, permission: perm, grantedById: null, at: grantedAt() });
  });
}

/** Toglie un permesso: la concessione personale se c'è, e una revoca se resta da ruolo o reparto. */
function revoke(personId: string, perm: string, projectId: string | null): void {
  if (personId === CLAUDE_ID) return;
  writeAccess((s) => {
    s.grants = s.grants.filter(
      (g) => !(g.personId === personId && g.projectId === projectId && g.permission === perm),
    );
  });
  if (!hasNow(personId, perm, projectId)) return;
  writeAccess((s) => {
    s.revocations.push({ personId, projectId, permission: perm });
  });
}

/**
 * Concede un permesso di progetto del prototipo (assegnabile a qualunque
 * ruolo) su un progetto di cui la persona è membro.
 */
export function grantProjectPermission(
  personId: string,
  projectId: string,
  perm: LocalProjectPermission,
): void {
  if (!isMember(personId, projectId)) return;
  grant(personId, perm, projectId);
}

/** Toglie un permesso di progetto del prototipo su un progetto, anche uno di base. */
export function revokeProjectPermission(
  personId: string,
  projectId: string,
  perm: LocalProjectPermission,
): void {
  if (!isMember(personId, projectId)) return;
  revoke(personId, perm, projectId);
}

/** Concede un permesso d'istanza del prototipo (assegnabile a qualunque ruolo). */
export function grantInstancePermission(personId: string, perm: LocalInstancePermission): void {
  grant(personId, perm, null);
}

/** Toglie un permesso d'istanza del prototipo, anche uno di base. */
export function revokeInstancePermission(personId: string, perm: LocalInstancePermission): void {
  revoke(personId, perm, null);
}

/** Riporta gli accessi al seme (ruoli, appartenenze, concessioni, reparti, persone). */
export function resetViewerGrants(): void {
  resetAccessState();
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

// Chi vede l'Amministrazione, e quali voci: `data/adminSections.ts` (area 9a).

// --- stato condiviso dell'app -----------------------------------------------

interface ViewerContextValue {
  viewer: Viewer;
  setPersona(personId: string): void;
}

const ViewerContext = createContext<ViewerContextValue>({
  viewer: viewerFor(DEFAULT_PERSONA_ID),
  setPersona: () => {},
});

/**
 * Da montare una volta nell'`App`: tiene la persona «vedi come» attiva e la
 * sessione del livello dati. La sessione si allinea DURANTE il render del
 * provider — prima che i figli rendano con la persona nuova — così nessuna
 * query parte (né si mostra) a nome della persona precedente.
 */
export function ViewerProvider({
  children,
  initialPersonId = DEFAULT_PERSONA_ID,
}: {
  children: ReactNode;
  initialPersonId?: string;
}) {
  const [personId, setPersonId] = useState(initialPersonId);
  // Ogni scrittura degli accessi (Members, Roles, reparti…) cambia cosa può
  // fare chi guarda, anche sé stesso: la versione entra nelle dipendenze del
  // valore del contesto, così chi legge `useViewer()` ri-renderizza e chiede
  // di nuovo `can()`. Le query le ricarica la scrittura (`useAdminWrite`).
  const accessVer = useSyncExternalStore(subscribeAccess, accessVersion);
  // Idempotente: rimette la sessione sulla persona di questo render.
  setSessionPersonId(personId);
  const value = useMemo<ViewerContextValue>(
    () => ({
      viewer: viewerFor(personId),
      setPersona: (next: string) => {
        // I messaggi parlano dei dati di chi guardava (un ritorno indietro su
        // una sua task): con la persona nuova non devono restare a schermo.
        if (next !== personId) {
          // Prima del cambio, con la sessione ancora della persona di prima:
          // ciò che aveva in sospeso parte a suo nome, non dell'altra.
          runBeforePersonaChange();
          clearToasts();
        }
        setPersonId(next);
      },
    }),
    // `accessVer` non si legge dentro: basta che cambi per dare un valore nuovo.
    [personId, accessVer],
  );
  return createElement(ViewerContext.Provider, { value }, children);
}

export function useViewer(): ViewerContextValue {
  return useContext(ViewerContext);
}
