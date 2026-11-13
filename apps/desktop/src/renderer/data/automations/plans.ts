import { CHAIN_MAX } from "@stubwise/shared";
import { PROJECT_NOT_FOUND, type EffectRequest } from "@stubwise/shared";
import { AUTOMATION_LIMITS } from "@stubwise/shared";
import { show } from "@stubwise/shared";
import * as core from "../../domain/automations/planCore";
import type { PlanWorld } from "../../domain/automations/planCore";
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
import type { Automation } from "../types";
import {
  canManageAutomation,
  canSeeAutomation,
  departmentRecipients,
  holdersOfRole,
  isDeactivated,
} from "./visibility";

// I PIANI delle azioni delle automazioni (area 7): cosa farebbe un'azione,
// con i controlli e le risoluzioni dell'esecuzione vera, senza scrivere
// niente. L'esecutore vero (`effects.ts`) fa il piano e poi scrive; la prova
// (`simulate.ts`) usa solo il piano. Così la prova fallisce dove fallirebbe
// la vera, con lo stesso codice e la stessa motivazione.
//
// Dalla R3 della fetta 1 i piani della fetta 1 (task, traguardo, richiesta,
// avviso, il progetto del passo) stanno in `domain/automations/planCore.ts`,
// puri e col mondo da fuori: qui il mondo è lo store del prototipo, e le
// firme restano quelle di prima. Email (F2), «avvia un'altra» e il progetto
// del cliente (F4) restano qui.

/** Il mondo dei piani nel prototipo: lo store. */
export const storeWorld: PlanWorld = {
  // Ogni lettura al momento (non un riferimento preso al caricamento): questi
  // moduli si importano a vicenda, e un `const` letto troppo presto è vuoto.
  person: (id) => PEOPLE.find((p) => p.id === id),
  isDeactivated: (id) => isDeactivated(id),
  holdersOfRole: (projectId, role) => holdersOfRole(projectId, role),
  departmentRecipients: (departmentId, projectId) => departmentRecipients(departmentId, projectId),
  canSeeProject: (personId, projectId) => visibleProjectIds(personId).has(projectId),
  projectGone: (projectId) => {
    const project = state.projectsById.get(projectId);
    return !project || !!project.archived;
  },
  checkNewTask: (owner, input) => checkNewTask(owner, input),
  checkNewMilestone: (owner, projectId, input) => checkNewMilestone(owner, projectId, input),
  checkNewRequest: (owner, input) => checkNewRequest(owner, input),
  defaultDepartmentOf: (personId) => defaultDepartmentOf(personId),
};

export type {
  ActionEffect,
  AssigneePlan,
  EffectOutcome,
  MilestonePlan,
  NotifyPlan,
  Planned,
  RequestPlan,
  TaskPlan,
} from "../../domain/automations/planCore";
export { failed, runLimitFailure } from "../../domain/automations/planCore";
import {
  failed,
  refuse,
  type ActionEffect,
  type EffectOutcome,
  type Planned,
} from "../../domain/automations/planCore";

export const personName = (id: string | null) => core.personName(storeWorld, id);
export const asFailure = (error: unknown, owner: string) =>
  core.asFailure(storeWorld, error, owner);
export const resolveAssignee = (
  who: Parameters<typeof core.resolveAssignee>[1],
  projectId: string,
) => core.resolveAssignee(storeWorld, who, projectId);
export const planTask = (eff: ActionEffect, a: Automation, owner: string, now: string) =>
  core.planTask(storeWorld, eff, a, owner, now);
export const planMilestone = (eff: ActionEffect, a: Automation, owner: string, now: string) =>
  core.planMilestone(storeWorld, eff, a, owner, now);
export const planRequest = (eff: ActionEffect, a: Automation, owner: string) =>
  core.planRequest(storeWorld, eff, a, owner);
export const planNotify = (eff: ActionEffect, a: Automation, owner: string) =>
  core.planNotify(storeWorld, eff, a, owner);

/** La profondità massima di una catena di avvii: del motore condiviso (area 7, F1). */
export { CHAIN_MAX };

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
