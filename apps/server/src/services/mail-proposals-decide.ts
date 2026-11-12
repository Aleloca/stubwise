import {
  emailMessages,
  emailProposalRecipients,
  emailProposals,
  googleAccounts,
  notifications,
  projectMembers,
  projects,
  roles,
  recordDecision,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import { permissionForMailAction, projectPermissionsOfUser, projectViewerIds } from "@stubwise/notifications";
import { ticketPrioritySchema, ticketStatusSchema, type MailProposal, type ProjectPermission, type TicketPriority, type TicketStatus } from "@stubwise/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { decideLegacy } from "./mail-proposals-legacy.js";
import { putProjectMember, RoleRuleError } from "./roles.js";
import { createTicket } from "../db/tickets.js";
import { enqueueBacklogIntake } from "./backlog-intake.js";
import { addSystemComment } from "./comments.js";
import { createMilestone } from "./milestones.js";
import { patchTicket } from "./tickets.js";
import { assigneeIdsOf, proposalPermissionsOf } from "./mail-proposals.js";

/**
 * DECIDERE UNA PROPOSTA CONDIVISA DELLA POSTA (area 6, fetta 2, D4).
 *
 * Chi decide: un destinatario registrato (`email_proposal_recipients`), coi
 * SUOI permessi nel progetto per OGNI azione scelta. Il primo che decide la
 * chiude per tutti: la riga si blocca (`FOR UPDATE`) e lo stato si
 * ricontrolla dentro la transazione, quindi due conferme simultanee ne
 * eseguono UNA (l'altra ha `already_handled` con chi ha deciso), e le card di
 * tutti i destinatari si chiudono insieme.
 *
 * La conferma PARZIALE (`indices`) esegue solo le azioni scelte, tutte o
 * nessuna: un'azione che fallisce annulla le altre (una transazione), e la
 * proposta resta `failed` con l'errore. `edits` cambia i campi modificabili
 * di un'azione scelta, e solo quelli (il progetto e il bersaglio no: si
 * cambiano con «Sposta»).
 *
 * Gli esecutori sono gli stessi della posta di prima (intake delle richieste,
 * milestone, patch e commento delle task, registro decisioni da TEMPLATE, mai
 * prosa del modello), più la task (`createTicket`, con `source = email`:
 * contenuto venuto da fuori per la regola «almeno B»).
 */

export type DecideError =
  | "not_found"
  | "already_handled"
  | "forbidden"
  | "invalid_selection"
  | "invalid_edits"
  | "invalid_assignee"
  | "invalid_target";

export type DecideResult =
  | { ok: true; status: "confirmed"; results: MailProposal["results"] }
  | { ok: true; status: "failed"; error: string }
  | { ok: true; status: "ignored" }
  | { ok: true; status: "handed" }
  | { ok: true; status: "moved"; projectId: string }
  | { ok: false; error: DecideError; decidedBy?: { userId: string; name: string } | null };

/** Chi decide: basta l'id, i permessi si leggono dal DB (anche dall'inbox). */
type Viewer = { id: string };
interface StoredAction {
  type: string;
  args: Record<string, unknown>;
}

/** I campi che una persona può modificare, per tipo (il prototipo). */
const EDITABLE: Record<string, readonly string[]> = {
  create_task: ["title", "description", "assigneeId", "dueDate"],
  create_backlog_item: ["title", "description"],
  comment_ticket: ["body"],
  create_milestone: ["name", "dueDate"],
  update_ticket: ["patch"],
  record_decision: [],
};

const OPEN = new Set(["classified", "proposed"]);

/** La proposta che chi guarda può decidere, o l'errore. */
async function loadDecidable(db: Db, viewer: Viewer, id: string) {
  const [row] = await db
    .select({
      proposal: emailProposals,
      message: emailMessages,
      mailboxEmail: googleAccounts.email,
      recipient: emailProposalRecipients.userId,
    })
    .from(emailProposals)
    .leftJoin(emailProposalRecipients, and(eq(emailProposalRecipients.proposalId, emailProposals.id), eq(emailProposalRecipients.userId, viewer.id)))
    .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(and(eq(emailProposals.id, id), eq(emailProposals.audience, "mail_recipients")));
  if (!row) return null;
  const permissions = await proposalPermissionsOf(db, viewer.id, row.proposal);
  if (!permissions) return null;
  // Non destinatario: solo una proposta PASSATA, e solo a chi ha il permesso
  // di OGNI sua azione nel progetto (il prototipo).
  if (!row.recipient && !(row.proposal.handedAt && coversAll(row.proposal, permissions))) return null;
  return { proposal: row.proposal, message: row.message, mailboxEmail: row.mailboxEmail, permissions, isRecipient: row.recipient !== null };
}

/** Chi ha il permesso di ogni azione della proposta. */
export function coversAll(proposal: { classification: unknown }, permissions: ReadonlySet<ProjectPermission>): boolean {
  const actions = (proposal.classification as { actions?: StoredAction[] }).actions ?? [];
  return actions.length > 0 && actions.every((a) => {
    const needed = permissionForMailAction(a.type);
    return !needed || permissions.has(needed as ProjectPermission);
  });
}

async function decidedByOf(db: Db, userId: string | null) {
  if (!userId) return null;
  const [row] = await db.select({ userId: users.id, displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, userId));
  return row ? { userId: row.userId, name: row.displayName ?? row.email.split("@")[0]! } : null;
}

/** Chiude le card di TUTTI i destinatari. */
async function closeCards(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], proposalId: string): Promise<void> {
  const rows = await tx
    .select({ id: emailProposalRecipients.notificationId })
    .from(emailProposalRecipients)
    .where(eq(emailProposalRecipients.proposalId, proposalId));
  const ids = rows.map((r) => r.id).filter((id): id is string => id !== null);
  if (ids.length === 0) return;
  await tx
    .update(notifications)
    .set({ status: "handled", handledAt: new Date() })
    .where(and(inArray(notifications.id, ids), eq(notifications.status, "open")));
}

