import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { visitSteps } from "../../../domain/automations/fields";
import type { AutomationVersion } from "../../../data/types";
import { MenuGroup, itemClass } from "../../../tasks-ui/Menu";
import { useToast } from "../../../tasks-ui/Toast";
import { MenuButton, primaryButton, quietButton, secondaryButton } from "../../tasks/controls";
import { clock, shortDate } from "../format";
import { CriticalGlyph, MoreGlyph } from "../glyphs";
import { codeClass } from "../shared";
import { useBuilder } from "./context";
import type { SaveStatus as Status } from "./useAutosave";

// La testata del costruttore (shape builder §3): ritorno, nome e codice,
// riga meta (progetto · stato · versione · proprietario · salvataggio),
// contatore dei problemi, «⋯», Test e l'azione primaria; poi le fasce
// (bozza di un'attiva, sola lettura, bozza cambiata da un altro).

export interface HeaderProps {
  status: Status;
  onRetry: () => void;
  draftExists: boolean;
  editingN: number;
  live: AutomationVersion | null;
  why: string | null;
  blocked: boolean;
  nothingToPublish: boolean;
  staleBy: string | null;
  /** Quando l'altro l'ha salvata (la fascia lo dice, [A 12]). */
  staleAt: string | null;
  onProblem: () => void;
  onTest: () => void;
  onPrimary: () => void;
  onReload: () => void;
  onRename: () => void;
  onDiscard?: () => void;
  onDeleteDraft?: () => void;
  onCollapse: (ids: Set<string>) => void;
  /** Arrivati dall'elenco: il ritorno è «← Automations» (shape §3). */
  fromList: boolean;
}

export function BuilderHeader(p: HeaderProps) {
  const { t, i18n } = useTranslation();
  const b = useBuilder();
  const a = b.automation;
  const general = a.projectId === null;
  const projectWords = general
    ? t("automations.builder.meta.general")
    : (() => {
        const prj = b.names.project(a.projectId);
        return prj ? `${prj.code} ${prj.name}` : "";
      })();
  const actionLabel =
    a.status === "draft"
      ? t("automations.actions.turnOn")
      : t("automations.builder.publishN", { n: p.editingN });
  return (
    <header className="sticky top-0 z-20 flex flex-col gap-2 border-b border-rule bg-ground pt-6 pr-8 pb-4 pl-8">
      {p.fromList ? (
        <Link
          to="/automations"
          data-back-link
          className="w-fit text-sm text-ink-muted hover:text-ink"
        >
          ← {t("automations.builder.backToList")}
        </Link>
      ) : (
        <Link
          to="/automations/$code"
          params={{ code: a.code }}
          data-back-link
          className="w-fit text-sm text-ink-muted hover:text-ink"
        >
          ← <span className={codeClass}>{a.code}</span> {a.name}
        </Link>
      )}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <h1 className="min-w-0 flex-1 basis-80 text-2xl font-semibold break-words text-ink">
          {a.name}{" "}
          <span className="num align-middle text-sm font-semibold text-ink-faint">{a.code}</span>
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {b.issues.total > 0 && (
            <button
              type="button"
              data-problem-count
              onClick={p.onProblem}
              title={t("automations.builder.nextProblem")}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-critical hover:bg-critical/8"
            >
              <CriticalGlyph />
              {t("automations.builder.problemsCount", { count: b.issues.total })}
            </button>
          )}
          <HeaderMenu
            onRename={p.onRename}
            onDiscard={p.onDiscard}
            onDeleteDraft={p.onDeleteDraft}
            onExpandAll={() => p.onCollapse(new Set())}
            onCollapseAll={() => {
              const all = new Set<string>();
              visitSteps(b.flow.steps, (s) => {
                if (["condition", "claude", "forEach", "repeatUntil"].includes(s.kind))
                  all.add(s.id);
              });
              p.onCollapse(all);
            }}
            readOnly={b.readOnly}
            code={a.code}
          />
          {!b.readOnly && (
            <>
              {p.blocked ? (
                <button
                  type="button"
                  disabled
                  title={p.why ?? undefined}
                  className={`${secondaryButton} opacity-40`}
                >
                  {t("automations.actions.test")}
                </button>
              ) : (
                <Link
                  to="/automations/$code/test"
                  params={{ code: a.code }}
                  onClick={p.onTest}
                  className={secondaryButton}
                >
                  {t("automations.actions.test")}
                </Link>
              )}
              <button
                type="button"
                data-primary-action
                disabled={p.blocked || p.nothingToPublish}
                title={p.why ?? undefined}
                onClick={p.onPrimary}
                className={`${primaryButton} disabled:opacity-40`}
              >
                {actionLabel}
              </button>
            </>
          )}
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
        <span>{projectWords}</span>
        <span aria-hidden="true">·</span>
        <span>{t(`automations.builder.meta.status.${a.status}`)}</span>
        {a.status !== "draft" && p.live && (
          <>
            <span aria-hidden="true">·</span>
            <span data-version-line>
              {p.draftExists
                ? t(`automations.builder.meta.editing.${a.status}`, {
                    n: p.editingN,
                    m: p.live.n,
                  })
                : t(`automations.builder.meta.live.${a.status}`, { m: p.live.n })}
            </span>
          </>
        )}
        {a.ownerId && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t("automations.builder.meta.actsAs", { name: b.names.person(a.ownerId) })}</span>
          </>
        )}
        {!b.readOnly && (
          <>
            <span aria-hidden="true">·</span>
            <SaveStatus status={p.status} onRetry={p.onRetry} />
          </>
        )}
      </p>
      {p.why && !b.readOnly && <p className="text-sm text-ink-muted">{p.why}</p>}
      {b.readOnly && (
        <p data-read-only className="text-sm text-ink-muted">
          {t("automations.builder.readOnly", {
            code: general ? t("automations.general") : (b.names.project(a.projectId)?.code ?? ""),
          })}
        </p>
      )}
      {!b.readOnly && a.status !== "draft" && p.draftExists && (
        <p data-draft-band className="text-sm text-ink">
          {t("automations.builder.band", { m: p.live?.n ?? 1 })}
        </p>
      )}
      {p.status === "stale" && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-ink">
          <CriticalGlyph />
          {t("automations.builder.stale", {
            name: b.names.person(p.staleBy),
            when: p.staleAt
              ? `${shortDate(p.staleAt, i18n.language)} ${clock(p.staleAt, i18n.language)}`
              : "",
          })}
          <button type="button" className={quietButton} onClick={p.onReload}>
            {t("automations.builder.reload")}
          </button>
        </p>
      )}
    </header>
  );
}

