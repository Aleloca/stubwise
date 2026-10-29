import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { OpenPrView, QueueItem } from "../../data/releases";
import type { MergeError } from "./MergeConfirm";
import type { ProjectEnvironment } from "../../data/types";
import { environmentServerFor } from "../../domain/releases/environmentServer";
import { sameCommit } from "../../domain/releases/releaseStatus";
import { Chevron, Menu, MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { rowKeys } from "../home/blocks/BlockSection";
import { shortRepo } from "./format";
import { PrRow } from "./PrRow";

// Le PR aperte, una lista sola raggruppata per ciò che manca (shape
// releases.md [R 2]): «Pronte per il rilascio» (la coda, con «Release») e
// «Non ancora pronte» (col motivo in parola). Nella pagina tutto il primo
// gruppo e i primi 8 del secondo; `?view=prs` è la stessa lista intera, con
// i filtri Repository · Author · State.

/** Quante «non ancora pronte» si vedono nella pagina prima di «Show all N». */
export const NOT_READY_PAGE = 8;

export type PrFilters = { repo: string | null; author: string | null; state: string | null };

export const NO_PR_FILTERS: PrFilters = { repo: null, author: null, state: null };

function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { id: string; label: string }[];
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value);
  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        {current ? `${label}: ${current.label}` : label}
        <Chevron />
      </button>
      {open && (
        <Menu label={label} align="right" onClose={() => setOpen(false)}>
          <MenuGroup>
            <RadioItem
              checked={value === null}
              onSelect={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              {t("releases.filters.any")}
            </RadioItem>
            {options.map((o) => (
              <RadioItem
                key={o.id}
                checked={value === o.id}
                onSelect={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
              >
                {o.label}
              </RadioItem>
            ))}
          </MenuGroup>
        </Menu>
      )}
    </span>
  );
}

function Group({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-pr-group={id} className="flex flex-col">
      <h3 className="heading-group px-3 pt-4 pb-1.5">{title}</h3>
      {note && <p className="px-3 pb-2 text-xs text-ink-muted">{note}</p>}
      {children}
    </div>
  );
}

export function PrList({
  projectCode,
  prs,
  queue,
  environments,
  filters = NO_PR_FILTERS,
  full = false,
}: {
  projectCode: string;
  prs: OpenPrView[];
  queue: QueueItem[];
  environments: ProjectEnvironment[];
  /** I filtri scelti in testa alla parte (`PrFilterBar`). */
  filters?: PrFilters;
  /** `?view=prs`: la lista intera, coi filtri. */
  full?: boolean;
}) {
  const { t } = useTranslation();
  // Una riga che ha preso un errore del merge resta nel primo gruppo, espansa
  // con l'errore, anche se nel frattempo la coda l'ha tolta (shape [R 10]).
  const [pinned, setPinned] = useState<Record<string, MergeError>>({});
  const onMergeError = (prId: string, error: MergeError | null) =>
    setPinned((prev) => {
      const next = { ...prev };
      // Una PR chiusa o sparita si aggiorna da sola: non si trattiene.
      if (error && error !== "already_closed" && error !== "not_found") next[prId] = error;
      else delete next[prId];
      return next;
    });

  const match = (p: OpenPrView) =>
    (!filters.repo || p.repo === filters.repo) &&
    (!full || !filters.author || p.authorName === filters.author) &&
    (!full || !filters.state || p.prState.state === filters.state);

  const queueIds = new Set(queue.map((q) => q.id));
  const canMerge = queue[0]?.canMerge ?? false;
  const ready = prs.filter((p) => (queueIds.has(p.id) || pinned[p.id]) && match(p));
  const notReady = prs.filter((p) => !queueIds.has(p.id) && !pinned[p.id] && match(p));
  const shownNotReady = full ? notReady : notReady.slice(0, NOT_READY_PAGE);
  // «Già su staging?»: il server della repository della PR in uno staging (R-L2).
  const staging = environments.filter((e) => e.kind === "staging");
  const onStaging = (p: OpenPrView) =>
    staging.some((e) => sameCommit(p.headSha, environmentServerFor(e, p.repositoryId)?.reportedSha));

  const row = (p: OpenPrView, isReady: boolean) => (
    <PrRow
      key={p.id}
      pr={p}
      projectCode={projectCode}
      ready={isReady}
      canMerge={isReady && (queue.find((q) => q.id === p.id)?.canMerge ?? canMerge)}
      onStaging={onStaging(p)}
      onMergeError={onMergeError}
    />
  );

  return (
    <div className="@container flex flex-col">
      <div onKeyDown={rowKeys("[data-pr-open]")} className="flex flex-col border-t border-rule">
        <Group
          id="ready"
          title={t("releases.groups.ready")}
          note={
            ready.length > 0 && !canMerge
              ? t("releases.merge.noPermission", { code: projectCode })
              : undefined
          }
        >
          {ready.length > 0 ? (
            <ul aria-label={t("releases.groups.ready")}>{ready.map((p) => row(p, true))}</ul>
          ) : (
            <p className="px-3 pb-3 text-sm text-ink-muted">{t("releases.groups.readyEmpty")}</p>
          )}
        </Group>
        <Group id="not-ready" title={t("releases.groups.notReady")}>
          {notReady.length > 0 ? (
            <ul aria-label={t("releases.groups.notReady")}>
              {shownNotReady.map((p) => row(p, false))}
            </ul>
          ) : (
            <p className="px-3 pb-3 text-sm text-ink-muted">{t("releases.groups.notReadyEmpty")}</p>
          )}
        </Group>
      </div>
      {!full && notReady.length > NOT_READY_PAGE && (
        <Link
          to="/p/$code/$section"
          params={{ code: projectCode, section: "releases" }}
          search={{ view: "prs" } as never}
          className="mt-2 self-start rounded-sm px-3 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          {t("releases.showAll", { count: notReady.length })}
        </Link>
      )}
    </div>
  );
}

/**
 * I filtri della lista, sulla riga del titolo «Pull requests» (shape
 * releases §6): Repository se ce n'è più d'uno; con `?view=prs` anche
 * Author e State.
 */
export function PrFilterBar({
  prs,
  full,
  filters,
  setFilters,
}: {
  prs: OpenPrView[];
  full: boolean;
  filters: PrFilters;
  setFilters: (update: (f: PrFilters) => PrFilters) => void;
}) {
  const { t } = useTranslation();
  const repos = [...new Set(prs.map((p) => p.repo))];
  const authors = [...new Map(prs.map((p) => [p.authorName, p.authorName])).values()];
  const states = [...new Set(prs.map((p) => p.prState.state))];
  if (repos.length <= 1 && !full) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {repos.length > 1 && (
        <FilterMenu
          label={t("releases.filters.repository")}
          value={filters.repo}
          options={repos.map((r) => ({ id: r, label: shortRepo(r) }))}
          onChange={(repo) => setFilters((f) => ({ ...f, repo }))}
        />
      )}
      {full && (
        <>
          <FilterMenu
            label={t("releases.filters.author")}
            value={filters.author}
            options={authors.map((a) => ({ id: a, label: a }))}
            onChange={(author) => setFilters((f) => ({ ...f, author }))}
          />
          <FilterMenu
            label={t("releases.filters.state")}
            value={filters.state}
            options={states.map((s) => ({
              id: s,
              label: t(`releases.prState.${s}`, { count: 2 }),
            }))}
            onChange={(state) => setFilters((f) => ({ ...f, state }))}
          />
        </>
      )}
    </div>
  );
}
