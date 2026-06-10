import {
  ticketPrioritySchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { useEffect, useRef, useState } from "react";
import type { Project, TicketFilters as TicketFiltersValue } from "../lib/api";
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from "./badges";

const SEARCH_DEBOUNCE_MS = 300;

interface TicketFiltersProps {
  value: TicketFiltersValue;
  projects: Project[];
  /** Patch parziale dei filtri; `undefined` rimuove la chiave (e il param). */
  onChange: (patch: Partial<TicketFiltersValue>) => void;
}

/**
 * Barra dei filtri della lista ticket. Componente puro: lo stato vive
 * nell'URL, qui arrivano `value` e si emettono patch via `onChange`.
 * La ricerca è debounced per non riscrivere l'URL a ogni tasto.
 */
export function TicketFilters({ value, projects, onChange }: TicketFiltersProps) {
  const [draft, setDraft] = useState(value.q ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Se q cambia da fuori (back/forward, link condiviso) il campo si allinea.
  useEffect(() => {
    setDraft(value.q ?? "");
  }, [value.q]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function handleSearch(next: string) {
    setDraft(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChange({ q: next.trim() || undefined });
    }, SEARCH_DEBOUNCE_MS);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-56 flex-1 flex-col gap-1">
        <label htmlFor="filter-q" className={labelClass}>
          Cerca
        </label>
        <input
          id="filter-q"
          type="search"
          value={draft}
          onChange={(event) => handleSearch(event.target.value)}
          placeholder="Cerca nel titolo…"
          className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
      </div>

      <FilterSelect
        id="filter-project"
        label="Progetto"
        value={value.projectId}
        options={projects.map((project) => ({ value: project.id, label: project.name }))}
        onChange={(projectId) => onChange({ projectId })}
      />
      <FilterSelect
        id="filter-status"
        label="Stato"
        value={value.status}
        options={ticketStatusSchema.options.map((status) => ({
          value: status,
          label: STATUS_LABELS[status],
        }))}
        onChange={(status) => onChange({ status: status as TicketFiltersValue["status"] })}
      />
      <FilterSelect
        id="filter-type"
        label="Tipo"
        value={value.type}
        options={ticketTypeSchema.options.map((type) => ({
          value: type,
          label: TYPE_LABELS[type],
        }))}
        onChange={(type) => onChange({ type: type as TicketFiltersValue["type"] })}
      />
      <FilterSelect
        id="filter-priority"
        label="Priorità"
        value={value.priority}
        options={ticketPrioritySchema.options.map((priority) => ({
          value: priority,
          label: PRIORITY_LABELS[priority],
        }))}
        onChange={(priority) =>
          onChange({ priority: priority as TicketFiltersValue["priority"] })
        }
      />
    </div>
  );
}

const labelClass = "font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase";

interface FilterSelectProps {
  id: string;
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
}

function FilterSelect({ id, label, value, options, onChange }: FilterSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
      >
        <option value="">Tutti</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
