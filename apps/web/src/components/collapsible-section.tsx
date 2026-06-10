import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  title: string;
  /** Annotazione mono a destra del titolo (es. conteggio, ambiente). */
  meta?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Sezione collassabile in stile pannello: header mono cliccabile con freccia
 * di stato, contenuto montato solo da aperta (le sezioni pesanti — stack
 * trace, breadcrumb — non costano nulla finché restano chiuse).
 */
export function CollapsibleSection({
  title,
  meta,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-ink-850"
      >
        <span className="font-mono text-[11px] tracking-[0.16em] text-fg-muted uppercase">
          <span aria-hidden className="mr-2 inline-block text-fg-faint">
            {open ? "▾" : "▸"}
          </span>
          {title}
        </span>
        {meta && <span className="font-mono text-[11px] text-fg-faint">{meta}</span>}
      </button>
      {open && <div className="border-t border-line px-4 py-3">{children}</div>}
    </section>
  );
}
