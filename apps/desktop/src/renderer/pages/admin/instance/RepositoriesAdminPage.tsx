import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAllRepositories,
  type InstanceRepositoryGroup,
  type InstanceRepositoryRow,
} from "../../../data/queries";
import { searchWords, fold } from "../../../domain/textSearch";
import { inputClass } from "../../../tasks-ui/Dialog";
import { ReadError } from "../../preferences/parts";
import { IntegrationPage } from "../integrations/parts";

// Repositories dell'Amministrazione (area 9b, shape admin-instance.md
// «Repositories»): un elenco del catalogo senza azioni, un gruppo per
// progetto. Lo apre chi ha `repos.manage` in almeno un progetto; elenca i
// progetti dove chi guarda ha `repos.view` (lo decide il livello dati: un
// progetto senza repository o che non si vede non compare, nemmeno
// contato). Ogni riga porta alle impostazioni dei repository del suo
// progetto (`href` del livello dati), dove si cambia. Oltre 10 repository,
// «Find a repository» per nome o progetto.

/** Oltre quanti repository compare il campo di ricerca. */
const FIND_FROM = 10;

/** La freccia in fondo alla riga: la riga porta altrove. */
function ArrowGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-ink-faint transition-transform duration-[var(--duration-fast)] ease-out group-hover:translate-x-0.5 motion-reduce:transition-none"
    >
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

/** Due gruppi finti: la testata del progetto e tre righe. */
function Skeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe mt-6 flex flex-col gap-8">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {[0, 1].map((g) => (
        <div key={g}>
          <span className={`block h-3 w-56 ${bar}`} />
          <div className="mt-3 border-t border-rule">
            {[0.3, 0.22, 0.26].map((w) => (
              <div key={w} className="flex h-11 items-center gap-3 border-b border-rule px-3">
                <span className={`h-2.5 ${bar}`} style={{ width: `${w * 100}%` }} />
                <span className={`ml-auto h-2.5 w-28 ${bar}`} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RepositoryRow({
  repo,
  group,
}: {
  repo: InstanceRepositoryRow;
  group: InstanceRepositoryGroup;
}) {
  const { t } = useTranslation();
  const account = repo.gitAccountName ?? t("admin.repositories.noAccount");
  return (
    <li className="border-b border-rule">
      {/* L'indirizzo lo dà il livello dati (`#/p/ACQ/settings/repositories`): qui si toglie solo il «#». */}
      <Link
        to={repo.href.replace(/^#/, "") as "/"}
        aria-label={`${t("admin.repositories.open", { name: repo.name, project: group.projectCode })}. ${[repo.fullName, account].filter(Boolean).join(". ")}`}
        className="group @container flex min-h-11 items-center gap-3 rounded-md px-3 py-1.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10"
      >
        {/* Stretta (1024): il nome completo scende sotto il nome. */}
        <span className="flex min-w-0 flex-1 flex-col @min-[760px]:flex-row @min-[760px]:items-baseline @min-[760px]:gap-3">
          <span title={repo.name} className="truncate text-md font-semibold text-ink">
            {repo.name}
          </span>
          {repo.fullName && (
            <span title={repo.fullName} className="truncate text-sm text-ink-muted">
              {repo.fullName}
            </span>
          )}
        </span>
        <span
          className={`shrink-0 truncate text-sm ${repo.gitAccountName ? "text-ink-muted" : "text-ink-faint"}`}
        >
          {account}
        </span>
        <ArrowGlyph />
      </Link>
    </li>
  );
}

function Group({ group }: { group: InstanceRepositoryGroup }) {
  const { t } = useTranslation();
  const name = t("admin.repositories.group", { code: group.projectCode, name: group.projectName });
  return (
    // Il gruppo si chiama «ACQ · Portale…», senza il conteggio accanto.
    <section aria-label={name} className="flex flex-col">
      <div className="flex items-baseline gap-3 pb-2 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-md text-ink">
          <span className="num text-xs font-semibold tracking-[0.02em]">{group.projectCode}</span>
          <span className="text-ink-faint"> · </span>
          <span className="font-semibold">{group.projectName}</span>
        </h2>
        <span className="num shrink-0 pr-3 text-xs text-ink-muted">
          {t("admin.repositories.count", { count: group.repositories.length })}
        </span>
      </div>
      <ul className="border-t border-rule">
        {group.repositories.map((r) => (
          <RepositoryRow key={r.id} repo={r} group={group} />
        ))}
      </ul>
    </section>
  );
}

/** Per nome, nome completo, codice o nome del progetto; ogni parola deve trovarsi. */
function filterGroups(groups: InstanceRepositoryGroup[], q: string): InstanceRepositoryGroup[] {
  const words = searchWords(q);
  if (words.length === 0) return groups;
  return groups
    .map((g) => {
      const project = fold(`${g.projectCode} ${g.projectName}`);
      return {
        ...g,
        repositories: g.repositories.filter((r) => {
          const text = `${project} ${fold(`${r.name} ${r.fullName ?? ""}`)}`;
          return words.every((w) => text.includes(w));
        }),
      };
    })
    .filter((g) => g.repositories.length > 0);
}

export function RepositoriesAdminPage() {
  const { t } = useTranslation();
  const repositories = useAllRepositories();
  const [q, setQ] = useState("");
  const all = repositories.data ?? [];
  const total = all.reduce((n, g) => n + g.repositories.length, 0);
  const shown = filterGroups(all, q);

  return (
    <IntegrationPage
      title={t("admin.repositories.title")}
      intro={t("admin.repositories.intro")}
      width={960}
    >
      {repositories.isPending ? (
        <Skeleton />
      ) : repositories.isError ? (
        <ReadError
          message={t("admin.repositories.loadError")}
          onRetry={() => void repositories.refetch()}
        />
      ) : total === 0 ? (
        <div className="mt-6 border-t border-rule pt-5">
          <p className="text-md text-ink">{t("admin.repositories.empty")}</p>
        </div>
      ) : (
        <>
          {total > FIND_FROM && (
            <input
              type="search"
              value={q}
              aria-label={t("admin.repositories.find")}
              placeholder={t("admin.repositories.find")}
              onChange={(e) => setQ(e.target.value)}
              className={`${inputClass} mt-5 h-7 max-w-64 py-0 text-sm`}
            />
          )}
          {shown.length === 0 ? (
            <p role="status" className="mt-6 border-t border-rule pt-5 text-md text-ink">
              {t("admin.repositories.noMatch", { q: q.trim() })}
            </p>
          ) : (
            <div className="mt-6 flex flex-col gap-8">
              {shown.map((g) => (
                <Group key={g.projectId} group={g} />
              ))}
            </div>
          )}
        </>
      )}
    </IntegrationPage>
  );
}
