import type { ProjectPermission } from "@stubwise/shared";
import type { DbOrTx } from "./dispatch.js";
import type { RequestCreatedEvent } from "./format.js";
import { publishNotification, type PublishOpts } from "./publish.js";

/**
 * Una richiesta va annunciata se viene da un COLLABORATORE: chi, nel progetto
 * della richiesta, NON ha `project.members.manage` — cioè chi non è fra i
 * destinatari stessi dell'avviso (`request.created` → `project.members.manage`,
 * ruling R14). Il `member` di prima, convertito in Legacy Member, ricade qui.
 * `null` = il richiedente non vede (più) il progetto: è comunque un
 * collaboratore. UNA regola per i due punti che pubblicano: la creazione del
 * ticket sul server e l'intake del backlog nel worker.
 */
export function isCollaboratorRequest(
  requesterPermissions: ReadonlySet<ProjectPermission> | null,
): boolean {
  return !(requesterPermissions?.has("project.members.manage") ?? false);
}

/** Cosa sa chi pubblica: l'evento senza `kind`. */
export type RequestCreatedInput = Omit<RequestCreatedEvent, "kind">;

/**
 * Avvisa gli admin che un collaboratore ha aperto un bug o una richiesta
 * (audience `admins`, webhook sotto `notifyTicketCreated`). Come
 * `publishNotification` NON LANCIA mai: un avviso mancato non deve far
 * fallire la creazione del ticket né il job di intake. L'ancora è il progetto
 * (e il ticket, se c'è): l'instradamento resta `admins`.
 */
export async function publishRequestCreated(
  db: DbOrTx,
  input: RequestCreatedInput,
  deps: { publish?: typeof publishNotification } = {},
): Promise<void> {
  const publish = deps.publish ?? publishNotification;
  const opts: PublishOpts = {
    projectId: input.projectId,
    ...(input.ticketId !== undefined ? { ticketId: input.ticketId } : {}),
  };
  try {
    await publish(db, { kind: "request.created", ...input }, opts);
  } catch {
    // Best-effort.
  }
}
