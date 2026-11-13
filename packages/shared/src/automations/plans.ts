import type { EffectRequest, EngineInput } from "./engine.js";
import type { Automation, ReasonCode, Step } from "./types.js";

// I PIANI delle azioni della fetta 1 (area 7, R3): cosa farebbe un'azione,
// coi controlli dell'esecuzione vera, senza scrivere e senza leggere uno
// store. Il mondo (persone, ruoli, reparti, progetti, i controlli dei
// permessi del proprietario) arriva da fuori (`PlanWorld`): nel prototipo
// dallo store, nella prova della build app dal contesto del server, nel
// worker da un'istantanea del DB prima di ogni effetto. Una regola sola:
// l'esecuzione vera e la prova falliscono allo stesso passo, con lo stesso
// codice e la stessa motivazione. Spostato qui dal renderer
// (`domain/automations/planCore.ts`, che lo ri-esporta) per il worker.

/** Una persona come la leggono i piani. */
export interface PlanPerson {
  id: string;
  name: string;
  departmentIds: string[];
  isClaude?: boolean;
}

/** I fatti che i piani leggono: nessuno è una scrittura. */
export interface PlanWorld {
  person(id: string): PlanPerson | undefined;
  isDeactivated(personId: string): boolean;
  /** Chi ha il ruolo nel progetto, in ordine alfabetico. */
  holdersOfRole(projectId: string, role: string): string[];
  /** I membri del reparto che vedono il progetto (`null`: nessun progetto). */
  departmentRecipients(departmentId: string, projectId: string | null): string[];
  canSeeProject(personId: string, projectId: string): boolean;
  /** Archiviato, eliminato o mai esistito: per nessuno. */
  projectGone(projectId: string): boolean;
  /**
   * I controlli delle scritture di oggi, coi permessi del proprietario:
   * lanciano `forbidden`, `not_found` o un dato non valido.
   */
  checkNewTask(owner: string, input: { projectId: string; title: string }): void;
  checkNewMilestone(
    owner: string,
    projectId: string,
    input: { name: string; dueDate: string | null },
  ): void;
  checkNewRequest(owner: string, input: { projectId: string; title: string }): void;
  defaultDepartmentOf(personId: string): string | null;
}

export const personName = (w: PlanWorld, id: string | null) =>
  (id ? w.person(id)?.name : undefined) ?? id ?? "—";

/** Una persona vera (non Claude), se c'è. */
const notClaude = (w: PlanWorld, id: string) => {
  const p = w.person(id);
  return p && !p.isClaude ? p : undefined;
};

export interface EffectOutcome {
  input: EngineInput;
  /** Il progetto in cui l'effetto ha agito (entra in `projectIds` dell'esecuzione). */
  projectId?: string;
}

/**
 * Un effetto che non parte: il codice macchina (`error`), la motivazione
 * per l'interfaccia (`why`, tradotta e nella prova al condizionale) e la
 * prosa del registro (`reason`).
 */
export const failed = (error: string, why: ReasonCode, reason: string): EffectOutcome => ({
  input: { kind: "effect_result", ok: false, error, reason, why },
});

const DAY = 86_400_000;
const dateIn = (now: string, days: number | null): string | null =>
  days === null ? null : new Date(Date.parse(now) + days * DAY).toISOString().slice(0, 10);

/** Un errore di una scrittura di oggi, come codice dell'esecuzione. */
export function asFailure(w: PlanWorld, error: unknown, owner: string): EffectOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "forbidden" || message === "not_found") {
    return failed(
      "permission_lost",
      { code: "permissionLostHere", params: { owner: personName(w, owner) } },
      `Permesso perso: il proprietario (${personName(w, owner)}) non può più farlo in questo progetto.`,
    );
  }
  return failed(
    "invalid_input",
    { code: "invalidInput", params: { message } },
    `Dati non validi per il passo (${message}).`,
  );
}

/** Il progetto di un'azione, risolto dal motore. */
export function projectOfEffect(eff: Extract<EffectRequest, { args: unknown }>, a: Automation) {
  const t = eff.projectTarget;
  if (!t) return null;
  return t.mode === "own" ? a.projectId : t.projectId;
}

export type ActionEffect = Extract<EffectRequest, { args: unknown }>;

/** Un piano, o il fallimento con cui l'esecuzione vera si fermerebbe. */
export type Planned<T> = { ok: true; plan: T } | { ok: false; outcome: EffectOutcome };

export const refuse = (outcome: EffectOutcome) => ({ ok: false as const, outcome });

/** L'incaricato di «Crea task» e come è stato scelto (Global Constraints). */
export interface AssigneePlan {
  assigneeId: string | null;
  departmentId: string | undefined;
  by: "person" | "department" | "role" | "none";
  role: string | null;
  /** La riga d'avviso del registro: nessuno ha il ruolo, la task nasce senza incaricato. */
  reason: string | undefined;
  /** Lo stesso avviso per l'interfaccia (B1). */
  why?: ReasonCode;
}

