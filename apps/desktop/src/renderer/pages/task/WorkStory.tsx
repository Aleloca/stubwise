import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { usePeople } from "../../data/queries";
import type { Person } from "../../data/types";
import type { StoryEntry } from "../../domain/claude/taskWork";
import { DisclosureGlyph, clock } from "../claude/conversation/parts";

/** Il nome di una fase come la dice la conversazione («Execution», «Correction»). */
export function phaseName(t: TFunction, phase: string | null): string {
  if (!phase) return "";
  return t(`claude.conversation.phase.${phase}`, { defaultValue: phase });
}

function line(t: TFunction, entry: StoryEntry, name: (id: string | null) => string): string {
  const s = "taskDetail.claude.story";
  switch (entry.kind) {
    case "run_started":
      return t(`${s}.run_started`, { name: name(entry.byId) });
    case "correction_requested":
      return t(`${s}.correction_requested`, { n: entry.ordinal, name: name(entry.byId) });
    case "correction_started":
    case "correction_resumed":
      return t(`${s}.${entry.kind}`, { n: entry.ordinal });
    case "plan":
      if (entry.status === "pending") return t(`${s}.plan_pending`);
      if (entry.status === "rejected" && entry.instructions) {
        return t(`${s}.plan_rejectedWith`, {
          name: name(entry.decidedById),
          instructions: entry.instructions,
        });
      }
      return t(`${s}.plan_${entry.status}`, { name: name(entry.decidedById) });
    case "question":
      return t(`${s}.question`, { text: entry.text });
    case "answer":
      return t(`${s}.answer`, { name: name(entry.byId), label: entry.label });
    case "result":
      // Il testo del risultato è quello del flusso: non si riscrive.
      return entry.text;
    case "pr":
      return t(`${s}.${entry.event}`, { n: entry.number });
    case "ended": {
      const phase = phaseName(t, entry.phase);
      if (entry.outcome === "stopped") {
        return entry.byId
          ? t(`${s}.stoppedBy`, { name: name(entry.byId), phase })
          : t(`${s}.stopped`, { phase });
      }
      return t(`${s}.${entry.outcome}`, { phase });
    }
  }
}

/**
 * La storia del lavoro di Claude sulla task: chiusa di default («Work
 * story 7»), aperta un elenco dalla più vecchia, ora tabellare e evento.
 * Solo ciò che il flusso e la piattaforma dimostrano (`workStory`).
 */
export function WorkStory({ entries }: { entries: StoryEntry[] }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const people = usePeople().data;
  const listId = useId();
  if (entries.length === 0) return null;
  const name = (id: string | null) => people?.find((p: Person) => p.id === id)?.name ?? "";
  const title = t("taskDetail.claude.story.title");
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1.5 flex h-8 items-center gap-1.5 self-start rounded-md px-1.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <DisclosureGlyph open={open} />
        {title}
        <span className="num text-xs text-ink-faint">{entries.length}</span>
      </button>
      {open && (
        <ol
          id={listId}
          aria-label={title}
          className="event-enter mt-1 flex flex-col border-l border-rule pl-3"
        >
          {entries.map((entry) => (
            <li
              key={entry.key}
              className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-x-3 py-1 text-sm"
            >
              <time dateTime={entry.at} className="num text-xs whitespace-nowrap text-ink-faint">
                {clock(entry.at, i18n.language)}
              </time>
              <span className="min-w-0 text-ink [overflow-wrap:anywhere]">
                {line(t, entry, name)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
