import { z } from "zod";

/**
 * Stato di un job AI nella coda del worker. L'enum Postgres `ai_job_status`
 * deriva da questo schema (shared = unica fonte di verità) per i VALORI, ma
 * non per il tipo che esiste davvero nel database.
 *
 * ⚠️ Toccare questa lista NON tocca Postgres. Il repo non genera migrazioni
 * dallo schema: aggiungere un valore qui lo rende valido per TypeScript in
 * server, worker, web e app mobile, mentre il primo INSERT lo fa esplodere con
 * `invalid input value for enum ai_job_status`. Un valore nuovo va SEMPRE con
 * una migrazione `ALTER TYPE "public"."ai_job_status" ADD VALUE '…'` in uno
 * statement proprio (l'ultimo precedente è `drizzle/0064_agent_questions.sql`).
 * Rimuovere o rinominare un valore è peggio: le righe che lo contengono restano
 * nel database, fuori da un tipo TS che non le ammette più.
 *
 * La guardia è `enum-parity.test.ts` in `@stubwise/db`, che confronta questa
 * lista con `pg_enum` dopo le migrazioni.
 */
export const aiJobStatusSchema = z.enum([
  "queued",
  "triaging",
  "fixing",
  // "held": il triage ha deciso "fix" ma il gate di automazione non lo
  // consente (auto-fix disattivato per il tipo, oppure effort sopra soglia).
  // Il job resta in attesa di un avvio manuale (POST /run-ai).
  "held",
  "pr_opened",
  "pr_merged",
  "failed",
  "skipped",
  // "pr_closed": la PR aperta dal fix è stata chiusa senza merge (rifiutata da
  // un umano). Stato terminale, distinto da "pr_merged".
  "pr_closed",
  // "awaiting_plan_approval": la pianificazione ha prodotto un piano che
  // supera la soglia di effort configurata; il job è parcheggiato in attesa
  // dell'approvazione umana prima di eseguirlo.
  "awaiting_plan_approval",
  // "awaiting_input": la pianificazione si è fermata su una domanda posta a un
  // umano (`agent_questions`); riparte alla risposta. Il worker non lo considera
  // un job attivo e non lo prende in carico: nessun heartbeat, nessun recupero
  // da orfano.
  "awaiting_input",
]);
export type AiJobStatus = z.infer<typeof aiJobStatusSchema>;

/**
 * Tipo di credenziale di un provider AI: chiave API o account (login del CLI).
 * Sta qui perché è parte della forma pubblica di un job (`providerKind`) e
 * deve essere leggibile anche dai client che non conoscono le rotte provider.
 * L'enum Postgres `ai_provider_kind` deriva da questo schema.
 */
export const aiProviderKindSchema = z.enum(["api_key", "account"]);
export type AiProviderKind = z.infer<typeof aiProviderKindSchema>;

/**
 * Forma pubblica di un AIJob nelle risposte API: la riga del DB con le date
 * in ISO 8601. `startedAt`/`finishedAt` sono nulli finché il worker non
 * prende in carico / conclude il job. Alimenta l'OpenAPI generata.
 */
export const aiJobSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  status: aiJobStatusSchema,
  log: z.string(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  // Provider AI usato dal job: solo etichetta e tipo credenziale (mai il
  // segreto). Null quando il job non ha provider: job pre-feature, fallback
  // env, o provider eliminato (FK on delete set null).
  providerLabel: z.string().nullable(),
  providerKind: aiProviderKindSchema.nullable(),
  // Chi ha chiesto il run. Null sui job nati automaticamente dall'ingest
  // (nessun umano dietro) e su quelli precedenti al campo. È IDENTITÀ, non
  // ruolo: la pagina ticket ci decide chi vede il pannello di risposta a una
  // domanda dell'agente (il richiedente, più i maintainer) — la stessa regola
  // che `actorAllows` applica lato server, dove resta l'autorità.
  requestedByUserId: z.uuid().nullable(),
});
export type AiJob = z.infer<typeof aiJobSchema>;
