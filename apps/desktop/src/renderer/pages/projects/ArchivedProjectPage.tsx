import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../components/WhoCanLink";
import {
  PROJECT_SWITCHES,
  useArchivedProject,
  useReopenProject,
  useSeesAdminSection,
  type ArchivedProjectRow,
  type ArchivedProjectView,
  type DeletionCountKey,
} from "../../data/queries";
import { formatDate } from "../../notifications/time";
import { Dialog } from "../../tasks-ui/Dialog";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { OpenCircleGlyph } from "../preferences/glyphs";
import { ProjectNotFound } from "../ProjectNotFound";
import { useSettingsWrite } from "../settings/SettingsFrame";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

// La pagina di un progetto archiviato (`/archived/<CODE>`, area 9c, Task 11,
// shape project-archive.md; maintainer, 31 ott 2026, domanda 1 (a)): la sua
// scheda d'archivio, in sola lettura [AR 1]. Fuori da `/p/`: il progetto non
// è «visibile», e la colonna resta quella di All projects. Sintesi, membri,
// conteggi (non link: per aprire si riapre, [AR 5]), repository e cosa torna
// acceso riaprendo, tutto dalla vista del livello dati; le sole azioni sono
// Reopen e Delete for good, spente con la loro frase e «Who?». Per chi non
// ne era membro e non è full admin la pagina è «not found» come per un
// codice che non c'è (R-G5).

/** I conteggi della pagina, nell'ordine dello shape. */
export const COUNT_KEYS: readonly DeletionCountKey[] = [
  "tasks",
  "requests",
  "docPages",
  "conversations",
  "channels",
  "driveFiles",
  "automations",
  "environments",
  "envFiles",
  "releases",
];

/** Oltre quanti membri l'elenco si chiude con «Show all». */
const MEMBERS_SHOWN = 12;

/** Il bottone critico secondario: il contorno e la parola in rosso. */
export const criticalOutlineButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-critical/60 px-3 text-sm font-semibold text-critical transition-colors duration-[var(--duration-fast)] ease-out hover:bg-critical/10";

export function ArchivedProjectPage({ code }: { code: string }) {
  const { t } = useTranslation();
  const archived = useArchivedProject(code);
  if (archived.isError)
    return (
      <section className="p-8">
        <PageError
          message={t("projects.archived.page.loadError", { code })}
          onRetry={() => void archived.refetch()}
        />
      </section>
    );
  if (archived.isPending) return <PageSkeletonArchived />;
  if (!archived.data) return <ProjectNotFound />;
  return <ArchivedProject view={archived.data} onReload={() => void archived.refetch()} />;
}

type OpenDialog = "reopen" | "delete" | null;

