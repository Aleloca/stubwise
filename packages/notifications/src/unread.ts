/**
 * QUANTE NOTIFICHE L'UTENTE HA ANCORA DA SMALTIRE: il numero sulla campanella
 * della SPA e il pallino sull'icona dell'app mobile.
 *
 * Sta QUI e non in `apps/server/src/services/inbox.ts` (da dove viene) per la
 * stessa ragione per cui ci sta `actions.ts`: dalla fase 4 il numero serve
 * anche al WORKER, che lo mette nel `badge` di ogni push e che non può
 * importare da `apps/server`. Il servizio inbox lo ri-esporta, così gli import
 * dei suoi consumatori (rotte, test) restano validi.
 *
 * Averne UNA SOLA copia non è pulizia: la campanella e il badge del telefono
 * DEVONO dire lo stesso numero. Due query gemelle divergerebbero alla prima
 * modifica del criterio, e la divergenza si vedrebbe solo su un telefono —
 * dove nessun test guarda.
 */
import { notifications } from "@stubwise/db";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./dispatch.js";

/**
 * DECISIONE: conta lo stato, non la lettura. `read_at` dice solo che l'utente
 * ha aperto la riga una volta, non che ha fatto ciò che chiedeva — un piano da
 * approvare letto e lasciato lì deve continuare a comparire. Il conteggio è
 * quindi "da smaltire": `open` più le snoozate GIÀ SCADUTE, che a un
 * `listInbox` successivo tornerebbero aperte comunque.
 *
 * NON scrive: la riapertura lazy è di `listInbox`. Così la campanella (polling
 * ogni 30 s da ogni scheda aperta) resta una lettura pura e dice comunque il
 * numero giusto.
 */
export async function unreadCount(db: DbOrTx, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        sql`(${notifications.status} = 'open' or (${notifications.status} = 'snoozed' and ${notifications.snoozedUntil} <= now()))`,
      ),
    );
  return row?.count ?? 0;
}