function validDate(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
}

/**
 * La patch di una task, ristretta e validata (review F2, punto 5): solo
 * `status`, `priority` e `assigneeId`, con gli enum delle task. La scrive il
 * MODELLO (o chi modifica la proposta): un campo in più o un valore inventato
 * non arrivano mai a `patchTicket`. `null` = patch non valida o vuota.
 */
export function validTicketPatch(raw: unknown): { status?: TicketStatus; priority?: TicketPriority; assigneeId?: string | null } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: { status?: TicketStatus; priority?: TicketPriority; assigneeId?: string | null } = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "status") {
      const parsed = ticketStatusSchema.safeParse(value);
      if (!parsed.success) return null;
      out.status = parsed.data;
    } else if (key === "priority") {
      const parsed = ticketPrioritySchema.safeParse(value);
      if (!parsed.success) return null;
      out.priority = parsed.data;
    } else if (key === "assigneeId") {
      if (value !== null && typeof value !== "string") return null;
      out.assigneeId = value;
    } else {
      return null;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Applica le modifiche consentite; `null` = modifiche non valide. */
function applyEdits(action: StoredAction, edit: Record<string, unknown>): StoredAction | null {
  const allowed = EDITABLE[action.type] ?? [];
  const args = { ...action.args };
  for (const [key, value] of Object.entries(edit)) {
    if (!allowed.includes(key)) return null;
    if ((key === "title" || key === "name" || key === "body") && (typeof value !== "string" || value.trim() === "")) return null;
    if (key === "description" && typeof value !== "string") return null;
    if (key === "dueDate" && !validDate(value)) return null;
    if (key === "assigneeId" && value !== null && typeof value !== "string") return null;
    if (key === "patch" && !validTicketPatch(value)) return null;
    args[key] = typeof value === "string" ? value.trim() : value;
  }
  return { type: action.type, args };
}

/** L'incaricato di un'azione, se ne ha uno. */
function assigneeOf(action: StoredAction): string | null {
  const raw = action.type === "update_ticket" ? (action.args.patch as Record<string, unknown> | undefined)?.assigneeId : action.args.assigneeId;
  return typeof raw === "string" ? raw : null;
}

class ActionFailed extends Error {}

export async function confirmMailProposal(
  db: Db,
  viewer: Viewer,
  id: string,
  input: { indices?: number[] | undefined; edits?: Record<string, Record<string, unknown>> | undefined },
  lang: Language,
): Promise<DecideResult> {
  const loaded = await loadDecidable(db, viewer, id);
  if (!loaded) return (await decideLegacy(db, viewer.id, id, { kind: "confirm", indices: input.indices, edits: input.edits })) ?? { ok: false, error: "not_found" };
  const { proposal, message, mailboxEmail, permissions } = loaded;
  if (!OPEN.has(proposal.status)) {
    return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, proposal.decidedByUserId) };
  }
  const stored = proposal.classification as { actions?: StoredAction[]; choose?: unknown };
  if (stored.choose) return { ok: false, error: "invalid_selection" };
  const all = stored.actions ?? [];

  const indices = input.indices ?? all.map((_, i) => i);
  if (indices.length === 0 || new Set(indices).size !== indices.length || indices.some((i) => !Number.isInteger(i) || i < 0 || i >= all.length)) {
    return { ok: false, error: "invalid_selection" };
  }
  const chosen: StoredAction[] = [];
  for (const index of indices) {
    const edit = input.edits?.[String(index)];
    const action = edit ? applyEdits(all[index]!, edit) : all[index]!;
    if (!action) return { ok: false, error: "invalid_edits" };
    chosen.push(action);
  }
  if (input.edits && Object.keys(input.edits).some((k) => !indices.includes(Number(k)))) return { ok: false, error: "invalid_edits" };

  for (const action of chosen) {
    const needed = permissionForMailAction(action.type);
    if (needed && !permissions.has(needed as ProjectPermission)) return { ok: false, error: "forbidden" };
  }
  // Un incaricato fuori dal progetto: lo si aggiunge come Contributor
  // (`confirm-with-members`), o si sceglie un altro.
  const assignees = chosen.map(assigneeOf).filter((a): a is string => a !== null);
  if (assignees.length > 0) {
    const viewers = new Set(await projectViewerIds(db, proposal.projectId));
    if (assignees.some((a) => !viewers.has(a))) return { ok: false, error: "invalid_assignee" };
  }

  const [project] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, proposal.projectId));
  const from = message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress;
  const subject = message.subject ?? t(lang, "email.input.none");

  try {
    return await db.transaction(async (tx) => {
      const [locked] = await tx.select({ status: emailProposals.status, decidedBy: emailProposals.decidedByUserId }).from(emailProposals).where(eq(emailProposals.id, id)).for("update");
      if (!locked || !OPEN.has(locked.status)) {
        return { ok: false as const, error: "already_handled" as const, decidedBy: await decidedByOf(db, locked?.decidedBy ?? null) };
      }
      const results: MailProposal["results"] = [];
      for (const [position, action] of chosen.entries()) {
        const a = action.args;
        switch (action.type) {
          case "create_task": {
            const ticket = await createTicket(tx as unknown as Db, {
              projectId: proposal.projectId,
              title: String(a.title),
              body: typeof a.description === "string" ? a.description : "",
              type: "task",
              priority: "medium",
              // Contenuto venuto da fuori: conta per la regola «almeno B».
              source: "email",
              ...(typeof a.assigneeId === "string" ? { assigneeId: a.assigneeId } : {}),
              ...(typeof a.dueDate === "string" ? { dueDate: a.dueDate } : {}),
              requestedByUserId: viewer.id,
            });
            results.push({ kind: "task", id: ticket.id, code: project?.code ? `${project.code}-${ticket.number}` : null });
            break;
          }
          case "create_backlog_item": {
            const r = await enqueueBacklogIntake(tx, {
              projectId: proposal.projectId,
              title: String(a.title),
              body: (typeof a.description === "string" && a.description.trim()) || subject,
              requestedByUserId: viewer.id,
              externalOrigin: "email",
            });
            if (!r.ok) throw new ActionFailed("target_gone");
            results.push({ kind: "request", id: r.jobId, code: null });
            break;
          }
          case "create_milestone": {
            const r = await createMilestone(tx, { projectId: proposal.projectId, name: String(a.name), dueDate: typeof a.dueDate === "string" ? a.dueDate : null });
            if (!r.ok && r.error !== "milestone_exists") throw new ActionFailed("target_gone");
            results.push({ kind: "milestone", id: r.ok ? r.milestone.id : "", code: null });
            break;
          }
          case "update_ticket":
          case "comment_ticket": {
            const ticketId = String(a.ticketId);
            const [ticket] = await tx.select({ id: tickets.id, number: tickets.number }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.projectId, proposal.projectId)));
            if (!ticket) throw new ActionFailed("target_gone");
            if (action.type === "update_ticket") {
              // La patch del modello si rivalida qui: un enum inventato
              // fallisce pulito, invece di far lanciare `patchTicket` (500).
              const patch = validTicketPatch(a.patch);
              if (!patch) throw new ActionFailed("invalid_action");
              const r = await patchTicket(tx, { ticketId, actorId: viewer.id, patch });
              if (!r.ok) throw new ActionFailed("target_gone");
            } else {
              await addSystemComment(tx, {
                ticketId,
                body: t(lang, "email.execution.commentBody", {
                  body: String(a.body),
                  link: `https://mail.google.com/mail/u/${encodeURIComponent(mailboxEmail)}/#all/${message.threadId}`,
                }),
              });
            }
            results.push({ kind: action.type === "update_ticket" ? "ticket_update" : "comment", id: ticket.id, code: project?.code ? `${project.code}-${ticket.number}` : null });
            break;
          }
          case "record_decision": {
            // ⚠️ MAI titolo e testo del modello: il registro decisioni è
            // scritto da TEMPLATE (`decision.email.*`), come la posta di prima.
            await recordDecision(tx, {
              projectId: proposal.projectId,
              source: "email",
              sourceKey: `email:${proposal.rfcMessageId}#${indices[position]}`,
              sourceRef: { proposalId: proposal.id },
              ...(typeof a.ticketId === "string" ? { ticketId: a.ticketId } : {}),
              title: t(lang, "decision.email.title", { subject }),
              decision: t(lang, "decision.email.decision", { from, subject, option: t(lang, "mailProposal.action.record_decision", { title: String(a.title ?? "") }) }),
              decidedByUserId: viewer.id,
            });
            results.push({ kind: "decision", id: proposal.id, code: null });
            break;
          }
          default:
            throw new ActionFailed("invalid_action");
        }
      }
      await tx
        .update(emailProposals)
        .set({
          status: "actioned",
          decidedByUserId: viewer.id,
          decidedAt: new Date(),
          confirmedIndices: indices.length < all.length ? indices : null,
          results,
        })
        .where(eq(emailProposals.id, id));
      await closeCards(tx, id);
      return { ok: true as const, status: "confirmed" as const, results };
    });
  } catch (err) {
    if (!(err instanceof ActionFailed)) throw err;
    // Tutto annullato; la proposta resta fallita, per tutti, con l'errore —
    // ma SOLO se è ancora aperta: fra il rollback e qui un altro destinatario
    // può averla decisa, e il suo esito non si sovrascrive (review F2, punto 3).
    const failed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(emailProposals)
        .set({ status: "failed", error: err.message, decidedByUserId: viewer.id, decidedAt: new Date() })
        .where(and(eq(emailProposals.id, id), inArray(emailProposals.status, ["classified", "proposed"])))
        .returning({ id: emailProposals.id });
      if (updated) await closeCards(tx, id);
      return Boolean(updated);
    });
    if (!failed) {
      const [now] = await db.select({ decidedByUserId: emailProposals.decidedByUserId }).from(emailProposals).where(eq(emailProposals.id, id));
      return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, now?.decidedByUserId ?? null) };
    }
    return { ok: true, status: "failed", error: err.message };
  }
}

