import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { InstanceServerRow, ServerRow } from "../../data/servers";
import { WorkingRing } from "../claude/conversation/parts";
import { accessProblem, diagnosesLine, healthParts, healthSentence, whereLine } from "./format";
import { HealthGlyph, Sparkline } from "./glyphs";

// L'elenco dei server di un progetto (shape servers.md §3): gruppi per
// salute — «Needs attention» (non risponde, in difficoltà) in cima, «Running
// fine» (in salute, rientrato) sotto, «Waiting for the agent» (mai collegato,
// R-L4: non si sa ancora se sta bene) in fondo. Un gruppo vuoto non compare;
// l'intestazione resta anche con un gruppo solo. Ogni riga, intera, porta
// al dettaglio; J/K scorrono le righe e Invio apre.
//
// Dall'Amministrazione (`projectCode` nullo, area 9b, shape admin-instance.md
// «Servers») le righe sono di tutta l'istanza: in più la colonna dei progetti
// (i soli visibili, R-G5) prima del mini-grafico, e in fondo il gruppo «Not in
// any project» degli orfani (R-L7), qualunque sia la loro salute.

/** Una riga del progetto, o di tutta l'istanza (coi progetti e `orphan`). */
type Row = ServerRow & Partial<Pick<InstanceServerRow, "projects" | "orphan">>;

type Group = "attention" | "fine" | "waiting" | "orphan";

const groupOf = (row: Row): Group =>
  row.orphan
    ? "orphan"
    : row.health.health === "down" || row.health.health === "trouble"
      ? "attention"
      : row.health.health === "never_connected"
        ? "waiting"
        : "fine";

/** Quanti codici di progetto stanno nella colonna; gli altri sono «+N». */
const PROJECTS_SHOWN = 4;

const codeNumber = (code: string) => Number(code.slice("SRV-".length));

