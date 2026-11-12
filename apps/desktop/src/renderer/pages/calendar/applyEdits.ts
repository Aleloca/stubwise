import type { CalendarEventPatch, CalendarGuestInput, CalendarScope } from "../../data/model";
import { sameSpan } from "./calendarWrites";

/** Fin dove è arrivato un salvataggio in modifica. */
export type EditStage = "nothing" | "time" | "details";

/** Un rifiuto a metà: dice cosa è già salvato (l'editor lo dice a vista). */
export class EditFailed extends Error {
  constructor(
    readonly saved: EditStage,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

type Saved = { id: string };
export type EditOps = {
  move: (v: {
    id: string;
    startsAt: string;
    endsAt: string;
    scope: CalendarScope;
    allDay?: boolean;
  }) => Promise<Saved>;
  update: (v: { id: string; patch: CalendarEventPatch; scope: CalendarScope }) => Promise<Saved>;
  setProject: (v: { id: string; projectId: string | null }) => Promise<Saved>;
};

/**
 * Le modifiche di un evento, in ordine: prima gli orari (e «tutto il giorno»),
 * la parte che il livello dati può rifiutare, così un rifiuto non lascia
 * salvato a metà il resto; poi i dettagli; poi il progetto.
 *
 * Gli orari si confrontano come istanti (review F4, 2), e i passi dopo lo
 * spostamento usano l'id che la move ha restituito (review F4, 3): su «tutta
 * la serie» non è detto che sia quello di partenza.
 */
export async function applyEdits(
  ops: EditOps,
  event: {
    id: string;
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    projectId: string | null;
  },
  next: {
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    patch: CalendarEventPatch;
    projectId: string | null;
  },
  scope: CalendarScope,
): Promise<void> {
  let saved: EditStage = "nothing";
  let id = event.id;
  try {
    if (!sameSpan(next, event) || next.allDay !== event.allDay) {
      const moved = await ops.move({
        id,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
        scope,
        ...(next.allDay !== event.allDay ? { allDay: next.allDay } : {}),
      });
      id = moved.id;
      saved = "time";
    }
    id = (await ops.update({ id, patch: next.patch, scope })).id;
    saved = "details";
    if (next.projectId !== event.projectId) await ops.setProject({ id, projectId: next.projectId });
  } catch (error) {
    throw new EditFailed(saved, error);
  }
}

/**
 * Si annuncia «creata» (o «aggiornata») solo se la scrittura non è rimasta
 * «non salvata» (review F4, 4): in quel caso lo dice il blocco, con «Retry».
 */
export const announcesSaved = (e: { save?: { state: string; error?: string } }): boolean =>
  e.save?.state !== "failed";

const guestKey = (g: { email: string; personId?: string | null }): string =>
  g.personId ? `p:${g.personId}` : `e:${g.email.toLowerCase()}`;

/**
 * Gli ospiti da mandare (review F4, minore): niente se l'insieme non è
 * cambiato (una modifica del titolo non riscrive gli invitati su Google), e
 * senza nomi inventati: la vista dà a un esterno il nome uguale all'email, e
 * quello non è un nome da scrivere su Google.
 */
export function guestsPatch(
  original: readonly { email: string; personId?: string | null }[],
  current: readonly { email: string; name?: string | null; personId?: string | null }[],
): CalendarGuestInput[] | undefined {
  const before = new Set(original.map(guestKey));
  const now = new Set(current.map(guestKey));
  if (before.size === now.size && [...now].every((k) => before.has(k))) return undefined;
  return current.map((g) =>
    g.personId
      ? { personId: g.personId }
      : g.name && g.name.trim().toLowerCase() !== g.email.toLowerCase()
        ? { email: g.email, name: g.name }
        : { email: g.email },
  );
}
