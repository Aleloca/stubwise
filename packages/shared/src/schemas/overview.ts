import { z } from "zod";

/**
 * L'Overview dell'app nuova (integrazione area 2, fetta 4): la cronologia di
 * progetto e l'attività del portafoglio nella forma del prototipo
 * (`TimelineEvent` di `apps/desktop/src/renderer/data/types.ts`), a pagine di
 * 28 giorni, e il brief settimanale come lo mostra l'Overview.
 *
 * Un oggetto PIATTO con campi opzionali per kind, non una
 * `discriminatedUnion`: quella non è attraversabile da `readerSchema`, e un
 * kind che il client non conosce deve diventare `UNKNOWN` ed essere ignorato,
 * non far fallire la pagina.
 *
 * Mappa dei kind del server (`projectTimelineEntrySchema`, la Roadmap del web
 * vecchio) su quelli del prototipo: ticket_opened → task_opened, ticket_done →
 * task_closed, milestone_due → milestone (alla sua data, anche futura),
 * pr_opened/pr_merged/pr_closed → stessi kind, report_day → daily_report,
 * decision e brief → stessi kind. `milestone_closed` non ha un kind nel
 * prototipo (il traguardo si colloca alla sua data) e non esce; `task_deleted`
 * è dell'area 10a, non integrata.
 */
export const chronologyKindSchema = z.enum([
  "task_opened",
  "task_closed",
  "milestone",
  "decision",
  "brief",
  "daily_report",
  "pr_opened",
  "pr_merged",
  "pr_closed",
]);
export type ChronologyKind = z.infer<typeof chronologyKindSchema>;

export const chronologyEventSchema = z.object({
  kind: chronologyKindSchema,
  at: z.iso.datetime(),
  /** Il progetto: c'è sempre nell'attività del portafoglio. */
  projectId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  /**
   * Il codice della task (`<PROGETTO>-<n>`) degli eventi `task_*` e `pr_*`,
   * così l'app lo mostra anche per una task che non ha in memoria. Solo per
   * le task che chi guarda vede: gli eventi stessi passano da quella regola.
   */
  taskCode: z.string().optional(),
  milestoneId: z.uuid().optional(),
  decisionId: z.uuid().optional(),
  /** Il titolo della decisione. */
  title: z.string().optional(),
  briefId: z.uuid().optional(),
  /** La prima riga del brief. */
  headline: z.string().optional(),
  reportId: z.uuid().optional(),
  /** La sintesi del report del giorno; null se il run di sintesi è fallito. */
  summary: z.string().nullable().optional(),
  prId: z.uuid().optional(),
  /** Il numero della pull request. */
  number: z.number().int().optional(),
});
export type ChronologyEvent = z.infer<typeof chronologyEventSchema>;

/**
 * Una pagina di cronologia, dalla più recente: le 4 settimane prima di
 * `before` (escluso), e nella PRIMA pagina anche i traguardi futuri.
 * `nextBefore` è il `before` della pagina successiva («Load older»); null se
 * prima non c'è più storia.
 */
export const chronologyPageSchema = z.object({
  events: z.array(chronologyEventSchema),
  nextBefore: z.iso.datetime().nullable(),
});
export type ChronologyPage = z.infer<typeof chronologyPageSchema>;

/**
 * Il brief settimanale come lo mostra l'Overview (`WeeklyBrief` del
 * prototipo): `headline` (la prima sezione, «dove siamo») e `summary` (il
 * markdown intero, o le sezioni ricomposte). È TESTO GENERATO dal modello, e
 * la vista lo dice (`generated`): non è il registro decisioni.
 */
export const weeklyBriefViewSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  headline: z.string(),
  summary: z.string(),
  createdAt: z.iso.datetime(),
  generated: z.boolean().default(true),
});
export type WeeklyBriefView = z.infer<typeof weeklyBriefViewSchema>;
