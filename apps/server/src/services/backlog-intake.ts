/**
 * Accodamento di un job `intake` del backlog a partire da TESTO GREZZO (titolo
 * + corpo), cioè la creazione "manuale" di una voce di discovery.
 *
 * PERCHÉ UN SERVIZIO E NON CODICE INLINE NELLA ROTTA: la stessa mutazione serve
 * a più superfici. Oggi la chiama `POST /api/projects/.../backlog` (rotta
 * `backlog.ts`); dalla fase 6 la chiamerà anche l'esecuzione di una proposta
 * Google, che ha in mano una transazione già aperta e un attore che non è
 * l'utente della richiesta HTTP. Per questo la funzione riceve il `tx` dal
 * chiamante e non ne apre uno proprio: chi accoda l'intake dentro una
 * transazione più grande (la stessa che marca la proposta come gestita) non
 * deve poter finire con un job accodato e la proposta ancora aperta.
 *
 * NB — la voce di backlog NON nasce qui: nasce nel worker, che processa il job
 * `intake` facendo dedup ed estrazione dei metadati. Questo modulo accoda e
 * basta, esattamente come faceva la rotta.
 *
 * ⚠️ `backlogIntakePayloadSchema` (`@stubwise/shared`) è una union di oggetti
 * **strict**: `{ ticketId }` oppure `{ title, body }`. Aggiungere un campo al
 * payload (per esempio chi ha richiesto l'intake) farebbe fallire il parse nel
 * worker con `MalformedBacklogPayloadError`, cioè un job `failed` in silenzio.
 * Chi volesse portare l'attore fino al worker deve prima allargare quello
 * schema — non basta metterlo nel payload da qui.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { backlogJobs, projects } from "@stubwise/db";

/** `Db` o una transazione drizzle già aperta dal chiamante. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface EnqueueBacklogIntakeInput {
  projectId: string;
  title: string;
  body: string;
}

export type EnqueueBacklogIntakeResult =
  | { ok: true; jobId: string }
  | { ok: false; error: "project_not_found" };

/**
 * Verifica che il progetto esista e accoda il job `intake` col payload manuale.
 * L'ordine (SELECT del progetto, poi INSERT) è quello della rotta: un progetto
 * inesistente non lascia job orfani in coda.
 */
export async function enqueueBacklogIntake(
  tx: DbOrTx,
  input: EnqueueBacklogIntakeInput,
): Promise<EnqueueBacklogIntakeResult> {
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, input.projectId));
  if (!project) return { ok: false, error: "project_not_found" };

  const [job] = await tx
    .insert(backlogJobs)
    .values({
      projectId: input.projectId,
      kind: "intake",
      payload: { title: input.title, body: input.body },
    })
    .returning({ id: backlogJobs.id });
  if (!job) throw new Error("L'insert del job intake non ha restituito la riga creata");
  return { ok: true, jobId: job.id };
}
