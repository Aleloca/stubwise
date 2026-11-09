import type { ProjectStatus, StatusFamily, StatusInput } from "../../data/types";

/** Uno stato nella bozza: `key` è il suo id se esiste già, altrimenti una chiave nuova. */
export interface DraftStatus {
  key: string;
  id?: string;
  name: string;
  family: StatusFamily;
}

/**
 * La bozza degli stati di un progetto, salvata tutta insieme. `moved` dice
 * dove vanno le task di uno stato tolto: id dello stato tolto → chiave di
 * uno stato della bozza (anche nuovo).
 */
export interface StatusDraft {
  statuses: DraftStatus[];
  moved: Record<string, string>;
}

export function draftOf(statuses: ProjectStatus[]): StatusDraft {
  return {
    statuses: statuses.map((s) => ({ key: s.id, id: s.id, name: s.name, family: s.family })),
    moved: {},
  };
}

/** Vero se la bozza è l'unico stato della sua famiglia: non si toglie e non cambia famiglia. */
export function isLastOfFamily(draft: StatusDraft, key: string): boolean {
  const status = draft.statuses.find((s) => s.key === key);
  return !!status && draft.statuses.filter((s) => s.family === status.family).length === 1;
}

/**
 * Le task che finiranno in ogni stato della bozza: quelle che ci sono già,
 * più quelle degli stati tolti spostate lì.
 */
export function taskCounts(
  draft: StatusDraft,
  countById: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of draft.statuses) out.set(s.key, s.id ? (countById.get(s.id) ?? 0) : 0);
  for (const [removedId, target] of Object.entries(draft.moved)) {
    out.set(target, (out.get(target) ?? 0) + (countById.get(removedId) ?? 0));
  }
  return out;
}

/**
 * Toglie uno stato dalla bozza. Le sue task (e quelle che vi erano già state
 * spostate) vanno su `target`.
 */
export function removeStatus(draft: StatusDraft, key: string, target: string | null): StatusDraft {
  const status = draft.statuses.find((s) => s.key === key);
  if (!status) return draft;
  const moved: Record<string, string> = {};
  for (const [from, to] of Object.entries(draft.moved)) {
    if (to === key) {
      if (target) moved[from] = target;
    } else {
      moved[from] = to;
    }
  }
  if (status.id && target) moved[status.id] = target;
  return { statuses: draft.statuses.filter((s) => s.key !== key), moved };
}

/** Ciò che `setProjectStatuses` riceve. */
export function toRequest(draft: StatusDraft): {
  statuses: StatusInput[];
  reassign: Record<string, string>;
} {
  return {
    statuses: draft.statuses.map((s) =>
      s.id
        ? { id: s.id, name: s.name.trim(), family: s.family }
        : { key: s.key, name: s.name.trim(), family: s.family },
    ),
    reassign: { ...draft.moved },
  };
}

/** Vero se la bozza dice qualcosa di diverso dagli stati salvati. */
export function changed(draft: StatusDraft, saved: ProjectStatus[]): boolean {
  if (draft.statuses.length !== saved.length) return true;
  return draft.statuses.some((s, i) => {
    const o = saved[i]!;
    return s.id !== o.id || s.name !== o.name || s.family !== o.family;
  });
}
