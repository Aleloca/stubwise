import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ServerRow as Row } from "../../data/servers";
import { WorkingRing } from "../claude/conversation/parts";
import {
  accessProblem,
  diagnosesLine,
  environmentsLine,
  healthParts,
  healthSentence,
} from "./format";
import { HealthGlyph, Sparkline } from "./glyphs";

// L'elenco dei server di un progetto (shape servers.md §3): gruppi per
// salute — «Needs attention» (non risponde, in difficoltà) in cima, «Running
// fine» (in salute, rientrato) sotto, «Waiting for the agent» (mai collegato,
// R-L4: non si sa ancora se sta bene) in fondo. Un gruppo vuoto non compare;
// l'intestazione resta anche con un gruppo solo. Ogni riga, intera, porta
// al dettaglio; J/K scorrono le righe e Invio apre.

type Group = "attention" | "fine" | "waiting";

const groupOf = (row: Row): Group =>
  row.health.health === "down" || row.health.health === "trouble"
    ? "attention"
    : row.health.health === "never_connected"
      ? "waiting"
      : "fine";

const codeNumber = (code: string) => Number(code.slice("SRV-".length));

/** Non risponde prima di in difficoltà, poi dal più vecchio; gli altri per codice. */
function sortRows(group: Group, rows: Row[]): Row[] {
  if (group !== "attention")
    return [...rows].sort((a, b) => codeNumber(a.code) - codeNumber(b.code));
  const rank = (r: Row) => (r.health.health === "down" ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.health.since ?? "").localeCompare(b.health.since ?? "") ||
      codeNumber(a.code) - codeNumber(b.code),
  );
}

export function groupRows(rows: Row[]): { group: Group; rows: Row[] }[] {
  return (["attention", "fine", "waiting"] as const)
    .map((group) => ({
      group,
      rows: sortRows(
        group,
        rows.filter((r) => groupOf(r) === group),
      ),
    }))
    .filter((g) => g.rows.length > 0);
}

/** Il lavoro di Claude, o l'accesso SSH se non è a posto: la seconda frase della riga. */
function WorkOrAccess({ row }: { row: Row }) {
  const { t } = useTranslation();
  if (row.work !== "none") {
    const words = t(`servers.work.${row.work}`);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {(row.work === "analyzing" || row.work === "fixing") && <WorkingRing size={10} />}
        <span className="truncate">
          {words}
          {row.workTaskCode && (
            <>
              {" · "}
              <span className="num font-semibold text-ink">{row.workTaskCode}</span>
            </>
          )}
        </span>
      </span>
    );
  }
  const problem = accessProblem(row, t);
  if (!problem) return null;
  const inTrouble = row.health.health === "down" || row.health.health === "trouble";
  return (
    <span className="truncate">
      {inTrouble ? t("servers.access.cantLook", { access: problem }) : problem}
    </span>
  );
}

function ServerRowItem({ row, projectCode }: { row: Row; projectCode: string }) {
  const { t, i18n } = useTranslation();
  const { word, when } = healthParts(row.health, t, i18n.language);
  const envs = environmentsLine(row, t);
  const diagnoses = diagnosesLine(row, projectCode, t);
  return (
    <li data-server-row={row.code} className="border-b border-rule">
      <Link
        to="/p/$code/servers/$server"
        params={{ code: projectCode, server: row.code }}
        aria-label={`${row.code} ${row.name}, ${healthSentence(row.health, t, i18n.language)}`}
        className="flex min-h-14 flex-col justify-center gap-0.5 rounded-md px-3 py-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="num w-12 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
            {row.code}
          </span>
          <span title={row.name} className="min-w-0 flex-1 truncate text-md font-medium text-ink">
            {row.name}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-sm">
            <HealthGlyph health={row.health.health} />
            <span className="font-semibold text-ink">{word}</span>
            {when && <span className="num text-ink-muted">· {when}</span>}
          </span>
          <Sparkline values={row.recentCpu} />
        </span>
        <span className="flex min-w-0 items-center gap-3 pl-15 text-sm text-ink-muted">
          <span className="min-w-0 shrink truncate" title={envs}>
            {envs || t("servers.noEnvironments")}
          </span>
          {diagnoses && <span className="shrink-0">{diagnoses}</span>}
          <span className="ml-auto flex min-w-0 shrink justify-end">
            <WorkOrAccess row={row} />
          </span>
        </span>
      </Link>
    </li>
  );
}

const typing = (el: Element | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

export function ServerList({ rows, projectCode }: { rows: Row[]; projectCode: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  // J/K scorrono le righe (come le task); Invio sul link apre il dettaglio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "j" && e.key !== "k") return;
      if (typing(document.activeElement) || document.querySelector("[aria-modal='true']")) return;
      const links = [
        ...(ref.current?.querySelectorAll<HTMLElement>("[data-server-row] > a") ?? []),
      ];
      if (links.length === 0) return;
      e.preventDefault();
      const at = links.indexOf(document.activeElement as HTMLElement);
      const next =
        at === -1 ? 0 : Math.min(links.length - 1, Math.max(0, at + (e.key === "j" ? 1 : -1)));
      links[next]!.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div ref={ref} className="flex flex-col gap-6">
      {groupRows(rows).map(({ group, rows: list }) => (
        <section key={group} aria-labelledby={`servers-${group}`} className="flex flex-col">
          <h2 id={`servers-${group}`} className="heading-group pb-2 pl-3">
            {t(`servers.groups.${group}`)}
          </h2>
          <ul
            aria-label={t(`servers.groups.${group}`)}
            className="flex flex-col border-t border-rule"
          >
            {list.map((row) => (
              <ServerRowItem key={row.code} row={row} projectCode={projectCode} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
