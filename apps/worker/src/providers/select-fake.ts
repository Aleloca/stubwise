import type { Db } from "@stubwise/db";
import type { ResolvedProvider } from "./chain.js";
import type { EmptyReason, ProviderSelection, SelectDeps } from "./select.js";

/**
 * Scelta dell'account FINTA, per i test dei chiamanti che non seminano
 * `ai_providers` (o girano su un db finto): sostituisce `selectProviders` con
 * un esito fisso e rende `markProviderLimited` un no-op. Le regole vere della
 * scelta le prova `select.test.ts`; qui si prova cosa fa il chiamante con
 * l'esito.
 */
export function fakeSelect(
  db: Db,
  outcome: ResolvedProvider[] | { emptyReason: EmptyReason } | "legacy",
  extra: Partial<SelectDeps> = {},
): SelectDeps {
  const selection: ProviderSelection =
    outcome === "legacy"
      ? { candidates: [], legacyAuth: true, emptyReason: null }
      : Array.isArray(outcome)
        ? { candidates: outcome, legacyAuth: false, emptyReason: null }
        : { candidates: [], legacyAuth: false, emptyReason: outcome.emptyReason };
  return {
    db,
    encryptionKey: Buffer.alloc(32),
    backgroundWeeklyThreshold: 90,
    selectProvidersFn: async () => selection,
    markProviderLimitedFn: async () => undefined,
    ...extra,
  };
}
