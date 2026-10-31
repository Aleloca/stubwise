import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import {
  useAllRepositories,
  useDetachedRepositories,
  type DetachedRepositoryRow,
  type InstanceRepositoryGroup,
  type InstanceRepositoryRow,
} from "../../../data/queries";
import { searchWords, fold } from "../../../domain/textSearch";
import { formatDate } from "../../../notifications/time";
import { inputClass } from "../../../tasks-ui/Dialog";
import { itemClass } from "../../../tasks-ui/Menu";
import { ReadError, RowMenu } from "../../preferences/parts";
import { secondaryButton } from "../../tasks/controls";
import { IntegrationPage } from "../integrations/parts";
import { DeleteDetachedRepositoryDialog, LinkRepositoryDialog } from "./LinkRepositoryDialog";

// Repositories dell'Amministrazione (area 9b, shape admin-instance.md
// «Repositories»): un elenco del catalogo senza azioni, un gruppo per
// progetto. Lo apre chi ha `repos.manage` in almeno un progetto; elenca i
// progetti dove chi guarda ha `repos.view` (lo decide il livello dati: un
// progetto senza repository o che non si vede non compare, nemmeno
// contato). Ogni riga porta alle impostazioni dei repository del suo
// progetto (`href` del livello dati), dove si cambia. Oltre 10 repository,
// «Find a repository» per nome o progetto.
//
// Area 9c (Task 11, shape project-archive.md): dopo i gruppi dei progetti,
// solo se non è vuoto, il gruppo «Not in any project» coi repository rimasti
// dal Delete di un progetto. Le sue righe non sono link (non c'è un progetto
// in cui aprirle): hanno «Link to a project…» e, per il full admin, il «⋯»
// con Delete…. Da dove vengono lo dice `formerProject`, che il livello dati
// dà solo agli ex membri e al full admin (R-G5): per gli altri niente, né
// nella riga né nella ricerca.

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

/** Per nome, nome completo e progetto d'origine (se la lettura lo dà); ogni parola deve trovarsi. */
function filterDetached(rows: DetachedRepositoryRow[], q: string): DetachedRepositoryRow[] {
  const words = searchWords(q);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const from = r.formerProject ? `${r.formerProject.code} ${r.formerProject.name}` : "";
    const text = fold(`${r.name} ${r.fullName ?? ""} ${from}`);
    return words.every((w) => text.includes(w));
  });
}

type DetachedDialog = { kind: "link" | "delete"; row: DetachedRepositoryRow };

/**
 * Il gruppo «Not in any project». Dopo un collegamento o un'eliminazione la
 * riga sparisce e il fuoco va al «Link to a project…» della riga dopo, o
 * all'h1 se il gruppo sparisce ([AR 8]); dopo un annullamento, al bottone che
 * ha aperto il dialogo.
 */
function DetachedGroup({
  rows,
  onReload,
  onFocusHeading,
}: {
  rows: DetachedRepositoryRow[];
  onReload: () => void;
  onFocusHeading: () => void;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<DetachedDialog | null>(null);
  const [leaving, setLeaving] = useState<{ id: string; next: string } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!leaving || rows.some((r) => r.id === leaving.id)) return;
    setLeaving(null);
    const next = list.current?.querySelector<HTMLElement>(
      `[data-link-repository="${leaving.next}"]`,
    );
    if (next) next.focus();
    else onFocusHeading();
  }, [rows, leaving, onFocusHeading]);

  const after = (row: DetachedRepositoryRow) => {
    const at = rows.findIndex((r) => r.id === row.id);
    const next = rows[at + 1] ?? rows[at - 1];
    // Senza un'altra riga il gruppo sparisce (e con lui questo componente): l'h1.
    if (next) setLeaving({ id: row.id, next: next.id });
    else onFocusHeading();
  };

  return (
    <section aria-labelledby={titleId} className="flex flex-col">
      <div className="flex items-baseline gap-3 pb-2 pl-3">
        <h2 id={titleId} className="heading-group min-w-0 flex-1 truncate">
          {t("admin.repositories.detached.group")}
        </h2>
        <span className="num shrink-0 pr-3 text-xs text-ink-muted">
          {t("admin.repositories.count", { count: rows.length })}
        </span>
      </div>
      <ul ref={list} className="@container border-t border-rule">
        {rows.map((r) => (
          <DetachedRow key={r.id} repo={r} onOpen={(kind) => setDialog({ kind, row: r })} />
        ))}
      </ul>
      {dialog?.kind === "link" && (
        <LinkRepositoryDialog
          repository={dialog.row}
          onClose={() => setDialog(null)}
          onReload={onReload}
          onDone={() => after(dialog.row)}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDetachedRepositoryDialog
          repository={dialog.row}
          onClose={() => setDialog(null)}
          onReload={onReload}
          onDone={() => after(dialog.row)}
        />
      )}
    </section>
  );
}