function ArchivedProject({ view, onReload }: { view: ArchivedProjectView; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reopenWhy = useId();
  const deleteWhy = useId();
  const seesLog = useSeesAdminSection("changelog");
  const date = formatDate(view.archivedAt, i18n.language);

  // Aprendo la pagina il fuoco va all'h1, come in ogni destinazione.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="@container flex max-w-[1040px] flex-col">
        <Link
          to="/projects"
          search={{ view: "archived" } as never}
          className="self-start rounded-sm text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          {t("projects.archived.page.back")}
        </Link>
        <p className="mt-3 flex items-start gap-1.5 border-b border-rule pb-3 text-sm text-pretty text-ink-muted">
          <span aria-hidden="true" className="mt-[3px] shrink-0">
            <OpenCircleGlyph size={12} />
          </span>
          <span className="min-w-0">
            {t("projects.archived.page.band", { date, name: view.archivedBy })}
          </span>
        </p>
        <header className="flex flex-col gap-4 pt-5 pb-6 @min-[880px]:flex-row @min-[880px]:items-start">
          <div className="min-w-0 flex-1">
            <h1
              ref={heading}
              tabIndex={-1}
              className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 outline-none"
            >
              <span className="num text-2xl font-semibold tracking-[-0.01em] text-ink">
                {view.code}
              </span>
              <span className="min-w-0 text-lg font-semibold text-pretty text-ink [overflow-wrap:anywhere]">
                {view.name}
              </span>
            </h1>
            {view.clientName && <p className="mt-1 text-sm text-ink-muted">{view.clientName}</p>}
          </div>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <Guarded
              enabled={view.canReopen}
              whyId={reopenWhy}
              why={t("projects.archived.reopenWhy", { code: view.code })}
              who={
                <WhoCanLink
                  action="manageProjectSettings"
                  projectId={view.projectId}
                  projectCode={view.code}
                />
              }
            >
              <button
                type="button"
                aria-disabled={!view.canReopen || undefined}
                aria-describedby={view.canReopen ? undefined : reopenWhy}
                onClick={() => view.canReopen && setDialog("reopen")}
                className={`${primaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
              >
                {t("projects.archived.reopen")}
              </button>
            </Guarded>
            <Guarded
              enabled={view.canDelete}
              whyId={deleteWhy}
              why={t("projects.archived.deleteWhy")}
              who={<WhoCanLink action="deleteProjects" projectId={null} />}
            >
              <button
                type="button"
                aria-disabled={!view.canDelete || undefined}
                aria-describedby={view.canDelete ? undefined : deleteWhy}
                onClick={() => view.canDelete && setDialog("delete")}
                className={`${criticalOutlineButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
              >
                {t("projects.archived.deleteForGood")}
              </button>
            </Guarded>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-x-12 gap-y-8 @min-[880px]:grid-cols-[520px_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-8">
            <Part title={t("projects.archived.page.summary")}>
              <p
                className={`max-w-[72ch] text-md whitespace-pre-line text-pretty [overflow-wrap:anywhere] ${view.description ? "text-ink" : "text-ink-muted"}`}
              >
                {view.description || t("projects.archived.page.noDescription")}
              </p>
            </Part>
            <Part title={t("projects.archived.page.contents")}>
              <dl className="grid grid-cols-2 gap-x-8">
                {COUNT_KEYS.map((key) => (
                  <div
                    key={key}
                    data-count={key}
                    className="flex h-8 items-baseline justify-between gap-3 border-b border-rule pt-1.5"
                  >
                    <dt className="min-w-0 truncate text-md text-ink">
                      {t(`projects.archived.counts.${key}`)}
                    </dt>
                    <dd className="num text-md text-ink">
                      {view.counts[key].toLocaleString(i18n.language)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-sm text-ink-muted">{t("projects.archived.page.toOpen")}</p>
            </Part>
          </div>
          <div className="flex min-w-0 flex-col gap-8">
            <Members members={view.members} />
            {view.repositories.length > 0 && (
              <Part title={t("projects.archived.page.repositories")}>
                <ul className="flex flex-col">
                  {view.repositories.map((name) => (
                    <li
                      key={name}
                      className="flex h-9 items-center border-b border-rule text-md font-semibold text-ink"
                    >
                      <span className="min-w-0 truncate">{name}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 max-w-[60ch] text-sm text-pretty text-ink-muted">
                  {t("projects.archived.page.repositoriesNote", { code: view.code })}
                </p>
              </Part>
            )}
          </div>
          <div className="@min-[880px]:col-span-2">
            <Part title={t("projects.archived.page.whenReopened")}>
              <WhenReopened view={view} />
              {seesLog && (
                <Link
                  to="/admin/$section"
                  params={{ section: "changelog" }}
                  search={{ project: view.code } as never}
                  className="mt-3 inline-block rounded-sm text-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
                >
                  {t("projects.archived.page.changeLog")}
                </Link>
              )}
            </Part>
          </div>
        </div>
      </div>
      {dialog === "reopen" && (
        <ReopenProjectDialog
          row={view}
          onClose={() => setDialog(null)}
          onReload={onReload}
          onReopened={() =>
            void navigate({
              to: "/p/$code/$section",
              params: { code: view.code, section: "overview" },
            })
          }
          onGone={() => void navigate({ to: "/projects", search: { view: "archived" } as never })}
        />
      )}
      {dialog === "delete" && (
        <DeleteProjectDialog
          projectId={view.projectId}
          code={view.code}
          onClose={() => setDialog(null)}
          onReload={onReload}
          onDeleted={() =>
            void navigate({
              to: "/projects",
              search: { view: "archived" } as never,
              state: { focus: "archived" } as never,
            })
          }
        />
      )}
    </section>
  );
}

/** Un bottone spento per permesso: «Who?» accanto e la frase sotto, letta dal bottone. */
function Guarded({
  enabled,
  why,
  whyId,
  who,
  children,
}: {
  enabled: boolean;
  why: string;
  whyId: string;
  who: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="flex max-w-[34ch] flex-col items-start gap-1">
      {/* «Who?» dopo il bottone che spiega: davanti sembrerebbe l'etichetta del bottone dopo. */}
      <span className="flex items-center gap-2">
        {children}
        {!enabled && <span className="text-sm">{who}</span>}
      </span>
      {!enabled && (
        <span id={whyId} className="text-xs text-pretty text-ink-muted">
          {why}
        </span>
      )}
    </span>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="heading-group border-b border-rule pb-2">
        {title}
      </h2>
      <div className="pt-3">{children}</div>
    </section>
  );
}

/** Le iniziali di un nome («Giulia Ferri» → «GF»): la pagina non legge le persone. */
const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function Members({ members }: { members: ArchivedProjectView["members"] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? members : members.slice(0, MEMBERS_SHOWN);
  return (
    <Part title={t("projects.archived.page.members")}>
      <ul className="flex flex-col">
        {shown.map((m) => (
          <li key={m.personId} className="flex h-10 items-center gap-3 border-b border-rule">
            <span
              aria-hidden="true"
              className="grid size-[22px] shrink-0 place-items-center rounded-full border border-rule-strong text-xs font-semibold text-ink-muted"
            >
              {initialsOf(m.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-md text-ink">{m.name}</span>
            <span className="shrink-0 text-sm text-ink-muted">{m.role}</span>
          </li>
        ))}
      </ul>
      {!all && members.length > MEMBERS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-2 rounded-sm text-sm font-medium text-ink underline-offset-2 hover:underline"
        >
          {t("projects.archived.page.showAll", { count: members.length })}
        </button>
      )}
      <p className="mt-2 text-xs text-ink-muted">{t("projects.archived.page.fullAdmins")}</p>
    </Part>
  );
}

/** Cosa torna acceso riaprendo, da `switchesOnReopen` (il pulse col suo intervallo). */
function WhenReopened({ view }: { view: ArchivedProjectView }) {
  const { t, i18n } = useTranslation();
  const label = (s: (typeof PROJECT_SWITCHES)[number]) =>
    s === "pulse"
      ? t("projects.archived.page.pulseEvery", { count: view.pulseEveryDays })
      : t(`settings.automations.switches.${s}`);
  const on = PROJECT_SWITCHES.filter((s) => view.switchesOnReopen[s]).map(label);
  const off = PROJECT_SWITCHES.filter((s) => !view.switchesOnReopen[s]).map(label);
  const and = new Intl.ListFormat(i18n.language, { type: "conjunction" });
  const text =
    on.length === 0
      ? t("projects.archived.page.allOff")
      : [
          t("projects.archived.page.comeBack", { list: on.join(", ") }),
          off.length > 0
            ? t("projects.archived.page.stayOff", { count: off.length, list: and.format(off) })
            : null,
        ]
          .filter(Boolean)
          .join(" ");
  return <p className="max-w-[80ch] text-md text-pretty text-ink">{text}</p>;
}

/** Testata e quattro blocchi finti, nella forma della pagina. */
function PageSkeletonArchived() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <section
      aria-busy="true"
      className="page-header skeleton-breathe pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]"
    >
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <div className="flex max-w-[1040px] flex-col gap-6">
        <span className={`block h-3 w-20 ${bar}`} />
        <span className={`block h-3 w-96 max-w-full ${bar}`} />
        <span className={`block h-7 w-72 max-w-full ${bar}`} />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-3 border-t border-rule pt-3">
            <span className={`block h-3 w-28 ${bar}`} />
            <span className={`block h-3 w-3/5 ${bar}`} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * «Reopen RNC?» (440 px): dalla pagina o dalla riga di Archived. Nessuna
 * riconferma (si torna indietro). Riuscito, il toast, poi chi l'ha aperto
 * decide dove andare (`onReopened`). Rifiuti: già riaperto → il toast e
 * `/p/RNC`; eliminato nel frattempo → il toast e `onGone`.
 */
export function ReopenProjectDialog({
  row,
  onClose,
  onReload,
  onReopened,
  onGone,
}: {
  row: Pick<ArchivedProjectRow, "projectId" | "code">;
  onClose: () => void;
  onReload: () => void;
  onReopened: () => void;
  onGone: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const reopen = useReopenProject();
  const [sending, setSending] = useState(false);
  const code = row.code;
  const write = useSettingsWrite(code, onReload, {
    onNotFound: () => {
      toast.error(t("projects.archived.reopenDialog.gone", { code }));
      onClose();
      onGone();
    },
  });

  async function submit() {
    if (sending) return;
    setSending(true);
    await write.run(
      () => reopen.mutateAsync(row.projectId),
      (reason) => {
        if (reason !== "not_archived") return;
        toast.show(t("projects.archived.reopenDialog.already", { code }));
        onClose();
        void navigate({ to: "/p/$code/$section", params: { code, section: "overview" } });
      },
      () => {
        toast.show(t("projects.archived.reopenDialog.done", { code }));
        onClose();
        onReopened();
      },
    );
    setSending(false);
  }

  return (
    <Dialog
      title={t("projects.archived.reopenDialog.title", { code })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" data-autofocus className={secondaryButton} onClick={onClose}>
            {t("projects.archived.reopenDialog.cancel")}
          </button>
          <button
            type="button"
            aria-disabled={sending || undefined}
            onClick={() => void submit()}
            className={primaryButton}
          >
            {sending
              ? t("projects.archived.reopenDialog.reopening")
              : t("projects.archived.reopenDialog.reopen")}
          </button>
        </>
      }
    >
      <ul className="flex flex-col gap-2 text-md text-pretty text-ink">
        {(["rail", "settings", "automations", "notifications"] as const).map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-[8px] size-1 shrink-0 rounded-full bg-ink-muted"
            />
            <span className="min-w-0">{t(`projects.archived.reopenDialog.${line}`)}</span>
          </li>
        ))}
      </ul>
      {write.message}
    </Dialog>
  );
}
