import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../components/WhoCanLink";
import type { ArchivedProjectRow } from "../../data/queries";
import { formatDate } from "../../notifications/time";
import { inputClass } from "../../tasks-ui/Dialog";
import { itemClass } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { RowMenu } from "../preferences/parts";
import { secondaryButton } from "../tasks/controls";
import { searchWords, fold } from "../../domain/textSearch";
import { ReopenProjectDialog } from "./ArchivedProjectPage";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

// All projects → Archived (area 9c, Task 11, shape project-archive.md): gli
// archiviati che chi guarda vede (ex membri e full admin), dal più recente.
// Una riga da 56 px è un link alla pagina dell'archiviato; a destra Reopen e
// il «⋯» con Delete for good (spenti con la loro frase e «Who?» quando la
// vista dice di no). La scheda la monta All projects solo se l'elenco non è
// vuoto. Dopo un dialogo il fuoco torna dov'era; se la riga sparisce va alla
// riga dopo (Reopen) o al titolo della scheda (`onFocusTitle`).

/** Oltre quanti archiviati compare «Find an archived project». */
const FIND_FROM = 20;

type OpenDialog = { kind: "reopen" | "delete"; row: ArchivedProjectRow };

export function ArchivedProjects({
  rows,
  state,
  onRetry,
  onFocusTitle,
}: {
  rows: ArchivedProjectRow[] | undefined;
  state: "loading" | "error" | "ready";
  onRetry: () => void;
  /** La riga se n'è andata e dopo non c'è niente: il fuoco al titolo della scheda (o all'h1). */
  onFocusTitle: () => void;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [q, setQ] = useState("");
  // La riga tolta e quella che prende il fuoco dopo (null: il titolo).
  const [leaving, setLeaving] = useState<{ id: string; next: string | null } | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!leaving || !rows || rows.some((r) => r.projectId === leaving.id)) return;
    const next =
      leaving.next &&
      list.current?.querySelector<HTMLElement>(`[data-archived-link="${leaving.next}"]`);
    setLeaving(null);
    if (next) next.focus();
    else onFocusTitle();
  }, [rows, leaving, onFocusTitle]);

  if (state === "error")
    return (
      <div className="pt-6">
        <PageError message={t("projects.archived.loadError")} onRetry={onRetry} />
      </div>
    );
  if (state === "loading" || !rows) return <ArchivedSkeleton />;

  const words = searchWords(q);
  const shown =
    words.length === 0
      ? rows
      : rows.filter((r) => {
          const text = fold(`${r.code} ${r.name} ${r.clientName ?? ""}`);
          return words.every((w) => text.includes(w));
        });
  const after = (row: ArchivedProjectRow, kind: "reopen" | "delete") => {
    const at = rows.findIndex((r) => r.projectId === row.projectId);
    const next = kind === "reopen" ? (rows[at + 1]?.projectId ?? null) : null;
    // Senza una riga dopo decide All projects: l'elenco può essersi svuotato,
    // e con lui la scheda (e questo componente).
    if (next) setLeaving({ id: row.projectId, next });
    else onFocusTitle();
  };

  return (
    <div className="pt-4">
      <p className="max-w-[72ch] pb-3 pl-4 text-md text-pretty text-ink-muted">
        {t("projects.archived.intro")}
      </p>
      {rows.length > FIND_FROM && (
        <input
          type="search"
          value={q}
          aria-label={t("projects.archived.find")}
          placeholder={t("projects.archived.find")}
          onChange={(e) => setQ(e.target.value)}
          className={`${inputClass} mb-3 ml-4 h-7 max-w-64 py-0 text-sm`}
        />
      )}
      {shown.length === 0 ? (
        <p role="status" className="border-t border-rule px-4 pt-4 text-md text-ink">
          {t("projects.archived.noMatch", { q: q.trim() })}
        </p>
      ) : (
        <ul
          ref={list}
          aria-label={t("projects.archived.list")}
          className="@container border-t border-rule"
        >
          {shown.map((row) => (
            <ArchivedRow
              key={row.projectId}
              row={row}
              onOpen={(kind) => setDialog({ kind, row })}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === "reopen" && (
        <ReopenProjectDialog
          row={dialog.row}
          onClose={() => setDialog(null)}
          onReload={onRetry}
          onReopened={() => after(dialog.row, "reopen")}
          onGone={onRetry}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteProjectDialog
          projectId={dialog.row.projectId}
          code={dialog.row.code}
          onClose={() => setDialog(null)}
          onReload={onRetry}
          onDeleted={() => after(dialog.row, "delete")}
        />
      )}
    </div>
  );
}

/**
 * Una riga: codice, nome, cliente; sotto «Archived Oct 3 by Roberta
 * Fontana». Il link copre la riga, i bottoni ci stanno sopra. Stretta (1024)
 * il cliente scende sulla seconda riga, Reopen resta a destra della prima.
 */
function ArchivedRow({
  row,
  onOpen,
}: {
  row: ArchivedProjectRow;
  onOpen: (kind: "reopen" | "delete") => void;
}) {
  const { t, i18n } = useTranslation();
  const reopenWhy = useId();
  const archived = t("projects.archived.archivedBy", {
    date: formatDate(row.archivedAt, i18n.language),
    name: row.archivedBy,
  });
  const client = row.clientName && (
    <span className="min-w-0 truncate text-sm text-ink-muted">{row.clientName}</span>
  );
  return (
    <li className="group relative flex min-h-14 items-center gap-3 border-b border-rule px-4 py-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <Link
            to="/archived/$code"
            params={{ code: row.code }}
            data-archived-link={row.projectId}
            className="flex min-w-0 items-baseline gap-3 rounded-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-focus"
          >
            <span className="num shrink-0 text-sm font-semibold tracking-[0.02em] text-ink">
              {row.code}
            </span>
            <span className="min-w-0 truncate text-md text-ink">{row.name}</span>
          </Link>
          <span className="hidden min-w-0 @min-[760px]:flex">{client}</span>
        </div>
        <p className="flex min-w-0 items-baseline gap-2 text-sm text-ink-muted">
          <span className="flex min-w-0 @min-[760px]:hidden">{client}</span>
          {row.clientName && (
            <span aria-hidden="true" className="text-ink-faint @min-[760px]:hidden">
              ·
            </span>
          )}
          <span className="num min-w-0 truncate">{archived}</span>
        </p>
      </div>
      <div className="relative z-10 flex shrink-0 flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          {!row.canReopen && (
            <span className="text-sm">
              <WhoCanLink
                action="manageProjectSettings"
                projectId={row.projectId}
                projectCode={row.code}
              />
            </span>
          )}
          <button
            type="button"
            aria-disabled={!row.canReopen || undefined}
            aria-describedby={row.canReopen ? undefined : reopenWhy}
            onClick={() => row.canReopen && onOpen("reopen")}
            className={`${secondaryButton} h-7 px-2.5 aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
          >
            {t("projects.archived.reopen")}
          </button>
          <RowMenu label={t("projects.archived.more", { code: row.code })}>
            {(close) =>
              row.canDelete ? (
                <button
                  type="button"
                  role="menuitem"
                  className={`${itemClass} text-critical`}
                  onClick={() => (close(true), onOpen("delete"))}
                >
                  {t("projects.archived.deleteForGood")}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    aria-disabled="true"
                    className={`${itemClass} cursor-default flex-col items-start gap-0 hover:bg-transparent`}
                  >
                    <span className="text-ink-muted">{t("projects.archived.deleteForGood")}</span>
                    <span className="text-xs text-ink-muted">
                      {t("projects.archived.deleteWhy")}
                    </span>
                  </button>
                  <span className="px-2 pb-1 text-xs">
                    <WhoCanLink action="deleteProjects" projectId={null} menuItem />
                  </span>
                </>
              )
            }
          </RowMenu>
        </div>
        {!row.canReopen && (
          <span
            id={reopenWhy}
            className="max-w-[36ch] text-right text-xs text-pretty text-ink-muted"
          >
            {t("projects.archived.reopenWhy", { code: row.code })}
          </span>
        )}
      </div>
    </li>
  );
}

/** Tre righe finte da 56 px. */
function ArchivedSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe pt-4">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className={`mb-4 ml-4 block h-3 w-80 max-w-full ${bar}`} />
      <div className="border-t border-rule">
        {[0.34, 0.28, 0.4].map((w) => (
          <div
            key={w}
            className="flex h-14 flex-col justify-center gap-2 border-b border-rule px-4"
          >
            <span className={`h-2.5 ${bar}`} style={{ width: `${w * 100}%` }} />
            <span className={`h-2 w-48 ${bar}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
