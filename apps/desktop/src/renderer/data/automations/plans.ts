import {
  PROJECT_NOT_FOUND,
  type EffectRequest,
  type EngineInput,
} from "../../domain/automations/engine";
import { AUTOMATION_LIMITS } from "../../domain/automations/fields";
import { show } from "../../domain/automations/preview";
import {
  checkNewMilestone,
  checkNewRequest,
  checkNewTask,
  defaultDepartmentOf,
} from "../api-mutations";
import { EMAIL, type MailDraftInput } from "../mail/compose";
import { checkSendNow } from "../mail/send";
import { PEOPLE } from "../seed/people";
import { state, visibleProjectIds } from "../store";
import type { Automation, ReasonCode, Step } from "../types";
import {
  canManageAutomation,
  canSeeAutomation,
  holdersOfRole,
  isDeactivated,
} from "./visibility";

// I PIANI delle azioni delle automazioni (area 7): cosa farebbe un'azione,
// con i controlli e le risoluzioni dell'esecuzione vera, senza scrivere
// niente. L'esecutore vero (`effects.ts`) fa il piano e poi scrive; la prova
// (`simulate.ts`) usa solo il piano. Così la prova fallisce dove fallirebbe
// la vera, con lo stesso codice e la stessa motivazione.

export interface EffectOutcome {
  input: EngineInput;
  /** Il progetto in cui l'effetto ha agito (entra in `projectIds` dell'esecuzione). */
  projectId?: string;
}

export const personName = (id: string | null) => PEOPLE.find((p) => p.id === id)?.name ?? id ?? "—";

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
export function asFailure(error: unknown, owner: string): EffectOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "forbidden" || message === "not_found") {
    return failed(
      "permission_lost",
      { code: "permissionLostHere", params: { owner: personName(owner) } },
      `Permesso perso: il proprietario (${personName(owner)}) non può più farlo in questo progetto.`,
    );
  }
  return failed(
    "invalid_input",
    { code: "invalidInput", params: { message } },
    `Dati non validi per il passo (${message}).`,
  );
}

/** Il progetto di un'azione, risolto dal motore. */
function projectOfEffect(eff: Extract<EffectRequest, { args: unknown }>, a: Automation) {
  const t = eff.projectTarget;
  if (!t) return null;
  return t.mode === "own" ? a.projectId : t.projectId;
}

/** La profondità massima di una catena di avvii. */
export const CHAIN_MAX = 3;

// --- i piani: cosa farebbe un'azione, senza scrivere ----------------------------------
//
// Ogni azione si decide in due tempi: il PIANO (progetto, incaricato,
// scadenza, testi, mittente — e i controlli, con lo stesso codice e la
// stessa motivazione dell'esecuzione vera) e la SCRITTURA. La prova
// (`simulate.ts`) usa solo i piani: fallisce dove fallirebbe la vera, e
// mostra quello che la vera farebbe, senza toccare lo store.

export type ActionEffect = Extract<EffectRequest, { args: unknown }>;

/** Un piano, o il fallimento con cui l'esecuzione vera si fermerebbe. */
export type Planned<T> = { ok: true; plan: T } | { ok: false; outcome: EffectOutcome };

