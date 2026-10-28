import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMyReleases, useProjects } from "../../../data/queries";
import type { QueueItem, ReleaseView } from "../../../data/releases";
import { prCode } from "../../releases/format";
import { PrStateWord, ReleaseStatusWord } from "../../releases/glyphs";
import { BlockSection, Capped, queryState, rowKeys } from "./BlockSection";

/**
 * «Releases» (shape releases.md §6, [R 22], [R 23]): prima i rilasci falliti
 * che mi riguardano (merge mio o iscrizione «rilascio fallito») finché la
 * task di riparazione non è chiusa, poi le PR pronte nei progetti dove posso
 * rilasciare. Nessun «Release» qui: la riga apre la sezione col pannello
 * della PR, il merge si fa col contesto.
 */

type Row = { kind: "release"; release: ReleaseView } | { kind: "pr"; pr: QueueItem };

const rowClass =
  "grid min-h-11 grid-cols-[112px_minmax(0,1fr)_40px_minmax(120px,168px)] items-center gap-3 rounded-md px-4 py-1.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6";

export function ReleasesBlock() {
  const { t } = useTranslation();
  const q = useMyReleases();
  const projects = useProjects().data;
  const codeOf = (projectId: string) => projects?.find((p) => p.id === projectId)?.code ?? "";
  const rows: Row[] = [
    ...(q.data?.failed ?? [])
      // Finché la sua task di riparazione non si chiude.
      .filter((r) => !r.fixTask || r.fixTask.open)
      .map((release): Row => ({ kind: "release", release })),
    ...(q.data?.ready ?? []).map((pr): Row => ({ kind: "pr", pr })),
  ];
  const state = queryState([q], { when: rows.length === 0, text: t("home.releases.empty") });
  return (
    <BlockSection title={t("home.blocks.releases")} count={rows.length} state={state}>
      <div onKeyDown={rowKeys("[data-releases-row]")}>
        <Capped
          items={rows}
          label={t("home.blocks.releases")}
          render={(row) =>
            row.kind === "release" ? (
              <li key={row.release.id} className="border-b border-rule">
                <Link
                  to="/p/$code/releases/$release"
                  params={{ code: row.release.projectCode, release: row.release.code }}
                  data-releases-row
                  className={rowClass}
                >
                  <span className="num text-xs font-semibold text-ink">{row.release.code}</span>
                  <span className="min-w-0 truncate text-md text-ink">{row.release.title}</span>
                  <span className="num text-xs text-ink-muted">{row.release.projectCode}</span>
                  <ReleaseStatusWord release={row.release} />
                </Link>
              </li>
            ) : (
              <li key={row.pr.id} className="border-b border-rule">
                <Link
                  to="/p/$code/$section"
                  params={{ code: codeOf(row.pr.projectId), section: "releases" }}
                  search={{ pr: row.pr.id } as never}
                  data-releases-row
                  className={rowClass}
                >
                  <span className="num text-xs font-semibold text-ink">{prCode(row.pr)}</span>
                  <span className="min-w-0 truncate text-md text-ink">{row.pr.title}</span>
                  <span className="num text-xs text-ink-muted">{codeOf(row.pr.projectId)}</span>
                  <span className="text-sm">
                    <PrStateWord pr={row.pr} />
                  </span>
                </Link>
              </li>
            )
          }
        />
      </div>
    </BlockSection>
  );
}
