import { launchRun, openRunAs } from "../api-mutations";
import { recordChange } from "../changelog/index";
import { state, storeGeneration, visibleProjectIds } from "../store";
import { writer } from "../writer";
import { canI, refuse } from "./common";
import { isRetryableKind, newerWorkOf } from "./status";
import type { InstanceRefusal, InstanceResult } from "./types";

// «Retry» / «Rimetti in coda» dello Stato dell'istanza (area 9b, Task 5). Sta
// in un modulo suo (ruling 3) perché è l'unico pezzo dell'istanza che
// raggiunge le scritture delle sessioni (`api-mutations`): la coda e le
// letture non ci arrivano.
//
// Decisione del maintainer del 30 ott 2026: chiede `settings.manage` E
// `runs.start` nel progetto; chi riprova è chi avvia, a suo nome, e il gate
// del piano vale come per «Avvia» (`openRunAs`, poi `launchRun`). Solo
// sull'esecuzione fallita di una task: una correzione ferma non si tocca
// (`pr-corrections.md`). Agisce solo sulla coda di Stubwise.

/** Il rifiuto di `openRunAs` come risposta d'istanza; un errore che non conosce si rilancia. */
function refusalOf(error: unknown): InstanceRefusal {
  const message = error instanceof Error ? error.message : "";
  if (message === "conflict") return refuse.conflict();
  if (message === "forbidden") return refuse.forbidden();
  const invalid = /^invalid: (.+)$/.exec(message);
  if (invalid) return refuse.invalid(invalid[1] === "status" ? "not_retryable" : invalid[1]!);
  throw error;
}

/** Rimette in coda il lavoro fallito di una task: una sessione nuova, a nome di chi preme. */
export async function retryJob(jobId: string): Promise<InstanceResult<{ conversationId: string }>> {
  const gen = storeGeneration();
  const me = await writer("instance.retryJob");
  const result = retryJobAs(me, jobId);
  if (!result.ok) return result;
  await launchRun(me, state.conversations.find((c) => c.id === result.conversationId)!, gen);
  // Un ripristino durante l'avvio: la risposta non parla dello stato nuovo.
  if (gen !== storeGeneration()) throw new Error("reset");
  return result;
}

/**
 * La forma sincrona di `retryJob` (il catalogo di Claude, area 10a): gli
 * stessi controlli, la sessione aperta con `openRunAs` e la voce, ma la
 * sessione non parte e non scrive eventi. La fa partire `launchRun`: qui
 * sopra subito, dal catalogo solo a gruppo riuscito.
 */
export function retryJobAs(me: string, jobId: string): InstanceResult<{ conversationId: string }> {
  const failed = state.conversations.find((c) => c.id === jobId);
  if (!failed || failed.projectId === null || !visibleProjectIds(me).has(failed.projectId))
    return refuse.notFound();
  if (!canI(me, "settings.manage") || !canI(me, "runs.start", failed.projectId))
    return refuse.forbidden();
  const task = failed.taskId ? state.tasksById.get(failed.taskId) : undefined;
  if (!task || !isRetryableKind(failed)) return refuse.invalid("not_retryable");
  // Superato da un lavoro più recente sulla task (revisione T13, I1): se è
  // ancora vivo è un conflitto, se è finito il fallito non si rimette più.
  const newer = newerWorkOf(failed);
  if (newer) return newer.live ? refuse.conflict() : refuse.invalid("not_retryable");

  let conversationId: string;
  try {
    conversationId = openRunAs(me, task).id;
  } catch (error) {
    return refusalOf(error);
  }
  recordChange({
    kind: "job.retried",
    actorId: me,
    projectId: task.projectId,
    object: { type: "task", id: task.id, label: task.code },
  });
  return { ok: true, conversationId };
}
