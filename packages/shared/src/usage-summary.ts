import { z } from "zod";

/**
 * Area 9, F4: AI → Usage nell'app (`GET /api/ai-usage/summary`), nella forma
 * della scheda del prototipo (`apps/desktop/src/renderer/data/instance/usage.ts`,
 * `getUsage`). Il raggruppamento, i giorni a zero e la regola R-G5 li fa il
 * server: un progetto che chi guarda non vede diventa la riga `other`, senza
 * codice, nome né id.
 */
export const USAGE_DIMENSIONS = ["day", "model", "project", "provider", "operation"] as const;
export const usageDimensionSchema = z.enum(USAGE_DIMENSIONS);
export type UsageDimension = z.infer<typeof usageDimensionSchema>;

/** Le chiavi senza nome: `other` (progetti invisibili, R-G5), `none` (righe senza progetto o senza provider). Le parole le mette la UI. */
export const USAGE_OTHER_KEY = "other";
export const USAGE_NONE_KEY = "none";

const usageLeafSchema = z.object({
  key: z.string(),
  /** Un nome (modello, provider, progetto); per giorno, operazione, `other` e `none` è la chiave stessa. */
  label: z.string(),
  /** Il codice di un progetto visibile, solo per `project`. */
  code: z.string().nullable().default(null),
  costUsd: z.number(),
  /** Ingresso + uscita (la cache letta sta solo nei totali). */
  tokens: z.number(),
  runs: z.number().int(),
});

export const usageSummarySchema = z.object({
  totals: z.object({ costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number().default(0), runs: z.number().int() }),
  /** Un punto per OGNI giorno dell'intervallo, anche a zero. */
  byDay: z.array(z.object({ day: z.string(), costUsd: z.number(), runs: z.number().int() })),
  rows: z.array(usageLeafSchema.extend({ children: z.array(usageLeafSchema).default([]) })),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** L'intervallo: gli ultimi N giorni, il mese corrente, o due date (estremi compresi, al più 366 giorni). */
export type UsageRange = { days: 7 | 30 | 90 } | { month: true } | { from: string; to: string };
