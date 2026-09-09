import { z } from "zod";

/**
 * Chi ha compiuto un'azione: l'id per la UI, l'email per dirlo a parole.
 * Estratto in un file a sé (invece di vivere in `notification.ts`, dove è
 * nato) perché `ticket.ts` ne ha bisogno per `planApprovedBy` (fase 7) e
 * `notification.ts` importa già da `ticket.ts` (`ticketPrioritySchema`):
 * tenerlo lì avrebbe creato un import circolare fra i due moduli.
 */
export const handledBySchema = z.object({ id: z.uuid(), email: z.string() });
export type HandledBy = z.infer<typeof handledBySchema>;
