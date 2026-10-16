import { aiUsageSnapshots, type Db } from "@stubwise/db";
import { desc } from "drizzle-orm";

/**
 * Età massima di uno snapshot d'usage per considerarlo attendibile: 3 volte il
 * default di USAGE_POLL_MINUTES (5') = 15'. COSTANTE, non una env: se il poll
 * usage è più lento (o disabilitato) gli snapshot risultano stantii e la
 * decisione degrada da sola al fallback a tempo — il comportamento giusto senza
 * un'altra manopola da tenere coerente.
 */
export const MAX_SNAPSHOT_AGE_MS = 3 * 5 * 60_000;

/**
 * Finestra di consumo normalizzata dal jsonb libero dello snapshot. Difensiva:
 * campi mancanti o malformati → null, e il chiamante degrada al fallback a
 * tempo (mai fidarsi di un numero che non c'è).
 */
export function parseWindow(value: unknown): { percentUsed: number } | null {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.percentUsed === "number" && Number.isFinite(v.percentUsed)) {
      return { percentUsed: v.percentUsed };
    }
  }
  return null;
}

/** Ultimo snapshot per provider (vedi latestSnapshots). */
export interface LatestSnapshot {
  capturedAt: Date;
  parseOk: boolean;
  sessionRemaining: unknown;
  weeklyRemaining: unknown;
  sessionResetAt: Date | null;
  weeklyResetAt: Date | null;
}

/**
 * Ultimo snapshot d'usage di CIASCUN provider in un solo round-trip:
 * `DISTINCT ON (provider_id)` ordinato per provider_id, captured_at desc
 * (stesso pattern di apps/server/src/routes/usage-snapshots.ts). Niente filtro
 * sul kind: gli api_key semplicemente non hanno snapshot.
 */
export async function latestSnapshots(db: Db): Promise<Map<string, LatestSnapshot>> {
  const rows = await db
    .selectDistinctOn([aiUsageSnapshots.providerId], {
      providerId: aiUsageSnapshots.providerId,
      capturedAt: aiUsageSnapshots.capturedAt,
      parseOk: aiUsageSnapshots.parseOk,
      sessionRemaining: aiUsageSnapshots.sessionRemaining,
      weeklyRemaining: aiUsageSnapshots.weeklyRemaining,
      sessionResetAt: aiUsageSnapshots.sessionResetAt,
      weeklyResetAt: aiUsageSnapshots.weeklyResetAt,
    })
    .from(aiUsageSnapshots)
    .orderBy(aiUsageSnapshots.providerId, desc(aiUsageSnapshots.capturedAt));
  return new Map(rows.map((r) => [r.providerId, r]));
}
