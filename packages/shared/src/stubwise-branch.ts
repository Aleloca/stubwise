/**
 * I branch dei fix di Stubwise sono `stubwise/ticket-<N>`. UNA sola regex per
 * tutto il monorepo: il webhook (`apps/server/src/routes/webhooks.ts`), la
 * derivazione del ciclo (`derivePrCycle`), la rotta delle correzioni, il
 * webhook "Request changes" e il worker la IMPORTANO da qui. Quattro copie
 * erano la ragione per cui `derivePrCycle` accettava qualunque `stubwise/*`
 * (anche `stubwise/graphify-setup`) mentre la rotta rispondeva 409: un
 * bottone mostrato che non funzionava.
 */
export const STUBWISE_BRANCH_RE = /^stubwise\/ticket-(\d+)$/;

/** Il numero del ticket di un branch Stubwise, o null se il branch non lo è. */
export function stubwiseTicketNumber(branch: string): number | null {
  const m = STUBWISE_BRANCH_RE.exec(branch);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}
