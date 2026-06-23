import { execa } from "execa";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";

/**
 * Worktree CONDIVISO di una generazione del motore documentazione ricorsivo (DAG).
 *
 * A differenza di `MirrorManager.withWorktree` (un worktree effimero per chiamata,
 * smontato all'uscita della callback), il DAG ha bisogno di UN SOLO worktree vivo
 * per l'INTERA durata della generazione: l'orientamento lo apre, poi molti job-nodo
 * (explore/synthesize) lo riusano in SOLA LETTURA via `createWorktreeReader(dir)`, e
 * la finalizzazione (M6) lo chiude. È implementato sopra i primitivi
 * `openWorktree`/`removeWorktree` di MirrorManager (gli stessi che ora alimentano
 * `withWorktree`), quindi conserva le convenzioni esistenti: branch `stubwise/*`,
 * `switch -C`, worktree detached sul default branch, nessun commit/push (read-only).
 *
 * INVARIANTE (riuso di quella di withWorktree, vedi mirrors.ts): finché questo
 * worktree è aperto NON va fatto `fetch --prune` del mirror, perché il refspec del
 * mirror cancellerebbe il ref `stubwise/*` checked-out. La serializzazione verso i
 * fix-job (che fanno ensureMirror → fetch) è garantita a monte dalla CATENA
 * PER-PROGETTO (M7): mentre una generazione tiene il worktree aperto, nessun altro
 * job dello stesso progetto tocca il mirror. I job-nodo concorrenti LEGGONO soltanto
 * da `dir` (nessuna scrittura git), quindi non interferiscono tra loro.
 *
 * `close()` è idempotente (delega a `remove()` di openWorktree, a sua volta
 * idempotente): una doppia chiusura — es. finalizzazione + cleanup d'errore — è
 * innocua.
 */

/** Timeout (ms) del `git rev-parse HEAD` nel worktree (repo patologico → no appeso). */
const GIT_REV_PARSE_TIMEOUT_MS = 60_000;

/**
 * Branch effimero (read-only) del worktree di generazione del DAG. Stabile per
 * progetto: una sola generazione per progetto è viva alla volta (serializzazione
 * per-progetto, M7), quindi un branch fisso è sufficiente e `switch -C` riallinea
 * un eventuale residuo di un run precedente.
 */
const GENERATION_BRANCH = "stubwise/docs-generation";

/** git locale nel worktree (HEAD del commit documentato), niente auth. */
async function resolveHeadSha(dir: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    timeout: GIT_REV_PARSE_TIMEOUT_MS,
  });
  return stdout.trim();
}

/** Handle del worktree di generazione: la directory, il commit documentato, la chiusura. */
export interface GenerationWorktree {
  /** Directory del worktree: i job-nodo la leggono via createWorktreeReader(dir). */
  dir: string;
  /** Commit HEAD effettivo del checkout (lo sha documentato dalla generazione). */
  commitSha: string;
  /** Smonta il worktree. Idempotente: da chiamare a finalizzazione (o su errore). */
  close: () => Promise<void>;
}

/**
 * Apre il worktree condiviso della generazione: `ensureMirror` + `openWorktree`
 * (path effimero stabile per la durata della generazione), risolve il commit HEAD
 * del checkout e ritorna l'handle `{ dir, commitSha, close }`. Su qualunque errore
 * dopo l'apertura del worktree, lo richiude prima di rilanciare (niente worktree
 * orfani).
 */
export async function openGenerationWorktree(
  mirrors: MirrorManager,
  project: MirrorProject,
): Promise<GenerationWorktree> {
  await mirrors.ensureMirror(project);
  const handle = await mirrors.openWorktree(project, GENERATION_BRANCH);
  try {
    const commitSha = await resolveHeadSha(handle.dir);
    return { dir: handle.dir, commitSha, close: handle.remove };
  } catch (error) {
    await handle.remove();
    throw error;
  }
}
