import { citedTaskCodes, releaseNotesDraft } from "@stubwise/shared";
import { state } from "../store";
import { canEditReleaseNotes, sees } from "./visibility";

// La bozza delle note di rilascio di una PR (area 10b, Task 8, S6b). Il
// prototipo non chiama un modello: una riga per task, dalla task della PR e
// dai commit che citano un codice di task del progetto. Legge solo ciò che chi chiede
// vede — un codice di una task invisibile, eliminata o inesistente non dà
// righe, come un commit senza codice (R-G5) — e non scrive nulla: il testo
// va nel campo (Task 10), e diventa le note solo con «Save» della persona.

/**
 * La bozza delle note: una riga per task, «- ACQ-12: <titolo>», dalla task
 * della PR e dai commit che citano un codice di task visibile; un commit
 * senza codice, o con un codice invisibile o eliminato, non dà righe.
 * `null` se chi chiede non può modificare le note. La regola sta in
 * `@stubwise/shared` (`releaseNotesDraft`, area 8 F1): qui le task che chi
 * chiede vede, del progetto della PR (I2).
 */
export function releaseNotesDraftFor(
  me: string,
  prId: string,
): { text: string; sources: string[] } | null {
  const pr = state.openPrs.find((p) => p.id === prId);
  if (!pr || !canEditReleaseNotes(me, pr)) return null;
  const ownTaskCode = (pr.taskId ? state.tasksById.get(pr.taskId)?.code : undefined) ?? null;
  const commitMessages = (pr.commits ?? []).map((c) => c.message);
  const tasks = citedTaskCodes(ownTaskCode, commitMessages).flatMap((code) => {
    const task = state.tasks.find((t) => t.code === code);
    return task && task.projectId === pr.projectId && sees(me, task.projectId)
      ? [{ code, title: task.title }]
      : [];
  });
  return releaseNotesDraft({ ownTaskCode, commitMessages, tasks });
}
