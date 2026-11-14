import { z } from "zod";

/**
 * Le iscrizioni agli avvisi di chi chiede, per progetto (area 8, F2, S5):
 * `GET /api/me/alert-subscriptions`. Una riga per riga delle Preferenze
 * (`liveRowTypes()` del catalogo: i tipi vivi, coi partner `sameRowAs` in una
 * riga sola). Lo stato lo calcola il SERVER (il client legge, non deduce):
 * - `on` / `off`: l'iscrizione (o, senza riga, il default del catalogo dai
 *   permessi di adesso);
 * - `suspended`: ci si potrebbe iscrivere ma adesso manca il permesso
 *   (`suspendedReason`): non si scrive;
 * - `mandatory`: un tipo solo obbligatorio, non si iscrive né si spegne.
 * `mandatory` (i motivi) dice per quali ragioni un avviso di quel tipo può
 * arrivare comunque. `phone` senza riga vuole anche l'interruttore `push` di
 * oggi (regola di 46): le Preferenze lo mostrano così.
 */
export const alertSubscriptionStateSchema = z.enum(["on", "off", "suspended", "mandatory"]);
export type AlertSubscriptionState = z.infer<typeof alertSubscriptionStateSchema>;

export const alertSubscriptionRowSchema = z.object({
  /** Il tipo della riga (`rowTypeOf`): l'interruttore scrive anche i suoi partner. */
  type: z.string(),
  group: z.string(),
  labelKey: z.string(),
  app: z.boolean(),
  phone: z.boolean(),
  state: alertSubscriptionStateSchema,
  /** Il permesso che manca (`suspended`), altrimenti null. */
  suspendedReason: z.string().nullable().default(null),
  /** I motivi per cui un avviso di questo tipo arriva comunque. */
  mandatory: z.array(z.string()).default([]),
});
export type AlertSubscriptionRow = z.infer<typeof alertSubscriptionRowSchema>;

export const projectSubscriptionsSchema = z.object({
  projectId: z.uuid(),
  projectCode: z.string(),
  projectName: z.string(),
  rows: z.array(alertSubscriptionRowSchema),
});
export type ProjectSubscriptions = z.infer<typeof projectSubscriptionsSchema>;

export const alertSubscriptionsListSchema = z.object({ items: z.array(projectSubscriptionsSchema) });

/** `PUT /api/me/alert-subscriptions/:projectId/:type`: una patch (gli assenti restano). */
export const setAlertSubscriptionSchema = z.object({ app: z.boolean().optional(), phone: z.boolean().optional() });
export type SetAlertSubscriptionInput = z.infer<typeof setAlertSubscriptionSchema>;

/** Copia e «Mute» rispondono con le righe di PRIMA, per l'«Annulla» (il client le riscrive con `PUT`). */
export const alertSubscriptionsBeforeSchema = z.object({ before: z.array(alertSubscriptionRowSchema) });

/** «Non avvisarmi più di questo» (`POST /api/inbox/:id/mute-type`): la riga di prima (l'«Annulla») e quella nuova. */
export const alertMuteResultSchema = z.object({
  before: alertSubscriptionRowSchema,
  row: alertSubscriptionRowSchema,
  /** Il progetto della card: l'«Annulla» riscrive `before` con `set(projectId, before.type, …)`. Facoltativo (additivo). */
  projectId: z.uuid().optional(),
});
export type AlertMuteResult = z.infer<typeof alertMuteResultSchema>;
