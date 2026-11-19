import { aiProviders, aiUsageSnapshots, type Db } from "@stubwise/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { RateLimitInfo } from "../agent/rate-limit-event.js";

/**
 * Età massima di uno snapshot per considerarlo attendibile: la sonda d'uso
 * rilegge l'account dopo 30' di inattività (USAGE_PROBE_IDLE_MINUTES), più un
 * giro di poll e un margine = 45'. COSTANTE, non una env: se nessun run né
 * sonda rinfresca lo snapshot, la decisione degrada da sola al fallback a
 * tempo senza un'altra manopola da tenere coerente.
 */
export const MAX_SNAPSHOT_AGE_MS = 45 * 60_000;

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

/**
 * % usata EFFETTIVA di una finestra. Una finestra che l'evento non ha portato
 * (jsonb null o illeggibile) conta 0: non è consumata; una il cui reset è già
 * passato è ripartita, qualunque cosa dicesse lo snapshot (la % salvata è del
 * ciclo precedente). Altrimenti vale il percentUsed salvato.
 */
export function effectiveUsedPercent(value: unknown, resetAt: Date | null, now: Date): number {
  const w = parseWindow(value);
  if (w === null) return 0;
  if (resetAt !== null && resetAt.getTime() <= now.getTime()) return 0;
  return w.percentUsed;
}

function windowJson(percentUsed: number): { percentUsed: number; percentRemaining: number; resetsLabel: null } {
  return { percentUsed, percentRemaining: 100 - percentUsed, resetsLabel: null };
}

/**
 * Scrive lo snapshot d'uso dal `rate_limit_event` (five_hour → sessione,
 * seven_day → settimana; le altre finestre, come seven_day_opus, non hanno una
 * colonna). Nessuna delle due → non scrive e ritorna false. `captured_at` è
 * quello passato, non now(): l'istante dell'evento.
 */
export async function writeRateLimitSnapshot(
  db: Db,
  providerId: string,
  info: RateLimitInfo,
  capturedAt: Date,
): Promise<boolean> {
  const session = info.windows["five_hour"];
  const weekly = info.windows["seven_day"];
  if (!session && !weekly) return false;
  await db.insert(aiUsageSnapshots).values({
    providerId,
    capturedAt,
    source: "deterministic",
    parseOk: true,
    rawText: null,
    sessionRemaining: session ? windowJson(session.usedPercent) : null,
    weeklyRemaining: weekly ? windowJson(weekly.usedPercent) : null,
    sessionResetAt: session?.resetsAt ?? null,
    weeklyResetAt: weekly?.resetsAt ?? null,
  });
  return true;
}

/** L'evento dice che l'account può lavorare: status "allowed" e ogni finestra < 100. */
export function rateLimitAllowsUnlock(info: RateLimitInfo): boolean {
  return info.status === "allowed" && Object.values(info.windows).every((w) => w.usedPercent < 100);
}

/** Azzera `limited_until` se valorizzato; true se ha scritto. Il guard evita scritture a vuoto. */
export async function clearProviderLimit(db: Db, providerId: string): Promise<boolean> {
  const cleared = await db
    .update(aiProviders)
    .set({ limitedUntil: null })
    .where(and(eq(aiProviders.id, providerId), isNotNull(aiProviders.limitedUntil)))
    .returning({ id: aiProviders.id });
  if (cleared.length === 0) return false;
  console.error(
    `[stubwise-worker] usage: credenziale ${providerId} di nuovo con margine, «al limite» azzerato`,
  );
  return true;
}
