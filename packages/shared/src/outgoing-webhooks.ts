import { z } from "zod";

/**
 * Area 9, F3 (D-10 = b, E-2 = a): il catalogo degli eventi dei webhook in
 * uscita, i 21 del prototipo (`apps/desktop/src/renderer/data/instance/
 * constants.ts`): i 13 di oggi («web») e gli 8 degli avvisi delle aree 8a/8b
 * («catalog»), spenti di default. Un webhook riceve SOLO gli eventi che ha
 * scelto. Il CHECK della 0188 ricopia gli id: un test di parità li allinea.
 *
 * `kinds` sono i `notification_kind` che un evento copre (un evento
 * dell'interfaccia può coprirne più d'uno, come gli interruttori di oggi);
 * vuoto per un avviso del catalogo che non ha ancora una notifica viva.
 */
export const OUTGOING_WEBHOOK_EVENTS = [
  { id: "ticket.created", source: "web", group: "tasks", kinds: ["ticket.created", "request.created"] },
  { id: "task.created_by_automation", source: "catalog", group: "tasks", kinds: [] },
  { id: "support.request", source: "catalog", group: "tasks", kinds: ["support.request"] },
  { id: "job.plan_review", source: "web", group: "work", kinds: ["job.plan_review"] },
  { id: "job.awaiting_input", source: "web", group: "work", kinds: ["job.awaiting_input"] },
  { id: "job.held", source: "web", group: "work", kinds: ["job.held"] },
  { id: "job.budget_held", source: "web", group: "work", kinds: ["job.budget_held"] },
  { id: "job.failed", source: "web", group: "work", kinds: ["job.failed"] },
  { id: "job.pr_opened", source: "web", group: "prs", kinds: ["job.pr_opened"] },
  { id: "job.pr_closed", source: "web", group: "prs", kinds: ["job.pr_closed"] },
  { id: "review.completed", source: "web", group: "prs", kinds: ["review.completed"] },
  { id: "pr.analysis_issues", source: "catalog", group: "prs", kinds: ["pr.analysis_issues"] },
  { id: "release.merged", source: "catalog", group: "prs", kinds: ["release.merged"] },
  { id: "release.succeeded", source: "catalog", group: "prs", kinds: ["release.succeeded"] },
  { id: "release.failed", source: "catalog", group: "prs", kinds: ["release.failed"] },
  { id: "docs.limit_paused", source: "web", group: "docs", kinds: ["docs.limit_paused", "docs.nightly_attention"] },
  { id: "docs.release_note", source: "catalog", group: "docs", kinds: ["docs.release_note"] },
  { id: "monitor", source: "web", group: "servers", kinds: ["monitor.alert", "monitor.recovered"] },
  { id: "server.diagnosis_ready", source: "catalog", group: "servers", kinds: ["server.diagnosis_ready"] },
  { id: "project.pulse", source: "web", group: "project", kinds: ["project.pulse"] },
  { id: "project.brief", source: "web", group: "project", kinds: ["project.brief"] },
] as const satisfies readonly { id: string; source: "web" | "catalog"; group: string; kinds: readonly string[] }[];

export type OutgoingWebhookEvent = (typeof OUTGOING_WEBHOOK_EVENTS)[number]["id"];
export const OUTGOING_WEBHOOK_EVENT_IDS = OUTGOING_WEBHOOK_EVENTS.map((e) => e.id) as [OutgoingWebhookEvent, ...OutgoingWebhookEvent[]];
/** Al più tanti webhook per istanza (D-10 = b). */
export const OUTGOING_WEBHOOK_LIMIT = 20;

/** L'evento (o gli eventi) di un `notification_kind`: chi lo sceglie lo riceve. */
export function webhookEventsOfKind(kind: string): OutgoingWebhookEvent[] {
  return OUTGOING_WEBHOOK_EVENTS.filter((e) => (e.kinds as readonly string[]).includes(kind)).map((e) => e.id);
}

/** Il formato: `generic` si mostra «JSON» (H-2 = a: l'enum di oggi non cambia). */
export const webhookFormatSchema = z.enum(["slack", "discord", "generic"]);

/**
 * Un webhook come si legge: l'URL in chiaro ([IN 4], non è un segreto), il
 * segreto MAI — solo se c'è e quando è stato ruotato.
 */