const refuse = (outcome: EffectOutcome) => ({ ok: false as const, outcome });

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
  who: Exclude<Extract<Step, { kind: "createTask" }>["assignee"], { personRef: string }>,
  projectId: string,
): AssigneePlan {
  const firstDepartment = (id: string) => PEOPLE.find((p) => p.id === id)?.departmentIds[0];
  // Il dato Persona è già letto dal motore (`resolvePerson`): qui arriva l'id, o vuoto.
  if (who && "personId" in who && !PEOPLE.some((p) => p.id === who.personId && !p.isClaude)) {
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
    const assigneeId = holdersOfRole(projectId, who.projectRole)[0] ?? null;
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
  eff: ActionEffect,
  a: Automation,
  owner: string,
  now: string,
): Planned<TaskPlan> {
  const projectId = projectOfEffect(eff, a);
  if (!projectId || !visibleProjectIds(owner).has(projectId)) return refuse(lost(owner));
  const args = eff.args as {
    title: string;
    description: string;
    // Il dato Persona è già letto dal motore (`resolvePerson`).
    assignee: Parameters<typeof resolveAssignee>[0];
    dueInDays: number | null;
    milestoneCode: string | null;
  };
  try {
    checkNewTask(owner, { projectId, title: args.title });
  } catch (error) {
    return refuse(asFailure(error, owner));
  }
  // Una persona fissa disattivata (area 9a) non si assegna: si decide qui, nel
  // piano, così la prova fallisce dove fallirebbe la vera e il proprietario
  // legge il motivo in parole (non il codice della scrittura).
  const who = args.assignee;
  if (who && "personId" in who && isDeactivated(who.personId)) {
    const name = personName(who.personId);
    return refuse(
      failed(
        "assignee_deactivated",
        { code: "assigneeDeactivated", params: { name } },
        `${name} è una persona disattivata: la task non le si può assegnare.`,
      ),
    );
  }
  const assignee = resolveAssignee(args.assignee, projectId);
  return {
    ok: true,
    plan: {
      projectId,
      title: args.title,
      description: args.description,
      assignee,
      departmentId: assignee.departmentId ?? defaultDepartmentOf(owner),
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
  eff: ActionEffect,
  a: Automation,
  owner: string,
  now: string,
): Planned<MilestonePlan> {
  const projectId = projectOfEffect(eff, a);
  if (!projectId || !visibleProjectIds(owner).has(projectId)) return refuse(lost(owner));
  const args = eff.args as { name: string; dueInDays: number | null };
  const plan = { projectId, name: args.name, dueDate: dateIn(now, args.dueInDays) };
  try {
    checkNewMilestone(owner, projectId, { name: plan.name, dueDate: plan.dueDate });
  } catch (error) {
    return refuse(asFailure(error, owner));
  }
  return { ok: true, plan };
}

export interface RequestPlan {
  projectId: string;
  title: string;
  description: string;
}

export function planRequest(eff: ActionEffect, a: Automation, owner: string): Planned<RequestPlan> {
  const projectId = projectOfEffect(eff, a);
  if (!projectId || !visibleProjectIds(owner).has(projectId)) return refuse(lost(owner));
  const args = eff.args as { title: string; description: string };
  try {
    checkNewRequest(owner, { projectId, title: args.title });
  } catch (error) {
    return refuse(asFailure(error, owner));
  }
  return { ok: true, plan: { projectId, title: args.title, description: args.description } };
}

export interface EmailPlan {
  /** L'indirizzo della casella del proprietario da cui partirebbe. */
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Ciò che si passa a `sendNow`. */
  input: MailDraftInput;
  /** L'indirizzo che non esiste: l'email partirebbe e tornerebbe indietro. */
  bounced: string | null;
}

/** La conversazione in cui va un'email: una nuova, o la risposta a un messaggio. */
export type ThreadOf = Pick<MailDraftInput, "threadId" | "mode" | "replyToMessageId" | "quote">;

/**
 * `sentSoFar`: le email già partite dalla catena (il limite di 20 la
 * conta tutta); `thread`: in quale conversazione va; `attachmentId`: l'id
 * di ogni allegato; `mailbox`: la casella scelta accendendo o pubblicando
 * (`Automation.mailbox`), che deve essere ancora una casella del
 * proprietario — altrimenti `mailbox_missing`, con l'indirizzo nella
 * motivazione. `null`: la casella del proprietario.
 */
export function planEmail(
  eff: ActionEffect,
  owner: string,
  sentSoFar: number,
  thread: (to: string) => ThreadOf,
  attachmentId: (i: number) => string,
  mailbox: string | null = null,
): Planned<EmailPlan> {
  const args = eff.args as { to: string; subject: string; body: string; attachments: unknown[] };
  if (sentSoFar >= AUTOMATION_LIMITS.emailsPerRun) {
    return refuse(
      failed(
        "email_limit",
        { code: "emailLimitChain", params: { max: AUTOMATION_LIMITS.emailsPerRun } },
        `Limite raggiunto: al massimo ${AUTOMATION_LIMITS.emailsPerRun} email per esecuzione, contando le automazioni avviate da questa.`,
      ),
    );
  }
  if (
    mailbox !== null &&
    !state.mailboxes.some(
      (b) => b.personId === owner && b.email.toLowerCase() === mailbox.toLowerCase(),
    )
  ) {
    return refuse(
      failed(
        "mailbox_missing",
        { code: "mailboxGone", params: { mailbox, owner: personName(owner) } },
        `La casella scelta per l'automazione (${mailbox}) non è più collegata a ${personName(owner)}: l'email non è partita.`,
      ),
    );
  }
  if (!state.mailboxes.some((b) => b.personId === owner)) {
    return refuse(
      failed(
        "mailbox_missing",
        { code: "noMailbox", params: { owner: personName(owner) } },
        `Il proprietario (${personName(owner)}) non ha una casella collegata: l'email non è partita.`,
      ),
    );
  }
  if (state.googleAccounts.find((g) => g.personId === owner)?.status !== "connected") {
    return refuse(
      failed(
        "mailbox_expired",
        { code: "mailboxExpired", params: { owner: personName(owner) } },
        `La casella del proprietario (${personName(owner)}) è scaduta: va ricollegata prima di riprovare.`,
      ),
    );
  }
  const to = args.to.trim();
  if (!EMAIL.test(to))
    return refuse(
      failed(
        "invalid_address",
        { code: "invalidAddress", params: { to } },
        `«${to}» non è un indirizzo email.`,
      ),
    );
  const input: MailDraftInput = {
    ...thread(to),
    to: [{ name: "", email: to, personId: null }],
    cc: [],
    subject: args.subject,
    body: args.body,
    attachments: args.attachments.map((f, i) => ({
      id: attachmentId(i),
      name: show(f) || `Allegato ${i + 1}`,
      sizeBytes: show((f as { testo?: unknown } | null)?.testo).length,
      driveFileId: null,
      as: "copy" as const,
    })),
  };
  try {
    const { from, bounced } = checkSendNow(owner, input, { from: mailbox });
    return {
      ok: true,
      plan: { from, to, subject: args.subject, body: args.body, input, bounced },
    };
  } catch (error) {
    return refuse(asFailure(error, owner));
  }
}

/** L'email è tornata indietro: l'indirizzo non esiste. */
export const bouncedFailure = (to: string): EffectOutcome =>
  failed(
    "address_not_found",
    { code: "addressNotFound", params: { to } },
    `L'indirizzo «${to}» non esiste: l'email è tornata indietro.`,
  );

export interface NotifyPlan {
  personId: string;
  /** Il progetto del passo, o nessuno (una generale che non ne ha risolto uno). */
  projectId: string | null;
  text: string;
}

export function planNotify(eff: ActionEffect, a: Automation, owner: string): Planned<NotifyPlan> {
  const args = eff.args as { who: { personId: string } | { projectRole: string }; text: string };
  // Il progetto del passo: quello dell'automazione, o uno risolto; una generale senza
  // progetto avvisa senza progetto (mai un progetto preso a caso fra quelli toccati).
  const projectId = projectOfEffect(eff, a) ?? a.projectId;
  // Come gli altri effetti: coi permessi del proprietario, che deve vedere il progetto del passo.
  if (projectId && !visibleProjectIds(owner).has(projectId)) return refuse(lost(owner));
  // Un ruolo: la prima persona col ruolo nel progetto, in ordine alfabetico (come «Crea task»).
  const personId =
    "projectRole" in args.who
      ? projectId
        ? (holdersOfRole(projectId, args.who.projectRole)[0] ?? "")
        : ""
      : args.who.personId;
  const person = PEOPLE.find((p) => p.id === personId && !p.isClaude);
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
  if (projectId && !visibleProjectIds(person.id).has(projectId)) {
    return refuse(
      failed(
        "recipient_cant_see",
        { code: "recipientCantSee", params: { name: person.name } },
        `${person.name} non vede il progetto: l'avviso non parte.`,
      ),
    );
  }
  return { ok: true, plan: { personId: person.id, projectId, text: args.text } };
}

/**
 * «Avvia un'altra automazione»: quella da avviare, se si può. `chain`: le
 * automazioni della catena di avvii sopra questa, questa compresa.
 */
export function planStart(eff: ActionEffect, owner: string, chain: string[]): Planned<Automation> {
  const id = (eff.args as { automationId: string }).automationId;
  const target = state.automations.find((a) => a.id === id);
  if (!target || !canSeeAutomation(owner, target)) {
    return refuse(
      failed(
        "automation_not_found",
        { code: "automationNotFound" },
        "L'automazione da avviare non esiste o il proprietario non la vede.",
      ),
    );
  }
  // R-J21: avviarla è come «Avvia ora» — il proprietario deve poterla gestire.
  if (!canManageAutomation(owner, target)) {
    return refuse(
      failed(
        "permission_lost",
        { code: "cantManage", params: { owner: personName(owner), name: target.name } },
        `Permesso perso: il proprietario (${personName(owner)}) non può gestire «${target.name}».`,
      ),
    );
  }
  if (target.status !== "active") {
    return refuse(
      failed(
        "automation_not_active",
        { code: "automationNotActive", params: { name: target.name } },
        `«${target.name}» non è attiva: non è partita.`,
      ),
    );
  }
  if (chain.includes(target.id)) {
    return refuse(
      failed(
        "automation_cycle",
        { code: "automationCycle", params: { name: target.name } },
        `«${target.name}» è già in questa catena di avvii: niente cicli.`,
      ),
    );
  }
  if (chain.length >= CHAIN_MAX) {
    return refuse(
      failed(
        "chain_limit",
        { code: "chainLimit", params: { max: CHAIN_MAX } },
        `Limite raggiunto: al massimo ${CHAIN_MAX} automazioni in una catena di avvii.`,
      ),
    );
  }
  return { ok: true, plan: target };
}

/** L'automazione avviata non può partire (troppe esecuzioni in corso, `startRun` → null). */
export const runLimitFailure = (name: string): EffectOutcome =>
  failed(
    "run_limit",
    { code: "runLimit", params: { name } },
    `«${name}» ha già troppe esecuzioni in corso.`,
  );

const lost = (owner: string) =>
  failed(
    "permission_lost",
    { code: "permissionLost", params: { owner: personName(owner) } },
    `Permesso perso: il proprietario (${personName(owner)}) non vede più il progetto del passo.`,
  );

// --- il progetto del cliente ------------------------------------------------------

export function resolveProject(
  eff: Extract<EffectRequest, { kind: "resolve_project" }>,
  owner: string,
): EffectOutcome {
  const link = state.clientProjectLinks.find((l) => l.clientKey === eff.clientKey);
  // Un progetto che il proprietario non vede vale come uno che non c'è (R-G5).
  if (
    !link ||
    !state.projectsById.has(link.projectId) ||
    !visibleProjectIds(owner).has(link.projectId)
  )
    return { input: { kind: "effect_result", ok: false, error: PROJECT_NOT_FOUND } };
  return {
    input: { kind: "project_chosen", projectId: link.projectId },
    projectId: link.projectId,
  };
}
