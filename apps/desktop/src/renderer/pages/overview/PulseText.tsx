import type { PulsePart } from "./pulseLine";
import { STALLED } from "./StalledSection";
import { TasksLink, numberLink } from "./links";

/**
 * I pezzi della riga di polso (`pulseParts`) uniti dal punto mediano: la
 * testata dell'Overview e la riga del portafoglio la disegnano così. Il
 * primo pezzo è d'inchiostro (il più importante), gli altri tenui; le ferme
 * sono un link alle Tasks del progetto filtrate su «stalled».
 * `partClassName` lascia a chi la usa nascondere un pezzo quando la riga è
 * stretta (il traguardo cade per primo).
 */
export function PulseText({
  parts,
  projectCode,
  partClassName,
}: {
  parts: PulsePart[];
  projectCode: string;
  partClassName?: (part: PulsePart) => string;
}) {
  return parts.map((part, i) => (
    <span key={part.kind} className={`inline-block ${partClassName?.(part) ?? ""}`}>
      {i > 0 && (
        <span aria-hidden="true" className="px-1.5 text-ink-faint">
          ·
        </span>
      )}
      {part.kind === "stalled" ? (
        <TasksLink
          projectCode={projectCode}
          criteria={STALLED}
          className={`${numberLink} ${i === 0 ? "" : "text-ink-muted hover:text-ink"}`}
        >
          {part.text}
        </TasksLink>
      ) : (
        <span className={i === 0 ? "text-ink" : undefined}>{part.text}</span>
      )}
    </span>
  ));
}
