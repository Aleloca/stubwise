import { projectDecisions, repositories, type Db } from "@stubwise/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Contesto delle DECISIONI GIÀ PRESE per le chat interne (fase 5).
 *
 * Vive accanto a `./context.ts` perché è lo stesso mestiere — un blocco di
 * testo appeso al system prompt, recuperato per pertinenza alla domanda — e
 * perché ne eredita la REGOLA D'ORO: **la chat non deve MAI peggiorare per
 * colpa di questo**. Progetto senza decisioni, domanda che non tocca nulla,
 * query fallita, DB giù: tutto vale `null`, e il chiamante prosegue col system
 * prompt di sempre.
 *
 * ⚠️ PERCHÉ IL BLOCCO È DIVERSO DA QUELLO DEL GRAFO. Il grafo e le pagine dei
 * Docs sono *descrizioni* del sistema: possono essere vecchie, e il modello può
 * ragionarci sopra. Il registro decisioni è la fonte di verità sui FATTI decisi
 * da persone (`packages/db/src/decisions.ts`), non è mai scritto dall'AI, e per
 * questo le istruzioni gli danno un peso diverso: una decisione registrata non
 * si contraddice, al massimo si segnala che è stata superata.
 *
 * NIENTE CITAZIONI. La forma di `Citation` è quella delle pagine dei Docs
 * (repository, slug, titolo) e una decisione non ne ha una: forzarcela dentro
 * porterebbe la UI a offrire link che non aprono niente. Il blocco resta testo.
 */

/** Logger minimale in stile pino, come `GraphContextLogger` in `./context.ts`. */
export interface DecisionContextLogger {
  debug(obj: unknown, msg?: string): void;
}

/** Quante decisioni al massimo entrano nel prompt. */
const MAX_DECISIONS = 5;

/** Lunghezza minima di una parola perché valga come termine di ricerca. */
const MIN_TERM_LENGTH = 3;

/** Quanti termini della domanda si usano al massimo (una domanda lunga non deve pesare). */
const MAX_TERMS = 20;

/**
 * I termini di ricerca estratti dalla domanda.
 *
 * Tiene SOLO lettere e cifre (unicode): il risultato entra in una
 * `to_tsquery`, e un carattere come `&`, `|`, `!` o `:` la farebbe fallire —
 * o peggio, ne cambierebbe il significato. La sanificazione qui non sostituisce
 * il parametro bindato (il valore passa comunque come parametro): è ciò che
 * rende la query *valida*, non ciò che la rende sicura.
 *
 * Termini in OR e non in AND: una domanda in linguaggio naturale contiene
 * quasi sempre parole che nel registro non compaiono, e un AND non troverebbe
 * mai niente.
 */
function searchTerms(question: string): string[] {
  const seen = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_TERM_LENGTH) continue;
    seen.add(raw);
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}

/** Una decisione, come entra nel prompt. */
interface DecisionForPrompt {
  title: string;
  decision: string;
  context: string | null;
  consequences: string | null;
  decidedAt: Date;
}

/** Righe di istruzione al modello, premesse al blocco. */
const INSTRUCTIONS = [
  "La sezione qui sotto riporta DECISIONI GIÀ PRESE su questo progetto da persone del team: sono fatti registrati, non documentazione e non ipotesi.",
  "Trattale come vincolanti: se una domanda tocca una di queste decisioni, rispondi coerentemente con quanto è stato deciso e dillo esplicitamente, invece di proporre l'alternativa che era stata scartata.",
  "Se una decisione ti sembra superata dai fatti, segnalalo come un dubbio da verificare: non riscriverla e non darla per cambiata.",
];

/** Compone il blocco da appendere al system prompt. */
export function buildDecisionContextBlock(decisions: DecisionForPrompt[]): string {
  const parts = [...INSTRUCTIONS, "", "--- DECISIONI PRESE SU QUESTO PROGETTO ---"];
  for (const row of decisions) {
    const day = row.decidedAt.toISOString().slice(0, 10);
    parts.push(`### ${row.title} (${day})`);
    parts.push(`Decisione: ${row.decision}`);
    if (row.context) parts.push(`Contesto: ${row.context}`);
    if (row.consequences) parts.push(`Conseguenze: ${row.consequences}`);
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

/**
 * Appende il blocco delle decisioni al system prompt, se c'è.
 *
 * VA PER ULTIMO, dopo i chunk dei Docs e dopo il blocco del grafo: le sue
 * istruzioni parlano di vincoli che valgono *nonostante* quello che le fonti
 * descrittive dicono, e l'ultimo blocco è quello che il modello legge più
 * vicino alla domanda. Con `null` il system torna identico byte per byte.
 */
export function appendDecisionContext(system: string, block: string | null): string {
  return block === null ? system : `${system}\n\n${block}`;
}

/**
 * Le decisioni del progetto pertinenti alla domanda, come blocco di testo.
 *
 * Full-text `to_tsvector('simple')` su titolo + decisione — `simple` e non una
 * configurazione linguistica perché l'istanza può essere in italiano o in
 * inglese e lo stemming sbagliato è peggio di nessuno stemming — ordinate per
 * pertinenza e, a parità, dalla più recente.
 *
 * `null` in ogni caso in cui non c'è nulla da dire o qualcosa è andato storto:
 * è il contratto di questo modulo.
 */
export async function retrieveDecisionContext(
  db: Db,
  { projectId, question }: { projectId: string; question: string },
  logger: DecisionContextLogger,
): Promise<string | null> {
  const terms = searchTerms(question);
  // Domanda senza parole utili ("?", "ok", emoji): non si interroga il DB.
  if (terms.length === 0) return null;
  const tsquery = terms.join(" | ");

  try {
    const matches = sql`to_tsvector('simple', ${projectDecisions.title} || ' ' || ${projectDecisions.decision}) @@ to_tsquery('simple', ${tsquery})`;
    const rank = sql`ts_rank(to_tsvector('simple', ${projectDecisions.title} || ' ' || ${projectDecisions.decision}), to_tsquery('simple', ${tsquery}))`;

    const rows = await db
      .select({
        title: projectDecisions.title,
        decision: projectDecisions.decision,
        context: projectDecisions.context,
        consequences: projectDecisions.consequences,
        decidedAt: projectDecisions.decidedAt,
      })
      .from(projectDecisions)
      .where(and(eq(projectDecisions.projectId, projectId), matches))
      .orderBy(sql`${rank} desc`, sql`${projectDecisions.decidedAt} desc`)
      .limit(MAX_DECISIONS);

    if (rows.length === 0) return null;
    return buildDecisionContextBlock(rows);
  } catch (err) {
    logger.debug(
      { err, projectId },
      "[decisions] retrieval del registro fallito: la chat prosegue senza",
    );
    return null;
  }
}

/**
 * Variante per le chat ancorate a un REPOSITORY (Docs di repo, `/docs` di
 * Slack): il registro è di progetto, quindi si risale al progetto del
 * repository. Un repository senza progetto — o inesistente — vale `null`, come
 * tutto il resto.
 */
export async function retrieveDecisionContextForRepository(
  db: Db,
  { repositoryId, question }: { repositoryId: string; question: string },
  logger: DecisionContextLogger,
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ projectId: repositories.projectId })
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    if (!row?.projectId) return null;
    return await retrieveDecisionContext(db, { projectId: row.projectId, question }, logger);
  } catch (err) {
    logger.debug(
      { err, repositoryId },
      "[decisions] retrieval del registro per repository fallito: la chat prosegue senza",
    );
    return null;
  }
}
