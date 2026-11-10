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

/**
 * «via Claude» (chat, fetta 3): la riga l'ha scritta Claude per conto di una
 * persona. Campi DERIVATI a lettura dal server (`via_claude_action_id` e il
 * richiedente del gruppo dell'azione), comuni a commenti, card di inbox e
 * registro della task. ADDITIVI con default: un server che non li manda dice
 * «non via Claude». Qui, accanto a `handledBySchema`, perché `ticket.ts`,
 * `notification.ts` e `task-view.ts` li usano tutti senza importarsi a vicenda.
 */
export const viaClaudeShape = {
  viaClaude: z.boolean().default(false),
  viaClaudeActionId: z.uuid().nullable().default(null),
  viaClaudeRequesterId: z.uuid().nullable().default(null),
};
