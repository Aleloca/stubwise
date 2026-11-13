// La bozza delle note di rilascio di una PR (area 8, F1; era
// `data/releases/notes.ts` del prototipo, area 10b S6b). Nessun modello: una
// riga per task, dalla task della PR e dai commit che citano un codice di
// task. Pura: il chiamante cerca le task dei codici (`citedTaskCodes`) e
// passa SOLO quelle che chi chiede vede e che sono del progetto della PR —
// un codice invisibile, eliminato, inesistente o di un altro progetto non dà
// righe (R-G5, I2 dell'area 10b).

/** Un codice di task in un messaggio di commit (`ACQ-12`, mai `ACQ-R3`). */
const TASK_CODE = /\b[A-Z]{2,4}-\d+\b/g;

/** I codici da cercare, nell'ordine: la task della PR, poi quelli citati dai commit; senza doppioni. */
export function citedTaskCodes(
  ownTaskCode: string | null,
  commitMessages: readonly string[],
): string[] {
  const out: string[] = [];
  const cited = commitMessages.flatMap((m) => m.match(TASK_CODE) ?? []);
  for (const code of [...(ownTaskCode ? [ownTaskCode] : []), ...cited]) {
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** La bozza: «- ACQ-12: <titolo>» per ogni codice con una task fra quelle date. */
export function releaseNotesDraft(input: {
  ownTaskCode: string | null;
  commitMessages: readonly string[];
  /** Le task che chi chiede vede, del progetto della PR (le altre non contano). */
  tasks: readonly { code: string; title: string }[];
}): { text: string; sources: string[] } {
  const byCode = new Map(input.tasks.map((t) => [t.code, t.title]));
  const sources: string[] = [];
  const lines: string[] = [];
  for (const code of citedTaskCodes(input.ownTaskCode, input.commitMessages)) {
    const title = byCode.get(code);
    if (title === undefined) continue;
    sources.push(code);
    lines.push(`- ${code}: ${title}`);
  }
  return { text: lines.join("\n"), sources };
}