export const outgoingWebhookViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  format: webhookFormatSchema,
  enabled: z.boolean(),
  events: z.array(z.enum(OUTGOING_WEBHOOK_EVENT_IDS)).default([]),
  secretSet: z.boolean().default(false),
  secretRotatedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
  /**
   * Rimandi, lotto 5: l'ultima prova (`POST …/test`), nelle parole del
   * prototipo — `ok`, `invalid_credentials` (401/403), `destination_error`
   * (un altro errore della destinazione, M-5), `unreachable` (nessuna risposta). null = mai provato, o
   * indirizzo/formato cambiati dopo. `.default(null)`.
   */
  lastTest: z
    .object({
      at: z.iso.datetime(),
      // Review del lotto 5 (M-5): `invalid_credentials` solo per 401/403;
      // `destination_error` per ogni altro errore con cui la destinazione ha risposto.
      outcome: z.enum(["ok", "invalid_credentials", "unreachable", "destination_error"]),
      /** Il codice della risposta; null se la destinazione non ha risposto. `.default(null)`. */
      status: z.number().int().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type OutgoingWebhookView = z.infer<typeof outgoingWebhookViewSchema>;

/** La creazione e la rigenerazione mostrano il segreto UNA volta. */
export const outgoingWebhookWithSecretSchema = outgoingWebhookViewSchema.extend({ secret: z.string() });
export type OutgoingWebhookWithSecret = z.infer<typeof outgoingWebhookWithSecretSchema>;

const urlSchema = z.url().max(2000).refine((u) => u.startsWith("https://"), { message: "Webhook URL must use https" });

export const webhookFieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: urlSchema,
  format: webhookFormatSchema,
  enabled: z.boolean(),
  events: z.array(z.enum(OUTGOING_WEBHOOK_EVENT_IDS)).max(OUTGOING_WEBHOOK_EVENTS.length),
});

export const createOutgoingWebhookSchema = webhookFieldsSchema.extend({
  enabled: webhookFieldsSchema.shape.enabled.default(true),
  events: webhookFieldsSchema.shape.events.default([]),
});
export type CreateOutgoingWebhookInput = z.infer<typeof createOutgoingWebhookSchema>;

/**
 * Una patch: i campi assenti RESTANO. Viene dalla base SENZA default, non dal
 * `.partial()` della creazione: Zod applicherebbe i default anche a un campo
 * assente, e una patch col solo nome riaccenderebbe il webhook svuotandone
 * gli eventi.
 */
export const updateOutgoingWebhookSchema = webhookFieldsSchema.partial();
export type UpdateOutgoingWebhookInput = z.infer<typeof updateOutgoingWebhookSchema>;

/** L'esito di una prova d'invio. */
export const outgoingWebhookTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable().default(null),
  error: z.string().nullable().default(null),
});

/** L'anteprima: il corpo che arriverebbe, per formato ed evento, da un evento d'esempio. */
export const outgoingWebhookPreviewSchema = z.object({
  format: webhookFormatSchema,
  event: z.enum(OUTGOING_WEBHOOK_EVENT_IDS),
  body: z.unknown(),
});

/**
 * Area 9, F3 (H-4 = a): gli interruttori della pagina Notifiche del web
 * vecchio, e l'evento che ognuno accende. È la mappa con cui la 0188 ha
 * migrato `notification_settings` (un test la confronta col SQL), e la
 * vista di compatibilità la usa sul webhook più vecchio.
 */
export const LEGACY_WEBHOOK_TOGGLES = {
  notifyTicketCreated: "ticket.created",
  notifyPlanReview: "job.plan_review",
  notifyAwaitingInput: "job.awaiting_input",
  notifyJobHeld: "job.held",
  notifyBudgetHeld: "job.budget_held",
  notifyJobFailed: "job.failed",
  notifyPrOpened: "job.pr_opened",
  notifyPrClosed: "job.pr_closed",
  notifyReviewCompleted: "review.completed",
  notifyDocsLimitPaused: "docs.limit_paused",
  notifyMonitor: "monitor",
  notifyPulse: "project.pulse",
  notifyBrief: "project.brief",
} as const satisfies Record<string, OutgoingWebhookEvent>;
export type LegacyWebhookToggle = keyof typeof LEGACY_WEBHOOK_TOGGLES;
