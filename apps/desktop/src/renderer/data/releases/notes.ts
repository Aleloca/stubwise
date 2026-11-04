import { state } from "../store";
import { canEditReleaseNotes, sees } from "./visibility";

// La bozza delle note di rilascio di una PR (area 10b, Task 8, S6b). Il
// prototipo non chiama un modello: una riga per task, dalla task della PR e
// dai commit che citano un codice di task. Legge solo ciò che chi chiede
// vede — un codice di una task invisibile, eliminata o inesistente non dà
// righe, come un commit senza codice (R-G5) — e non scrive nulla: il testo
// va nel campo (Task 10), e diventa le note solo con «Save» della persona.

/** Un codice di task in un messaggio di commit (`ACQ-12`, mai `ACQ-R3`). */
const TASK_CODE = /\b[A-Z]{2,4}-\d+\b/g;

/**
 * La bozza delle note: una riga per task, «- ACQ-12: <titolo>», dalla task
 * della PR e dai commit che citano un codice di task visibile; un commit
 * senza codice, o con un codice invisibile o eliminato, non dà righe.
 * `null` se chi chiede non può modificare le note.
 */
export function releaseNotesDraftFor(
  me: string,
  prId: string,
): { text: string; sources: string[] } | null {
  const pr = state.openPrs.find((p) => p.id === prId);
  if (!pr || !canEditReleaseNotes(me, pr)) return null;
  const own = pr.taskId ? state.tasksById.get(pr.taskId)?.code : undefined;
  const cited = (pr.commits ?? []).flatMap((c) => c.message.match(TASK_CODE) ?? []);
  const lines: string[] = [];
  const sources: string[] = [];
  for (const code of [...(own ? [own] : []), ...cited]) {
    if (sources.includes(code)) continue;
    const task = state.tasks.find((t) => t.code === code);
    if (!task || !sees(me, task.projectId)) continue;
    sources.push(code);
    lines.push(`- ${code}: ${task.title}`);
  }
  return { text: lines.join("\n"), sources };
}
