import { useTranslation } from "react-i18next";
import type { ProductPresenceView } from "../../../data/types";
import { presenceColor } from "./presenceColor";

// Un altro scrive nel blocco in cui ha il fuoco chi guarda (shape
// product-editor.md §3.13, [PE 18]): nessuna barra dentro il blocco in
// modifica, ma una nota sul suo bordo destro, alla prima riga, 12 px
// `ink-muted` col pallino del colore: «Marco Bellini is writing here».
// Detta una volta (`polite`): la nota visibile è `aria-hidden`, e lo stesso
// testo entra in una regione `polite` dell'editor che c'è SEMPRE, vuota
// finché nessuno scrive nel blocco col fuoco (`LiveNoteRegion`): una regione
// nata già piena non si annuncia. Il testo e il cursore di chi guarda non
// cambiano finché non esce dal blocco: lo tiene la sessione dell'editor.

/** «Marco Bellini is writing here» / «… sta scrivendo qui»; vuota senza nessuno. */
export function useWritingHere(people: readonly ProductPresenceView[]): string {
  const { t, i18n } = useTranslation();
  if (people.length === 0) return "";
  const names = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
    people.map((p) => p.name),
  );
  return t("productDocs.live.writingHere", { count: people.length, names });
}

export function RemoteBlockNote({ people }: { people: ProductPresenceView[] }) {
  const text = useWritingHere(people);
  if (people.length === 0) return null;
  return (
    <span
      aria-hidden="true"
      data-remote-note=""
      style={{ top: "var(--block-pt, 0px)" }}
      className="pointer-events-none absolute right-0 z-10 mt-0.5 flex max-w-[60%] items-center gap-1.5 rounded-sm bg-ground px-1 text-xs leading-4 text-ink-muted"
    >
      <span className="flex shrink-0 -space-x-0.5">
        {people.map((p) => (
          <span
            key={p.personId}
            className="size-2 rounded-full ring-1 ring-ground"
            style={{ background: presenceColor(p.color) }}
          />
        ))}
      </span>
      <span className="truncate">{text}</span>
    </span>
  );
}

/** La regione `polite` dell'editor, montata con lui: riceve la nota quando compare. */
export function LiveNoteRegion({ people }: { people: readonly ProductPresenceView[] }) {
  const text = useWritingHere(people);
  return (
    <span aria-live="polite" data-live-note="" className="sr-only">
      {text}
    </span>
  );
}
