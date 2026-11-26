import { backlogItemRequesters, backlogItems, backlogItemTickets, milestones, projects, projectStatuses, tickets, type Db } from "@stubwise/db";
import { and, asc, eq, notInArray } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Un evento delle Automations come lo leggono i campi dell'inizio: tipo, progetto, oggetto, la fotografia del trigger. */
export interface AutomationEventRef {
  kind: "task_created" | "task_closed" | "request_created" | "request_converted" | "milestone_reached";
  projectId: string;
  objectId: string;
  payload: unknown;
}

/**
 * I CAMPI DELL'INIZIO di un evento (`triggerFields.ts` di `@stubwise/shared`),
 * composti dalle righe vere (area 7, fetta 1). Sta qui perché lo usano il
 * consumatore del worker (l'esecuzione vera) e gli esempi della prova nel
 * server: la prova parte coi dati che leggerebbe l'esecuzione. Un oggetto
 * sparito ripiega sulla fotografia del trigger (`payload`).
 */

async function projectCodeOf(tx: Tx, projectId: string): Promise<string> {
  const [p] = await tx.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  return p?.code ?? "";
}

async function taskFields(tx: Tx, ticketId: string, code: string, snapshot: Record<string, unknown>) {
  const [t] = await tx
    .select({ number: tickets.number, title: tickets.title, assigneeId: tickets.assigneeId, status: projectStatuses.name })
    .from(tickets)
    .leftJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
    .where(eq(tickets.id, ticketId));
  const number = t?.number ?? (snapshot.number as number | undefined) ?? null;
  return {
    codice: number === null ? "" : `${code}-${number}`,
    titolo: t?.title ?? (snapshot.title as string | undefined) ?? "",
    progetto: code,
    incaricato: t?.assigneeId ?? (snapshot.assigneeId as string | null | undefined) ?? "",
    stato: t?.status ?? "",
  };
}

async function requestFields(tx: Tx, itemId: string, code: string, snapshot: Record<string, unknown>) {
  const [r] = await tx
    .select({ number: backlogItems.number, title: backlogItems.title, document: backlogItems.document, urgency: backlogItems.urgency })
    .from(backlogItems)
    .where(eq(backlogItems.id, itemId));
  const [requester] = await tx
    .select({ userId: backlogItemRequesters.userId })
    .from(backlogItemRequesters)
    .where(eq(backlogItemRequesters.itemId, itemId))
    .orderBy(asc(backlogItemRequesters.requestedAt), asc(backlogItemRequesters.userId))
    .limit(1);
  // «Dal supporto»: la voce nasce da una task del widget del customer service.
  const [support] = await tx
    .select({ id: tickets.id })
    .from(backlogItemTickets)
    .innerJoin(tickets, eq(tickets.id, backlogItemTickets.ticketId))
    .where(and(eq(backlogItemTickets.itemId, itemId), notInArray(backlogItemTickets.role, ["converted_to"]), eq(tickets.source, "widget")))
    .limit(1);
  const number = r?.number ?? (snapshot.number as number | undefined) ?? null;
  return {
    codice: number === null ? "" : `${code}-R${number}`,
    titolo: r?.title ?? (snapshot.title as string | undefined) ?? "",
    descrizione: r?.document ?? "",
    progetto: code,
    richiedente: requester?.userId ?? "",
    urgenza: r?.urgency ?? (snapshot.urgency as string | null | undefined) ?? "",
    dal_supporto: support !== undefined,
  };
}

/** I campi dell'inizio di un evento, dalle righe vere al consumo. */
export async function automationEventFields(tx: Tx | Db, event: AutomationEventRef): Promise<Record<string, unknown>> {
  const t = tx as Tx;
  const snapshot = (event.payload ?? {}) as Record<string, unknown>;
  const code = await projectCodeOf(t, event.projectId);
  switch (event.kind) {
    case "task_created":
    case "task_closed":
      return { task: await taskFields(t, event.objectId, code, snapshot) };
    case "request_created":
      return { richiesta: await requestFields(t, event.objectId, code, snapshot) };
    case "request_converted": {
      const ticketId = typeof snapshot.ticketId === "string" ? snapshot.ticketId : null;
      return {
        richiesta: await requestFields(t, event.objectId, code, snapshot),
        ...(ticketId ? { task: await taskFields(t, ticketId, code, {}) } : {}),
      };
    }
    case "milestone_reached": {
      const [m] = await t.select({ name: milestones.name }).from(milestones).where(eq(milestones.id, event.objectId));
      return { traguardo: { nome: m?.name ?? (snapshot.name as string | undefined) ?? "", progetto: code } };
    }
  }
}
