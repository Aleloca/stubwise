import { gitIdentities, tickets, type Db } from "@stubwise/db";
import { stubwiseTicketNumber, type MandatoryReason } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { gitIn } from "../pipeline/repo-steps.js";

/**
 * L'AUTORE COLLEGATO di una PR, per il destinatario obbligatorio `pr_author`
 * degli avvisi del catalogo (area 8, F2, S4: `pr.analysis_issues`,
 * `pr.corrected`). Best-effort, mai indovinato:
 * - una PR di Stubwise (`stubwise/ticket-<N>` del suo ticket): l'autore della
 *   task (Stubwise l'ha aperta per lui);
 * - una PR di un collega: l'email dell'autore del commit di testa, letta nel
 *   worktree, collegata a un membro da `git_identities` (l'unico legame fra
 *   identità git e persone). Nessun login della piattaforma è collegato a un
 *   utente, quindi senza quell'email collegata non c'è nessun obbligatorio.
 */
export async function prAuthorMandatory(
  db: Db,
  input: { projectId: string; ticketNumber: number | null; branch: string; headAuthorEmail: string | null },
): Promise<{ userId: string; reason: MandatoryReason }[]> {
  const own = stubwiseTicketNumber(input.branch);
  if (own !== null) {
    if (own !== input.ticketNumber) return [];
    const [task] = await db
      .select({ userId: tickets.requestedByUserId })
      .from(tickets)
      .where(and(eq(tickets.projectId, input.projectId), eq(tickets.number, own)));
    return task?.userId ? [{ userId: task.userId, reason: "pr_author" }] : [];
  }
  const email = input.headAuthorEmail?.trim().toLowerCase();
  if (!email) return [];
  const [identity] = await db.select({ userId: gitIdentities.userId }).from(gitIdentities).where(eq(sql`lower(${gitIdentities.email})`, email));
  return identity ? [{ userId: identity.userId, reason: "pr_author" }] : [];
}

/** L'email dell'autore di un commit nel worktree; `null` se git non la sa dire. */
export async function commitAuthorEmail(dir: string, ref = "HEAD"): Promise<string | null> {
  try {
    const out = (await gitIn(dir, ["log", "-1", "--format=%ae", ref])).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
