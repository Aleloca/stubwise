import type { InstanceRefusal } from "../instance/types";

// Le risposte delle scritture delle impostazioni di progetto (area 9c):
// quelle d'istanza del 9b, più `busy` (un progetto che non si archivia
// adesso, con cosa aspettare).

export type BusyReason =
  /** `title` è `null` se chi guarda non vede la conversazione (`canSeeConversation`): ruling del controller (pre-flight), P23. */
  | { kind: "claude_session"; code: string | null; title: string | null; waiting: boolean }
  | { kind: "release"; code: string };

export type ProjectRefusal = InstanceRefusal | { ok: false; error: "busy"; reasons: BusyReason[] };

export type ProjectResult<T extends object = object> = ({ ok: true } & T) | ProjectRefusal;
