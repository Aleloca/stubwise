import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Worktree aperti delle sessioni di refinement (design 2026-10-14 §3.4), per
 * id della sessione dell'agente. In memoria: il worker è UN processo (come il
 * registro della chat CODE, `code-session.ts`). Al riavvio è vuoto e il turno
 * successivo riapre i worktree nello STESSO percorso (`refineParentDir`).
 */
export interface RefineWorktreeEntry {
  agentSessionId: string;
  parentDir: string;
  repos: { repositoryId: string; name: string; dir: string }[];
  remove(): Promise<void>;
}

export interface RefineWorktreeRegistry {
  get(agentSessionId: string): RefineWorktreeEntry | undefined;
  set(entry: RefineWorktreeEntry): void;
  remove(agentSessionId: string): Promise<void>;
  ids(): string[];
  closeAll(): Promise<void>;
}

/** Cwd del CLI della sessione: DETERMINISTICA, il CLI indicizza `--resume` per cwd. */
export function refineParentDir(agentSessionId: string): string {
  return join(tmpdir(), "stubwise-refine", agentSessionId);
}

export function createRefineWorktreeRegistry(): RefineWorktreeRegistry {
  const entries = new Map<string, RefineWorktreeEntry>();
  return {
    get: (id) => entries.get(id),
    set: (entry) => void entries.set(entry.agentSessionId, entry),
    ids: () => [...entries.keys()],
    async remove(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id); // prima della chiusura: una seconda remove non la ritrova
      await entry.remove();
    },
    async closeAll() {
      const all = [...entries.values()];
      entries.clear();
      for (const entry of all) await entry.remove().catch(() => undefined);
    },
  };
}
