import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { DisclosureGlyph } from "../claude/conversation/parts";

/**
 * «Skills in this run · 11» (area 9c, [PX 4]): una riga a disclosure,
 * chiusa di base; aperta, un blocco per plugin («stubwise · stubwise, init,
 * start») nell'ordine di `skillsForRun`. È l'elenco scritto alla nascita
 * della sessione: un cambio successivo in Settings → Plugins non lo tocca,
 * e nessuna frase dice «changed since». Senza elenco (sessioni nate prima
 * del 9c) la riga non c'è. La usano la sezione Claude, la storia del lavoro
 * e la testata della pagina della sessione.
 */
export function SkillsInRun({
  skills,
  className = "",
}: {
  skills: readonly { plugin: string; skill: string }[] | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!skills || skills.length === 0) return null;
  const title = t("projectEffects.run.skills");
  const groups: { plugin: string; skills: string[] }[] = [];
  for (const s of skills) {
    const last = groups.at(-1);
    if (last?.plugin === s.plugin) last.skills.push(s.skill);
    else groups.push({ plugin: s.plugin, skills: [s.skill] });
  }
  return (
    <div data-run-skills className={`flex min-w-0 flex-col ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1.5 flex h-7 items-center gap-1.5 self-start rounded-md px-1.5 text-xs text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <DisclosureGlyph open={open} />
        {title}
        <span className="num text-ink-faint">{skills.length}</span>
      </button>
      {open && (
        <ul
          id={listId}
          aria-label={title}
          className="event-enter flex max-w-[72ch] flex-col gap-1 pt-1 pb-1 pl-5"
        >
          {groups.map((g) => (
            <li key={g.plugin} className="text-sm text-ink [overflow-wrap:anywhere]">
              <span className="font-medium">{g.plugin}</span>
              <span className="text-ink-muted"> · {g.skills.join(", ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