/**
 * Persona → lei (e il suo primo reparto); reparto → nessun incaricato, quel
 * reparto; ruolo nel progetto → il primo col ruolo in ordine alfabetico,
 * nessuno → senza incaricato e un avviso.
 */
export function resolveAssignee(
  w: PlanWorld,
  who: Exclude<Extract<Step, { kind: "createTask" }>["assignee"], { personRef: string }>,
  projectId: string,
): AssigneePlan {
  const firstDepartment = (id: string) => w.person(id)?.departmentIds[0];
  // Il dato Persona è già letto dal motore (`resolvePerson`): qui arriva l'id, o vuoto.
  if (who && "personId" in who && !(w.person(who.personId) && !w.person(who.personId)!.isClaude)) {
    return {
      assigneeId: null,
      departmentId: undefined,
      by: "none",
      role: null,
      reason: "Il dato della persona è vuoto: la task nasce senza incaricato.",
      why: { code: "noAssignee" },
    };
  }
  if (who && "personId" in who) {
    return {
      assigneeId: who.personId,
      departmentId: firstDepartment(who.personId),
      by: "person",
      role: null,
      reason: undefined,
    };
  }
  if (who && "departmentId" in who) {
    return {
      assigneeId: null,
      departmentId: who.departmentId,
      by: "department",
      role: null,
      reason: undefined,
    };
  }
  if (who && "projectRole" in who) {
    const assigneeId = w.holdersOfRole(projectId, who.projectRole)[0] ?? null;
    return {
      assigneeId,
      departmentId: assigneeId ? firstDepartment(assigneeId) : undefined,
      by: "role",
      role: who.projectRole,
      reason: assigneeId
        ? undefined
        : `Nessuno ha il ruolo «${who.projectRole}» nel progetto: la task nasce senza incaricato.`,
      ...(assigneeId ? {} : { why: { code: "noRoleAssignee", params: { role: who.projectRole } } }),
    };
  }
  return { assigneeId: null, departmentId: undefined, by: "none", role: null, reason: undefined };
}

export interface TaskPlan {
  projectId: string;
  title: string;
  description: string;
  assignee: AssigneePlan;
  /** Il reparto della task: quello dell'incaricato o del passo, altrimenti il primo del proprietario. */
  departmentId: string | null;
  dueDate: string | null;
  /** Il codice del traguardo creato da un passo precedente (`milestoneRef`). */
  milestoneCode: string | null;
}

export function planTask(
  w: PlanWorld,
  eff: ActionEffect,
  a: Automation,
  owner: string,
  now: string,
): Planned<TaskPlan> {
  const projectId = projectOfEffect(eff, a);
  const refused = projectRefusal(w, projectId, owner);
  if (refused || !projectId) return refused ?? refuse(unavailable());
  const args = eff.args as {
    title: string;
    description: string;
    // Il dato Persona è già letto dal motore (`resolvePerson`).
    assignee: Parameters<typeof resolveAssignee>[1];
    dueInDays: number | null;
    milestoneCode: string | null;
  };
  try {
    w.checkNewTask(owner, { projectId, title: args.title });
  } catch (error) {
    return refuse(asFailure(w, error, owner));
  }
  // Una persona fissa disattivata (area 9a) non si assegna: si decide qui, nel
  // piano, così la prova fallisce dove fallirebbe la vera e il proprietario
  // legge il motivo in parole (non il codice della scrittura).
  const who = args.assignee;
  if (who && "personId" in who && w.isDeactivated(who.personId)) {
    const name = personName(w, who.personId);
    return refuse(
      failed(
        "assignee_deactivated",
        { code: "assigneeDeactivated", params: { name } },
        `${name} è una persona disattivata: la task non le si può assegnare.`,
      ),
    );
  }
  const assignee = resolveAssignee(w, args.assignee, projectId);
  return {
    ok: true,
    plan: {
      projectId,
      title: args.title,
      description: args.description,
      assignee,
      departmentId: assignee.departmentId ?? w.defaultDepartmentOf(owner),
      dueDate: dateIn(now, args.dueInDays),
      milestoneCode: args.milestoneCode,
    },
  };
}

export interface MilestonePlan {
  projectId: string;
  name: string;
  dueDate: string | null;
}

export function planMilestone(
  w: PlanWorld,
  eff: ActionEffect,
  a: Automation,
  owner: string,
  now: string,
): Planned<MilestonePlan> {
  const projectId = projectOfEffect(eff, a);
  const refused = projectRefusal(w, projectId, owner);
  if (refused || !projectId) return refused ?? refuse(unavailable());
  const args = eff.args as { name: string; dueInDays: number | null };
  const plan = { projectId, name: args.name, dueDate: dateIn(now, args.dueInDays) };
  try {
    w.checkNewMilestone(owner, projectId, { name: plan.name, dueDate: plan.dueDate });
  } catch (error) {
    return refuse(asFailure(w, error, owner));
  }
  return { ok: true, plan };
}

export interface RequestPlan {
  projectId: string;
  title: string;
  description: string;
}

