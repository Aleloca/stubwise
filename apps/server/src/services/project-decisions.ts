import { projectDecisions, recordDecision, tickets, users, type Db } from "@stubwise/db";
import type { DecisionPatch, DecisionSource, ProjectDecision } from "@stubwise/shared";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * LETTURA E SCRITTURA MANUALE del registro decisioni (Fase 5) — il lato HTTP.
 *
 * Le decisioni AUTOMATICHE non passano di qui: le scrivono i writer nella stessa
 * transazione dell'evento che le origina (`./questions.ts`, `./jobs.ts`,
 * `./pulse.ts`), che è l'unico modo perché una decisione non sopravviva a un
 * evento annullato. Qui c'è ciò che serve alle superfici che il registro lo
 * LEGGONO — API, Docs, chat, MCP — più la voce che una persona aggiunge a mano.
 *
 * ⚠️ Nessun agente, mai: vale l'invariante della fase (vedi il docblock di
 * `recordDecision` in `@stubwise/db`).
 *
 * ACL: nessuna qui dentro. Il permesso di VEDERE il progetto lo controlla la
 * rotta con `canViewProject`, come per timeline e brief; il permesso di
 * MODIFICARE una voce è una regola di merito e sta in {@link canEditDecision}.
 */

/** Colonne della proiezione pubblica, join con l'autore e col ticket d'origine. */
const DECISION_COLUMNS = {
  id: projectDecisions.id,
  projectId: projectDecisions.projectId,
  source: projectDecisions.source,
  ticketId: projectDecisions.ticketId,
  ticketNumber: tickets.number,
  title: projectDecisions.title,
  context: projectDecisions.context,
  decision: projectDecisions.decision,
  consequences: projectDecisions.consequences,
  decidedByUserId: projectDecisions.decidedByUserId,
  decidedByEmail: users.email,
  decidedAt: projectDecisions.decidedAt,
  supersededById: projectDecisions.supersededById,
  createdAt: projectDecisions.createdAt,
};

type DecisionRow = {
  [K in keyof typeof DECISION_COLUMNS]: K extends "decidedAt" | "createdAt"
    ? Date
    : K extends "ticketNumber"
      ? number | null
      : K extends "source"
        ? DecisionSource
        : string | null;
} & { id: string; projectId: string; title: string; decision: string };

/**
 * La proiezione pubblica. `sourceKey`/`sourceRef` restano dentro: sono la
 * meccanica dell'idempotenza, non un dato per chi legge (vedi
 * `projectDecisionSchema`).
 */
