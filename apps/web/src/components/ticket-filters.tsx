import {
  ticketPrioritySchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project, TicketFilters as TicketFiltersValue } from "../lib/api";
import { milestonesQueryOptions } from "../lib/queries";
import { PRIORITY_LABEL_KEYS, STATUS_LABEL_KEYS, TYPE_LABEL_KEYS } from "./badges";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Stato UI dei filtri della lista: come {@link TicketFiltersValue} ma con lo
 * stato allargato per includere il valore sintetico `"all"` (tutti gli stati).
 * `status` assente = default "stati attivi", `"all"` = nessun filtro di stato,
 * un valore = filtro su quel singolo stato. La traduzione in filtri API (il
 * campo `statuses`) avviene nella pagina.
 */
export interface TicketFiltersState extends Omit<TicketFiltersValue, "status"> {
  status?: TicketFiltersValue["status"] | "all";
}

interface TicketFiltersProps {
  value: TicketFiltersState;
  projects: Project[];
  /** Patch parziale dei filtri; `undefined` rimuove la chiave (e il param). */
  onChange: (patch: Partial<TicketFiltersState>) => void;
}

/**
 * Barra dei filtri della lista ticket. Componente puro: lo stato vive
 * nell'URL, qui arrivano `value` e si emettono patch via `onChange`.
 * La ricerca è debounced per non riscrivere l'URL a ogni tasto.
 */
export function TicketFilters({ value, projects, onChange }: TicketFiltersProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value.q ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Se q cambia da fuori (back/forward, link condiviso) il campo si allinea.
  useEffect(() => {
    setDraft(value.q ?? "");
  }, [value.q]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Milestone per-progetto: la query si abilita solo con un projectId (le
  // milestone non esistono fuori da un progetto). Senza progetto il select
  // resta disabilitato con la sola opzione "All".
  const { data: milestones = [] } = useQuery(milestonesQueryOptions(value.projectId));

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
          {t("tickets:filters.search")}
        </label>
        <input
          id="filter-q"
          type="search"
          value={draft}
          onChange={(event) => handleSearch(event.target.value)}
          placeholder={t("tickets:filters.searchPlaceholder")}
          className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
      </div>

      <FilterSelect
        id="filter-project"
        label={t("tickets:filters.project")}
        value={value.projectId}
        options={projects.map((project) => ({ value: project.id, label: project.name }))}
        // Le milestone sono per-progetto: cambiando progetto un milestoneId di
        // un altro progetto resterebbe orfano, quindi lo si azzera nello stesso
        // patch (undefined → sparisce dall'URL).
        onChange={(projectId) => onChange({ projectId, milestoneId: undefined })}
      />
      {/*
        Stato: l'opzione vuota è "Attivi (default)" (nasconde done/closed), poi
        "Tutti" (nessun filtro), poi i singoli stati. Il valore vuoto emette
        `undefined` → la pagina applica il default degli stati attivi.
      */}
      <FilterSelect
        id="filter-status"
        label={t("tickets:filters.status")}
        emptyLabel={t("tickets:filters.statusActive")}
        value={value.status}
        options={[
          { value: "all", label: t("tickets:filters.statusAll") },
          ...ticketStatusSchema.options.map((status) => ({
            value: status,
            label: t(STATUS_LABEL_KEYS[status]),
          })),
        ]}
        onChange={(status) => onChange({ status: status as TicketFiltersState["status"] })}
      />
      <FilterSelect
        id="filter-type"
        label={t("tickets:filters.type")}
        value={value.type}
        options={ticketTypeSchema.options.map((type) => ({
          value: type,
          label: t(TYPE_LABEL_KEYS[type]),
        }))}
        onChange={(type) => onChange({ type: type as TicketFiltersValue["type"] })}
      />
      <FilterSelect
        id="filter-priority"
        label={t("tickets:filters.priority")}
        value={value.priority}
        options={ticketPrioritySchema.options.map((priority) => ({
          value: priority,
          label: t(PRIORITY_LABEL_KEYS[priority]),
        }))}
        onChange={(priority) =>
          onChange({ priority: priority as TicketFiltersValue["priority"] })
        }
      />
      <FilterSelect
        id="filter-milestone"
        label={t("tickets:filters.milestone")}
        value={value.milestoneId}
        // Abilitato solo con un progetto selezionato: le milestone sono
        // per-progetto e fuori da un progetto non c'è nulla da elencare.
        disabled={value.projectId === undefined}
        options={milestones.map((milestone) => ({
          value: milestone.id,
          label: milestone.name,
        }))}
        onChange={(milestoneId) => onChange({ milestoneId })}
      />
    </div>
  );
}

export const labelClass = "font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase";

export interface FilterSelectProps {
  id: string;
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  /** Etichetta dell'opzione vuota; default `tickets:filters.all`. */
  emptyLabel?: string;
}

/** Select di filtro riusabile: opzione vuota + opzioni tradotte dal chiamante. */
export function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  emptyLabel,
}: FilterSelectProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">{emptyLabel ?? t("tickets:filters.all")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
