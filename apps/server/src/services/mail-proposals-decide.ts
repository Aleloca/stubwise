import {
  emailMessages,
  emailProposalRecipients,
  emailProposals,
  googleAccounts,
  notifications,
  projects,
  recordDecision,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import { permissionForMailAction, projectPermissionsOfUser, projectViewerIds } from "@stubwise/notifications";
import type { MailProposal, ProjectPermission } from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import { createTicket } from "../db/tickets.js";
import { enqueueBacklogIntake } from "./backlog-intake.js";
import { addSystemComment } from "./comments.js";
import { createMilestone } from "./milestones.js";
import { patchTicket } from "./tickets.js";

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
    .select({ proposal: emailProposals, message: emailMessages, mailboxEmail: googleAccounts.email })
    .from(emailProposals)
    .innerJoin(emailProposalRecipients, and(eq(emailProposalRecipients.proposalId, emailProposals.id), eq(emailProposalRecipients.userId, viewer.id)))
    .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(and(eq(emailProposals.id, id), eq(emailProposals.audience, "mail_recipients")));
  if (!row) return null;
  const permissions = await projectPermissionsOfUser(db, viewer.id, row.proposal.projectId);
  if (!permissions) return null;
  return { ...row, permissions };
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
    if (key === "patch" && (value === null || typeof value !== "object")) return null;
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
  if (!loaded) return { ok: false, error: "not_found" };
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
              const r = await patchTicket(tx, { ticketId, actorId: viewer.id, patch: (a.patch ?? {}) as Parameters<typeof patchTicket>[1]["patch"] });
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
    // Tutto annullato; la proposta resta fallita, per tutti, con l'errore.
    await db
      .update(emailProposals)
      .set({ status: "failed", error: err.message, decidedByUserId: viewer.id, decidedAt: new Date() })
      .where(eq(emailProposals.id, id));
    await db.transaction((tx) => closeCards(tx, id));
    return { ok: true, status: "failed", error: err.message };
  }
}

/** «Ignora»: chiude la proposta per tutti. Chi la vede può ignorarla. */
export async function ignoreMailProposal(db: Db, viewer: Viewer, id: string): Promise<DecideResult> {
  const loaded = await loadDecidable(db, viewer, id);
  if (!loaded) return { ok: false, error: "not_found" };
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
