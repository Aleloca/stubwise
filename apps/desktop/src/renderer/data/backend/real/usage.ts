import { ApiError } from "@stubwise/api-client";
import type { UsageDimension, UsageRange, UsageRow, UsageView } from "../../instance/usage";
import { appClient } from "./client";

// Amministrazione → AI → Usage nella build app (area 9, F4) su
// `GET /api/ai-usage/summary` (72): la forma del prototipo, col raggruppamento,
// i giorni a zero e la riga «Other projects» (R-G5, `key: "other"`) fatti dal
// server. Le righe «senza» (nessun progetto, nessun account) il server le
// chiama `none`: qui sono `key: null`, come nel prototipo, e le parole le mette
// la scheda. Un intervallo rifiutato (`range_too_long`, `invalid_range`) è un
// errore della lettura.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** La rotta (sul client vero: `client.usage`). */
export interface UsageApi {
  summary(input: {
    range: UsageRange;
    groupBy: UsageDimension;
    thenBy?: UsageDimension;
    projectId?: string;
  }): Promise<Any>;
}

const rowOf = (r: Any): UsageRow => ({
  key: r.key === "none" ? null : r.key,
  label: r.key === "none" ? "" : r.label,
  ...(r.code ? { code: r.code } : {}),
  costUsd: r.costUsd,
  tokens: r.tokens,
  runs: r.runs,
});

export function createRealUsage(api: UsageApi) {
  return {
    async getUsage(input: {
      range: UsageRange;
      groupBy: UsageDimension;
      thenBy?: UsageDimension;
      /** Settings → Usage del progetto: i soli consumi di quel progetto (404 → `not_found`). */
      projectId?: string;
    }): Promise<UsageView> {
      try {
        const s = await api.summary(input);
        return {
          totals: s.totals,
          byDay: s.byDay,
          rows: (s.rows as Any[]).map((r) => ({
            ...rowOf(r),
            children: (r.children ?? []).map(rowOf),
          })),
        };
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
        if (error instanceof ApiError && error.status === 404) throw new Error("not_found");
        if (error instanceof ApiError && error.status === 400)
          throw new Error(error.code || "invalid_range");
        throw error;
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: UsageApi = {
  summary: (input) => appClient().usage.summary(input as Any),
};

/** SOLO TEST: la rotta vera. */
export const liveUsageApiForTest = liveApi;

export const liveUsage = createRealUsage(liveApi);

/**
 * Progetto → Settings → Usage (ritiro del web vecchio, inventario 1.3): la
 * stessa lettura col filtro per progetto. `null` per un progetto che chi
 * guarda non vede, come il prototipo (`getProjectUsage`).
 */
export async function getProjectUsage(
  projectId: string,
  input: { range: UsageRange; groupBy: UsageDimension; thenBy?: UsageDimension },
): Promise<UsageView | null> {
  try {
    return await liveUsage.getUsage({ ...input, projectId });
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") return null;
    throw error;
  }
}
