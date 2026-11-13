import { instanceSettings, monthlyCostUsd, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * IL BUDGET MENSILE DELL'ISTANZA, in UN posto (area 7, F3, C-F3-1). La stessa
 * lettura stava in cinque copie (fix e correzioni, turni di refinement e di
 * chat, posta, server): ora la fanno tutti da qui, e il passo di Claude delle
 * automazioni e la sua prova la chiamano prima di OGNI passo (D1).
 *
 * - `limitUsd`: `instance_settings.monthly_budget_usd`, `null` = nessun limite
 *   (il numeric di Postgres arriva come stringa: `Number()` lo converte).
 * - `spentUsd`: `monthlyCostUsd` (TUTTI i run del mese, vedi il suo docblock).
 * - `exhausted`: c'è un limite e la spesa lo ha raggiunto.
 *
 * `costFn` si inietta solo nei test (come facevano le copie).
 */
export interface AiBudgetState {
  exhausted: boolean;
  limitUsd: number | null;
  spentUsd: number;
}

export async function monthlyBudgetLimitUsd(db: Db | Tx): Promise<number | null> {
  const [settings] = await (db as Db)
    .select({ monthlyBudgetUsd: instanceSettings.monthlyBudgetUsd })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return settings?.monthlyBudgetUsd != null && settings.monthlyBudgetUsd !== "" ? Number(settings.monthlyBudgetUsd) : null;
}

export async function aiBudgetState(db: Db | Tx, costFn: (db: Db) => Promise<number> = monthlyCostUsd): Promise<AiBudgetState> {
  const limitUsd = await monthlyBudgetLimitUsd(db);
  if (limitUsd === null) return { exhausted: false, limitUsd: null, spentUsd: 0 };
  const spentUsd = await costFn(db as Db);
  return { exhausted: spentUsd >= limitUsd, limitUsd, spentUsd };
}
