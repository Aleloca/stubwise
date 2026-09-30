import { prCorrections } from "@stubwise/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "./dispatch.js";

/**
 * IL CICLO DI CORREZIONE di una PR aperta da Stubwise (design
 * `docs/plans/2026-09-30-pr-correction-loop-design.md`), condiviso fra SERVER
 * (il bottone, il webhook del provider, la riga di stato sul ticket) e WORKER
 * (la review che chiede modifiche, la correzione che ha pushato). Sta qui per
 * la stessa ragione di `project-timeline.ts`: due writer della stessa coda in
 * due app diverse sono esattamente due regole che poi divergono.
 *
 * Una correzione è una riga `pr_corrections` più, quando parte, una riga
 * `ai_jobs` con `correction_id`. Il CONTATORE dei giri automatici non si salva
 * da nessuna parte: si deriva dalle righe, così non può andare fuori sincrono.
 */

/** Dove: una PR di una repository. */
export interface PrRef {
  repositoryId: string;
  prNumber: number;
}

/** I trigger di una persona: azzerano il contatore della tornata. */
const HUMAN_TRIGGERS = ["stubwise", "provider"] as const;

/** Le righe di UNA PR. */
function onPr(pr: PrRef) {
  return and(
    eq(prCorrections.repositoryId, pr.repositoryId),
    eq(prCorrections.prNumber, pr.prNumber),
  );
}

/**
 * Quante correzioni AUTOMATICHE (`trigger='review'`) ha fatto la tornata
 * corrente della PR: quelle create DOPO l'ultima richiesta umana
 * (`stubwise`/`provider`), o tutte se una persona non ha mai chiesto niente.
 *
 * Le `cancelled` non contano in nessuno dei due sensi (una correzione annullata
 * con la PR chiusa non è né un giro né un azzeramento). Una richiesta umana
 * ancora `pending` azzera GIÀ: la tornata nuova comincia quando una persona
 * chiede, non quando la sua correzione riesce a partire — altrimenti il ciclo
 * automatico potrebbe fermarsi al tetto proprio mentre una persona ha appena
 * chiesto di andare avanti.
 *
 * A parità di istante l'automatica conta come PRECEDENTE all'umana (confronto `>` stretto): non è un giro della tornata nuova.
 *
 * La correzione `queued` in corso CONTA: è il giro che sta girando ("Giro 2 di
 * 3 · correzione in corso").
 */
export async function autoRoundsInCurrentSeries(db: DbOrTx, pr: PrRef): Promise<number> {
  // UNA sola query: la soglia dell'ultima richiesta umana è una subquery, così
  // il confronto resta in Postgres alla precisione dei microsecondi (un `Date`
  // JS la troncherebbe ai millisecondi) e non c'è una finestra fra due letture.
  const human = alias(prCorrections, "human");
  const lastHumanAt = db
    .select({ at: sql`max(${human.createdAt})` })
    .from(human)
    .where(
      and(
        eq(human.repositoryId, pr.repositoryId),
        eq(human.prNumber, pr.prNumber),
        inArray(human.trigger, [...HUMAN_TRIGGERS]),
        ne(human.status, "cancelled"),
      ),
    );
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(prCorrections)
    .where(
      and(
        onPr(pr),
        eq(prCorrections.trigger, "review"),
        ne(prCorrections.status, "cancelled"),
        sql`${prCorrections.createdAt} > coalesce((${lastHumanAt}), '-infinity'::timestamptz)`,
      ),
    );
  return row?.n ?? 0;
}
