import { z } from "zod";

/**
 * Due enum foglia, estratti in un file a sé SENZA cambiarne la forma (1 ott
 * 2026, ciclo di correzione post-PR, Task D6) — stesso motivo di `actor.ts`.
 *
 * `ticket.ts` ha bisogno di `prCycleSchema` (`pr-correction.ts`) per il campo
 * `cycle` della voce PR, e `pr-correction.ts` usava questi due enum da
 * `project.ts` e `docs.ts` — che a loro volta importano da `ticket.ts`
 * (`ticketPrioritySchema`). Il giro chiuso faceva valutare `project.ts`/
 * `notification.ts` prima che `ticket.ts` avesse definito i suoi schemi
 * (`ReferenceError ... before initialization` caricando il package). Qui non
 * importano niente, quindi il giro non si chiude. `project.ts` e `docs.ts` li
 * ri-esportano: nessun import esistente cambia.
 */

/** Il provider git di un progetto/repository. */
export const gitProviderKindSchema = z.enum(["bitbucket", "github"]);
export type GitProviderKind = z.infer<typeof gitProviderKindSchema>;

/** Motivo per cui un job è in `held`: solo `limit` è auto-ripristinabile. */
export const heldReasonSchema = z.enum(["limit", "budget", "other"]);
export type HeldReason = z.infer<typeof heldReasonSchema>;
