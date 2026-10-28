import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePeople } from "../../data/queries";
import type { ReleaseView } from "../../data/releases";
import { ghostButton } from "../task/parts";
import { ago, mergedBy, releaseWord } from "./format";
import { ReleaseStatusWord } from "./glyphs";

// I rilasci del progetto (shape releases.md §6, «Releases»): una riga da
// 44px — codice · titolo della PR · glifo + parola · chi e quando; fuori da
// Stubwise «· outside Stubwise»; con la task di riparazione «· AUD-140
// fixing», che non si troncano mai (si va a capo). Nella pagina gli ultimi 10 e «Show all N» (`?view=releases`), lì
// a pagine da 50.

export const RELEASES_PAGE = 10;
export const RELEASES_CHUNK = 50;

const rowGrid =
  "grid min-h-11 grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md px-3 py-1.5 @[560px]:grid-cols-[72px_minmax(0,1fr)_auto_minmax(0,240px)]";

export function ReleaseRow({ release }: { release: ReleaseView }) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const person = (id: string | null) =>
    id ? (people?.find((p) => p.id === id)?.name ?? null) : null;
  const who = `${mergedBy(release, t, person)} · ${ago(release.mergedAt, t, i18n.language)}`;
  const fixing = release.fixTask?.open ? release.fixTask.code : null;
  const label = [release.code, release.title, releaseWord(release, t), who]
    .concat(fixing ? [t("releases.list.fixing", { task: fixing })] : [])
    .join(", ");
  return (
    <li className="border-b border-rule">
      <Link
        to="/p/$code/releases/$release"
        params={{ code: release.projectCode, release: release.code }}
        data-release-row={release.code}
        aria-label={label}
        className={`${rowGrid} transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6`}
      >
        <span className="num text-xs font-semibold tracking-[0.02em] text-ink">{release.code}</span>
        <span className="min-w-0 truncate text-md text-ink" title={release.title}>
          {release.title}
        </span>
        <ReleaseStatusWord release={release} />
        {/* Chi e quando va a capo invece di troncarsi: «outside Stubwise» e
            «AUD-140 fixing» sono il punto della riga, non un dettaglio. */}
        <span className="col-start-2 min-w-0 text-sm text-ink-muted [overflow-wrap:anywhere] @[560px]:col-start-auto @[560px]:text-right">
          {who}
          {fixing && (
            <>
              {" · "}
              <span className="num font-semibold text-ink">{fixing}</span>{" "}
              {t("releases.list.fixingWord")}
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

export function ReleaseList({
  releases,
  projectCode,
  full = false,
}: {
  releases: ReleaseView[];
  projectCode: string;
  full?: boolean;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(RELEASES_CHUNK);
  const visible = full ? releases.slice(0, shown) : releases.slice(0, RELEASES_PAGE);
  return (
    <div className="@container flex flex-col">
      <ul aria-label={t("releases.parts.releases")} className="flex flex-col border-t border-rule">
        {visible.map((r) => (
          <ReleaseRow key={r.id} release={r} />
        ))}
      </ul>
      {full && releases.length > shown && (
        <button
          type="button"
          className={`${ghostButton} mt-1 self-start`}
          onClick={() => setShown((n) => n + RELEASES_CHUNK)}
        >
          {t("releases.showMore", { count: Math.min(RELEASES_CHUNK, releases.length - shown) })}
        </button>
      )}
      {!full && releases.length > RELEASES_PAGE && (
        <Link
          to="/p/$code/$section"
          params={{ code: projectCode, section: "releases" }}
          search={{ view: "releases" } as never}
          className="mt-2 self-start rounded-sm px-3 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          {t("releases.showAll", { count: releases.length })}
        </Link>
      )}
    </div>
  );
}