/** «Ignora»: chiude la proposta per tutti. Chi la vede può ignorarla. */
export async function ignoreMailProposal(db: Db, viewer: Viewer, id: string): Promise<DecideResult> {
  const loaded = await loadDecidable(db, viewer, id);
  if (!loaded) return (await decideLegacy(db, viewer.id, id, { kind: "ignore" })) ?? { ok: false, error: "not_found" };
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(emailProposals)
      .set({ status: "ignored", decidedByUserId: viewer.id, decidedAt: new Date(), outcome: { type: "ignored" } })
      .where(and(eq(emailProposals.id, id), inArray(emailProposals.status, ["classified", "proposed"])))
      .returning({ id: emailProposals.id });
    if (!updated) {
      return { ok: false as const, error: "already_handled" as const, decidedBy: await decidedByOf(db, loaded.proposal.decidedByUserId) };
    }
    await closeCards(tx, id);
    return { ok: true as const, status: "ignored" as const };
  });
}

/** Una notifica è la card di una proposta CONDIVISA? (Per l'inbox.) */
export async function sharedProposalOfNotification(db: Db, userId: string, notificationId: string): Promise<string | null> {
  const [row] = await db
    .select({ proposalId: emailProposalRecipients.proposalId })
    .from(emailProposalRecipients)
    .where(and(eq(emailProposalRecipients.notificationId, notificationId), eq(emailProposalRecipients.userId, userId)));
  return row?.proposalId ?? null;
}

