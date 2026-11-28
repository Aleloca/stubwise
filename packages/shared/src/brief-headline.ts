/**
 * L'incipit di un brief: la prima sezione ("dove siamo") se il parse dei
 * marcatori l'ha prodotta, altrimenti l'inizio del markdown. Null se il brief
 * è `done` ma senza testo (provider assente: caso previsto, non un errore).
 *
 * Sta qui (spostata da `@stubwise/notifications`, che la ri-esporta) perché
 * la usano il server (la vista dell'Overview, la cronologia), il worker (la
 * `headline` della notifica `project.brief`) e la nuova app, che compone la
 * vista di un brief letto per id: la riga della card d'inbox, quella della
 * cronologia e quella del lettore devono essere LA STESSA, o lo stesso brief
 * sembrerebbe due brief diversi.
 */
export function briefHeadline(
  sections: Record<string, string> | null,
  summary: string | null,
): string | null {
  const first = sections?.whereWeAre ?? Object.values(sections ?? {})[0];
  const text = (first ?? summary ?? "").trim();
  if (!text) return null;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** Il testo intero di un brief: il markdown, o le sezioni ricomposte (come `latestWeeklyBrief`). */
export function briefSummaryText(sections: Record<string, string> | null, summary: string | null): string {
  return summary ?? Object.values(sections ?? {}).join("\n\n");
}
