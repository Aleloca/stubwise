/**
 * ESECUZIONE AUTOMATICA di una serie ricorrente (fase 7b, Task 5).
 *
 * ⚠️ **Questo modulo non chiama MAI un esecutore di agenti, e non deve
 * poterlo fare in futuro** — è la stessa linea della fase 7 (nessun lavoro
 * parte senza che una persona lo decida) applicata a un'automazione
 * RICORRENTE, dove il costo di sbagliare si moltiplica per il numero di
 * occorrenze: è la lezione delle 730 notifiche del 9 settembre 2026 in
 * un'altra forma. `decisions-never-ai.test.ts` verifica anche questo
 * modulo, sia a runtime (l'SDK Anthropic mockato resta a zero mentre questa
 * funzione gira davvero su un Postgres vero) sia sul sorgente.
 *
 * Per questo **non riusa** i servizi del server (`enqueueBacklogIntake`,
 * `createMilestone`, `apps/server/src/services/*.ts`): quello per
 * `create_backlog_item` avvia un job d'intake — un run del modello che
 * riassume il contenuto — ESATTAMENTE il tipo di lavoro che qui non deve mai
 * partire da solo. Le due scritture qui sotto sono quindi DIRETTE e
 * DETERMINISTICHE: nessun jsonb generato, nessuna coda.
 *
 * `milestone` e `backlog_item` sono INSERT dirette (poche righe, non un
 * servizio importato attraverso il confine server/worker — stessa scelta
 * documentata per `gmailThreadUrl`/`calendarDayUrl` in questo modulo);
 * `reminder` non crea nulla: la card della proposta È il promemoria.
 */
import { backlogItems, milestones, type Db } from "@stubwise/db";
import { and, eq } from "drizzle-orm";

export interface AutoCalendarActionInput {
  action: "backlog_item" | "milestone" | "reminder";
  projectId: string;
  /** Il nome della milestone / il titolo della voce di backlog: «<titolo> entro il <data>». */
  name: string;
  /** Scadenza ISO (`YYYY-MM-DD`) dell'occorrenza. */
  dueDate: string;
}

export type AutoCalendarActionOutcome =
  | { type: "milestone"; milestoneId: string }
  | { type: "backlog_item"; backlogItemId: string }
  | { type: "reminder" }
  /** Una milestone con lo stesso nome esiste già su questo progetto: non è un errore, l'oggetto voluto c'era. */
  | { type: "exists" };

/**
 * Esegue l'azione configurata sulla serie e torna l'esito da scrivere su
 * `calendar_events.outcome`. Non lancia mai per un progetto scomparso: chi
 * chiama ha appena letto la riga con un `project_id` valido nella stessa
 * casella, e un progetto cancellato nel mezzo è un caso limite che si
 * accetta di non coprire qui (a differenza del percorso manuale, questo non
 * ha un utente a cui rispondere "non è più possibile").
 */
export async function executeAutoCalendarAction(
  db: Db,
  input: AutoCalendarActionInput,
): Promise<AutoCalendarActionOutcome> {
  if (input.action === "reminder") return { type: "reminder" };

  if (input.action === "milestone") {
    const [existing] = await db
      .select({ id: milestones.id })
      .from(milestones)
      .where(and(eq(milestones.projectId, input.projectId), eq(milestones.name, input.name)));
    if (existing) return { type: "exists" };
    const [created] = await db
      .insert(milestones)
      .values({ projectId: input.projectId, name: input.name, dueDate: new Date(input.dueDate) })
      .onConflictDoNothing()
      .returning({ id: milestones.id });
    if (!created) {
      // Corsa persa contro un'altra riga della stessa serie (non dovrebbe
      // succedere: il dedup per-tick del poller ne tenta una sola) — trattata
      // come "esiste già", non come un fallimento da riprovare all'infinito.
      return { type: "exists" };
    }
    return { type: "milestone", milestoneId: created.id };
  }

  // "backlog_item": INSERT diretta, testo deterministico, nessun job — il
  // corpo non ha bisogno di un modello per dire "questo appuntamento
  // ricorrente propone una voce di backlog".
  const [created] = await db
    .insert(backlogItems)
    .values({
      projectId: input.projectId,
      title: input.name,
      document: input.name,
      source: "manual",
    })
    .returning({ id: backlogItems.id });
  if (!created) throw new Error("insert della voce di backlog non ha restituito la riga");
  return { type: "backlog_item", backlogItemId: created.id };
}