/** I tipi che si possono spostare su un altro progetto (il prototipo). */
const PORTABLE = new Set(["create_task", "create_backlog_item", "record_decision", "create_milestone"]);

/**
 * «Passa al progetto»: chi NON può confermarla la passa a chi nel progetto ha
 * il permesso di ogni sua azione, che da lì la vede (con l'estratto, non il
 * messaggio) e la decide. Resta aperta; nessuna card nuova *(O)*: la si trova
 * in `/proposals?status=handed`.
 */
export async function handMailProposal(db: Db, viewer: Viewer, id: string): Promise<DecideResult> {
  const loaded = await loadDecidable(db, viewer, id);
  if (!loaded) return (await decideLegacy(db, viewer.id, id, { kind: "hand" })) ?? { ok: false, error: "not_found" };
  if (!loaded.isRecipient) return { ok: false, error: "not_found" };
  const { proposal, permissions } = loaded;
  if (!OPEN.has(proposal.status) || proposal.handedAt) {
    return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, proposal.decidedByUserId ?? proposal.handedByUserId) };
  }
  const stored = proposal.classification as { choose?: unknown };
  if (stored.choose || coversAll(proposal, permissions)) return { ok: false, error: "invalid_selection" };
  const [updated] = await db
    .update(emailProposals)
    .set({ handedAt: new Date(), handedByUserId: viewer.id })
    .where(and(eq(emailProposals.id, id), inArray(emailProposals.status, ["classified", "proposed"]), isNull(emailProposals.handedAt)))
    .returning({ id: emailProposals.id });
  if (!updated) return { ok: false, error: "already_handled", decidedBy: null };
  return { ok: true, status: "handed" };
}

