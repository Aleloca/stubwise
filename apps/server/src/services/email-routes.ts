import { emailMessages, googleAccounts, projectEmailRoutes, type Db } from "@stubwise/db";
import { normalizeRouteValue, type DbOrTx } from "@stubwise/notifications";
import type { EmailRoute } from "@stubwise/shared";
import { asc, eq, sql } from "drizzle-orm";

/**
 * Le REGOLE DI ROUTING della posta di un progetto (Fase 6, Task 6): lettura,
 * sostituzione dell'insieme, e l'elenco delle etichette Gmail già osservate che
 * alimenta il picker della UI.
 *
 * La normalizzazione dei valori NON è qui: arriva da `normalizeRouteValue` di
 * `@stubwise/notifications`, la stessa funzione che il poller (Task 7) usa per
 * confrontare. È il punto dell'intero modulo — una regola salvata in una grafia
 * e confrontata in un'altra è una regola che non scatta mai, e nessun test
 * dell'una o dell'altra metà se ne accorgerebbe.
 */

/** Ordine stabile delle regole in risposta: per criterio, poi per valore. */
async function readRoutes(db: DbOrTx, projectId: string): Promise<EmailRoute[]> {
  const rows = await db
    .select({ kind: projectEmailRoutes.kind, value: projectEmailRoutes.value })
    .from(projectEmailRoutes)
    .where(eq(projectEmailRoutes.projectId, projectId))
    .orderBy(asc(projectEmailRoutes.kind), asc(projectEmailRoutes.value));
  return rows.map((row) => ({ kind: row.kind, value: row.value }));
}

/** Le regole di un progetto, per `GET /api/projects/:projectId/email-routes`. */
export function listEmailRoutes(db: Db, projectId: string): Promise<EmailRoute[]> {
  return readRoutes(db, projectId);
}

/** Esito di {@link putEmailRoutes}: o le regole salvate, o il valore da correggere. */
export type PutEmailRoutesResult =
  | { ok: true; routes: EmailRoute[] }
  | { ok: false; error: "invalid_route_value"; detail: string };

/**
 * SOSTITUISCE l'insieme completo delle regole del progetto.
 *
 * Delete + insert in **una transazione**: un PUT che fallisse a metà lascerebbe
 * il progetto senza regole, cioè con tutta la sua posta fuori perimetro, che è
 * il modo peggiore di fallire (silenzioso: nessun errore, solo mail che
 * smettono di arrivare).
 *
 * I duplicati si deduplicano in silenzio — è quello che dice l'unique
 * `(project_id, kind, value)`, e due grafie della stessa regola non sono un
 * errore dell'utente ma la stessa intenzione scritta due volte. Un valore che
 * dopo la normalizzazione resta VUOTO è invece un 400: `@` o `<>` non sono una
 * regola, e salvarli come riga inerte darebbe l'impressione che filtrino
 * qualcosa.
 */
export async function putEmailRoutes(
  db: Db,
  projectId: string,
  routes: EmailRoute[],
): Promise<PutEmailRoutesResult> {
  const normalized: EmailRoute[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const value = normalizeRouteValue(route.kind, route.value);
    if (value === "") return { ok: false, error: "invalid_route_value", detail: route.value };
    const key = `${route.kind} ${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ kind: route.kind, value });
  }

  await db.transaction(async (tx) => {
    await tx.delete(projectEmailRoutes).where(eq(projectEmailRoutes.projectId, projectId));
    if (normalized.length > 0) {
      await tx
        .insert(projectEmailRoutes)
        .values(normalized.map((route) => ({ projectId, kind: route.kind, value: route.value })));
    }
  });

  return { ok: true, routes: await readRoutes(db, projectId) };
}

/**
 * Le etichette Gmail DISTINTE già viste nella posta delle caselle di CHI CHIEDE.
 *
 * Perché per utente e non per progetto: le etichette sono un fatto della
 * casella, non del progetto — un progetto senza regole non ha ancora nessun
 * messaggio, e un elenco costruito sulla sua posta sarebbe vuoto proprio quando
 * serve, cioè mentre si scrive la prima regola. L'utente vede quindi le proprie
 * etichette, che sono anche le sole che ha titolo per conoscere.
 *
 * Finché il poller (Task 7) non esiste `email_messages` è vuota e la risposta è
 * `[]`: è una lista di suggerimenti, e la sua assenza non impedisce di scrivere
 * a mano il nome di un'etichetta.
 */
export async function listObservedEmailLabels(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ label: sql<string>`distinct unnest(${emailMessages.labels})` })
    .from(emailMessages)
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(eq(googleAccounts.userId, userId));
  // L'ordinamento in JS e non in SQL: `distinct unnest(...)` in select list non
  // è ordinabile per la colonna derivata su tutti i piani, e la lista è per
  // costruzione piccola (le etichette di una casella, non i suoi messaggi).
  return rows
    .map((row) => row.label)
    .filter((label) => label !== null && label !== "")
    .sort((a, b) => a.localeCompare(b));
}
