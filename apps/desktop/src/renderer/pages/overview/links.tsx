import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { FilterCriteria } from "../../data/types";

/**
 * Un link alle Tasks del progetto già filtrate: la stessa ricerca
 * `filters=` che la pagina Tasks legge e scrive (`parseCriteria`), nessun
 * formato secondo. Ogni numero dell'Overview è uno di questi.
 */
export function TasksLink({
  projectCode,
  criteria,
  className,
  label,
  title,
  children,
}: {
  projectCode: string;
  criteria: FilterCriteria;
  className?: string;
  /** Il nome accessibile, quando il contenuto (un numero) non basta da solo. */
  label?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/p/$code/$section"
      params={{ code: projectCode, section: "tasks" }}
      search={{ filters: criteria } as never}
      aria-label={label}
      title={title}
      className={className}
    >
      {children}
    </Link>
  );
}

/** Il link quieto di un numero o di un nome: inchiostro, sottolineato al passaggio. */
export const numberLink =
  "rounded-sm text-ink underline-offset-4 decoration-ink/40 transition-colors duration-[var(--duration-fast)] ease-out hover:underline";

const DAY_MS = 86_400_000;

/** Una data ISO a `days` giorni da `date` (negativi = prima). */
export const shiftDate = (date: string, days: number): string =>
  new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