/**
 * «Sposta su un altro progetto»: una proposta nuova sul progetto scelto, con
 * le stesse azioni (le pubblica il worker al giro dopo, ai destinatari membri
 * di QUEL progetto); questa si chiude per tutti. Chi sposta è un destinatario
 * che vede il progetto di arrivo; le azioni sono tutte spostabili; sul
 * progetto di arrivo non c'è già una proposta per questa email.
 */
export async function reassignMailProposal(db: Db, viewer: Viewer, id: string, targetProjectId: string): Promise<DecideResult> {
  const loaded = await loadDecidable(db, viewer, id);
  if (!loaded) return (await decideLegacy(db, viewer.id, id, { kind: "reassign", projectId: targetProjectId })) ?? { ok: false, error: "not_found" };
  if (!loaded.isRecipient) return { ok: false, error: "not_found" };
  const { proposal } = loaded;
  if (!OPEN.has(proposal.status)) return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, proposal.decidedByUserId) };
  const stored = proposal.classification as { actions?: StoredAction[]; choose?: unknown; summary?: string };
  const actions = stored.actions ?? [];
  if (stored.choose || actions.length === 0 || !actions.every((a) => PORTABLE.has(a.type))) return { ok: false, error: "invalid_selection" };
  if (targetProjectId === proposal.projectId || !(await projectPermissionsOfUser(db, viewer.id, targetProjectId))) {
    return { ok: false, error: "invalid_target" };
  }
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: emailProposals.status }).from(emailProposals).where(eq(emailProposals.id, id)).for("update");
    if (!locked || !OPEN.has(locked.status)) return { ok: false as const, error: "already_handled" as const, decidedBy: null };
    const [created] = await tx
      .insert(emailProposals)
      .values({
        emailMessageId: proposal.emailMessageId,
        projectId: targetProjectId,
        rfcMessageId: proposal.rfcMessageId,
        audience: "mail_recipients",
        status: "classified",
        classification: { version: 2, summary: stored.summary ?? "", actions, movedFrom: proposal.projectId, movedBy: viewer.id },
      })
      .onConflictDoNothing()
      .returning({ id: emailProposals.id });
    if (!created) return { ok: false as const, error: "invalid_target" as const };
    await tx
      .update(emailProposals)
      .set({ status: "ignored", decidedByUserId: viewer.id, decidedAt: new Date(), outcome: { type: "reassigned_to", projectId: targetProjectId } })
      .where(eq(emailProposals.id, id));
    await closeCards(tx, id);
    return { ok: true as const, status: "moved" as const, projectId: targetProjectId };
  });
}

