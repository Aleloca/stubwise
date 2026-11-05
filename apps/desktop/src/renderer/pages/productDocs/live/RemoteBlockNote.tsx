import { useTranslation } from "react-i18next";
import type { ProductPresenceView } from "../../../data/types";
import { presenceColor } from "./presenceColor";

// Un altro scrive nel blocco in cui ha il fuoco chi guarda (shape
// product-editor.md §3.13, [PE 18]): nessuna barra dentro il blocco in
// modifica, ma una nota sul suo bordo destro, alla prima riga, 12 px
// `ink-muted` col pallino del colore: «Marco Bellini is writing here».
// Detta una volta (`polite`). Il testo e il cursore di chi guarda non
// cambiano finché non esce dal blocco: lo tiene la sessione dell'editor.

export function RemoteBlockNote({ people }: { people: ProductPresenceView[] }) {
  const { t, i18n } = useTranslation();
  if (people.length === 0) return null;
  const names = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
    people.map((p) => p.name),
  );
  return (
    <span
      aria-live="polite"
      data-remote-note=""
      style={{ top: "var(--block-pt, 0px)" }}
      className="pointer-events-none absolute right-0 z-10 flex max-w-[60%] mt-0.5 items-center gap-1.5 rounded-sm bg-ground px-1 text-xs leading-4 text-ink-muted"
    >
      <span aria-hidden="true" className="flex shrink-0 -space-x-0.5">
        {people.map((p) => (
          <span
            key={p.personId}
            className="size-2 rounded-full ring-1 ring-ground"
            style={{ background: presenceColor(p.color) }}
          />
        ))}
      </span>
      <span className="truncate">
        {t("productDocs.live.writingHere", { count: people.length, names })}
      </span>
    </span>
  );
}
