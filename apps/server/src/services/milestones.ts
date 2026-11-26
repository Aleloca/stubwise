import { eq } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { milestones } from "@stubwise/db";

/**
 * La creazione di una milestone sta in `@stubwise/db` (area 7: la usa anche
 * l'esecutore delle automazioni nel worker): qui la si ri-esporta, così
 * nessun import del server cambia.
 */
export {
  createMilestone,
  type CreateMilestoneError,
  type CreateMilestoneInput,
  type CreateMilestoneResult,
  type MilestoneRow,
} from "@stubwise/db";

/** `Db` o una transazione drizzle già aperta dal chiamante. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Elimina un traguardo (`DELETE /api/milestones/:id`, estratto perché lo usa
 * anche l'esecutore delle azioni di Claude): le task passano a `milestone_id`
 * null (FK SET NULL), non si cancellano. `false`: non c'era.
 */
export async function deleteMilestone(tx: DbOrTx, id: string): Promise<boolean> {
  const deleted = await tx.delete(milestones).where(eq(milestones.id, id)).returning({ id: milestones.id });
  return deleted.length > 0;
}
