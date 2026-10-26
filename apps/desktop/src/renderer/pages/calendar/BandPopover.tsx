import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CalendarEventView } from "../../data/types";
import { EventListRow, useEventName, type ProjectRef } from "./EventBlock";

// Il popover di una fascia sovrapposta («+N more»), nella griglia oraria e
// nelle celle del mese (shape calendar.md §5, [A 2]).

/** L'elenco di una fascia sovrapposta («+N more»): ora, codice, titolo, risposta. */
export function BandPopover({
  band,
  topPct,
  projects,
  withMailbox,
  onOpen,
  onClose,
  title,
  side = "left",
}: {
  side?: "left" | "right";
  band: CalendarEventView[];
  topPct?: number;
  projects: ReadonlyMap<string, ProjectRef>;
  withMailbox: boolean;
  onOpen: (id: string) => void;
  onClose: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  const name = useEventName();
  const ref = useRef<HTMLDivElement>(null);
  // Il fuoco entra sulla prima riga; alla chiusura torna al bottone «+N more»
  // (se nel frattempo non è andato altrove di proposito).
  useLayoutEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    el?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || (el?.contains(active) ?? false);
      if (lost && origin?.isConnected) origin.focus();
    };
  }, []);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title ?? t("calendar.block.band", { count: band.length })}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        }
        // Tab gira fra le righe del popover.
        if (e.key !== "Tab") return;
        const rows = [...(ref.current?.querySelectorAll<HTMLElement>("button") ?? [])];
        if (rows.length === 0) return;
        const at = rows.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        rows[(at + (e.shiftKey ? -1 : 1) + rows.length) % rows.length]!.focus();
      }}
      style={topPct !== undefined ? { top: `${topPct}%` } : undefined}
      className={`menu-enter absolute ${side === "right" ? "right-1" : "left-1"} z-30 flex max-h-80 w-72 max-w-[min(18rem,80vw)] flex-col overflow-y-auto rounded-lg border border-rule-strong bg-surface p-1.5 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]`}
    >
      {title && <p className="px-2 pt-1 pb-1.5 text-xs font-semibold text-ink-muted">{title}</p>}
      {band.map((e) => {
        const project = e.projectId ? projects.get(e.projectId) : undefined;
        return (
          <EventListRow
            key={e.id}
            e={e}
            project={project}
            name={name(e, project, withMailbox)}
            onOpen={() => onOpen(e.id)}
          />
        );
      })}
    </div>
  );
}
