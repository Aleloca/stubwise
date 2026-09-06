import type { Db } from "./client.js";
import { projectDecisions, type ProjectDecisionRow } from "./schema.js";

/** `Db` o una transazione drizzle: la decisione va scritta dove sta l'evento. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Le quattro sorgenti ammesse dal CHECK `project_decisions_source_chk`. */
export type DecisionSource = "ask_user" | "plan_review" | "pulse" | "manual";

export interface RecordDecisionParams {
  projectId: string;
  source: DecisionSource;
  /**
   * Chiave di IDEMPOTENZA della decisione dentro il progetto
   * (`question:<id>`, `plan_review:<jobId>:<n>`, `pulse:<notificationId>`,
   * `manual:<uuid>`). È l'unica cosa che rende un replay del writer innocuo.
   */
  sourceKey: string;
  /** Gli id d'origine in forma strutturata, per risalire all'evento. */
  sourceRef?: Record<string, unknown>;
  ticketId?: string | null;
  title: string;
  context?: string | null;
  decision: string;
  consequences?: string | null;
  decidedByUserId?: string | null;
  /** Omesso = `now()` del DB (il default della colonna). */
  decidedAt?: Date;
}

/**
 * Registra una decisione nel registro di progetto (`project_decisions`).
 *
 * ⚠️ INVARIANTE DELLA FASE 5 — **il registro non è mai scritto dall'AI.** Questo
 * helper non chiama nessun agente e non deve mai farlo: i suoi chiamanti
 * automatici (risposta a una domanda dell'agente, approvazione/rifiuto di un
 * piano, "Procedi" del pulse) compongono `title`, `decision`, `context` e
 * `consequences` da **template i18n** (`decision.*`) interpolati con dati
 * strutturati GIÀ persistiti — il testo della domanda, l'etichetta dell'opzione
 * scelta, la sua `consequence`, le istruzioni di rifiuto scritte da una persona,
 * il titolo della voce di backlog e quelli delle alternative scartate. Le voci
 * `manual` le scrive una persona. Il brief e i riassunti "in breve" sono
 * narrativa generata; questo è il FATTO, ed è la sola cosa che la chat, i Docs e
 * il tool MCP possono citare come tale.
 *
 * Va chiamata NELLA STESSA TRANSAZIONE dell'evento che registra: una decisione
 * sopravvissuta a un UPDATE annullato (la risposta persa in una corsa, il piano
 * risolto da un altro fra la lettura e la scrittura) racconterebbe una scelta
 * che nessuno ha mai fatto.
 *
 * IDEMPOTENZA: `onConflictDoNothing` sull'unique `(project_id, source_key)`.
 * Un replay non aggiunge una riga **e non riscrive quella esistente** — la prima
 * versione del fatto è quella buona. Il ritorno lo dice: la riga creata, oppure
 * `null` quando non è stato scritto nulla perché c'era già.
 */
export async function recordDecision(
  db: DbOrTx,
  params: RecordDecisionParams,
): Promise<ProjectDecisionRow | null> {
  const rows = await db
    .insert(projectDecisions)
    .values({
      projectId: params.projectId,
      source: params.source,
      sourceKey: params.sourceKey,
      ...(params.sourceRef ? { sourceRef: params.sourceRef } : {}),
      ...(params.ticketId ? { ticketId: params.ticketId } : {}),
      title: params.title,
      ...(params.context ? { context: params.context } : {}),
      decision: params.decision,
      ...(params.consequences ? { consequences: params.consequences } : {}),
      ...(params.decidedByUserId ? { decidedByUserId: params.decidedByUserId } : {}),
      ...(params.decidedAt ? { decidedAt: params.decidedAt } : {}),
    })
    .onConflictDoNothing({
      target: [projectDecisions.projectId, projectDecisions.sourceKey],
    })
    .returning();
  return rows[0] ?? null;
}
