import { useTranslation } from "react-i18next";
import { useMentionSearch, usePeople } from "../../../data/queries";
import type { CitationRef } from "../../../data/types";
import { Avatar } from "../../../tasks-ui/PersonChip";
import { BreakablePath } from "../../../tasks-ui/Markdown";

// I menu della casella («#» oggetti, «@» persone, «/» comandi) hanno la
// stessa forma: una superficie flottante di 320 px sopra la casella, a
// gruppi, che cerca mentre si scrive. Il fuoco resta nel campo: le frecce,
// Invio/Tab ed Esc li gestisce la casella (`aria-activedescendant`).

export interface Suggestion {
  id: string;
  group: string;
  /** Il codice di catalogo (o il nome del comando), in cifre tabellari. */
  code: string | null;
  label: string;
  detail: string | null;
  /** Il testo che entra nella casella al posto di «#…» / «@…» / «/…». */
  insert: string;
  ref?: CitationRef;
  projectId?: string | null;
  personId?: string;
  path?: boolean;
  /** Il codice su una riga, il nome sotto (i comandi: «/nome» e la descrizione). */
  stacked?: boolean;
}

export interface SuggestionGroup {
  label: string;
  items: Suggestion[];
}

const GROUP_ORDER = ["task", "request", "doc", "file", "project"] as const;

/** I risultati di «#» o «@» per la ricerca scritta dopo il carattere. */
export function useMentionSuggestions(
  kind: "objects" | "people",
  q: string,
  enabled: boolean,
): { groups: SuggestionGroup[]; loading: boolean } {
  const { t } = useTranslation();
  const query = useMentionSearch(kind, q, enabled);
  const results = query.data ?? [];
  if (kind === "people") {
    return {
      loading: query.isPending && enabled,
      groups: results.length
        ? [
            {
              label: t("claude.conversation.menus.people"),
              items: results.map((r) => ({
                id: `person:${r.ref.id}`,
                group: "person",
                code: null,
                label: r.label,
                detail: r.detail,
                insert: `@${r.label}`,
                ref: r.ref,
                personId: r.ref.id,
              })),
            },
          ]
        : [],
    };
  }
  const groups = GROUP_ORDER.map((kind) => ({
    label: t(`claude.conversation.menus.groups.${kind}`),
    items: results
      .filter((r) => r.ref.kind === kind)
      .map<Suggestion>((r) => ({
        id: `${r.ref.kind}:${r.ref.id}`,
        group: kind,
        code: kind === "file" || kind === "doc" ? null : r.code,
        label: r.label,
        detail: kind === "doc" ? [r.code, r.detail].filter(Boolean).join(" · ") : r.detail,
        insert: kind === "file" ? r.label : [r.code, r.label].filter(Boolean).join(" "),
        ref: r.ref,
        projectId: r.projectId,
        path: kind === "file",
      })),
  })).filter((g) => g.items.length > 0);
  return { groups, loading: query.isPending && enabled };
}

/** Il menu flottante: gruppi con intestazione, righe con codice, nome e dettaglio. */
export function SuggestionMenu({
  id,
  label,
  groups,
  active,
  onPick,
  empty,
  note,
}: {
  id: string;
  label: string;
  groups: SuggestionGroup[];
  active: number;
  onPick: (s: Suggestion) => void;
  empty: string | null;
  note?: string | null;
}) {
  const people = usePeople().data;
  let index = -1;
  return (
    <div
      id={id}
      role="listbox"
      aria-label={label}
      className="menu-enter absolute bottom-full left-0 z-30 mb-2 flex max-h-80 w-[320px] max-w-full flex-col overflow-y-auto rounded-lg border border-rule-strong bg-surface p-1.5 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      {groups.length === 0 && empty && (
        <p className="px-2 py-1.5 text-sm text-ink-muted">{empty}</p>
      )}
      {groups.map((group) => (
        <div
          key={group.label}
          role="group"
          aria-label={group.label}
          className="flex flex-col not-first:mt-1 not-first:border-t not-first:border-rule not-first:pt-1"
        >
          <span aria-hidden="true" className="heading-group px-2 pt-1.5 pb-1">
            {group.label}
          </span>
          {group.items.map((s) => {
            index += 1;
            const selected = index === active;
            const person = s.personId ? people?.find((p) => p.id === s.personId) : null;
            return (
              <div
                key={s.id}
                id={`${id}-${index}`}
                role="option"
                aria-selected={selected}
                // Il clic non toglie il fuoco al campo.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(s)}
                className={`flex min-h-8 cursor-default flex-col justify-center gap-0.5 rounded-md px-2 py-1 text-sm ${selected ? "bg-ink/8" : "hover:bg-ink/5"}`}
              >
                {s.stacked ? (
                  <>
                    <span className="truncate font-semibold text-ink">{s.code}</span>
                    <span className="line-clamp-2 text-sm text-ink-muted">{s.label}</span>
                  </>
                ) : (
                  <span className="flex min-w-0 items-center gap-2">
                    {person && <Avatar person={person} />}
                    {s.code && (
                      <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
                        {s.code}
                      </span>
                    )}
                    <span className="min-w-0 truncate text-ink">
                      {s.path ? <BreakablePath path={s.label} /> : s.label}
                    </span>
                  </span>
                )}
                {s.detail && (
                  <span className={`truncate text-xs text-ink-muted ${person ? "pl-[30px]" : ""}`}>
                    {s.detail}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {note && <p className="border-t border-rule px-2 pt-2 pb-1 text-xs text-ink-muted">{note}</p>}
    </div>
  );
}

/** Le righe di un menu in ordine, come le contano le frecce. */
export const flatten = (groups: SuggestionGroup[]) => groups.flatMap((g) => g.items);