function toPublicDecision(row: DecisionRow): ProjectDecision {
  return {
    id: row.id,
    projectId: row.projectId,
    source: row.source,
    ticketId: row.ticketId,
    ticketNumber: row.ticketNumber,
    title: row.title,
    context: row.context,
    decision: row.decision,
    consequences: row.consequences,
    // Autore ed email vengono dallo STESSO left join: o ci sono entrambi, o la
    // decisione è di un utente cancellato (o di nessuno) e l'attore è null.
    decidedBy:
      row.decidedByUserId && row.decidedByEmail
        ? { id: row.decidedByUserId, email: row.decidedByEmail }
        : null,
    decidedAt: row.decidedAt.toISOString(),
    supersededById: row.supersededById,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Le decisioni di un progetto, dalla più recente. `source` filtra per sorgente.
 *
 * LEFT JOIN su utenti e ticket, non INNER: `decided_by_user_id` e `ticket_id`
 * sono ON DELETE SET NULL proprio perché la decisione deve sopravvivere a chi
 * l'ha presa e al ticket da cui è nata — un inner join le farebbe sparire
 * esattamente nel caso in cui lo storico serve di più.
 */
export async function listProjectDecisions(
  db: Db,
  projectId: string,
  options: { limit: number; source?: DecisionSource },
): Promise<ProjectDecision[]> {
  const rows = await db
    .select(DECISION_COLUMNS)
    .from(projectDecisions)
    .leftJoin(users, eq(users.id, projectDecisions.decidedByUserId))
    .leftJoin(tickets, eq(tickets.id, projectDecisions.ticketId))
    .where(
      options.source
        ? and(
            eq(projectDecisions.projectId, projectId),
            eq(projectDecisions.source, options.source),
          )
        : eq(projectDecisions.projectId, projectId),
    )
    // `id` come spareggio: due decisioni possono avere lo stesso `decided_at`
    // (una data inserita a mano, o due writer nello stesso istante).
    .orderBy(desc(projectDecisions.decidedAt), desc(projectDecisions.id))
    .limit(options.limit);
  return rows.map((row) => toPublicDecision(row as DecisionRow));
}

/** Una decisione per id dentro un progetto, o `null`. */
export async function getProjectDecision(
  db: Db,
  projectId: string,
  decisionId: string,
): Promise<ProjectDecision | null> {
  const [row] = await db
    .select(DECISION_COLUMNS)
    .from(projectDecisions)
    .leftJoin(users, eq(users.id, projectDecisions.decidedByUserId))
    .leftJoin(tickets, eq(tickets.id, projectDecisions.ticketId))
    .where(and(eq(projectDecisions.projectId, projectId), eq(projectDecisions.id, decisionId)));
  return row ? toPublicDecision(row as DecisionRow) : null;
}

/**
 * Aggiunge una voce SCRITTA A MANO da una persona.
 *
 * `sourceKey` è un uuid generato qui: una voce manuale non ha un evento a cui
 * essere idempotente — è un atto, e due volte è due decisioni. Passa comunque
 * da {@link recordDecision} e non da un insert suo, così l'unica porta di
 * scrittura del registro resta una.
 */
export async function createManualDecision(
  db: Db,
  input: {
    projectId: string;
    authorId: string;
    title: string;
    decision: string;
    context?: string;
    consequences?: string;
    ticketId?: string;
    decidedAt?: string;
  },
): Promise<ProjectDecision> {
  const row = await recordDecision(db, {
    projectId: input.projectId,
    source: "manual",
    sourceKey: `manual:${randomUUID()}`,
    ...(input.ticketId ? { ticketId: input.ticketId } : {}),
    title: input.title,
    ...(input.context ? { context: input.context } : {}),
    decision: input.decision,
    ...(input.consequences ? { consequences: input.consequences } : {}),
    decidedByUserId: input.authorId,
    ...(input.decidedAt ? { decidedAt: new Date(input.decidedAt) } : {}),
  });
  // `null` = conflitto sull'unique, impossibile con una sourceKey appena
  // generata: se capita è un bug, e va detto invece di restituire una riga finta.
  if (!row) throw new Error("insert della decisione manuale non ha restituito la riga");
  const created = await getProjectDecision(db, input.projectId, row.id);
  if (!created) throw new Error("decisione appena creata non rileggibile");
  return created;
}

/**
 * Chi può MODIFICARE una decisione: il suo autore o un maintainer.
 *
 * Una decisione senza autore (voce automatica di un utente cancellato) resta
 * modificabile dai soli admin: non c'è nessuno a cui restituirla, e lasciarla
 * aperta a chiunque farebbe del registro un wiki.
 */
export function canEditDecision(
  decision: ProjectDecision,
  actor: { id: string; role: string },
): boolean {
  return actor.role === "admin" || decision.decidedBy?.id === actor.id;
}

/** Esito tipizzato di {@link patchDecision}, mappato a HTTP dalla rotta. */
export type PatchDecisionError = "not_found" | "forbidden" | "invalid_supersede";

export type PatchDecisionResult =
  | { ok: true; decision: ProjectDecision }
  | { ok: false; error: PatchDecisionError };

/**
 * Modifica una decisione: correzione del testo, o "segnala come superata"
 * (`supersededById`).
 *
 * SEMANTICA PATCH: i campi assenti restano invariati, quelli esplicitamente
 * `null` si azzerano. `title` e `decision` non sono azzerabili — sono NOT NULL
 * e sono la decisione stessa.
 *
 * `supersededById` deve puntare a una decisione DELLO STESSO PROGETTO e diversa
 * da questa: un registro in cui una voce supera sé stessa, o una di un altro
 * progetto, non è un registro. La FK da sola non lo impedirebbe.
 */
export async function patchDecision(
  db: Db,
  input: {
    projectId: string;
    decisionId: string;
    actor: { id: string; role: string };
    patch: DecisionPatch;
  },
): Promise<PatchDecisionResult> {
  const current = await getProjectDecision(db, input.projectId, input.decisionId);
  if (!current) return { ok: false, error: "not_found" };
  if (!canEditDecision(current, input.actor)) return { ok: false, error: "forbidden" };

  const { patch } = input;
  if (patch.supersededById !== undefined && patch.supersededById !== null) {
    if (patch.supersededById === input.decisionId) {
      return { ok: false, error: "invalid_supersede" };
    }
    if (!(await getProjectDecision(db, input.projectId, patch.supersededById))) {
      return { ok: false, error: "invalid_supersede" };
    }
  }

  await db
    .update(projectDecisions)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
      ...(patch.context !== undefined ? { context: patch.context } : {}),
      ...(patch.consequences !== undefined ? { consequences: patch.consequences } : {}),
      ...(patch.supersededById !== undefined ? { supersededById: patch.supersededById } : {}),
    })
    .where(eq(projectDecisions.id, input.decisionId));

  const updated = await getProjectDecision(db, input.projectId, input.decisionId);
  if (!updated) return { ok: false, error: "not_found" };
  return { ok: true, decision: updated };
}