export function planRequest(
  w: PlanWorld,
  eff: ActionEffect,
  a: Automation,
  owner: string,
): Planned<RequestPlan> {
  const projectId = projectOfEffect(eff, a);
  const refused = projectRefusal(w, projectId, owner);
  if (refused || !projectId) return refused ?? refuse(unavailable());
  const args = eff.args as { title: string; description: string };
  try {
    w.checkNewRequest(owner, { projectId, title: args.title });
  } catch (error) {
    return refuse(asFailure(w, error, owner));
  }
  return { ok: true, plan: { projectId, title: args.title, description: args.description } };
}

export interface NotifyPlan {
  /**
   * Chi riceve l'avviso, uno per persona: la persona, il primo col ruolo, o
   * i membri del reparto che vedono il progetto del passo (area 10b).
   */
  personIds: string[];
  /** Il progetto del passo, o nessuno (una generale che non ne ha risolto uno). */
  projectId: string | null;
  text: string;
}

type NotifyWho = { personId: string } | { projectRole: string } | { departmentId: string };

export function planNotify(
  w: PlanWorld,
  eff: ActionEffect,
  a: Automation,
  owner: string,
): Planned<NotifyPlan> {
  const args = eff.args as { who: NotifyWho; text: string };
  // Il progetto del passo: quello dell'automazione, o uno risolto; una generale senza
  // progetto avvisa senza progetto (mai un progetto preso a caso fra quelli toccati).
  const projectId = projectOfEffect(eff, a) ?? a.projectId;
  // Come gli altri effetti: coi permessi del proprietario, che deve vedere il progetto del passo.
  const refused = projectId ? projectRefusal(w, projectId, owner) : null;
  if (refused) return refused;
  // Un reparto: ogni membro che vede il progetto, e nessun altro (R-G5). Chi non lo
  // vede non si nomina nemmeno nel motivo del fallimento.
  if ("departmentId" in args.who) {
    const personIds = w.departmentRecipients(args.who.departmentId, projectId);
    if (personIds.length === 0) {
      return refuse(
        failed(
          "no_recipient",
          { code: "noDepartmentRecipient" },
          "Nessuno del reparto vede il progetto: non c'è nessuno da avvisare.",
        ),
      );
    }
    return { ok: true, plan: { personIds, projectId, text: args.text } };
  }
  // Un ruolo: la prima persona col ruolo nel progetto, in ordine alfabetico (come «Crea task»).
  const personId =
    "projectRole" in args.who
      ? projectId
        ? (w.holdersOfRole(projectId, args.who.projectRole)[0] ?? "")
        : ""
      : args.who.personId;
  const person = notClaude(w, personId);
  if (!personId || !person) {
    return refuse(
      "projectRole" in args.who
        ? failed(
            "no_recipient",
            {
              code: projectId ? "noRoleHolder" : "noRoleProject",
              params: { role: args.who.projectRole },
            },
            projectId
              ? `Nessuno ha il ruolo «${args.who.projectRole}» nel progetto: non c'è nessuno da avvisare.`
              : `Senza un progetto non c'è un «${args.who.projectRole}» da avvisare.`,
          )
        : failed(
            "no_recipient",
            { code: "noRecipient" },
            "Non c'è nessuno da avvisare: il dato della persona è vuoto.",
          ),
    );
  }
  if (projectId && !w.canSeeProject(person.id, projectId)) {
    return refuse(
      failed(
        "recipient_cant_see",
        { code: "recipientCantSee", params: { name: person.name } },
        `${person.name} non vede il progetto: l'avviso non parte.`,
      ),
    );
  }
  return { ok: true, plan: { personIds: [person.id], projectId, text: args.text } };
}

/** L'automazione avviata non può partire (troppe esecuzioni in corso, `startRun` → null). */
export const runLimitFailure = (name: string): EffectOutcome =>
  failed(
    "run_limit",
    { code: "runLimit", params: { name } },
    `«${name}» ha già troppe esecuzioni in corso.`,
  );

/**
 * Area 9c ([PX 5], confermata dal maintainer): il progetto del passo non
 * c'è più per nessuno — archiviato, eliminato (il passo resta senza id,
 * `purge.ts`) o mai esistito. Il passo non si fa e l'esecuzione finisce non
 * riuscita, con la frase neutra: nessun codice né nome del progetto.
 */
export const projectGone = (w: PlanWorld, projectId: string | null): boolean => {
  if (!projectId) return true;
  return w.projectGone(projectId);
};

export const unavailable = () =>
  failed(
    "project_unavailable",
    { code: "projectUnavailable" },
    "Il progetto del passo non è più disponibile.",
  );

/** Il progetto del passo: non più disponibile, o che il proprietario non vede più. */
export const projectRefusal = (w: PlanWorld, projectId: string | null, owner: string) =>
  projectGone(w, projectId)
    ? refuse(unavailable())
    : !w.canSeeProject(owner, projectId!)
      ? refuse(lost(w, owner))
      : null;

const lost = (w: PlanWorld, owner: string) =>
  failed(
    "permission_lost",
    { code: "permissionLost", params: { owner: personName(w, owner) } },
    `Permesso perso: il proprietario (${personName(w, owner)}) non vede più il progetto del passo.`,
  );
