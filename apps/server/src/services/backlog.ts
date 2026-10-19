/**
 * Servizio del backlog di discovery: le operazioni che devono poter essere
 * invocate ANCHE fuori da una rotta HTTP.
 *
 * `convertBacklogItem` nasce estraendo il corpo di `POST
 * /api/backlog/:id/convert` (routes/backlog.ts), che restava logica inline in
 * una rotta e quindi non era riusabile. La rotta ora è un adattatore che mappa
 * gli errori tipizzati sui suoi status HTTP; il secondo chiamante è il "Procedi
 * con X" del pulse (fase 2), che converte la proposta scelta e ne lancia il run.
 */
import { backlogItemRequesters, backlogItems, backlogItemTickets, tickets, type Db } from "@stubwise/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { createTicket } from "../db/tickets.js";
import { closeRefineSessionForItem } from "./backlog-refine.js";
import type { Actor } from "./jobs.js";

export interface ConvertBacklogItemInput {
  itemId: string;
  /**
   * Chi chiede la conversione. NON è un gate: promuovere un'idea a task è
   * lavoro da operator (la rotta è `requireAuth`, non `requireAdmin`) e il
   * controllo su chi può ESEGUIRE sta a valle, nel gate del piano di
   * `startRun`. OGGI NON È USATO: né `createTicket` né `backlog_items`
   * registrano chi ha convertito. Sta nell'input per stabilità di firma verso
   * i chiamanti (la rotta e il pulse), così tracciare l'autore in futuro non
   * costringerà a toccarli.
   */
  actor: Actor;
}

export type ConvertBacklogItemResult =
  | { ok: true; ticketId: string; ticketNumber: number }
  | { ok: false; error: "not_found" | "already_converted" | "not_convertible" };

/**
 * Converte una voce di backlog in un ticket `task`: documento come corpo,
 * priorità dall'urgenza ed effort già valorizzato, riusando `createTicket`
 * (numero sequenziale per-progetto, row-lock su `projects`). NON accoda alcun
 * `aiJob`: il gate di automazione o il run manuale decideranno. Linka con
 * `role=converted_to` e porta la voce in `converted`. Tutto transazionale
 * (`createTicket` apre un savepoint annidato).
 *
 * Errori: `not_found` (voce inesistente), `already_converted` (voce già
 * convertita, anche per corsa fra due chiamate concorrenti), `not_convertible`
 * (voce archiviata: la UI nasconde già l'azione sulle voci bloccate).
 *
 * ASIMMETRIA VOLUTA fra pre-check e claim: la guardia sull'archiviata sta SOLO
 * nel pre-check, quindi la corsa archivia/converti resta aperta (chi archivia
 * mentre l'altro sta convertendo perde: il ticket nasce lo stesso). Il claim
 * protegge dal DOPPIO ticket, non dall'archiviazione. Non spostare la guardia
 * dentro il claim: `claimed = 0` diventerebbe ambiguo fra `already_converted` e
 * `not_convertible`, e i due 409 non sarebbero più distinguibili.
 */
export async function convertBacklogItem(
  db: Db,
  input: ConvertBacklogItemInput,
): Promise<ConvertBacklogItemResult> {
  const id = input.itemId;
  const [item] = await db
    .select({
      projectId: backlogItems.projectId,
      title: backlogItems.title,
      document: backlogItems.document,
      implementationPlan: backlogItems.implementationPlan,
      originContent: backlogItems.originContent,
      status: backlogItems.status,
      effort: backlogItems.effort,
      urgency: backlogItems.urgency,
    })
    .from(backlogItems)
    .where(eq(backlogItems.id, id));
  if (!item) return { ok: false, error: "not_found" };
  if (item.status === "converted") return { ok: false, error: "already_converted" };
  if (item.status === "archived") return { ok: false, error: "not_convertible" };

  const result = await db.transaction(async (tx) => {
    // CLAIM anti-TOCTOU come PRIMA operazione: UPDATE condizionato allo
    // stato. Due convert concorrenti si serializzano sul row-lock della
    // voce: il secondo trova 0 righe (status già converted) ed esce SENZA
    // aver creato nulla (→ already_converted). Il pre-check sopra resta solo
    // per il fast-path senza transazione.
    const claimed = await tx
      .update(backlogItems)
      .set({ status: "converted" })
      .where(and(eq(backlogItems.id, id), sql`${backlogItems.status} <> 'converted'`))
      .returning({ id: backlogItems.id });
    if (claimed.length === 0) return null;

    // Il ticket eredita il richiedente più vecchio della voce (null se non ce
    // ne sono). Letto dopo il claim, nella stessa transazione.
    const [firstRequester] = await tx
      .select({ userId: backlogItemRequesters.userId })
      .from(backlogItemRequesters)
      .where(eq(backlogItemRequesters.itemId, id))
      .orderBy(asc(backlogItemRequesters.requestedAt), asc(backlogItemRequesters.userId))
      .limit(1);
    const ticket = await createTicket(tx, {
      requestedByUserId: firstRequester?.userId ?? null,
      projectId: item.projectId,
      title: item.title,
      body: item.document,
      type: "task",
      priority: item.urgency ?? "medium",
      source: "manual",
      // Il ticket eredita design (originContent) e piano dalla voce.
      implementationPlan: item.implementationPlan,
      originContent: item.originContent,
    });
    // createTicket non copre l'effort: lo propaghiamo dalla voce (già stimato).
    if (item.effort !== null) {
      await tx.update(tickets).set({ effort: item.effort }).where(eq(tickets.id, ticket.id));
    }
    await tx
      .insert(backlogItemTickets)
      .values({ itemId: id, ticketId: ticket.id, role: "converted_to" });
    // La conversione chiude anche la sessione di refinement: la voce è ormai un
    // ticket. Dopo il claim (che tiene il lock della voce): ordine voce → sessione.
    await closeRefineSessionForItem(tx, id);
    return { ticketId: ticket.id, ticketNumber: ticket.number };
  });

  if (!result) return { ok: false, error: "already_converted" };
  return { ok: true, ...result };
}
