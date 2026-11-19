import { aiProviders, aiUsageSnapshots } from "@stubwise/db";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authErrorResponses } from "./shared.js";

/**
 * Finestra di consumo normalizzata: percentuale usata e residua (interi 0–100,
 * complementari), più `resetsLabel`, l'orario di reset come label testuale
 * della vecchia TUI `/usage` (non-ISO, es. "2:39pm (Europe/Rome)") — opzionale.
 * Gli snapshot nuovi nascono dal `rate_limit_event` del CLI e hanno SEMPRE
 * `resetsLabel` null: il reset sta nei `*ResetAt`, e il pannello li usa quando
 * la label manca. Nullable perché lo snapshot la conserva come jsonb libero e
 * una finestra può mancare (es. nessun limite di 5 ore per gli account Ultra).
 */
const usageWindowSchema = z
  .object({
    percentUsed: z.number(),
    percentRemaining: z.number(),
    resetsLabel: z.string().nullable().optional(),
  })
  .nullable();

/**
 * Ultimo snapshot di consumo di una credenziale `account`. Dal 19 nov 2026 lo
 * scrive il worker leggendo il `rate_limit_event` dello stream-json (a ogni run
 * di un account, più una sonda minima per quelli fermi): `source` è
 * `deterministic` = letto senza LLM, `parseOk` true, `rawText` null. `llm_fallback`
 * e `parseOk=false` esistono solo per le righe del vecchio lettore `/usage`
 * (ritirato). `rawText` è incluso SOLO per quelle ultime (admin-only, serve al
 * banner di diagnosi): resta assente/null per tutti gli snapshot nuovi.
 */
const snapshotItemSchema = z.object({
  providerId: z.uuid(),
  providerLabel: z.string(),
  capturedAt: z.iso.datetime(),
  sessionRemaining: usageWindowSchema,
  weeklyRemaining: usageWindowSchema,
  sessionResetAt: z.iso.datetime().nullable(),
  weeklyResetAt: z.iso.datetime().nullable(),
  source: z.enum(["deterministic", "llm_fallback"]),
  parseOk: z.boolean(),
  rawText: z.string().nullable().optional(),
});

export const aiUsageSnapshotsSchema = z.array(snapshotItemSchema);

export type AiUsageSnapshot = z.infer<typeof snapshotItemSchema>;

/**
 * Route dell'usage residuo dell'abbonamento (ultimo snapshot per credenziale
 * `account`), sotto /api/ai-usage. Solo admin: `rawText` è admin-only e serve
 * alla diagnosi del parser.
 *
 * Query "ultimo snapshot per provider" senza N+1: un solo round-trip con
 * `DISTINCT ON (provider_id)` ordinato per `captured_at desc`, join su
 * ai_providers filtrato ai soli `account`. Postgres-specifico, ma il DB è
 * Postgres (testcontainers in test). Niente loop per-provider.
 */
export async function aiUsageSnapshotsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/snapshots",
    {
      config: { access: { kind: "instance", permission: "usage.view" } },
      schema: { response: { 200: aiUsageSnapshotsSchema, ...authErrorResponses } },
    },
    async () => {
      // DISTINCT ON (provider_id) tiene la prima riga per provider nell'ordine
      // dato: ordinando provider_id, captured_at desc otteniamo l'ultimo
      // snapshot di ciascun provider in un'unica query.
      const rows = await app.db
        .selectDistinctOn([aiUsageSnapshots.providerId], {
          providerId: aiUsageSnapshots.providerId,
          providerLabel: aiProviders.label,
          capturedAt: aiUsageSnapshots.capturedAt,
          sessionRemaining: aiUsageSnapshots.sessionRemaining,
          weeklyRemaining: aiUsageSnapshots.weeklyRemaining,
          sessionResetAt: aiUsageSnapshots.sessionResetAt,
          weeklyResetAt: aiUsageSnapshots.weeklyResetAt,
          source: aiUsageSnapshots.source,
          parseOk: aiUsageSnapshots.parseOk,
          rawText: aiUsageSnapshots.rawText,
        })
        .from(aiUsageSnapshots)
        .innerJoin(aiProviders, eq(aiUsageSnapshots.providerId, aiProviders.id))
        .where(eq(aiProviders.kind, "account"))
        .orderBy(aiUsageSnapshots.providerId, desc(aiUsageSnapshots.capturedAt));

      return rows.map((r) => ({
        providerId: r.providerId,
        providerLabel: r.providerLabel,
        capturedAt: r.capturedAt.toISOString(),
        sessionRemaining: normalizeWindow(r.sessionRemaining),
        weeklyRemaining: normalizeWindow(r.weeklyRemaining),
        sessionResetAt: r.sessionResetAt ? r.sessionResetAt.toISOString() : null,
        weeklyResetAt: r.weeklyResetAt ? r.weeklyResetAt.toISOString() : null,
        source: r.source,
        parseOk: r.parseOk,
        // rawText è admin-only e diagnostico: lo esponiamo SOLO quando il parse
        // è fallito (con parseOk=true a DB è già null, ma restiamo difensivi).
        rawText: r.parseOk ? null : (r.rawText ?? null),
      }));
    },
  );
}

/**
 * Normalizza il jsonb libero della finestra di consumo nello shape esposto
 * `{ percentUsed, percentRemaining, resetsLabel? }`, o null se mancante/non
 * conforme. `resetsLabel` è una label testuale (non-ISO) passata tale-e-quale.
 */
function normalizeWindow(
  value: unknown,
): { percentUsed: number; percentRemaining: number; resetsLabel?: string | null } | null {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.percentUsed === "number" && typeof v.percentRemaining === "number") {
      return {
        percentUsed: v.percentUsed,
        percentRemaining: v.percentRemaining,
        resetsLabel: typeof v.resetsLabel === "string" ? v.resetsLabel : null,
      };
    }
  }
  return null;
}
