import type { DecisionLogEntry } from "../data/model";

// Il «superata da» del registro decisioni: una catena (A superata da B,
// superata da C…), mai un giro. Lo stesso controllo lo fa il «server» quando
// scrive e la UI quando offre le scelte.

/** Vero se segnare `id` come superata da `byId` chiuderebbe un giro (o se sono la stessa). */
export function wouldCycle(
  entries: readonly Pick<DecisionLogEntry, "id" | "supersededById">[],
  id: string,
  byId: string,
): boolean {
  const next = new Map(entries.map((d) => [d.id, d.supersededById]));
  const seen = new Set<string>();
  for (let at: string | null | undefined = byId; at; at = next.get(at)) {
    if (at === id) return true;
    if (seen.has(at)) return false;
    seen.add(at);
  }
  return false;
}

/** Le voci (dello stesso progetto) che possono dire di aver superato `id`. */
export function supersedeCandidates<E extends DecisionLogEntry>(
  entries: readonly E[],
  id: string,
): E[] {
  const self = entries.find((d) => d.id === id);
  if (!self) return [];
  return entries.filter(
    (d) => d.projectId === self.projectId && d.id !== id && !wouldCycle(entries, id, d.id),
  );
}