/**
 * «Quale progetto?»: la persona sceglie fra i progetti incerti. La domanda se
 * ne va (le card si chiudono) e l'email si riclassifica per QUEL progetto
 * soltanto (`email_messages.project_id`, letto da `classify-v2.ts`), in ogni
 * casella che la contiene; le proposte nuove le pubblica il worker.
 */
export async function chooseMailProposalProject(db: Db, viewer: Viewer, id: string, projectId: string): Promise<DecideResult> {
  const loaded = await loadDecidable(db, viewer, id);
  if (!loaded || !loaded.isRecipient) return { ok: false, error: "not_found" };
  const { proposal } = loaded;
  if (!OPEN.has(proposal.status)) return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, proposal.decidedByUserId) };
  const choose = (proposal.classification as { choose?: { projectIds?: string[] } }).choose?.projectIds;
  if (!choose) return { ok: false, error: "invalid_selection" };
  if (!choose.includes(projectId) || !(await projectPermissionsOfUser(db, viewer.id, projectId))) return { ok: false, error: "invalid_target" };
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: emailProposals.status }).from(emailProposals).where(eq(emailProposals.id, id)).for("update");
    if (!locked || !OPEN.has(locked.status)) return { ok: false as const, error: "already_handled" as const, decidedBy: null };
    await closeCards(tx, id);
    // La domanda non resta: la sua chiave (email, progetto) serve alla
    // proposta vera che nascerà per il progetto scelto.
    await tx.delete(emailProposals).where(eq(emailProposals.id, id));
    await tx
      .update(emailMessages)
      .set({ classificationState: null, status: "new", projectId, scopeProjectIds: [projectId], uncertainProjectIds: [] })
      .where(
        sql`coalesce(${emailMessages.rfcMessageId}, 'gmail:' || ${emailMessages.accountId} || ':' || ${emailMessages.gmailMessageId}) = ${proposal.rfcMessageId}`,
      );
    return { ok: true as const, status: "moved" as const, projectId };
  });
}

/**
 * Conferma aggiungendo come Contributor gli incaricati che non sono membri
 * (`addOutsiders`). Rotta con la riconferma; serve `project.members.manage`, e
 * l'aggiunta passa dalle regole di Membri (`putProjectMember`: escalation,
 * bersaglio sopra). Le persone restano nel progetto SOLO se la conferma
 * riesce: altrimenti chi è stato appena aggiunto se ne va *(O)*.
 */
