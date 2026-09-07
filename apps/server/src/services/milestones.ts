/**
 * Creazione di una milestone di progetto.
 *
 * PERCHÉ UN SERVIZIO: la stessa mutazione ha oggi una sola superficie (`POST
 * /api/milestones`) e ne avrà una seconda dalla fase 6 — la conferma di una
 * proposta nata da un evento di calendario, che crea la milestone dentro la
 * transazione che chiude la proposta. Riceve quindi il `tx` dal chiamante e non
 * ne apre uno proprio.
 *
 * GLI ERRORI SONO TIPIZZATI, NON HTTP: questo modulo non conosce Fastify. Le
 * rotte traducono (`project_not_found` → 404, `repository_not_in_project` →
 * 400, `milestone_exists` → 409); l'esecuzione di una proposta li userà per
 * decidere l'esito da scrivere sulla riga della posta, dove "esiste già" non è
 * un errore ma un outcome.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { milestones, projects, repositories } from "@stubwise/db";
import type { MilestoneStatus } from "@stubwise/shared";
import { isUniqueViolation } from "../routes/shared.js";

/** `Db` o una transazione drizzle già aperta dal chiamante. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type MilestoneRow = typeof milestones.$inferSelect;

export type CreateMilestoneError =
  | "project_not_found"
  | "repository_not_in_project"
  | "milestone_exists";

export type CreateMilestoneResult =
  | { ok: true; milestone: MilestoneRow }
  | { ok: false; error: CreateMilestoneError };

export interface CreateMilestoneInput {
  projectId: string;
  name: string;
  /** ISO date/datetime, oppure `null` per "senza scadenza". */
  dueDate?: string | null;
  description?: string | null;
  /**
   * Repository d'ORIGINE, opzionale: dalla fase 5 la milestone è del progetto e
   * la web app non lo manda più. Se c'è, deve appartenere al progetto.
   */
  repositoryId?: string | null;
  status?: MilestoneStatus;
}

/**
 * Crea la milestone applicando, nello stesso ordine della rotta, le due
 * validazioni che la precedono (progetto esistente, repository d'origine dentro
 * il progetto) e traducendo la violazione dell'unique sul nome in
 * `milestone_exists`.
 */
export async function createMilestone(
  tx: DbOrTx,
  input: CreateMilestoneInput,
): Promise<CreateMilestoneResult> {
  const { projectId, name, description, dueDate, repositoryId, status } = input;

  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return { ok: false, error: "project_not_found" };

  // Il repository d'origine è OPZIONALE (la milestone è del progetto). Se c'è,
  // deve appartenere al progetto: un repo altrui resta un errore, non un campo
  // ignorato.
  if (repositoryId !== undefined && repositoryId !== null) {
    const [repository] = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.id, repositoryId), eq(repositories.projectId, projectId)));
    if (!repository) return { ok: false, error: "repository_not_in_project" };
  }

  // Pre-check del nome PRIMA dell'insert, oltre alla cattura della violazione
  // dell'unique `(project_id, name)` qui sotto. Non è una ridondanza: un errore
  // Postgres ABORTA la transazione, quindi un chiamante che ci passa un `tx`
  // già aperto (l'esecuzione di una proposta) non potrebbe fare nulla dopo
  // averlo catturato. Con il pre-check il caso normale — "esiste già" — non
  // sporca mai la transazione; il `catch` resta per la sola corsa fra due
  // creazioni simultanee, dove la seconda perde comunque.
  const [existing] = await tx
    .select({ id: milestones.id })
    .from(milestones)
    .where(and(eq(milestones.projectId, projectId), eq(milestones.name, name)));
  if (existing) return { ok: false, error: "milestone_exists" };

  try {
    const [created] = await tx
      .insert(milestones)
      .values({
        projectId,
        repositoryId: repositoryId ?? null,
        name,
        description: description ?? null,
        dueDate: dueDate !== undefined && dueDate !== null ? new Date(dueDate) : null,
        ...(status !== undefined ? { status } : {}),
        // `closedAt` coerente con lo stato fin dalla nascita: una milestone
        // creata già chiusa ha una data di chiusura.
        ...(status === "closed" ? { closedAt: new Date() } : {}),
      })
      .returning();
    if (!created) throw new Error("insert della milestone non ha restituito la riga");
    return { ok: true, milestone: created };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: "milestone_exists" };
    throw error;
  }
}
