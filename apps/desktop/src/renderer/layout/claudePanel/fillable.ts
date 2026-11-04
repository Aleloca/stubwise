import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { FieldRef } from "../../data/types";

// I campi riempibili (area 10b, Task 10; shape `claude-drafts.md`): una
// pagina dichiara il suo campo finché è montata — la risposta di supporto,
// le note di rilascio di una PR, il corpo di un'email, la descrizione di una
// task (D1) — e il riquadro di Claude ci mette una bozza SOLO se il campo
// della bozza è dichiarato adesso. Un campo non dichiarato (un'altra pagina,
// chi non può modificare, la casella di un altro) non esiste per il riquadro:
// la bozza resta nella conversazione con «Put it in the field». Nessuna UI
// propria: il registro è in memoria, e nessuna bozza scrive dati.

export interface FillableField {
  ref: FieldRef;
  /** L'etichetta del campo, per la riga («the reply to ACQ-S2»). */
  labelKey: string;
  /**
   * Il testo del campo ADESSO: letto dal valore vivo (uno store, un ref), mai
   * da una chiusura del render — subito dopo `put` deve già dire il testo nuovo.
   */
  get(): string;
  /** Mette il testo e il segno; «Replace or add below?» lo chiede chi chiama, se `get()` non è vuoto. */
  put(text: string, how: "replace" | "below", sources?: readonly string[]): void;
  /** «Undo» della riga: rimette il testo di prima, senza segno. */
  restore(text: string): void;
  /** «Show» della riga: il fuoco nel campo. */
  focus?(): void;
}

/** La chiave stabile di un campo: lo stesso oggetto di dati, la stessa chiave. */
export function fieldKey(ref: FieldRef): string {
  switch (ref.kind) {
    case "supportReply":
      return `supportReply:${ref.conversationId}`;
    case "releaseNotes":
      return `releaseNotes:${ref.prId}`;
    case "mailBody":
      return `mailBody:${ref.threadId ?? "new"}`;
    case "taskDescription":
      return `taskDescription:${ref.taskId}`;
  }
}

/** I campi dichiarati: vale l'ultimo dichiarato per la stessa chiave. */
const declared: { key: string; current: FillableField }[] = [];

const listeners = new Set<() => void>();
let version = 0;
function changed() {
  version += 1;
  for (const l of listeners) l();
}
export const subscribeFillable = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Il campo dichiarato dalla pagina aperta adesso, o `null`. */
export function fillableFor(ref: FieldRef): FillableField | null {
  const key = fieldKey(ref);
  for (let i = declared.length - 1; i >= 0; i--) {
    if (declared[i]!.key === key) return declared[i]!.current;
  }
  return null;
}

/** Si ridisegna a ogni dichiarazione, ritiro e render di un campo (il suo testo può essere cambiato). */
export function useFillableVersion(): number {
  return useSyncExternalStore(subscribeFillable, () => version);
}

/**
 * Una pagina dichiara un campo riempibile finché è montata; `null` = non
 * c'è (chi guarda non può scriverci). Ogni render della pagina avvisa chi
 * ascolta: il testo del campo può essere cambiato (una modifica, un invio,
 * Esc), e il riquadro lo confronta con quello di Claude.
 */
export function useFillableField(field: FillableField | null): void {
  const entry = useRef<{ key: string; current: FillableField } | null>(null);
  const key = field ? fieldKey(field.ref) : null;
  // Sempre l'oggetto dell'ultimo render: `put` e `get` vedono lo stato di adesso.
  useLayoutEffect(() => {
    if (entry.current && field) entry.current.current = field;
  });
  useLayoutEffect(() => {
    if (!field || key === null) return;
    const mine = { key, current: field };
    entry.current = mine;
    declared.push(mine);
    changed();
    return () => {
      const at = declared.indexOf(mine);
      if (at !== -1) declared.splice(at, 1);
      if (entry.current === mine) entry.current = null;
      changed();
    };
    // L'oggetto cambia a ogni render: conta solo quale campo è.
  }, [key]);
  // Dopo ogni render: il testo può essere cambiato.
  useEffect(() => {
    if (key !== null) changed();
  });
}

/** Solo per i test: nessun campo dichiarato. */
export function __resetFillableForTest(): void {
  declared.length = 0;
  changed();
}