export async function confirmMailProposalWithMembers(
  db: Db,
  viewer: Pick<SessionUser, "id" | "instancePermissions">,
  id: string,
  input: { indices?: number[] | undefined; edits?: Record<string, Record<string, unknown>> | undefined; addOutsiders: string[] },
  lang: Language,
  /** La traccia di ogni aggiunta e rimozione (il log della rotta). */
  log: (line: string, fields: Record<string, unknown>) => void = () => {},
  /** SOLO per i test: gira fra l'aggiunta dei Contributor e la conferma. */
  afterMembersAdded?: () => Promise<void>,
): Promise<DecideResult | { ok: false; error: "rule"; rule: RoleRuleError }> {
  const loaded = await loadDecidable(db, viewer, id);
  if (!loaded) return { ok: false, error: "not_found" };
  const { proposal, permissions } = loaded;
  if (!permissions.has("project.members.manage")) return { ok: false, error: "forbidden" };
  // Solo gli incaricati della proposta: non un id qualunque (review F2, punto
  // 6). Chi fra loro vede già il progetto si salta più sotto, come prima.
  const assignees = new Set(assigneeIdsOf((proposal.classification as { actions?: { type: string; args?: Record<string, unknown> }[] }).actions ?? []));
  if (input.addOutsiders.some((userId) => !assignees.has(userId))) return { ok: false, error: "invalid_selection" };
  const contributor = await presetRoleIdOf(db, "contributor");
  // Chi vede già il progetto (membri E full admin impliciti) non si aggiunge.
  const already = new Set(await projectViewerIds(db, proposal.projectId));
  // Le righe CREATE da questa chiamata, con la loro creazione: la rimozione
  // tocca solo quelle, e solo se sono ancora le stesse (stesso ruolo, stessa
  // creazione). Chi era già membro non si aggiunge e non si toglie mai.
  const added: { userId: string; createdAt: Date }[] = [];
  const undo = async () => {
    for (const row of added) {
      const removed = await db
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, proposal.projectId),
            eq(projectMembers.userId, row.userId),
            eq(projectMembers.roleId, contributor),
            // Al millisecondo: `Date` non porta i µs di Postgres.
            sql`date_trunc('milliseconds', ${projectMembers.createdAt}) = ${row.createdAt.toISOString()}::timestamptz`,
          ),
        )
        .returning({ userId: projectMembers.userId });
      log(
        removed.length > 0
          ? "posta: Contributor tolto, la conferma della proposta non è riuscita"
          : "posta: Contributor NON tolto, la riga è cambiata nel frattempo",
        { proposalId: id, projectId: proposal.projectId, userId: row.userId, byUserId: viewer.id },
      );
    }
  };
  try {
    for (const userId of [...new Set(input.addOutsiders)]) {
      if (already.has(userId)) continue;
      const member = await putProjectMember(db, viewer, permissions, proposal.projectId, userId, contributor);
      const [created] = await db
        .select({ createdAt: projectMembers.createdAt })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, proposal.projectId), eq(projectMembers.userId, userId)));
      added.push({ userId, createdAt: created!.createdAt });
      log("posta: Contributor aggiunto per una proposta della posta", {
        proposalId: id,
        projectId: proposal.projectId,
        userId: member.userId,
        byUserId: viewer.id,
      });
    }
  } catch (err) {
    await undo();
    if (err instanceof RoleRuleError) return { ok: false, error: "rule", rule: err };
    throw err;
  }
  // In un finally: anche se la conferma LANCIA, i Contributor aggiunti qui
  // non restano (review F2, punto 6).
  let confirmed = false;
  try {
    await afterMembersAdded?.();
    const result = await confirmMailProposal(db, viewer, id, input, lang);
    confirmed = result.ok && result.status === "confirmed";
    return result;
  } finally {
    if (!confirmed) await undo();
  }
}

async function presetRoleIdOf(db: Db, key: string): Promise<string> {
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, key));
  if (!row) throw new Error(`ruolo preset ${key} assente`);
  return row.id;
}