function SaveStatus({ status, onRetry }: { status: Status; onRetry: () => void }) {
  const { t } = useTranslation();
  if (status === "error")
    return (
      <span data-save-status={status} className="inline-flex items-center gap-1.5 text-critical">
        <CriticalGlyph />
        {t("automations.builder.save.error")}
        <button
          type="button"
          className="font-medium text-ink underline-offset-4 hover:underline"
          onClick={onRetry}
        >
          {t("automations.builder.save.retry")}
        </button>
      </span>
    );
  return (
    <span data-save-status={status}>
      {status === "saving"
        ? t("automations.builder.save.saving")
        : status === "stale"
          ? t("automations.builder.save.stopped")
          : t("automations.builder.save.saved")}
    </span>
  );
}

function HeaderMenu({
  onRename,
  onDiscard,
  onDeleteDraft,
  onExpandAll,
  onCollapseAll,
  readOnly,
  code,
}: {
  onRename: () => void;
  onDiscard?: () => void;
  onDeleteDraft?: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  readOnly: boolean;
  code: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const item = (label: string, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`${itemClass} ${danger ? "text-critical" : ""}`}
      onClick={run}
    >
      {label}
    </button>
  );
  return (
    <MenuButton
      ariaLabel={t("automations.builder.headerMenu")}
      menuLabel={t("automations.builder.headerMenu")}
      align="right"
      label={<MoreGlyph />}
      className="grid size-8 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
    >
      {(close) => (
        <>
          <MenuGroup>
            {!readOnly && item(t("automations.builder.menu.rename"), () => (close(), onRename()))}
            {item(t("automations.builder.menu.expandAll"), () => (close(), onExpandAll()))}
            {item(t("automations.builder.menu.collapseAll"), () => (close(), onCollapseAll()))}
            {item(t("automations.actions.copyLink"), () => {
              close();
              void navigator.clipboard?.writeText(
                `${window.location.origin}${window.location.pathname}#/automations/${code}/edit`,
              );
              toast.show(t("automations.toast.linkCopied"));
            })}
          </MenuGroup>
          {(onDiscard || onDeleteDraft) && (
            <MenuGroup>
              {onDiscard &&
                item(t("automations.builder.menu.discard"), () => (close(), onDiscard()), true)}
              {onDeleteDraft &&
                item(t("automations.actions.deleteDraft"), () => (close(), onDeleteDraft()), true)}
            </MenuGroup>
          )}
        </>
      )}
    </MenuButton>
  );
}
