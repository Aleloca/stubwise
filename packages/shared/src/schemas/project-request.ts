import { z } from "zod";
import { backlogItemStatusSchema, backlogUrgencySchema } from "./backlog.js";

/**
 * Una richiesta da trasformare in task (integrazione area 2, fetta 3): la
 * forma minima di `ProjectRequest` del prototipo che servono a «Da decidere»
 * e al blocco «Richieste nuove» della Home. La sezione Requests arriva con la
 * fetta 4: fino ad allora la voce si apre nel web vecchio (`webHref`).
 */
export const requestToConvertViewSchema = z.object({
  id: z.uuid(),
  /** `<PROGETTO>-R<n>`: n è la posizione della voce, per data di creazione, fra le voci del progetto. */
  code: z.string(),
  projectId: z.uuid(),
  title: z.string(),
  status: backlogItemStatusSchema,
  /** La scala dei ticket (low/medium/high/urgent); null se non stimata. */
  urgency: backlogUrgencySchema.nullable(),
  requesterIds: z.array(z.uuid()).default([]),
  requestCount: z.number().int().default(1),
  createdAt: z.iso.datetime(),
  /** La voce nel web vecchio. */
  webHref: z.string(),
});
export type RequestToConvertView = z.infer<typeof requestToConvertViewSchema>;
