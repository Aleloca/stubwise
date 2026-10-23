import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Project } from "../data/types";
import { shortcutLabel } from "../platform/platform";
import { Tooltip } from "./Tooltip";

/**
 * Tessera di un progetto fissato: 40×40, il codice in cifre tabellari, il
 * nome nell'etichetta e nel tooltip (mai troncato: il tooltip va a capo).
 * «Aspetta te» è un punto pieno nell'angolo; «Claude al lavoro» è un anello
 * che pulsa intorno alla tessera, fermo con movimento ridotto.
 */
export function ProjectTile({ project, index }: { project: Project; index: number }) {
  const { t } = useTranslation();
  const waitingId = useId();
  const claudeId = useId();
  const { waitingOnViewer, claudeWorking } = project.signals;
  const describedBy =
    [waitingOnViewer && waitingId, claudeWorking && claudeId].filter(Boolean).join(" ") ||
    undefined;
  const shortcut = index < 9 ? shortcutLabel(["mod", String(index + 1)]) : undefined;

  return (
    <Tooltip label={project.name} shortcut={shortcut}>
      <Link
        to="/p/$code"
        params={{ code: project.code }}
        aria-label={t("rail.tileLabel", { code: project.code, name: project.name })}
        aria-describedby={describedBy}
        className="group relative grid size-10 place-items-center rounded-lg border border-rule text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:border-rule-strong hover:bg-ink/6 hover:text-ink active:bg-ink/10 aria-[current=page]:border-ink/40 aria-[current=page]:bg-ink/10 aria-[current=page]:text-ink"
      >
        <span className="num text-xs font-semibold tracking-[0.02em]">{project.code}</span>
        {claudeWorking && (
          <>
            <span
              aria-hidden="true"
              className="rail-pulse pointer-events-none absolute -inset-[3px] rounded-[11px] border-[1.5px] border-claude"
            />
            <span id={claudeId} className="sr-only">
              {t("rail.claudeWorking")}
            </span>
          </>
        )}
        {waitingOnViewer && (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-[3px] -right-[3px] size-2.5 rounded-full border-2 border-rail bg-warning"
            />
            <span id={waitingId} className="sr-only">
              {t("rail.waitingOnYou")}
            </span>
          </>
        )}
      </Link>
    </Tooltip>
  );
}
