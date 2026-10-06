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

/** La riga `ticket_repositories` che la regola guarda. */
export interface CorrectablePrRow {
  branch: string;
  /** Il numero del ticket che possiede la riga. */
  ticketNumber: number;
  /** Adozione esplicita di un maintainer (6 ott 2026); null = mai adottata. */
  adoptedAt: Date | string | null;
  /** Adozione rilasciata («Smetti di correggere»); null = ancora adottata. */
  adoptionReleasedAt: Date | string | null;
}

/**
 * LA regola di correggibilità (6 ott 2026, design
 * `docs/plans/2026-10-06-adopt-external-pr-design.md`): Stubwise può
 * pushare correzioni sul branch di una PR SOLO se
 *  - è il branch `stubwise/ticket-<N>` del ticket stesso (la PR che Stubwise
 *    ha aperto), OPPURE
 *  - un maintainer l'ha ADOTTATA esplicitamente e non l'ha ancora rilasciata.
 *
 * Una sola copia: `derivePrCycle`, la rotta delle correzioni, il webhook
 * «Request changes», `enqueueCorrection`, la review e `runCorrection` la
 * importano da qui. Chi decide «chi può correggere cosa» non deve esistere in
 * due copie: è il modo in cui un bottone mostrato smette di funzionare, o —
 * peggio — una correzione finisce sul branch di una persona che non l'ha
 * chiesta. Che una PR SIA adottabile (fork, branch base) lo decide
 * l'adozione, prima di scrivere `adoptedAt`: qui si legge solo il fatto.
 */
export function isCorrectablePr(row: CorrectablePrRow): boolean {
  if (stubwiseTicketNumber(row.branch) === row.ticketNumber) return true;
  return row.adoptedAt !== null && row.adoptionReleasedAt === null;
}
