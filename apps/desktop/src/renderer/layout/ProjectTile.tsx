import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Project } from "../data/types";
import { shortcutLabel } from "../platform/platform";
import { Tooltip } from "./Tooltip";

export const tileClass =
  "group relative grid size-10 place-items-center rounded-lg border border-rule text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:border-rule-strong hover:bg-ink/6 hover:text-ink active:bg-ink/10 aria-[current=page]:border-ink/40 aria-[current=page]:bg-ink/10 aria-[current=page]:text-ink";

/**
 * I due segnali di una tessera, solo grafici (il testo lo dà chi li usa):
 * «Claude al lavoro» = anello TRATTEGGIATO di 2 px che pulsa intorno alla
 * tessera (fermo con movimento ridotto); «aspetta te» = punto pieno
 * nell'angolo. Entrambi d'inchiostro (`--claude` è neutro, vedi i token):
 * li separa la forma, non la tinta, così non si confondono coi reparti.
 */
export function TileSignals({ waiting, claude }: { waiting: boolean; claude: boolean }) {
  return (
    <>
      {claude && (
        <span
          aria-hidden="true"
          data-signal="claude"
          className="rail-pulse pointer-events-none absolute -inset-[4px] rounded-[12px] border-2 border-dashed border-claude"
        />
      )}
      {waiting && (
        <span
          aria-hidden="true"
          data-signal="waiting"
          className="pointer-events-none absolute -top-[3px] -right-[3px] size-2.5 rounded-full border-2 border-rail bg-ink"
        />
      )}
    </>
  );
}

/**
 * Tessera di un progetto fissato: 40×40, il codice in cifre tabellari, il
 * nome nell'etichetta e nel tooltip (mai troncato: il tooltip va a capo).
 * Gli stati sono anche testo: descrizione accessibile e tooltip. «Ti aspetta»
 * non è un dato del progetto ma di chi guarda: lo passa il binario.
 */
export function ProjectTile({
  project,
  index,
  waiting: waitingOnViewer,
}: {
  project: Project;
  index: number;
  waiting: boolean;
}) {
  const { t } = useTranslation();
  const waitingId = useId();
  const claudeId = useId();
  const { claudeWorking } = project.signals;
  const describedBy =
    [waitingOnViewer && waitingId, claudeWorking && claudeId].filter(Boolean).join(" ") ||
    undefined;
  // Chi vede legge gli stati anche nel tooltip, non solo come punto e anello.
  const tooltip = [
    project.name,
    waitingOnViewer && t("rail.waitingOnYou"),
    claudeWorking && t("rail.claudeWorking"),
  ]
    .filter(Boolean)
    .join(" · ");
  const shortcut = index < 9 ? shortcutLabel(["mod", String(index + 1)]) : undefined;

  return (
    <Tooltip label={tooltip} shortcut={shortcut}>
      <Link
        to="/p/$code"
        params={{ code: project.code }}
        aria-label={t("rail.tileLabel", { code: project.code, name: project.name })}
        aria-describedby={describedBy}
        className={tileClass}
      >
        <span className="num text-xs font-semibold tracking-[0.02em]">{project.code}</span>
        <TileSignals waiting={waitingOnViewer} claude={claudeWorking} />
        {claudeWorking && (
          <span id={claudeId} className="sr-only">
            {t("rail.claudeWorking")}
          </span>
        )}
        {waitingOnViewer && (
          <span id={waitingId} className="sr-only">
            {t("rail.waitingOnYou")}
          </span>
        )}
      </Link>
    </Tooltip>
  );
}

/**
 * Sentinella di trabocco: quando le tessere non entrano tutte, l'ultimo
 * posto dice quante ne mancano («+4») e porta i loro segnali sommati —
 * nessuno stato si perde perché la finestra è bassa. Apre «Tutti i progetti».
 */
export function OverflowTile({
  hidden,
  waitingIds,
}: {
  hidden: Project[];
  /** I progetti che aspettano chi guarda. */
  waitingIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const waiting = hidden.filter((p) => waitingIds.has(p.id)).length;
  const claude = hidden.some((p) => p.signals.claudeWorking);
  const label = [
    t("rail.more", { count: hidden.length }),
    waiting > 0 && t("rail.moreWaiting", { count: waiting }),
    claude && t("rail.claudeWorking"),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip label={label}>
      <Link to="/projects" aria-label={label} data-rail-overflow className={tileClass}>
        <span aria-hidden="true" className="num text-xs font-semibold">
          +{hidden.length}
        </span>
        <TileSignals waiting={waiting > 0} claude={claude} />
      </Link>
    </Tooltip>
  );
}
