import { z } from "zod";

/**
 * Schemi della CODA DI RILASCIO (fase 8, Task 9-10): una pagina sola, per il
 * maintainer (design §4), che elenca tutte le PR aperte sui repository
 * collegati — di qualunque origine, la review le tratta già tutte allo
 * stesso modo. Stubwise CONOSCE queste PR, non le esegue né le rilascia mai
 * da sé: l'unica scrittura è il merge esplicito, riservato all'admin.
 */

/** Verdetto della review automatica (speculare a pr_reviews.verdict in packages/db). */
export const prReviewVerdictSchema = z.enum(["approve", "request_changes"]);
export type PrReviewVerdict = z.infer<typeof prReviewVerdictSchema>;

/** Esito di UN check del provider — vedi PullRequestCheck in @stubwise/git. */
export const releaseCheckOutcomeSchema = z.enum(["success", "failure", "pending"]);
export type ReleaseCheckOutcome = z.infer<typeof releaseCheckOutcomeSchema>;

/**
 * Rollup dei check del provider per UNA PR. `no_checks` è un caso a sé, non
 * "success" (vedi PullRequestChecks in @stubwise/git) — letto LIVE a ogni
 * richiesta della coda, mai persistito.
 */
export const releaseChecksSchema = z.object({
  status: z.union([releaseCheckOutcomeSchema, z.literal("no_checks")]),
  checks: z.array(z.object({ name: z.string(), status: releaseCheckOutcomeSchema })),
});
export type ReleaseChecks = z.infer<typeof releaseChecksSchema>;

/** Esito del test INTERNO (ticket_repositories.test_status) — vedi CLAUDE.md fase 8. */
export const releaseTestStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type ReleaseTestStatus = z.infer<typeof releaseTestStatusSchema>;

/** Livello di rischio (ticket_repositories.risk) — una regola, mai un giudizio del modello. */
export const releaseRiskLevelSchema = z.enum(["low", "medium", "high"]);
export type ReleaseRiskLevel = z.infer<typeof releaseRiskLevelSchema>;

/**
 * Una riga della coda: una PR aperta su un repository collegato. I campi
 * "nuovi" della fase 8 (checks, testStatus, risk, deployedOn) sono
 * `.nullable()`/array-vuoto per costruzione — non sono mai stati letti da un
 * client precedente (la pagina nasce con questa fase), ma restano la forma
 * giusta: righe storiche (aperte prima della fase 8) hanno testStatus/risk
 * NULL per davvero, non un valore finto.
 */
export const releaseQueueItemSchema = z.object({
  ticketId: z.uuid(),
  ticketNumber: z.number().int(),
  ticketTitle: z.string(),
  repositoryId: z.uuid(),
  repositoryName: z.string(),
  projectId: z.uuid(),
  projectName: z.string(),
  branch: z.string(),
  prUrl: z.url(),
  /** null se il formato dell'URL non è riconosciuto (mai lancia, vedi parsePrNumberFromUrl). */
  prNumber: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  /** Assente = nessuna review automatica ancora prodotta per questa PR. */
  reviewVerdict: prReviewVerdictSchema.nullable(),
  reviewSummary: z.string().nullable(),
  checks: releaseChecksSchema,
  testStatus: releaseTestStatusSchema.nullable(),
  risk: releaseRiskLevelSchema.nullable(),
  riskReason: z.string().nullable(),
  /**
   * Nomi degli ambienti (non-test) del progetto il cui ultimo campione
   * riporta ESATTAMENTE l'head commit di questa PR — match esatto, non un
   * antenato: non prova che una revisione precedente sia già live altrove,
   * solo che QUESTA lo è. Vuoto = nessun match, non "sicuramente non
   * rilasciata" (potrebbe non esserci un ambiente collegato, o l'agente non
   * ha ancora campionato).
   */
  deployedOn: z.array(z.string()),
});
export type ReleaseQueueItem = z.infer<typeof releaseQueueItemSchema>;

export const releaseQueueSchema = z.object({ items: z.array(releaseQueueItemSchema) });
export type ReleaseQueue = z.infer<typeof releaseQueueSchema>;

/** Esito del rilascio: lo sha del merge commit. */
export const releaseResultSchema = z.object({ merged: z.literal(true), sha: z.string() });
export type ReleaseResult = z.infer<typeof releaseResultSchema>;
