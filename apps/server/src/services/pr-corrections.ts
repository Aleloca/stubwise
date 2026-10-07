import { ticketRepositories, tickets, type Db } from "@stubwise/db";
import { correctionActionAllowed, enqueueCorrection } from "@stubwise/notifications";
import { isCorrectablePr, prNumberFromUrl } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { Actor } from "./jobs.js";

export type RequestCorrectionError =
  | "forbidden"
  | "pr_not_found"
  | "not_stubwise_pr"
  | "pr_not_open"
  | "correction_in_flight"
  | "job_in_flight";

export type RequestCorrectionResult =
  | { ok: true; correctionId: string }
  | { ok: false; error: RequestCorrectionError };

/**
 * "Chiedi modifiche" dal ticket (design §3, §6, §9). Chi può: chiunque
 * possa lanciare un run sul ticket — nessun gate di approvazione, perché una
 * correzione lavora sulla PR di un piano già approvato, non ne scrive uno
 * nuovo: `resolvePlan`/`preApprovePlan`/`revokePlanApproval` e il gate di
 * `startRun` non si toccano. Il BUDGET invece sì: `actorRole` arriva a
 * `enqueueCorrection`, e solo il click di un admin accende `manualTrigger`
 * (E7, `correctionManualTrigger`) — un member ottiene la correzione, ma a
 * budget esaurito il worker la ferma `held`.
 *
 * Qui si decide solo se la PR è CORREGGIBILE (esiste, è di Stubwise, è
 * aperta). «C'è già qualcosa in corso» lo decide `enqueueCorrection`, sotto
 * lo STESSO lock advisory di `startRun` (`hashtext(ticketId)`): con
 * `trigger: "stubwise"` una correzione attiva o un job vivo sul ticket sono
 * un rifiuto (`correction_in_flight` / `job_in_flight`), mai una `pending` —
 * chi preme il bottone è qui, e un 409 gli dice cosa succede. La `pending`
 * esiste per chi preme "Request changes" sulla piattaforma, a cui non si può
 * rispondere di no; se ce n'è una in attesa e niente la blocca più, il click
 * ci si fonde e la fa partire: l'id restituito è il SUO.
 *
 * La lettura della riga PR qui sta FUORI dal lock e serve al 409 immediato;
 * `enqueueCorrection` la rilegge SOTTO il lock, e una PR chiusa nel frattempo
 * diventa lo stesso `pr_not_open` senza scrivere niente (il webhook di
 * chiusura scrive lo stato della riga prima di annullare: Task D3).
 *
 * La nota non finisce in nessun log: la scrive una persona per l'agente.
 */
export async function requestCorrection(
  db: Db,
  input: { ticketId: string; repositoryId: string; actor: Actor; note?: string },
): Promise<RequestCorrectionResult> {
  const { ticketId, repositoryId, actor } = input;
  const [pr] = await db
    .select({
      branch: ticketRepositories.branch,
      prUrl: ticketRepositories.prUrl,
      prState: ticketRepositories.prState,
      prNumber: ticketRepositories.prNumber,
      ticketNumber: tickets.number,
      adoptedAt: ticketRepositories.adoptedAt,
      adoptionReleasedAt: ticketRepositories.adoptionReleasedAt,
    })
    .from(ticketRepositories)
    .innerJoin(tickets, eq(tickets.id, ticketRepositories.ticketId))
    .where(
      and(eq(ticketRepositories.ticketId, ticketId), eq(ticketRepositories.repositoryId, repositoryId)),
    );
  if (!pr) return { ok: false, error: "pr_not_found" };
  // Stubwise non pusha MAI sul branch di qualcun altro (design §2) se non
  // dopo un'ADOZIONE esplicita di un maintainer (6 ott 2026): la regola
  // unica `isCorrectablePr` di @stubwise/shared, la stessa di derivePrCycle.
  if (!isCorrectablePr(pr)) return { ok: false, error: "not_stubwise_pr" };
  // Su una PR ADOTTATA «Chiedi modifiche» è di un admin (7 ott 2026,
  // `correctionActionAllowed`): un member riceve 403, niente scritto.
  // `enqueueCorrection` lo riverifica sotto il lock (difesa in profondità).
  if (!correctionActionAllowed(actor.role, pr)) return { ok: false, error: "forbidden" };
  // "Aperta" = la stessa condizione della coda di rilascio: `prState = 'open'`
  // E un `prUrl`. Il numero dalla riga; per le righe storiche (prima della
  // 0081, o un backfill che non l'ha riconosciuto) dall'URL.
  const prNumber = pr.prUrl === null ? null : (pr.prNumber ?? prNumberFromUrl(pr.prUrl));
  if (pr.prState !== "open" || prNumber === null) return { ok: false, error: "pr_not_open" };

  // Lo schema del corpo normalizza già una nota vuota ad assente; qui lo si
  // rifà per un chiamante che non passi dalla rotta.
  const note = input.note?.trim();
  // Niente `reviewId`: enqueueCorrection usa già l'ultima review completed
  // della PR (A6) — una regola in un posto solo.
  const result = await enqueueCorrection(db, {
    ticketId,
    repositoryId,
    prNumber,
    trigger: "stubwise",
    requestedByUserId: actor.id,
    actorRole: actor.role, // E7: solo un admin scavalca il budget
    ...(note ? { note } : {}),
  });
  if (!result.ok) {
    // Rilasciata fra la lettura qui sopra e il lock: lo stesso 409 del caso
    // letto subito.
    return { ok: false, error: result.error === "pr_not_correctable" ? "not_stubwise_pr" : result.error };
  }
  return { ok: true, correctionId: result.correctionId };
}