/**
 * Una riga (60 px, due righe; non un link). Prima: nome, nome completo,
 * account git, a destra «Link to a project…» (e il «⋯» del full admin).
 * Seconda: «From RNC · …, deleted Oct 31» o «Without a project since Oct
 * 31». Stretta (1024) l'account scende sulla seconda riga e il bottone sotto,
 * a destra.
 */
function DetachedRow({
  repo: r,
  onOpen,
}: {
  repo: DetachedRepositoryRow;
  onOpen: (kind: "link" | "delete") => void;
}) {
  const { t, i18n } = useTranslation();
  const whyId = useId();
  const canLink = r.linkTargets.length > 0;
  const date = formatDate(r.detachedAt, i18n.language);
  const account = (
    <span
      className={`min-w-0 truncate text-sm ${r.gitAccountName ? "text-ink-muted" : "text-ink-faint"}`}
    >
      {r.gitAccountName ?? t("admin.repositories.noAccount")}
    </span>
  );
  return (
    <li className="flex flex-col gap-1.5 border-b border-rule px-3 py-2.5 @min-[760px]:flex-row @min-[760px]:items-center @min-[760px]:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span title={r.name} className="truncate text-md font-semibold text-ink">
            {r.name}
          </span>
          {r.fullName && (
            <span title={r.fullName} className="min-w-0 truncate text-sm text-ink-muted">
              {r.fullName}
            </span>
          )}
          <span className="ml-auto hidden shrink-0 @min-[760px]:flex">{account}</span>
        </div>
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-ink-muted">
          <span className="num min-w-0">
            {r.formerProject ? (
              <Trans
                i18nKey="admin.repositories.detached.from"
                values={{ code: r.formerProject.code, name: r.formerProject.name, date }}
                components={{ b: <span className="font-semibold text-ink" /> }}
              />
            ) : (
              t("admin.repositories.detached.since", { date })
            )}
          </span>
          <span aria-hidden="true" className="text-ink-faint @min-[760px]:hidden">
            ·
          </span>
          <span className="flex min-w-0 @min-[760px]:hidden">{account}</span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 self-end @min-[760px]:self-center">
        <div className="flex items-center gap-2">
          {!canLink && (
            <span className="text-sm">
              <WhoCanLink action="manageRepos" projectId={null} />
            </span>
          )}
          <button
            type="button"
            data-link-repository={r.id}
            aria-disabled={!canLink || undefined}
            aria-describedby={canLink ? undefined : whyId}
            onClick={() => canLink && onOpen("link")}
            className={`${secondaryButton} h-7 px-2.5 aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
          >
            {t("admin.repositories.detached.link")}
          </button>
          {r.canDelete && (
            <RowMenu label={t("admin.repositories.detached.more", { name: r.name })}>
              {(close) => (
                <button
                  type="button"
                  role="menuitem"
                  className={`${itemClass} text-critical`}
                  onClick={() => (close(true), onOpen("delete"))}
                >
                  {t("admin.repositories.detached.delete")}
                </button>
              )}
            </RowMenu>
          )}
        </div>
        {!canLink && (
          <span id={whyId} className="max-w-[44ch] text-right text-xs text-pretty text-ink-muted">
            {t("admin.repositories.detached.noTargets")}
          </span>
        )}
      </div>
    </li>
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
  const detached = useDetachedRepositories();
  const [q, setQ] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const all = repositories.data ?? [];
  const loose = detached.data ?? [];
  const total = all.reduce((n, g) => n + g.repositories.length, 0) + loose.length;
  const shown = filterGroups(all, q);
  const shownLoose = filterDetached(loose, q);
  const focusHeading = () =>
    body.current?.closest("section")?.querySelector<HTMLElement>("h1")?.focus();

  return (
    <IntegrationPage
      title={t("admin.repositories.title")}
      intro={t("admin.repositories.intro")}
      width={960}
    >
      <div ref={body}>
        {repositories.isPending || detached.isPending ? (
          <Skeleton />
        ) : repositories.isError || detached.isError ? (
          <ReadError
            message={t("admin.repositories.loadError")}
            onRetry={() => {
              if (repositories.isError) void repositories.refetch();
              if (detached.isError) void detached.refetch();
            }}
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
            {shown.length === 0 && shownLoose.length === 0 ? (
              <p role="status" className="mt-6 border-t border-rule pt-5 text-md text-ink">
                {t("admin.repositories.noMatch", { q: q.trim() })}
              </p>
            ) : (
              <div className="mt-6 flex flex-col gap-8">
                {shown.map((g) => (
                  <Group key={g.projectId} group={g} />
                ))}
                {shownLoose.length > 0 && (
                  <DetachedGroup
                    rows={shownLoose}
                    onReload={() => void detached.refetch()}
                    onFocusHeading={focusHeading}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </IntegrationPage>
  );
}