/** Non risponde prima di in difficoltà, poi dal più vecchio; gli altri per codice. */
function sortRows<R extends Row>(group: Group, rows: R[]): R[] {
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

export function groupRows<R extends Row>(rows: R[]): { group: Group; rows: R[] }[] {
  return (["attention", "fine", "waiting", "orphan"] as const)
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
  const text = accessText(row, t);
  return text ? <span className="truncate">{text}</span> : null;
}

type T = ReturnType<typeof useTranslation>["t"];

/** L'accesso SSH in parole, se non è a posto (nessun lavoro di Claude in corso). */
function accessText(row: Row, t: T): string | null {
  const problem = accessProblem(row, t);
  if (!problem) return null;
  const inTrouble = row.health.health === "down" || row.health.health === "trouble";
  return inTrouble ? t("servers.access.cantLook", { access: problem }) : problem;
}

/** I progetti in parole, per il nome accessibile: i codici, o «In projects you can't see». */
function projectsText(row: Row, t: T): string | null {
  if (!row.projects || row.orphan) return null;
  if (row.projects.length === 0) return t("servers.hiddenProjects");
  return t("servers.projectsLabel", { codes: row.projects.map((p) => p.code).join(" ") });
}

/** La seconda riga in parole, per il nome accessibile: lavoro (o accesso), dove sta, diagnosi, progetti. */
function secondLine(row: Row, where: string, diagnoses: string | null, t: T): string {
  const work =
    row.work !== "none"
      ? `${t(`servers.work.${row.work}`)}${row.workTaskCode ? ` · ${row.workTaskCode}` : ""}`
      : accessText(row, t);
  const projects = row.projects?.length ? projectsText(row, t) : null;
  return [work, where || t("servers.noEnvironments"), diagnoses, projects]
    .filter(Boolean)
    .join(". ");
}

/** Le parole della salute che chiedono attenzione pesano; «Healthy» e «Back to normal» no. */
const LOUD = new Set(["down", "trouble", "never_connected"]);

/**
 * La colonna dei progetti (area 9b): i codici visibili, al più 4 e «+N»; ogni
 * codice ha nel `title` codice e nome, «+N» quelli dei nascosti dalla colonna.
 * Un server dei soli progetti invisibili dice «—»; un orfano non ha colonna.
 */
function ProjectCodes({ projects }: { projects: { code: string; name: string }[] }) {
  const { t } = useTranslation();
  const shown = projects.slice(0, PROJECTS_SHOWN);
  const rest = projects.slice(PROJECTS_SHOWN);
  const label = (p: { code: string; name: string }) => `${p.code} · ${p.name}`;
  return (
    <span data-server-projects aria-hidden="true" className="num flex items-center gap-1.5 text-xs">
      {projects.length === 0 ? (
        <span className="text-ink-faint">—</span>
      ) : (
        <>
          {shown.map((p) => (
            <span
              key={p.code}
              data-project-code
              title={label(p)}
              className="font-semibold tracking-[0.02em] text-ink-muted"
            >
              {p.code}
            </span>
          ))}
          {rest.length > 0 && (
            <span data-projects-more title={rest.map(label).join("\n")} className="text-ink-faint">
              {t("servers.projectsMore", { count: rest.length })}
            </span>
          )}
        </>
      )}
    </span>
  );
}

function ServerRowItem({ row, projectCode }: { row: Row; projectCode: string | null }) {
  const { t, i18n } = useTranslation();
  const { word, when } = healthParts(row.health, t, i18n.language);
  const where = whereLine(row, t);
  const diagnoses = diagnosesLine(row, projectCode, t);
  // Dall'Amministrazione: la colonna dei progetti (non per gli orfani).
  const projects = row.projects && !row.orphan ? row.projects : null;
  const label = `${row.code} ${row.name}, ${healthSentence(row.health, t, i18n.language)}. ${secondLine(row, where, diagnoses, t)}`;
  const className =
    "flex min-h-14 flex-col justify-center gap-0.5 rounded-md px-3 py-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10";
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-3">
        <span className="num w-12 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
          {row.code}
        </span>
        <span title={row.name} className="min-w-0 flex-1 truncate text-md font-medium text-ink">
          {row.name}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-sm">
          <HealthGlyph health={row.health.health} />
          <span
            className={
              LOUD.has(row.health.health) ? "font-semibold text-ink" : "font-normal text-ink-muted"
            }
          >
            {word}
          </span>
          {when && <span className="num text-ink-muted">· {when}</span>}
        </span>
        {/* Larga: i codici prima del mini-grafico, in una colonna che allinea le righe
            (vuota per un orfano). Stretta (1024): scendono sulla seconda riga. */}
        {row.projects && (
          <span className="hidden w-36 shrink-0 @min-[760px]:flex">
            {projects && <ProjectCodes projects={projects} />}
          </span>
        )}
        <Sparkline values={row.recentCpu} />
      </span>
      <span className="flex min-w-0 items-center gap-3 pl-15 text-sm text-ink-muted">
        <span className="min-w-0 shrink truncate" title={where}>
          {where || t("servers.noEnvironments")}
        </span>
        {diagnoses && <span className="shrink-0">{diagnoses}</span>}
        {projects && projects.length > 0 && (
          <span className="shrink-0 @min-[760px]:hidden">
            <ProjectCodes projects={projects} />
          </span>
        )}
        <span className="ml-auto flex min-w-0 shrink justify-end">
          <WorkOrAccess row={row} />
        </span>
      </span>
    </>
  );
  return (
    <li data-server-row={row.code} className="border-b border-rule">
      {projectCode ? (
        <Link
          to="/p/$code/servers/$server"
          params={{ code: projectCode, server: row.code }}
          aria-label={label}
          className={className}
        >
          {body}
        </Link>
      ) : (
        <Link
          to="/admin/servers/$server"
          params={{ server: row.code }}
          aria-label={label}
          className={className}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

const typing = (el: Element | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/**
 * Il riordino in 200 ms (shape servers.md §5): una riga che cambia gruppo o
 * posto scivola da dov'era invece di saltare. FLIP sulle righe per codice;
 * niente con «riduci il movimento».
 */
function useReorderMotion(ref: React.RefObject<HTMLElement | null>, order: string) {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>("[data-server-row]") ?? [])];
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    for (const el of rows) {
      const code = el.dataset.serverRow!;
      const top = el.getBoundingClientRect().top;
      next.set(code, top);
      const before = last.current.get(code);
      if (before === undefined || before === top || reduce || typeof el.animate !== "function")
        continue;
      el.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], {
        duration: 200,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      });
    }
    last.current = next;
  }, [ref, order]);
}

export function ServerList({ rows, projectCode }: { rows: Row[]; projectCode: string | null }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const groups = groupRows(rows);
  useReorderMotion(ref, groups.map((g) => `${g.group}:${g.rows.map((r) => r.code)}`).join("|"));

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
    <div ref={ref} className="@container flex flex-col gap-6">
      {groups.map(({ group, rows: list }) => (
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
